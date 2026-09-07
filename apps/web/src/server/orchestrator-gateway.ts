import "server-only";

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { z } from "zod";
import {
  mcpMessagesResponseSchema,
  statusResponseSchema,
  submitIntentResponseSchema,
} from "../lib/orchestrator-contract";
import { OrchestratorGatewayError, parseMcpToolResponse } from "./orchestrator-protocol";

const REPOSITORY_ROOT = resolve(process.cwd(), "../..");
const GATEWAY_ENTRYPOINT = resolve(REPOSITORY_ROOT, "scripts/agentctl-mcp");
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_048_576;

type ToolName =
  "proof_platform_status" | "proof_platform_messages" | "proof_platform_submit_intent";

function gatewayEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: "C.UTF-8",
    NODE_ENV: process.env.NODE_ENV,
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

function invokeGateway<T>(
  name: ToolName,
  arguments_: object,
  valueSchema: z.ZodType<T>,
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(GATEWAY_ENTRYPOINT, [], {
      cwd: REPOSITORY_ROOT,
      env: gatewayEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;

    const finishWithError = (error: OrchestratorGatewayError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(
        new OrchestratorGatewayError(
          "gateway_timeout",
          "The local orchestrator did not respond in time.",
        ),
      );
    }, REQUEST_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES) {
        child.kill();
        finishWithError(
          new OrchestratorGatewayError(
            "invalid_gateway_response",
            "The local orchestrator response exceeded the size limit.",
          ),
        );
      }
    });
    child.stderr.resume();

    child.on("error", () => {
      finishWithError(
        new OrchestratorGatewayError(
          "gateway_unavailable",
          "The local orchestrator gateway could not be started.",
        ),
      );
    });
    child.stdin.on("error", () => {
      finishWithError(
        new OrchestratorGatewayError(
          "gateway_unavailable",
          "The local orchestrator gateway closed before receiving the request.",
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finishWithError(
          new OrchestratorGatewayError(
            "gateway_unavailable",
            "The local orchestrator gateway exited before responding.",
          ),
        );
        return;
      }

      try {
        const value = parseMcpToolResponse(output, valueSchema);
        settled = true;
        clearTimeout(timeout);
        resolvePromise(value);
      } catch (error) {
        finishWithError(
          error instanceof OrchestratorGatewayError
            ? error
            : new OrchestratorGatewayError(
                "invalid_gateway_response",
                "The local orchestrator response could not be read.",
              ),
        );
      }
    });

    child.stdin.end(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: arguments_ },
      })}\n`,
    );
  });
}

export function readOrchestratorStatus() {
  return invokeGateway("proof_platform_status", {}, statusResponseSchema);
}

export function readOrchestratorMessages(options: { messageId?: string; limit: number }) {
  return invokeGateway("proof_platform_messages", options, mcpMessagesResponseSchema);
}

export function submitOrchestratorIntent(message: string) {
  return invokeGateway("proof_platform_submit_intent", { message }, submitIntentResponseSchema);
}
