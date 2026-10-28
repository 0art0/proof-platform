/**
 * The browser's requests to the same-origin proof API. Each one validates the answer at runtime
 * and resolves to a result value instead of throwing, so the workspace decides what to show.
 */

import {
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  type MovePreview,
  type OperatorDeclaration,
  type ProofEdge,
  type ProofNode,
} from "@proof/protocol";
import { explainMacroFailure } from "../macro-labels";
import {
  backtrackApiResponseSchema,
  commandApiResponseSchema,
  movePreviewApiResponseSchema,
  proofHistoryApiResponseSchema,
  suggestionApiResponseSchema,
  type MoveChoiceRequest,
} from "./api-contract";

export async function requestSuggestions(sessionId: string, request: unknown, signal: AbortSignal) {
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/suggestion-sets`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        cache: "no-store",
        signal,
      },
    );
    const parsed = suggestionApiResponseSchema.safeParse(await response.json());
    return !parsed.success || parsed.data.ok !== response.ok
      ? invalidBrowserResponse()
      : parsed.data;
  } catch (error) {
    return {
      ok: false as const,
      error: {
        code:
          error instanceof DOMException && error.name === "AbortError" ? "aborted" : "unavailable",
        message: "The suggestion service could not be reached.",
      },
    };
  }
}

export async function requestMovePreview(
  sessionId: string,
  choice: MoveChoiceRequest,
  operators: readonly OperatorDeclaration[],
): Promise<{ ok: true; preview: MovePreview } | ActionFailure> {
  try {
    const response = await postChoice(sessionId, "move-previews", choice);
    const parsed = movePreviewApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) {
      return {
        ok: false,
        code: parsed.data.error.code,
        message: explainMacroFailure(parsed.data.error.code, parsed.data.error.message),
      };
    }
    const preview = createMovePreviewSchema({ operators }).safeParse(parsed.data.data.preview);
    return preview.success ? { ok: true, preview: preview.data } : invalidActionResponse();
  } catch {
    return { ok: false, message: "The preview service could not be reached." };
  }
}

export async function requestApply(sessionId: string, choice: MoveChoiceRequest) {
  try {
    const response = await postChoice(sessionId, "commands", choice);
    const parsed = commandApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) {
      return {
        ok: false as const,
        code: parsed.data.error.code,
        message: explainMacroFailure(parsed.data.error.code, parsed.data.error.message),
      };
    }
    // A step that applied a library result may have added constants to the proof: the node is
    // read in the operators the answer's session states, which include them.
    const node = createProofNodeSchema({
      operators: parsed.data.data.session.operators,
    }).safeParse(parsed.data.data.node);
    if (!node.success || parsed.data.data.session.currentNodeId !== node.data.id)
      return invalidActionResponse();
    return {
      ok: true as const,
      session: parsed.data.data.session,
      node: node.data,
      receipt: parsed.data.data.receipt,
    };
  } catch {
    return { ok: false as const, message: "The command service could not be reached." };
  }
}

export async function requestHistory(sessionId: string) {
  try {
    const response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/history`, {
      cache: "no-store",
    });
    const parsed = proofHistoryApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) return { ok: false as const, message: parsed.data.error.message };
    // The history is read in the operators its session states: later nodes may use constants
    // that steps added.
    const stated = parsed.data.data.session.operators;
    const nodes = parsed.data.data.nodes.map((value) =>
      createProofNodeSchema({ operators: stated }).safeParse(value),
    );
    const edges = parsed.data.data.edges.map(({ edge, name }) => ({
      name,
      parsed: createProofEdgeSchema({ operators: stated }).safeParse(edge),
    }));
    if (nodes.some((value) => !value.success) || edges.some(({ parsed }) => !parsed.success))
      return invalidActionResponse();
    return {
      ok: true as const,
      nodes: nodes.map((value) => value.data as ProofNode),
      edges: edges.map(({ name, parsed }) => ({ name, edge: parsed.data as ProofEdge })),
    };
  } catch {
    return { ok: false as const, message: "The proof history could not be reached." };
  }
}

export async function requestBacktrack(
  sessionId: string,
  request: Readonly<{ expectedCurrentNodeId: string; targetNodeId: string }>,
) {
  try {
    const response = await fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/backtrack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      cache: "no-store",
    });
    const parsed = backtrackApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidActionResponse();
    if (!parsed.data.ok) return { ok: false as const, message: parsed.data.error.message };
    const node = createProofNodeSchema({
      operators: parsed.data.data.session.operators,
    }).safeParse(parsed.data.data.node);
    if (!node.success || parsed.data.data.session.currentNodeId !== node.data.id)
      return invalidActionResponse();
    return { ok: true as const, session: parsed.data.data.session, node: node.data };
  } catch {
    return { ok: false as const, message: "The backtrack service could not be reached." };
  }
}

function postChoice(
  sessionId: string,
  resource: string,
  choice: MoveChoiceRequest,
): Promise<Response> {
  return fetch(`/api/proof-sessions/${encodeURIComponent(sessionId)}/${resource}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(choice),
    cache: "no-store",
  });
}

type ActionFailure = { ok: false; message: string; code?: string };
function invalidBrowserResponse() {
  return {
    ok: false as const,
    error: {
      code: "invalid_response",
      message: "The suggestion service returned an invalid response.",
    },
  };
}
function invalidActionResponse(): ActionFailure {
  return { ok: false, message: "The proof service returned an invalid response." };
}
