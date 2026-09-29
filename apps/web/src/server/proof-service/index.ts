import "server-only";

import {
  createMovePreviewSchema,
  createProofEdgeSchema,
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  interactionEventSchema,
  moveRequiresInputResponseSchema,
  observeQuerySchema,
  observeResponseSchema,
  operatorDeclarationSchema,
  protocolCommandEnvelopeSchema,
  protocolCommandResponseSchema,
  protocolDiagnosticsResponseSchema,
  protocolRequiresInputResponseSchema,
  proofCommandReceiptSchema,
  previewRegeneratedResponseSchema,
  proofNodeIdSchema,
  recordInteractionEventRequestSchema,
  stableIdentifierSchema,
  suggestionSetIdSchema,
  type DisplayedSuggestionSet,
  type InteractionEvent,
  type MovePreview,
  type OperatorDeclaration,
  type ProofCommandReceipt,
  type ProofEdge,
  type ProofNode,
} from "@proof/protocol";
import {
  parseProofArtifact,
  proofArtifactImportResponseSchema,
  proofArtifactRejectionResponseSchema,
  type ProofArtifact,
} from "@proof/protocol";
import {
  problemApprovalRequestSchema,
  problemDraftValidationResponseSchema,
  problemSetupDiagnosticSchema,
  problemSetupOptionsSchema,
  proofSessionMetadataSchema,
  type ProblemSetupOptions,
  type ProofSessionMetadata,
} from "@proof/protocol";
import type { ResolvedProofSelection } from "@proof/selections";
import { z } from "zod";
import {
  backtrackRequestSchema,
  moveChoiceRequestSchema,
  suggestionTransitionClassSchema,
  suggestionRequestSchema,
  type MoveChoiceRequest,
  type ProofSelectionDescriptor,
  type SuggestionTransitionClass,
} from "../../features/stored-proof-workspace/api-contract";

const DEFAULT_PROOF_HTTP_ORIGIN = "http://127.0.0.1:8787";
const DEFAULT_PROOF_SESSION_ID = "session:development";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const repositoryDiagnosticCodeSchema = z.enum([
  "invalid-initial-session",
  "session-not-found",
  "invalid-session-record",
  "current-node-not-found",
  "invalid-current-node",
  "invalid-command-record",
  "invalid-suggestion-set-record",
  "suggestion-set-not-found",
  "suggestion-set-rejected",
  "invalid-preview-record",
  "preview-not-found",
  "preview-rejected",
  "command-rejected",
  "serialized-stale-command",
  "storage-failure",
  "commit-unknown",
  "invalid-edge-record",
  "invalid-proof-history",
  "backtrack-target-not-found",
  "backtrack-rejected",
  "serialized-stale-backtrack",
  "invalid-request",
  "not-found",
  "internal-error",
  "invalid-catalog",
  "interaction-event-rejected",
  "interaction-event-conflict",
  "invalid-interaction-event-record",
  "session-read-only",
]);

const proofServiceFailureSchema = z
  .object({
    diagnostics: z.tuple([
      z
        .object({
          code: repositoryDiagnosticCodeSchema,
          message: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict();

const proofSessionSchema = z
  .object({
    id: stableIdentifierSchema,
    rootNodeId: proofNodeIdSchema,
    currentNodeId: proofNodeIdSchema,
    operators: z.array(operatorDeclarationSchema),
  })
  .strict();

const currentSessionEnvelopeSchema = z
  .object({
    session: proofSessionSchema,
    node: z.unknown(),
  })
  .strict();

const recordedSuggestionEnvelopeSchema = z
  .object({
    suggestionSet: displayedSuggestionSetSchema,
    replayed: z.boolean(),
    transitionClasses: z.array(suggestionTransitionClassSchema),
  })
  .strict();

const storedSuggestionEnvelopeSchema = z
  .object({
    suggestionSet: displayedSuggestionSetSchema,
    transitionClasses: z.array(suggestionTransitionClassSchema),
  })
  .strict();

const movePreviewEnvelopeSchema = z
  .object({
    preview: z.unknown(),
    replayed: z.boolean(),
    regeneratedFrom: stableIdentifierSchema.optional(),
  })
  .strict();

const interactionEventEnvelopeSchema = z
  .object({ event: interactionEventSchema, replayed: z.boolean() })
  .strict();

const commandEnvelopeSchema = z
  .object({
    session: proofSessionSchema,
    node: z.unknown(),
    receipt: proofCommandReceiptSchema,
    replayed: z.boolean(),
  })
  .strict();

const proofHistoryEnvelopeSchema = z
  .object({
    session: proofSessionSchema,
    nodes: z.array(z.unknown()),
    edges: z.array(
      z
        .object({
          edge: z.unknown(),
          name: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const backtrackEnvelopeSchema = z
  .object({
    session: proofSessionSchema,
    node: z.unknown(),
    replayed: z.boolean(),
  })
  .strict();

export type ProofSession = z.infer<typeof proofSessionSchema>;

export type CurrentProofSession = Readonly<{
  session: ProofSession;
  node: ProofNode;
}>;

export type RecordedSuggestionSet = Readonly<{
  suggestionSet: DisplayedSuggestionSet;
  replayed: boolean;
  transitionClasses: readonly SuggestionTransitionClass[];
}>;

export type RecordedMovePreview = Readonly<{
  preview: MovePreview;
  replayed: boolean;
  /** The stale preview this one regenerated after the approved definitions changed. */
  regeneratedFrom?: string;
}>;

export type RecordedInteractionEvent = Readonly<{ event: InteractionEvent; replayed: boolean }>;

export type AppliedProofCommand = Readonly<{
  session: ProofSession;
  node: ProofNode;
  receipt: ProofCommandReceipt;
  replayed: boolean;
}>;

export type ProofHistory = Readonly<{
  session: ProofSession;
  nodes: readonly ProofNode[];
  edges: readonly ProofHistoryEdge[];
}>;

export type ProofHistoryEdge = Readonly<{ edge: ProofEdge; name: string }>;

export type BacktrackedProofSession = Readonly<{
  session: ProofSession;
  node: ProofNode;
  replayed: boolean;
}>;

export type ProofServiceErrorCode =
  | z.infer<typeof repositoryDiagnosticCodeSchema>
  | "invalid_request"
  | "requires-input"
  | "preview-regenerated"
  | "service_unavailable"
  | "invalid_upstream_response";

export class ProofServiceError extends Error {
  readonly code: ProofServiceErrorCode;
  readonly status: number;

  constructor(code: ProofServiceErrorCode, message: string, status: number) {
    super(message);
    this.name = "ProofServiceError";
    this.code = code;
    this.status = status;
  }
}

type ProofServiceRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Load the product session selected for the web workspace. */
export function readConfiguredProofSession(
  options: ProofServiceRequestOptions = {},
): Promise<CurrentProofSession> {
  return readCurrentProofSession(process.env.PROOF_SESSION_ID ?? DEFAULT_PROOF_SESSION_ID, options);
}

/** Read and revalidate the current persisted node using its stored operator environment. */
export async function readCurrentProofSession(
  sessionIdInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<CurrentProofSession> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const response = await requestProofService(`/proof-sessions/${encodeURIComponent(sessionId)}`, {
    method: "GET",
    ...signalOption(options.signal),
  });
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200) throw failureForResponse(response.status, value);

  const envelope = currentSessionEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw invalidUpstreamResponse();
  const { session } = envelope.data;
  const node = parseProofNode(envelope.data.node, session.operators);
  if (session.id !== sessionId || node === undefined || node.id !== session.currentNodeId) {
    throw invalidUpstreamResponse();
  }
  return { session, node };
}

/** Persist deterministic retrieval evidence; no suggestion is recomputed in the web app. */
export async function createStoredSuggestionSet(
  sessionIdInput: unknown,
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<RecordedSuggestionSet> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const request = suggestionRequestSchema.safeParse(requestInput);
  if (!request.success) {
    throw invalidRequest(
      "Only strict snapshot-anchored exact or associative selection descriptors are accepted.",
    );
  }

  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/suggestion-sets`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
      ...signalOption(options.signal),
    },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200 && response.status !== 201) {
    throw failureForResponse(response.status, value);
  }

  const envelope = recordedSuggestionEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw invalidUpstreamResponse();
  if (envelope.data.replayed !== (response.status === 200)) throw invalidUpstreamResponse();
  if (!suggestionSetMatchesRequest(envelope.data.suggestionSet, request.data)) {
    throw invalidUpstreamResponse();
  }
  if (!transitionClassesMatchSuggestionSet(envelope.data)) throw invalidUpstreamResponse();
  return envelope.data;
}

/** Read back the immutable suggestion evidence exactly as persisted by the worker. */
export async function readStoredSuggestionSet(
  sessionIdInput: unknown,
  suggestionSetIdInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<
  Readonly<{
    suggestionSet: DisplayedSuggestionSet;
    transitionClasses: readonly SuggestionTransitionClass[];
  }>
> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const suggestionSetId = suggestionSetIdSchema.safeParse(suggestionSetIdInput);
  if (!suggestionSetId.success) throw invalidRequest("The suggestion-set ID is invalid.");
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/suggestion-sets/${encodeURIComponent(
      suggestionSetId.data,
    )}`,
    { method: "GET", ...signalOption(options.signal) },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200) throw failureForResponse(response.status, value);

  const envelope = storedSuggestionEnvelopeSchema.safeParse(value);
  if (
    !envelope.success ||
    envelope.data.suggestionSet.id !== suggestionSetId.data ||
    !transitionClassesMatchSuggestionSet(envelope.data)
  ) {
    throw invalidUpstreamResponse();
  }
  return envelope.data;
}

/** Persist a kernel-validated preview for one exact displayed choice without advancing state. */
export async function createStoredMovePreview(
  sessionIdInput: unknown,
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<RecordedMovePreview> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const request = parseMoveChoiceRequest(requestInput);
  // Preview responses intentionally stay compact, so load the immutable operator environment
  // needed to validate custom MathJSON before accepting the preview snapshot.
  const current = await readCurrentProofSession(sessionId, options);
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/move-previews`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      ...signalOption(options.signal),
    },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200 && response.status !== 201) {
    throw failureForResponse(response.status, value);
  }

  const envelope = movePreviewEnvelopeSchema.safeParse(value);
  if (!envelope.success || envelope.data.replayed !== (response.status === 200)) {
    throw invalidUpstreamResponse();
  }
  const preview = parseMovePreview(envelope.data.preview, current.session.operators);
  if (
    preview === undefined ||
    preview.nodeId !== current.node.id ||
    preview.stateId !== current.node.state.id ||
    preview.suggestionSetId !== request.suggestionSetId ||
    preview.chosenSuggestionId !== request.chosenSuggestionId
  ) {
    throw invalidUpstreamResponse();
  }
  return {
    preview,
    replayed: envelope.data.replayed,
    ...(envelope.data.regeneratedFrom === undefined
      ? {}
      : { regeneratedFrom: envelope.data.regeneratedFrom }),
  };
}

/** Record one ordered, node-anchored interaction event; the worker assigns its sequence. */
export async function recordStoredInteractionEvent(
  sessionIdInput: unknown,
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<RecordedInteractionEvent> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const request = recordInteractionEventRequestSchema.safeParse(requestInput);
  if (!request.success) throw invalidRequest("The interaction event is invalid.");
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/interaction-events`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
      ...signalOption(options.signal),
    },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200 && response.status !== 201) {
    throw failureForResponse(response.status, value);
  }
  const envelope = interactionEventEnvelopeSchema.safeParse(value);
  if (
    !envelope.success ||
    envelope.data.replayed !== (response.status === 200) ||
    envelope.data.event.id !== request.data.id ||
    envelope.data.event.nodeId !== request.data.nodeId ||
    envelope.data.event.kind !== request.data.kind
  ) {
    throw invalidUpstreamResponse();
  }
  return envelope.data;
}

/** Execute one exact displayed choice through the worker's command service. */
export async function executeStoredProofCommand(
  sessionIdInput: unknown,
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<AppliedProofCommand> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const request = parseMoveChoiceRequest(requestInput);
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/commands`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      ...signalOption(options.signal),
    },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200 && response.status !== 201) {
    throw failureForResponse(response.status, value);
  }

  const envelope = commandEnvelopeSchema.safeParse(value);
  if (!envelope.success || envelope.data.replayed !== (response.status === 200)) {
    throw invalidUpstreamResponse();
  }
  const { session, receipt } = envelope.data;
  const node = parseProofNode(envelope.data.node, session.operators);
  if (
    session.id !== sessionId ||
    node === undefined ||
    session.currentNodeId !== node.id ||
    receipt.commandId !== request.commandId ||
    receipt.nodeId !== node.id ||
    receipt.resultStateId !== node.state.id
  ) {
    throw invalidUpstreamResponse();
  }
  return { session, node, receipt, replayed: envelope.data.replayed };
}

/** Read the retained, rooted proof-discovery tree without recomputing historical evidence. */
export async function readProofHistory(
  sessionIdInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProofHistory> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/history`,
    { method: "GET", ...signalOption(options.signal) },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200) throw failureForResponse(response.status, value);

  const envelope = proofHistoryEnvelopeSchema.safeParse(value);
  if (!envelope.success || envelope.data.session.id !== sessionId) {
    throw invalidUpstreamResponse();
  }
  const { session } = envelope.data;
  const nodes = envelope.data.nodes.map((input) => parseProofNode(input, session.operators));
  const edges = envelope.data.edges.map(({ edge, name }) => {
    const parsed = parseProofEdge(edge, session.operators);
    return parsed === undefined ? undefined : { edge: parsed, name };
  });
  if (nodes.some((node) => node === undefined) || edges.some((edge) => edge === undefined)) {
    throw invalidUpstreamResponse();
  }
  const history: ProofHistory = {
    session,
    nodes: nodes as ProofNode[],
    edges: edges as ProofHistoryEdge[],
  };
  if (!isRootedProofHistory(history)) throw invalidUpstreamResponse();
  return history;
}

/** Repoint the session to an already-retained node; no proof-state transition is fabricated. */
export async function backtrackProofSession(
  sessionIdInput: unknown,
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<BacktrackedProofSession> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const request = backtrackRequestSchema.safeParse(requestInput);
  if (!request.success) throw invalidRequest("The backtrack request is invalid.");
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/backtrack`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request.data),
      ...signalOption(options.signal),
    },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200) throw failureForResponse(response.status, value);

  const envelope = backtrackEnvelopeSchema.safeParse(value);
  if (!envelope.success) throw invalidUpstreamResponse();
  const { session } = envelope.data;
  const node = parseProofNode(envelope.data.node, session.operators);
  if (
    session.id !== sessionId ||
    node === undefined ||
    session.currentNodeId !== request.data.targetNodeId ||
    node.id !== request.data.targetNodeId
  ) {
    throw invalidUpstreamResponse();
  }
  return { session, node, replayed: envelope.data.replayed };
}

/**
 * The worker's answer to a command envelope or an observation (roadmap N25). Structured
 * failures (requires-input with aliased menus, replay-failed reports, regenerated previews and
 * protocol diagnostics) are returned rather than thrown, so the caller can relay them intact.
 */
export type ProtocolServiceAnswer = Readonly<{
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  body: unknown;
}>;

const protocolStructuredFailureSchema = z.union([
  protocolRequiresInputResponseSchema,
  previewRegeneratedResponseSchema,
  z
    .object({
      status: z.literal("replay-failed"),
      report: z.unknown(),
      diagnostics: z.tuple([
        z.object({ code: z.literal("replay-failed"), message: z.string().min(1) }).strict(),
      ]),
    })
    .strict(),
  protocolDiagnosticsResponseSchema,
]);

/** Send one command envelope, from a human or an agent, to the worker's command service. */
export async function submitProtocolCommand(
  sessionIdInput: unknown,
  envelopeInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProtocolServiceAnswer> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const envelope = protocolCommandEnvelopeSchema.safeParse(envelopeInput);
  if (!envelope.success) throw invalidRequest("The command envelope is invalid.");
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/protocol-commands`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope.data),
      ...signalOption(options.signal),
    },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status === 200 || response.status === 201) {
    const parsed = protocolCommandResponseSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.commandId !== envelope.data.commandId ||
      parsed.data.replayed !== (response.status === 200)
    ) {
      throw invalidUpstreamResponse();
    }
    return { ok: true, status: response.status, body: parsed.data };
  }
  return protocolFailureAnswer(response.status, value);
}

/** Observe the session: full snapshot with aliases, compact summary, or delta since a cursor. */
export async function observeProofSession(
  sessionIdInput: unknown,
  queryInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProtocolServiceAnswer> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const query = observeQuerySchema.safeParse(queryInput);
  if (!query.success) throw invalidRequest("The observe query is invalid.");
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query.data)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/observe?${search.toString()}`,
    { method: "GET", ...signalOption(options.signal) },
  );
  const value = await readValidatedEnvelope(response);
  if (response.status === 200) {
    const parsed = observeResponseSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.view !== query.data.view ||
      parsed.data.session.id !== sessionId
    ) {
      throw invalidUpstreamResponse();
    }
    return { ok: true, status: 200, body: parsed.data };
  }
  return protocolFailureAnswer(response.status, value);
}

function protocolFailureAnswer(status: number, value: unknown): ProtocolServiceAnswer {
  const parsed = protocolStructuredFailureSchema.safeParse(value);
  if (!parsed.success || status < 400 || status > 599) throw invalidUpstreamResponse();
  const diagnostic = parsed.data.diagnostics[0];
  return {
    ok: false,
    status: status === 422 ? 422 : publicFailureStatus(status),
    code: diagnostic.code,
    message: diagnostic.message,
    body: parsed.data,
  };
}

function parseIdentifier(input: unknown, label: string): string {
  const parsed = stableIdentifierSchema.safeParse(input);
  if (!parsed.success) throw invalidRequest(`The ${label} ID is invalid.`);
  return parsed.data;
}

function parseProofNode(
  input: unknown,
  operators: readonly OperatorDeclaration[],
): ProofNode | undefined {
  try {
    const parsed = createProofNodeSchema({ operators }).safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseMovePreview(
  input: unknown,
  operators: readonly OperatorDeclaration[],
): MovePreview | undefined {
  try {
    const parsed = createMovePreviewSchema({ operators }).safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseProofEdge(
  input: unknown,
  operators: readonly OperatorDeclaration[],
): ProofEdge | undefined {
  try {
    const parsed = createProofEdgeSchema({ operators }).safeParse(input);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parseMoveChoiceRequest(input: unknown): MoveChoiceRequest {
  const parsed = moveChoiceRequestSchema.safeParse(input);
  if (!parsed.success) throw invalidRequest("The displayed-move choice is invalid.");
  return parsed.data;
}

function transitionClassesMatchSuggestionSet(input: {
  suggestionSet: DisplayedSuggestionSet;
  transitionClasses: readonly SuggestionTransitionClass[];
}): boolean {
  const moveSuggestionIds = input.suggestionSet.suggestions
    .filter(({ source }) => source === "move")
    .map(({ id }) => id);
  return (
    moveSuggestionIds.length === input.transitionClasses.length &&
    moveSuggestionIds.every(
      (suggestionId, index) => input.transitionClasses[index]?.suggestionId === suggestionId,
    )
  );
}

function isRootedProofHistory(history: ProofHistory): boolean {
  const nodeIds = history.nodes.map(({ id }) => id);
  const edgeIds = history.edges.map(({ edge }) => edge.id);
  const nodes = new Set(nodeIds);
  if (
    nodes.size !== nodeIds.length ||
    new Set(edgeIds).size !== edgeIds.length ||
    !nodes.has(history.session.rootNodeId) ||
    !nodes.has(history.session.currentNodeId)
  ) {
    return false;
  }

  const children = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const { edge } of history.edges) {
    if (!nodes.has(edge.parentNodeId) || !nodes.has(edge.childNodeId)) return false;
    children.set(edge.parentNodeId, [...(children.get(edge.parentNodeId) ?? []), edge.childNodeId]);
    incoming.set(edge.childNodeId, (incoming.get(edge.childNodeId) ?? 0) + 1);
  }
  if (
    (incoming.get(history.session.rootNodeId) ?? 0) !== 0 ||
    nodeIds.some(
      (nodeId) => nodeId !== history.session.rootNodeId && (incoming.get(nodeId) ?? 0) !== 1,
    )
  ) {
    return false;
  }

  const reached = new Set<string>();
  const pending: string[] = [history.session.rootNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (nodeId === undefined || reached.has(nodeId)) continue;
    reached.add(nodeId);
    pending.push(...(children.get(nodeId) ?? []));
  }
  return reached.size === history.nodes.length;
}

async function requestProofService(pathname: string, init: RequestInit): Promise<Response> {
  let origin: string;
  try {
    origin = configuredProofServiceOrigin();
  } catch {
    throw new ProofServiceError(
      "service_unavailable",
      "The proof service is not configured correctly.",
      503,
    );
  }

  try {
    return await fetch(new URL(pathname, `${origin}/`), {
      ...init,
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json", ...headersRecord(init.headers) },
    });
  } catch (error) {
    if (error instanceof ProofServiceError) throw error;
    throw new ProofServiceError(
      "service_unavailable",
      "The proof service could not be reached.",
      503,
    );
  }
}

function configuredProofServiceOrigin(): string {
  const configured = process.env.PROOF_HTTP_ORIGIN ?? DEFAULT_PROOF_HTTP_ORIGIN;
  const url = new URL(configured);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid proof-service origin.");
  }
  return url.origin;
}

function headersRecord(headers: HeadersInit | undefined): Record<string, string> {
  return headers === undefined ? {} : Object.fromEntries(new Headers(headers).entries());
}

function signalOption(signal: AbortSignal | undefined): Readonly<{ signal?: AbortSignal }> {
  return signal === undefined ? {} : { signal };
}

async function readValidatedEnvelope(
  response: Response,
  maxBytes: number = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") throw invalidUpstreamResponse();

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw invalidUpstreamResponse();
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw invalidUpstreamResponse();
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw invalidUpstreamResponse();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidUpstreamResponse();
  }
}

function failureForResponse(status: number, value: unknown): ProofServiceError {
  // The worker answers 422 when a move still needs menu choices; nothing was recorded.
  const requiresInput = moveRequiresInputResponseSchema.safeParse(value);
  if (status === 422 && requiresInput.success) {
    return new ProofServiceError("requires-input", requiresInput.data.diagnostics[0].message, 422);
  }
  // A stale preview was regenerated and recorded instead of applied; the client re-previews.
  const regenerated = previewRegeneratedResponseSchema.safeParse(value);
  if (status === 409 && regenerated.success) {
    return new ProofServiceError(
      "preview-regenerated",
      regenerated.data.diagnostics[0].message,
      409,
    );
  }
  const failure = proofServiceFailureSchema.safeParse(value);
  if (!failure.success || status < 400 || status > 599) throw invalidUpstreamResponse();
  const diagnostic = failure.data.diagnostics[0];
  return new ProofServiceError(diagnostic.code, diagnostic.message, publicFailureStatus(status));
}

function publicFailureStatus(status: number): number {
  if (
    status === 400 ||
    status === 404 ||
    status === 409 ||
    status === 413 ||
    status === 415 ||
    status === 503
  ) {
    return status;
  }
  return 502;
}

function invalidRequest(message: string): ProofServiceError {
  return new ProofServiceError("invalid_request", message, 400);
}

function invalidUpstreamResponse(): ProofServiceError {
  return new ProofServiceError(
    "invalid_upstream_response",
    "The proof service returned an invalid response.",
    502,
  );
}

function suggestionSetMatchesRequest(
  suggestionSet: DisplayedSuggestionSet,
  request: z.infer<typeof suggestionRequestSchema>,
): boolean {
  if (suggestionSet.id !== request.id) return false;
  const stateId = request.selections[0]?.anchor.stateId;
  if (
    stateId === undefined ||
    suggestionSet.stateId !== stateId ||
    request.selections.some((selection) => selection.anchor.stateId !== stateId)
  ) {
    return false;
  }

  if (request.selections.length === 1) {
    const descriptor = request.selections[0];
    return (
      descriptor !== undefined &&
      suggestionSet.selection.kind !== "selection-query" &&
      resolvedSelectionMatchesDescriptor(suggestionSet.selection, descriptor)
    );
  }
  if (
    suggestionSet.selection.kind !== "selection-query" ||
    suggestionSet.selection.stateId !== stateId ||
    suggestionSet.selection.selections.length !== request.selections.length
  ) {
    return false;
  }
  return suggestionSet.selection.selections.every((subject, index) => {
    const descriptor = request.selections[index];
    return (
      descriptor !== undefined &&
      subject.id === `selection:request-${index + 1}` &&
      subject.abstraction === undefined &&
      resolvedSelectionMatchesDescriptor(subject.selection, descriptor)
    );
  });
}

function resolvedSelectionMatchesDescriptor(
  resolved: ResolvedProofSelection,
  descriptor: ProofSelectionDescriptor,
): boolean {
  if (resolved.kind !== descriptor.kind || !jsonEquals(resolved.anchor, descriptor.anchor)) {
    return false;
  }
  if (resolved.kind === "exact" && descriptor.kind === "exact") {
    return jsonEquals(resolved.path, descriptor.path);
  }
  return (
    resolved.kind === "associative" &&
    descriptor.kind === "associative" &&
    jsonEquals(resolved.containerPath, descriptor.containerPath) &&
    resolved.startOperand === descriptor.startOperand &&
    resolved.endOperand === descriptor.endOperand &&
    jsonEquals(resolved.displayRange, descriptor.displayRange)
  );
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// ---------------------------------------------------------------------------------------------
// Manual problem and session creation (roadmap N26)
// ---------------------------------------------------------------------------------------------

/** The session ID `readConfiguredProofSession` loads (the development session by default). */
export function configuredProofSessionId(): string {
  return process.env.PROOF_SESSION_ID ?? DEFAULT_PROOF_SESSION_ID;
}

/** The entry form's menus: sorts, library layers and the reviewed starter packs. */
export async function readProblemSetupOptions(
  options: ProofServiceRequestOptions = {},
): Promise<ProblemSetupOptions> {
  const response = await requestProofService("/problem-setup/options", {
    method: "GET",
    ...signalOption(options.signal),
  });
  const value = await readValidatedEnvelope(response);
  if (response.status !== 200) throw invalidUpstreamResponse();
  const parsed = problemSetupOptionsSchema.safeParse(value);
  if (!parsed.success) throw invalidUpstreamResponse();
  return parsed.data;
}

const problemSetupFailureSchema = z.union([
  z.object({ diagnostics: z.array(problemSetupDiagnosticSchema).min(1) }).strict(),
  z
    .object({
      diagnostics: z.tuple([
        z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
      ]),
    })
    .strict(),
]);

/**
 * Validate a draft into a review; writes nothing. A 422 carries the draft diagnostics and is
 * returned, not thrown, so the form can show every one of them.
 */
export async function validateProblemDraftRequest(
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProtocolServiceAnswer> {
  const request = z.object({ draft: z.unknown() }).strict().safeParse(requestInput);
  if (!request.success) throw invalidRequest("The draft validation request is invalid.");
  const response = await requestProofService("/problem-drafts/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.data),
    ...signalOption(options.signal),
  });
  const value = await readValidatedEnvelope(response);
  const parsed = problemDraftValidationResponseSchema.safeParse(value);
  if (response.status === 200 && parsed.success && parsed.data.ok) {
    return { ok: true, status: 200, body: parsed.data };
  }
  if (response.status === 422 && parsed.success && !parsed.data.ok) {
    const [first] = parsed.data.diagnostics;
    return {
      ok: false,
      status: 422,
      code: "invalid-draft",
      message: first?.message ?? "The draft is invalid.",
      body: { diagnostics: parsed.data.diagnostics },
    };
  }
  return problemSetupFailureAnswer(response.status, value);
}

export type CreatedProblemSession = Readonly<{
  session: ProofSession;
  node: ProofNode;
  metadata: ProofSessionMetadata;
  replayed: boolean;
}>;

const createdProblemSessionEnvelopeSchema = z
  .object({
    session: proofSessionSchema,
    node: z.unknown(),
    metadata: proofSessionMetadataSchema,
    replayed: z.boolean(),
  })
  .strict();

/**
 * Approve a reviewed draft: the worker re-validates it, checks the reviewed digest, and creates
 * the session and root node together. 201 creates, 200 replays an identical approval.
 */
export async function createProblemSession(
  requestInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProtocolServiceAnswer> {
  const request = problemApprovalRequestSchema.safeParse(requestInput);
  if (!request.success) throw invalidRequest("The approval request is invalid.");
  const response = await requestProofService("/proof-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request.data),
    ...signalOption(options.signal),
  });
  const value = await readValidatedEnvelope(response);
  if (response.status === 200 || response.status === 201) {
    const envelope = createdProblemSessionEnvelopeSchema.safeParse(value);
    if (!envelope.success) throw invalidUpstreamResponse();
    const { session } = envelope.data;
    const node = parseProofNode(envelope.data.node, session.operators);
    if (
      session.id !== request.data.sessionId ||
      node === undefined ||
      node.id !== session.rootNodeId ||
      envelope.data.replayed !== (response.status === 200)
    ) {
      throw invalidUpstreamResponse();
    }
    const created: CreatedProblemSession = { ...envelope.data, session, node };
    return { ok: true, status: response.status, body: created };
  }
  return problemSetupFailureAnswer(response.status, value);
}

function problemSetupFailureAnswer(status: number, value: unknown): ProtocolServiceAnswer {
  const parsed = problemSetupFailureSchema.safeParse(value);
  if (!parsed.success || status < 400 || status > 599) throw invalidUpstreamResponse();
  const [first] = parsed.data.diagnostics;
  return {
    ok: false,
    status: status === 422 ? 422 : publicFailureStatus(status),
    code: first?.code ?? "invalid_upstream_response",
    message: first?.message ?? "The proof service rejected the request.",
    body: parsed.data,
  };
}

/** The largest artifact the web boundary relays in either direction. */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

/** The download file name of a session's artifact: the ID with unsafe characters replaced. */
export function artifactFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, "-")}.proof-artifact.json`;
}

/**
 * Fetch a session's versioned proof artifact (roadmap N27). The body is the worker's artifact
 * exactly as sent (its digest covers that content); it is checked against the strict artifact
 * schema and the requested session before it is relayed.
 */
export async function exportProofArtifact(
  sessionIdInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProtocolServiceAnswer> {
  const sessionId = parseIdentifier(sessionIdInput, "proof session");
  const response = await requestProofService(
    `/proof-sessions/${encodeURIComponent(sessionId)}/export`,
    { method: "GET", ...signalOption(options.signal) },
  );
  const value = await readValidatedEnvelope(response, MAX_ARTIFACT_BYTES);
  if (response.status === 200) {
    const parsed = parseProofArtifact(value);
    if (!parsed.ok || parsed.artifact.sessionId !== sessionId) throw invalidUpstreamResponse();
    return { ok: true, status: 200, body: value };
  }
  return artifactFailureAnswer(response.status, value);
}

/**
 * The stored artifact of a session, parsed, for the static viewers (roadmap N28). It reads stored
 * rows only; the viewers never call the kernel, moves or retrieval.
 */
export async function readStoredProofArtifact(
  sessionIdInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProofArtifact> {
  const answer = await exportProofArtifact(sessionIdInput, options);
  if (!answer.ok) {
    if (answer.status === 404) {
      throw new ProofServiceError("invalid_request", "The proof session was not found.", 404);
    }
    throw new ProofServiceError(
      "invalid_upstream_response",
      answer.message ?? "The proof service could not export the session.",
      answer.status,
    );
  }
  const parsed = parseProofArtifact(answer.body);
  if (!parsed.ok) throw invalidUpstreamResponse();
  return parsed.artifact;
}

/**
 * Upload an artifact: the worker revalidates it completely and creates a read-only session.
 * 201 creates, 200 finds the session of an identical earlier upload, 422 carries the diagnostics
 * of the first failed check (nothing is written).
 */
export async function uploadProofArtifact(
  artifactInput: unknown,
  options: ProofServiceRequestOptions = {},
): Promise<ProtocolServiceAnswer> {
  if (typeof artifactInput !== "object" || artifactInput === null || Array.isArray(artifactInput)) {
    throw invalidRequest("A proof artifact must be a JSON object.");
  }
  const response = await requestProofService("/artifacts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(artifactInput),
    ...signalOption(options.signal),
  });
  const value = await readValidatedEnvelope(response);
  if (response.status === 200 || response.status === 201) {
    const parsed = proofArtifactImportResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.replayed !== (response.status === 200)) {
      throw invalidUpstreamResponse();
    }
    return { ok: true, status: response.status, body: parsed.data };
  }
  return artifactFailureAnswer(response.status, value);
}

function artifactFailureAnswer(status: number, value: unknown): ProtocolServiceAnswer {
  const parsed = proofArtifactRejectionResponseSchema.safeParse(value);
  if (!parsed.success || status < 400 || status > 599) throw invalidUpstreamResponse();
  const [first] = parsed.data.diagnostics;
  return {
    ok: false,
    status: status === 422 ? 422 : publicFailureStatus(status),
    code: first?.code ?? "invalid_upstream_response",
    message: first?.message ?? "The proof service rejected the artifact.",
    body: parsed.data,
  };
}
