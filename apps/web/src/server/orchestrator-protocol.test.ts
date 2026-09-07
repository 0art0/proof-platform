import { describe, expect, it } from "vitest";
import { mcpMessagesResponseSchema, statusResponseSchema } from "../lib/orchestrator-contract";
import { parseMcpToolResponse } from "./orchestrator-protocol";

function successEnvelope(value: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
      isError: false,
    },
  });
}

describe("orchestrator MCP envelope parsing", () => {
  it("accepts a valid status envelope and its recursive TODO tree", () => {
    const status = parseMcpToolResponse(
      successEnvelope({
        todo: {
          id: "project",
          title: "Proof Platform",
          status: "in_progress",
          taskId: null,
          children: [
            {
              id: "todo-1",
              title: "Interaction spike",
              status: "done",
              taskId: "task-1",
              children: [],
            },
          ],
        },
        tasks: [],
      }),
      statusResponseSchema,
    );

    expect(status.todo.children[0]?.title).toBe("Interaction spike");
  });

  it("converts durable message fields to the browser contract", () => {
    const result = parseMcpToolResponse(
      successEnvelope({
        messages: [
          {
            id: "msg-123456789abc",
            content: "Build the next slice",
            status: "completed",
            reply: "Created one bounded task.",
            thread_id: "thread-1",
            next_wake_at: null,
            last_error: null,
            created_at: "2026-09-07T08:00:00+00:00",
            updated_at: "2026-09-07T08:01:00+00:00",
          },
        ],
      }),
      mcpMessagesResponseSchema,
    );

    expect(result.messages[0]).toMatchObject({
      id: "msg-123456789abc",
      threadId: "thread-1",
      createdAt: "2026-09-07T08:00:00+00:00",
    });
  });

  it("surfaces a bounded MCP tool error", () => {
    const output = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [{ type: "text", text: "unknown message: msg-missing" }],
        isError: true,
      },
    });

    expect(() => parseMcpToolResponse(output, mcpMessagesResponseSchema)).toThrowError(
      expect.objectContaining({
        code: "orchestrator_error",
        message: "unknown message: msg-missing",
      }),
    );
  });

  it("surfaces a JSON-RPC error envelope", () => {
    const output = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "method not found" },
    });

    expect(() => parseMcpToolResponse(output, statusResponseSchema)).toThrowError(
      expect.objectContaining({
        code: "orchestrator_error",
        message: "method not found",
      }),
    );
  });

  it.each([
    ["not json", "malformed JSON"],
    [JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }), "invalid response envelope"],
    [successEnvelope({ todo: [], tasks: "wrong" }), "unexpected shape"],
  ])("rejects invalid gateway output", (output, expectedMessage) => {
    expect(() => parseMcpToolResponse(output, statusResponseSchema)).toThrow(expectedMessage);
  });
});
