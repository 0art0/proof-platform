import {
  createProofNodeSchema,
  protocolCommandResponseSchema,
  semanticReplayReportSchema,
  type OperatorDeclaration,
  type ProofNode,
  type ProtocolCommandEnvelope,
  type ProtocolCommandResponse,
  type SemanticReplayReport,
} from "@proof/protocol";
import { z } from "zod";
import { protocolCommandApiResponseSchema, storedProofSessionSchema } from "./api-contract";

export type ProtocolCommandFailure = Readonly<{
  ok: false;
  /** The HTTP status, or 0 when the service could not be reached. */
  status: number;
  code: string;
  message: string;
  /** The report of a replay whose step failed; nothing was written. */
  replayReport?: SemanticReplayReport;
}>;

export type ProtocolCommandOutcome =
  Readonly<{ ok: true; response: ProtocolCommandResponse }> | ProtocolCommandFailure;

/**
 * Send one N25 command envelope through the web proxy. Every structured failure comes back as a
 * readable code and message; nothing is dropped silently.
 */
export async function postProtocolCommand(
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
): Promise<ProtocolCommandOutcome> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/protocol-commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        cache: "no-store",
      },
    );
    body = await response.json();
  } catch {
    return {
      ok: false,
      status: 0,
      code: "unavailable",
      message: "The proof service could not be reached.",
    };
  }
  const parsed = protocolCommandApiResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.ok !== response.ok) return invalidResponse(response.status);
  if (!parsed.data.ok) {
    const replay = replayFailureSchema.safeParse(parsed.data.details);
    return {
      ok: false,
      status: response.status,
      code: parsed.data.error.code,
      message: parsed.data.error.message || "The command was refused without a reason.",
      ...(replay.success ? { replayReport: replay.data.report } : {}),
    };
  }
  const committed = protocolCommandResponseSchema.safeParse(parsed.data.data);
  if (!committed.success || committed.data.commandId !== envelope.commandId) {
    return invalidResponse(response.status);
  }
  return { ok: true, response: committed.data };
}

const replayFailureSchema = z
  .object({ status: z.literal("replay-failed"), report: semanticReplayReportSchema })
  .loose();

function invalidResponse(status: number): ProtocolCommandFailure {
  return {
    ok: false,
    status,
    code: "invalid_response",
    message: "The proof service returned an invalid response.",
  };
}

const currentSessionResponseSchema = z
  .object({
    ok: z.literal(true),
    data: z.object({ session: storedProofSessionSchema, node: z.unknown() }).strict(),
  })
  .strict();

export type CurrentSession = Readonly<{
  session: z.infer<typeof storedProofSessionSchema>;
  node: ProofNode;
}>;

/** Read the session's current node after a command moved the cursor. */
export async function readCurrentSession(
  sessionId: string,
): Promise<Readonly<{ ok: true; value: CurrentSession }> | Readonly<{ ok: false }>> {
  try {
    const response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}`, {
      cache: "no-store",
    });
    const parsed = currentSessionResponseSchema.safeParse(await response.json());
    if (!response.ok || !parsed.success) return { ok: false };
    const operators: readonly OperatorDeclaration[] = parsed.data.data.session.operators;
    const node = createProofNodeSchema({ operators }).safeParse(parsed.data.data.node);
    if (!node.success || node.data.id !== parsed.data.data.session.currentNodeId) {
      return { ok: false };
    }
    return { ok: true, value: { session: parsed.data.data.session, node: node.data } };
  } catch {
    return { ok: false };
  }
}

/** A readable sentence for a refused command, naming what to do next where that is known. */
export function describeCommandFailure(action: string, failure: ProtocolCommandFailure): string {
  const hint =
    failure.status === 409
      ? " The session changed since this view was loaded; reload the workspace and try again."
      : failure.status === 0 || failure.status >= 500
        ? " Try again once the proof service is available."
        : "";
  return `${action} rejected (${failure.code}): ${failure.message}${hint}`;
}
