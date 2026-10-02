import { protocolCommandEnvelopeSchema, type ProtocolCommandEnvelope } from "@proof/protocol";
import { WEB_ACTOR } from "../stored-proof-workspace/toolbar-actions";
import {
  apiResponse,
  lemmaCandidatesSchema,
  type LemmaCandidates,
  type LemmaTarget,
} from "./api-contract";

export type Outcome<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; status: number; code: string; message: string }>;

export type LemmaReviewDecision = "approved" | "rejected";

/** Save a closed step as a draft lemma. The worker derives the statement and its renderings. */
export function extractLemmaEnvelope(
  commandId: string,
  nodeId: string,
  target: LemmaTarget,
): ProtocolCommandEnvelope {
  return protocolCommandEnvelopeSchema.parse({
    commandId,
    actor: WEB_ACTOR,
    command: { kind: "extract-conditional-lemma", nodeId, target },
  });
}

/** Decide a saved lemma draft; the acting human is the reviewer. */
export function reviewLemmaEnvelope(
  commandId: string,
  draftArtifactId: string,
  decision: LemmaReviewDecision,
  notes: string,
): ProtocolCommandEnvelope {
  return protocolCommandEnvelopeSchema.parse({
    commandId,
    actor: WEB_ACTOR,
    command: { kind: "review-conditional-lemma", draftArtifactId, decision, notes },
  });
}

const UNAVAILABLE = {
  ok: false,
  status: 0,
  code: "unavailable",
  message: "The proof service could not be reached.",
} as const;

const INVALID = {
  ok: false,
  status: 502,
  code: "invalid_response",
  message: "The proof service returned an invalid response.",
} as const;

/** The steps of the session that could become lemmas, each with its preview or reason. */
export async function fetchLemmaCandidates(
  sessionId: string,
  signal?: AbortSignal,
): Promise<Outcome<LemmaCandidates>> {
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/conditional-lemmas`,
      { cache: "no-store", ...(signal === undefined ? {} : { signal }) },
    );
    const parsed = apiResponse(lemmaCandidatesSchema).safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return INVALID;
    return parsed.data.ok
      ? { ok: true, value: parsed.data.data }
      : { ok: false, status: response.status, ...parsed.data.error };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, status: 0, code: "aborted", message: "The request was cancelled." };
    }
    return UNAVAILABLE;
  }
}

/** A fresh command ID; a retry of the same action reuses it so the worker replays. */
export function newLemmaCommandId(kind: "save" | "review"): string {
  return `command:lemma-${kind}-${crypto.randomUUID()}`;
}
