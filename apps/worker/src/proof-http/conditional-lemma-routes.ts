/**
 * Conditional-lemma route (roadmap N44). Saving a lemma and reviewing it are envelope commands
 * (`extract-conditional-lemma`, `review-conditional-lemma`); this route only reads:
 *
 * - `GET /proof-sessions/:id/conditional-lemmas`: every step (a node and a target an edge acted
 *   on) with its preview, or the reason it cannot be saved yet.
 * - `POST /proof-sessions/:id/conditional-lemmas/preview` `{ nodeId, target: { kind, id } }`: the
 *   lemma that saving a closed target would create (rendered server-side, with the hypotheses it
 *   keeps and drops), or the reason it cannot be saved. Nothing is recorded; it also answers for
 *   read-only sessions, whose saving is refused by the write path.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { stableIdentifierSchema } from "@proof/mathjson-model";
import { proofNodeIdSchema } from "@proof/protocol";
import { z } from "zod";
import { listConditionalLemmaCandidates, previewConditionalLemma } from "../conditional-lemmas";
import { listLibrary } from "../library-repository";
import { loadProofHistory, proofSessionIdSchema } from "../proof-repository";
import { pathSegments, readJsonBody, writeJson } from "./http-util";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const MAX_BODY_BYTES = 16 * 1024;

const previewRequestSchema = z
  .object({
    nodeId: proofNodeIdSchema,
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema }).strict(),
  })
  .strict();

/** Handle the conditional-lemma route; false when the request is for another route. */
export async function handleConditionalLemmaRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const segments = pathSegments(request.url);
  if (
    segments === undefined ||
    segments[0] !== "proof-sessions" ||
    segments[2] !== "conditional-lemmas"
  ) {
    return false;
  }
  const list = segments.length === 3;
  if (!list && !(segments.length === 4 && segments[3] === "preview")) return false;
  const sessionId = proofSessionIdSchema.safeParse(segments[1]);
  if (!sessionId.success) return false;
  const expected = list ? "GET" : "POST";
  if (request.method !== expected) {
    response.setHeader("allow", expected);
    writeJson(response, 405, {
      diagnostics: [{ code: "method-not-allowed", message: `Use ${expected}.` }],
    });
    return true;
  }
  if (list) {
    await handleList(context, response, sessionId.data);
    return true;
  }
  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) {
    writeJson(response, body.status, {
      diagnostics: [{ code: "invalid-request", message: body.message }],
    });
    return true;
  }
  const parsed = previewRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    writeJson(response, 400, {
      diagnostics: [{ code: "invalid-request", message: "Send { nodeId, target }." }],
    });
    return true;
  }
  const history = await loadProofHistory(context.store, sessionId.data);
  if (history.status !== "loaded") {
    writeJson(response, repositoryFailureStatus(history), { diagnostics: history.diagnostics });
    return true;
  }
  const derived = await derivedArtifacts(context, sessionId.data);
  if (!("artifacts" in derived)) {
    writeJson(response, repositoryFailureStatus(derived), { diagnostics: derived.diagnostics });
    return true;
  }
  const preview = previewConditionalLemma(
    {
      session: history.session,
      nodes: history.nodes,
      edges: history.edges.map(({ edge }) => edge),
      nodeId: parsed.data.nodeId,
      target: parsed.data.target,
    },
    derived.artifacts,
  );
  writeJson(response, 200, { sessionId: sessionId.data, preview });
  return true;
}

async function derivedArtifacts(
  context: ServiceContext,
  sessionId: string,
): Promise<Readonly<{ artifacts: Parameters<typeof previewConditionalLemma>[1] }> | Failed> {
  if (context.library === undefined) return { artifacts: [] };
  const listed = await listLibrary(context.library, { sessionId, layers: ["derived"] });
  return listed.status === "found" ? { artifacts: listed.artifacts } : listed;
}

type Failed = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [{ code: string; message: string }];
}>;

/** `GET /proof-sessions/:id/conditional-lemmas`: every step that could be saved, or why not. */
async function handleList(
  context: ServiceContext,
  response: ServerResponse,
  sessionId: string,
): Promise<void> {
  const history = await loadProofHistory(context.store, sessionId);
  if (history.status !== "loaded") {
    writeJson(response, repositoryFailureStatus(history), { diagnostics: history.diagnostics });
    return;
  }
  const derived = await derivedArtifacts(context, sessionId);
  if (!("artifacts" in derived)) {
    writeJson(response, repositoryFailureStatus(derived), { diagnostics: derived.diagnostics });
    return;
  }
  writeJson(response, 200, {
    sessionId,
    readOnly: history.session.readOnly === true,
    candidates: listConditionalLemmaCandidates(
      {
        session: history.session,
        nodes: history.nodes,
        edges: history.edges.map(({ edge }) => edge),
      },
      derived.artifacts,
    ),
  });
}
