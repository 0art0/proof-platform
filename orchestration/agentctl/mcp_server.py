from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from .config import Config
from .state import State
from .util import AgentCtlError


PROTOCOL_VERSION = "2025-06-18"


def _open_state(root: Path) -> tuple[Config, State]:
    config = Config.load(root)
    config.ensure_runtime_directories()
    state = State(config.database_path)
    state.migrate()
    state.ensure_todo_root(config.project_name)
    return config, state


def _todo_summary(node: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": node["id"],
        "title": node["title"],
        "status": node["status"],
        "taskId": node.get("task_id"),
        "children": [_todo_summary(child) for child in node.get("children", [])],
    }


def _task_summary(state: State, task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task["id"],
        "title": task["title"],
        "status": task["status"],
        "attempt": task["attempt"],
        "failureCount": task["failure_count"],
        "maxAttempts": task["max_attempts"],
        "todoPath": state.todo_path_for_task(task["id"]),
        "dependencies": state.dependencies(task["id"]),
        "summary": task["result_summary"],
        "error": task["last_error"],
    }


def tools() -> list[dict[str, Any]]:
    return [
        {
            "name": "proof_platform_submit_intent",
            "description": (
                "Submit the user's explicit development intent to the deterministic Proof Platform "
                "supervisor. The read-only planning agent will validate and split it into durable tasks."
            ),
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "required": ["message"],
                "properties": {
                    "message": {"type": "string", "minLength": 1, "maxLength": 12000}
                },
            },
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": False,
            },
        },
        {
            "name": "proof_platform_status",
            "description": "Read the durable project TODO hierarchy and current execution task states.",
            "inputSchema": {"type": "object", "additionalProperties": False},
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
        {
            "name": "proof_platform_messages",
            "description": "Read replies and decisions recorded by the Proof Platform orchestrator.",
            "inputSchema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "messageId": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                },
            },
            "annotations": {
                "readOnlyHint": True,
                "destructiveHint": False,
                "idempotentHint": True,
                "openWorldHint": False,
            },
        },
    ]


def call_tool(root: Path, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _config, state = _open_state(root)
    try:
        if name == "proof_platform_submit_intent":
            message = arguments.get("message")
            if not isinstance(message, str) or not message.strip():
                raise AgentCtlError("message must be a non-empty string")
            message_id = state.create_message(message)
            return {
                "messageId": message_id,
                "status": "pending",
                "next": "Use proof_platform_messages with this messageId to read the reply.",
            }
        if name == "proof_platform_status":
            return {
                "todo": _todo_summary(state.todo_tree()),
                "tasks": [_task_summary(state, task) for task in state.list_tasks()],
            }
        if name == "proof_platform_messages":
            message_id = arguments.get("messageId")
            limit = arguments.get("limit", 20)
            if message_id is not None and not isinstance(message_id, str):
                raise AgentCtlError("messageId must be a string")
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
                raise AgentCtlError("limit must be an integer from 1 to 100")
            messages = state.list_messages()
            if message_id:
                messages = [message for message in messages if message["id"] == message_id]
                if not messages:
                    raise AgentCtlError(f"unknown message: {message_id}")
            return {"messages": messages[-limit:]}
        raise AgentCtlError(f"unknown MCP tool: {name}")
    finally:
        state.close()


def _success(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": code, "message": message},
    }


def handle(root: Path, request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    if method == "notifications/initialized":
        return None
    if method == "initialize":
        requested = request.get("params", {}).get("protocolVersion")
        protocol = requested if isinstance(requested, str) else PROTOCOL_VERSION
        return _success(
            request_id,
            {
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "proof-platform-orchestrator", "version": "1.0.0"},
            },
        )
    if method == "ping":
        return _success(request_id, {})
    if method == "tools/list":
        return _success(request_id, {"tools": tools()})
    if method == "tools/call":
        params = request.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("name"), str):
            return _error(request_id, -32602, "tools/call requires a tool name")
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            return _error(request_id, -32602, "tool arguments must be an object")
        try:
            value = call_tool(root, params["name"], arguments)
        except (AgentCtlError, OSError, json.JSONDecodeError) as exc:
            return _success(
                request_id,
                {
                    "content": [{"type": "text", "text": str(exc)}],
                    "isError": True,
                },
            )
        return _success(
            request_id,
            {
                "content": [
                    {"type": "text", "text": json.dumps(value, ensure_ascii=False)}
                ],
                "structuredContent": value,
                "isError": False,
            },
        )
    if request_id is None:
        return None
    return _error(request_id, -32601, f"method not found: {method}")


def serve(root: Path) -> int:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            response = handle(root, request)
        except (json.JSONDecodeError, ValueError) as exc:
            response = _error(None, -32700, str(exc))
        if response is not None:
            print(json.dumps(response, separators=(",", ":")), flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    args = parser.parse_args(argv)
    return serve(args.root.resolve())


if __name__ == "__main__":
    raise SystemExit(main())
