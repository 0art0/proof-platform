from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any, Sequence

from . import __version__
from .config import Config
from .gitops import ensure_repository, root_git
from .integrate import integrate_task
from .scheduler import daemon
from .scope import validate_proposed_scopes
from .state import State, TASK_TRANSITIONS, TODO_ROOT_ID, TODO_STATUSES
from .tmux import attach, has_session, list_sessions, start_session, stop_session
from .util import AgentCtlError, json_dumps, run, utc_now
from .verify import parse_command


IDIOTS_GUIDE = """\
Idiot's guide:
  First run:
    1. ./scripts/agentctl doctor       Check Git, tmux, Codex, Node, and pnpm.
    2. ./scripts/agentctl init         Create the local task database (once).
    3. ./scripts/agentctl start        Start the supervisor in the background.

  Get work done:
    4. ./scripts/agentctl ask "Describe the change you want"
    5. ./scripts/agentctl messages     Read Sol's reply and created task IDs.
    6. ./scripts/agentctl status       Watch delegated workers and reviews.
    7. ./scripts/agentctl approve TASK_ID
    8. ./scripts/agentctl integrate TASK_ID

  If something goes wrong:
    ./scripts/agentctl logs TASK_ID    Show the latest worker or reviewer log.
    ./scripts/agentctl retry TASK_ID   Retry a failed or paused task.
    ./scripts/agentctl stop            Stop the supervisor.

Approval and integration are deliberately separate. Nothing is pushed remotely.
"""


def _state(config: Config) -> State:
    config.ensure_runtime_directories()
    state = State(config.database_path)
    state.migrate()
    state.ensure_todo_root(config.project_name)
    return state


def command_doctor(config: Config, _args: argparse.Namespace) -> int:
    checks: list[tuple[str, bool, str]] = []
    for command in ("git", "tmux", "python3", config.codex_command):
        path = shutil.which(command)
        checks.append((command, path is not None, path or "not found"))
    git_check = root_git(config.root, ["rev-parse", "--is-inside-work-tree"], check=False)
    checks.append(("git repository", git_check.returncode == 0, git_check.stderr.strip() or git_check.stdout.strip()))
    head_check = root_git(config.root, ["rev-parse", "--verify", "HEAD"], check=False)
    checks.append(("initial commit", head_check.returncode == 0, head_check.stdout.strip() or "missing"))
    node_check = run([str(config.root / "scripts" / "nodew"), "--version"], cwd=config.root, check=False)
    checks.append(("Node.js 24", node_check.returncode == 0, (node_check.stdout + node_check.stderr).strip()))
    pnpm_check = run([str(config.root / "scripts" / "pnpmw"), "--version"], cwd=config.root, check=False)
    checks.append(("pnpm", pnpm_check.returncode == 0, (pnpm_check.stdout + pnpm_check.stderr).strip()))
    if config.database_path.exists():
        state = State(config.database_path)
        try:
            state.migrate()
            integrity = state.integrity_check()
            checks.append(("SQLite state", integrity == "ok", integrity))
        finally:
            state.close()
    else:
        checks.append(("SQLite state", True, "not initialized"))
    width = max(len(label) for label, _, _ in checks)
    for label, ok, detail in checks:
        print(f"{'ok' if ok else 'FAIL':4}  {label:<{width}}  {detail}")
    return 0 if all(ok for _, ok, _ in checks) else 1


def command_init(config: Config, _args: argparse.Namespace) -> int:
    ensure_repository(config.root)
    config.ensure_runtime_directories()
    state = State(config.database_path)
    try:
        state.migrate()
        state.ensure_todo_root(config.project_name)
        if state.integrity_check() != "ok":
            raise AgentCtlError("SQLite integrity check failed after initialization")
        backup = config.state_dir / "backups" / f"state-initial-{utc_now().replace(':', '-')}.sqlite3"
        state.backup(backup)
    finally:
        state.close()
    print(f"initialized autonomous workflow state at {config.database_path}")
    return 0


def command_start(config: Config, _args: argparse.Namespace) -> int:
    ensure_repository(config.root)
    state = _state(config)
    state.close()
    name = f"{config.tmux_prefix}-orchestrator"
    if has_session(config, name):
        print(f"orchestrator already running in tmux session {name}")
        return 0
    start_session(
        config,
        name,
        [str(config.root / "scripts" / "orchestrator-supervise")],
        cwd=config.root,
    )
    print(f"started orchestrator in tmux session {name}")
    return 0


def command_stop(config: Config, _args: argparse.Namespace) -> int:
    name = f"{config.tmux_prefix}-orchestrator"
    if has_session(config, name):
        stop_session(config, name)
        print(f"stopped {name}; task workers were left intact")
    else:
        print("orchestrator is not running")
    return 0


def command_attach(config: Config, _args: argparse.Namespace) -> int:
    name = f"{config.tmux_prefix}-orchestrator"
    if not has_session(config, name):
        raise AgentCtlError("orchestrator tmux session is not running")
    return attach(config, name)


def _remote_session_name(config: Config) -> str:
    return f"{config.tmux_prefix}-remote-orchestrator"


def command_remote_start(config: Config, _args: argparse.Namespace) -> int:
    ensure_repository(config.root)
    state = _state(config)
    state.close()
    name = _remote_session_name(config)
    if not has_session(config, name):
        start_session(
            config,
            name,
            [str(config.root / "scripts" / "orchestrator-remote")],
            cwd=config.root,
        )
        print(f"started read-only remote orchestrator session {name}")
    else:
        print(f"remote orchestrator session already running: {name}")
    relay = run(
        [config.codex_command, "remote-control", "start", "--json"],
        cwd=config.root,
        check=False,
        timeout=30,
    )
    output = (relay.stdout or relay.stderr).strip()
    if relay.returncode != 0:
        print(f"remote relay is not connected: {output}", file=sys.stderr)
        return 1
    try:
        relay_state = json.loads(output)
    except json.JSONDecodeError:
        relay_state = {}
    connected = (
        isinstance(relay_state, dict)
        and relay_state.get("status") in {"connected", "ready"}
        and not relay_state.get("timedOut", False)
    )
    if not connected:
        print(f"remote relay is enabled but not connected: {output}", file=sys.stderr)
        return 1
    print(output)
    return 0


def command_remote_status(config: Config, _args: argparse.Namespace) -> int:
    name = _remote_session_name(config)
    session = "running" if has_session(config, name) else "stopped"
    daemon_status = run(
        [config.codex_command, "app-server", "daemon", "version"],
        cwd=config.root,
        check=False,
        timeout=10,
    )
    print(f"remote orchestrator session: {session} ({name})")
    print((daemon_status.stdout or daemon_status.stderr).strip() or "app-server unavailable")
    return 0 if session == "running" and daemon_status.returncode == 0 else 1


def command_remote_pair(config: Config, _args: argparse.Namespace) -> int:
    result = run(
        [config.codex_command, "remote-control", "pair", "--json"],
        cwd=config.root,
        check=False,
        timeout=30,
    )
    output = (result.stdout or result.stderr).strip()
    print(output)
    return result.returncode


def command_remote_stop(config: Config, _args: argparse.Namespace) -> int:
    name = _remote_session_name(config)
    if has_session(config, name):
        stop_session(config, name)
        print(f"stopped repository remote session {name}")
    else:
        print("repository remote orchestrator session is not running")
    print("host Remote Control was left enabled because it may serve other Codex sessions")
    return 0


def command_remote_attach(config: Config, _args: argparse.Namespace) -> int:
    name = _remote_session_name(config)
    if not has_session(config, name):
        raise AgentCtlError("remote orchestrator session is not running")
    return attach(config, name)


def command_daemon(config: Config, args: argparse.Namespace) -> int:
    ensure_repository(config.root)
    return daemon(config, once=args.once)


def command_ask(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        message_id = state.create_message(args.message)
    finally:
        state.close()
    print(message_id)
    return 0


def command_messages(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        messages = state.list_messages()
    finally:
        state.close()
    if args.json:
        print(json.dumps(messages, indent=2, ensure_ascii=False))
        return 0
    if not messages:
        print("no orchestrator messages")
        return 0
    for message in messages:
        print(f"{message['id']}  {message['status']}  {message['created_at']}")
        print(f"  user: {message['content']}")
        if message.get("reply"):
            print(f"  orchestrator: {message['reply']}")
        if message.get("last_error"):
            print(f"  error: {message['last_error']}")
    return 0


def command_task_add(config: Config, args: argparse.Namespace) -> int:
    prompt = args.prompt
    if args.prompt_file:
        prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    if not prompt:
        raise AgentCtlError("provide --prompt or --prompt-file")
    scopes = validate_proposed_scopes(args.write, config.protected_paths)
    if not args.check:
        raise AgentCtlError("at least one --check is required")
    for command in args.check:
        parse_command(command)
    state = _state(config)
    try:
        for dependency in args.depends:
            state.get_task(dependency)
        task_id = state.create_task(
            title=args.title,
            prompt=prompt,
            scopes=scopes,
            checks=args.check,
            base_branch=config.base_branch,
            max_attempts=config.max_task_attempts,
            dependencies=args.depends,
            priority=args.priority,
            capabilities=args.capability,
            todo_parent_id=args.todo_parent,
        )
    finally:
        state.close()
    print(task_id)
    return 0


def _todo_lines(
    node: dict[str, Any], prefix: str = "", last: bool = True, root: bool = True
) -> list[str]:
    connector = "" if root else ("└─ " if last else "├─ ")
    task = f" task={node['task_id']}" if node.get("task_id") else ""
    lines = [f"{prefix}{connector}[{node['status']}] {node['title']} ({node['id']}){task}"]
    children = node.get("children", [])
    child_prefix = prefix if root else prefix + ("   " if last else "│  ")
    for index, child in enumerate(children):
        lines.extend(
            _todo_lines(child, child_prefix, index == len(children) - 1, root=False)
        )
    return lines


def command_todo(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        tree = state.todo_tree()
    finally:
        state.close()
    if args.json:
        print(json.dumps(tree, indent=2, ensure_ascii=False))
    else:
        print("\n".join(_todo_lines(tree)))
    return 0


def command_todo_add(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        todo_id = state.create_todo(
            title=args.title,
            parent_id=args.parent,
            description=args.description,
            status=args.status,
            sort_order=args.order,
        )
    finally:
        state.close()
    print(todo_id)
    return 0


def command_todo_set(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        state.update_todo_status(args.todo_id, args.status)
    finally:
        state.close()
    print(f"set {args.todo_id} to {args.status}")
    return 0


def command_todo_show(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        todo = state.get_todo(args.todo_id)
    finally:
        state.close()
    print(json.dumps(todo, indent=2, ensure_ascii=False))
    return 0


def command_status(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        tasks = state.list_tasks()
    finally:
        state.close()
    if args.json:
        print(json.dumps(tasks, indent=2, ensure_ascii=False))
        return 0
    sessions = set(list_sessions(config))
    print(f"orchestrator: {'running' if f'{config.tmux_prefix}-orchestrator' in sessions else 'stopped'}")
    print(
        "remote orchestrator: "
        f"{'running' if _remote_session_name(config) in sessions else 'stopped'}"
    )
    if not tasks:
        print("no tasks")
        return 0
    for task in tasks:
        retry = f" wake={task['next_wake_at']:.0f}" if task.get("next_wake_at") else ""
        print(
            f"{task['id']:<40} {task['status']:<20} attempt={task['attempt']}"
            f" failures={task['failure_count']}/{task['max_attempts']}{retry}  {task['title']}"
        )
    return 0


def command_task_show(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        task = state.get_task(args.task_id)
        task["dependencies"] = state.dependencies(args.task_id)
        task["todo"] = state.todo_for_task(args.task_id)
        task["todoPath"] = state.todo_path_for_task(args.task_id)
        task["events"] = state.events(args.task_id, limit=args.events)
    finally:
        state.close()
    print(json.dumps(task, indent=2, ensure_ascii=False))
    return 0


def command_logs(config: Config, args: argparse.Namespace) -> int:
    matches = sorted((config.state_dir / "logs").glob(f"{args.task_id}-*"))
    if not matches:
        raise AgentCtlError(f"no logs found for {args.task_id}")
    selected = matches if args.all else matches[-1:]
    for path in selected:
        print(f"==> {path.name} <==")
        print(path.read_text(encoding="utf-8", errors="replace"), end="")
    return 0


def command_approve(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        state.transition(
            args.task_id,
            "ready_to_integrate",
            actor="user",
            expected="awaiting_approval",
            payload={"approval": "explicit CLI approval"},
        )
    finally:
        state.close()
    print(f"approved {args.task_id}; integration is still a separate action")
    return 0


def command_integrate(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        integrated = integrate_task(config, state, args.task_id)
    finally:
        state.close()
    print(f"integrated {args.task_id} at {integrated}")
    return 0


def command_retry(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    try:
        task = state.get_task(args.task_id)
        if "queued" not in TASK_TRANSITIONS[task["status"]]:
            raise AgentCtlError(f"task cannot be retried from {task['status']}")
        state.fence_task(args.task_id, actor="user", reason="manual retry")
        state.transition(
            args.task_id,
            "queued",
            actor="user",
            expected=task["status"],
            fields={"next_wake_at": None, "last_error": None},
            payload={"reason": "manual retry"},
        )
    finally:
        state.close()
    print(f"queued {args.task_id} for retry")
    return 0


def command_cancel(config: Config, args: argparse.Namespace) -> int:
    state = _state(config)
    session: str | None = None
    try:
        task = state.get_task(args.task_id)
        if "cancelled" not in TASK_TRANSITIONS[task["status"]]:
            raise AgentCtlError(f"task cannot be cancelled from {task['status']}")
        state.fence_task(args.task_id, actor="user", reason=args.reason)
        session = task.get("tmux_session")
        state.transition(
            args.task_id,
            "cancelled",
            actor="user",
            expected=task["status"],
            payload={"reason": args.reason},
        )
    finally:
        state.close()
    if session:
        stop_session(config, session)
    print(f"cancelled {args.task_id}; worktree and logs were retained")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agentctl",
        description="Proof Platform autonomous workflow",
        epilog=IDIOTS_GUIDE,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command")

    commands.add_parser("doctor").set_defaults(handler=command_doctor)
    commands.add_parser("init").set_defaults(handler=command_init)
    commands.add_parser("start").set_defaults(handler=command_start)
    commands.add_parser("stop").set_defaults(handler=command_stop)
    commands.add_parser("attach").set_defaults(handler=command_attach)

    remote_parser = commands.add_parser("remote")
    remote_commands = remote_parser.add_subparsers(dest="remote_command", required=True)
    for name, handler in (
        ("start", command_remote_start),
        ("status", command_remote_status),
        ("pair", command_remote_pair),
        ("stop", command_remote_stop),
        ("attach", command_remote_attach),
    ):
        remote_commands.add_parser(name).set_defaults(handler=handler)

    daemon_parser = commands.add_parser("daemon")
    daemon_parser.add_argument("--once", action="store_true")
    daemon_parser.set_defaults(handler=command_daemon)

    ask_parser = commands.add_parser("ask")
    ask_parser.add_argument("message")
    ask_parser.set_defaults(handler=command_ask)

    messages_parser = commands.add_parser("messages")
    messages_parser.add_argument("--json", action="store_true")
    messages_parser.set_defaults(handler=command_messages)

    task_parser = commands.add_parser("task")
    task_commands = task_parser.add_subparsers(dest="task_command", required=True)
    add_parser = task_commands.add_parser("add")
    add_parser.add_argument("--title", required=True)
    prompt_group = add_parser.add_mutually_exclusive_group(required=True)
    prompt_group.add_argument("--prompt")
    prompt_group.add_argument("--prompt-file")
    add_parser.add_argument("--write", action="append", required=True)
    add_parser.add_argument("--check", action="append", default=[])
    add_parser.add_argument("--depends", action="append", default=[])
    add_parser.add_argument("--capability", action="append", default=[])
    add_parser.add_argument("--priority", type=int, default=0)
    add_parser.add_argument("--todo-parent", default=TODO_ROOT_ID)
    add_parser.set_defaults(handler=command_task_add)
    show_parser = task_commands.add_parser("show")
    show_parser.add_argument("task_id")
    show_parser.add_argument("--events", type=int, default=100)
    show_parser.set_defaults(handler=command_task_show)

    todo_parser = commands.add_parser("todo")
    todo_parser.add_argument("--json", action="store_true")
    todo_parser.set_defaults(handler=command_todo)
    todo_commands = todo_parser.add_subparsers(dest="todo_command")
    todo_add = todo_commands.add_parser("add")
    todo_add.add_argument("--title", required=True)
    todo_add.add_argument("--parent", default=TODO_ROOT_ID)
    todo_add.add_argument("--description", default="")
    todo_add.add_argument("--status", choices=sorted(TODO_STATUSES), default="planned")
    todo_add.add_argument("--order", type=int, default=0)
    todo_add.set_defaults(handler=command_todo_add)
    todo_set = todo_commands.add_parser("set")
    todo_set.add_argument("todo_id")
    todo_set.add_argument("status", choices=sorted(TODO_STATUSES))
    todo_set.set_defaults(handler=command_todo_set)
    todo_show = todo_commands.add_parser("show")
    todo_show.add_argument("todo_id")
    todo_show.set_defaults(handler=command_todo_show)

    status_parser = commands.add_parser("status")
    status_parser.add_argument("--json", action="store_true")
    status_parser.set_defaults(handler=command_status)

    logs_parser = commands.add_parser("logs")
    logs_parser.add_argument("task_id")
    logs_parser.add_argument("--all", action="store_true")
    logs_parser.set_defaults(handler=command_logs)

    for name, handler in (("approve", command_approve), ("integrate", command_integrate), ("retry", command_retry)):
        action_parser = commands.add_parser(name)
        action_parser.add_argument("task_id")
        action_parser.set_defaults(handler=handler)
    cancel_parser = commands.add_parser("cancel")
    cancel_parser.add_argument("task_id")
    cancel_parser.add_argument("--reason", default="cancelled by user")
    cancel_parser.set_defaults(handler=command_cancel)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    arguments = parser.parse_args(argv)
    if arguments.command is None:
        parser.print_help()
        return 0
    try:
        config = Config.load(arguments.root)
        return int(arguments.handler(config, arguments))
    except (AgentCtlError, OSError, json.JSONDecodeError) as exc:
        print(f"agentctl: {exc}", file=sys.stderr)
        return 2
