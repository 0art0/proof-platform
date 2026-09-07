import { z } from "zod";

const jsonRpcErrorSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.literal(1).nullable(),
    error: z
      .object({
        code: z.number().int(),
        message: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const textContentSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

const jsonRpcSuccessSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.literal(1),
    result: z
      .object({
        content: z.array(textContentSchema),
        structuredContent: z.unknown().optional(),
        isError: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type OrchestratorGatewayErrorCode =
  "gateway_unavailable" | "gateway_timeout" | "invalid_gateway_response" | "orchestrator_error";

export class OrchestratorGatewayError extends Error {
  readonly code: OrchestratorGatewayErrorCode;

  constructor(code: OrchestratorGatewayErrorCode, message: string) {
    super(message);
    this.name = "OrchestratorGatewayError";
    this.code = code;
  }
}

function protocolError(message: string): OrchestratorGatewayError {
  return new OrchestratorGatewayError("invalid_gateway_response", message);
}

export function parseMcpToolResponse<T>(output: string, valueSchema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output.trim());
  } catch {
    throw protocolError("The local orchestrator returned malformed JSON.");
  }

  const rpcError = jsonRpcErrorSchema.safeParse(decoded);
  if (rpcError.success) {
    throw new OrchestratorGatewayError("orchestrator_error", rpcError.data.error.message);
  }

  const response = jsonRpcSuccessSchema.safeParse(decoded);
  if (!response.success) {
    throw protocolError("The local orchestrator returned an invalid response envelope.");
  }

  if (response.data.result.isError) {
    const message = response.data.result.content.find((item) => item.text.trim())?.text;
    throw new OrchestratorGatewayError(
      "orchestrator_error",
      message ?? "The local orchestrator rejected the request.",
    );
  }

  if (response.data.result.structuredContent === undefined) {
    throw protocolError("The local orchestrator response did not contain structured data.");
  }

  const value = valueSchema.safeParse(response.data.result.structuredContent);
  if (!value.success) {
    throw protocolError("The local orchestrator returned data in an unexpected shape.");
  }
  return value.data;
}
