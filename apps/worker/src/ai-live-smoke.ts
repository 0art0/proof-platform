/**
 * Live smoke test of the AI roles against the Vercel AI Gateway. It makes paid provider calls, so
 * it is run by hand and never by `npm test`:
 *
 *   node --env-file=.env.local --import tsx apps/worker/src/ai-live-smoke.ts \
 *     [--problems corpus:contraposition,corpus:weak-shift] [--out <directory>]
 *
 * It starts the worker in process on the memory store with the real AI runtime and drives each
 * benchmark problem through the HTTP routes the web application uses, in order: propose a
 * background, revise it once and accept it; build and approve a library; formalize the problem and
 * open a session (from the corpus reference draft when the drafted setup is not admitted, so the
 * later roles still run); request suggestions and shortlist them; describe a step and apply it;
 * and save it as a reusable move. Problems run concurrently.
 *
 * Every gateway attempt is timed and its token usage recorded by wrapping `fetch`; the attempt is
 * attributed to its call by the envelope ID in the request. The stored call evidence says whether
 * each output passed validation. The provider timeout defaults to 600000 ms here (unless
 * `PROOF_AI_TIMEOUT_MS` is set) so that long generations are measured rather than cut off; the
 * summary counts the attempts that took longer than the worker's 120000 ms default. The output
 * directory receives one JSON record per problem and `summary.md`/`summary.json` per role.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { BENCHMARK_CORPUS, type CorpusProblem, type CorpusSelection } from "@proof/library";
import {
  configuredVercelApiKey,
  DEFAULT_LLM_TIMEOUT_MS,
  NONE_RELEVANT_CHOICE_ID,
  VERCEL_AI_GATEWAY_BASE_URL,
} from "@proof/llm";
import { corpusReferenceDraft, scoreFormalizerDraft } from "./ai-evaluation";
import { startProofWorker } from "./proof-worker-startup";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DEFAULT_PROBLEMS = [
  "corpus:contraposition",
  "corpus:proof-by-cases",
  "corpus:divisibility-sum",
  "corpus:subset-chain-membership",
  "corpus:weak-shift",
];

/** The step the user describes in words for each problem; the move executor plans it. */
const DESCRIBED_STEPS: Readonly<Record<string, string>> = {
  "corpus:contraposition": "Assume not q and show not p.",
  "corpus:proof-by-cases": "Split into the two cases of p or q.",
  "corpus:divisibility-sum": "Use that a common divisor of two integers divides their sum.",
  "corpus:subset-chain-membership": "From x ∈ A and A ⊆ B, conclude x ∈ B.",
  "corpus:weak-shift": "Add c to both sides of a ≤ b.",
};
const GENERIC_STEP = "Take the most natural first step towards the goal.";
const REVISION_FEEDBACK =
  "Keep only the constants the statement itself needs, and reuse an existing operator wherever one fits.";
const WEB_ACTOR = { id: "actor:web", kind: "human" } as const;
const SLOW_MS = DEFAULT_LLM_TIMEOUT_MS;

const ROLES = [
  "background-proposer",
  "librarian",
  "proof-state-formalizer",
  "move-shortlister",
  "move-executor",
  "move-author",
] as const;

type Attempt = {
  callId: string | null;
  role: string | null;
  model: string | null;
  reasoningEffort: string | null;
  startedAt: string;
  ms: number;
  status: number | "aborted" | "network-error";
  finishReason: string | null;
  /** The response without its choices (the generated content): id, model, usage, metadata. */
  meta: Json | null;
  error: string | null;
  costUsd: number | null;
};

type StepRecord = {
  step: string;
  role: string | null;
  callId: string | null;
  http: number;
  ms: number;
  outcome: string;
  /** Stored evidence status; `none` when no provider call was recorded. */
  evidence: string;
  detail: Json;
};

type ProblemRecord = {
  problemId: string;
  instruction: string;
  sessionFrom: "formalizer" | "reference" | null;
  steps: StepRecord[];
  error: string | null;
};

/** Wrap `fetch` so that every gateway attempt is timed and its usage kept. */
function recordGatewayAttempts(baseUrl: string): Attempt[] {
  const attempts: Attempt[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(baseUrl)) return original(input, init);
    const request = describeGatewayRequest(init?.body);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const attempt: Attempt = {
      ...request,
      startedAt,
      ms: 0,
      status: "network-error",
      finishReason: null,
      meta: null,
      error: null,
      costUsd: null,
    };
    attempts.push(attempt);
    try {
      const response = await original(input, init);
      const text = await response.clone().text();
      attempt.ms = Math.round(performance.now() - started);
      attempt.status = response.status;
      if (!response.ok) {
        attempt.error = text.slice(0, 4_000);
        return response;
      }
      const body = parseJson(text);
      if (body !== null && typeof body === "object") {
        const { choices, ...meta } = body as Json;
        attempt.meta = meta;
        attempt.finishReason = Array.isArray(choices) ? (choices[0]?.finish_reason ?? null) : null;
      }
      return response;
    } catch (error: unknown) {
      attempt.ms = Math.round(performance.now() - started);
      attempt.status =
        error instanceof Error && error.name === "AbortError" ? "aborted" : "network-error";
      attempt.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  return attempts;
}

function describeGatewayRequest(
  body: unknown,
): Pick<Attempt, "callId" | "role" | "model" | "reasoningEffort"> {
  const payload = typeof body === "string" ? (parseJson(body) as Json | null) : null;
  // Chat calls carry the envelope as the user message; Jev carries it as `state`.
  const envelope =
    payload?.state ??
    (typeof payload?.messages?.[1]?.content === "string"
      ? parseJson(payload.messages[1].content)
      : null);
  return {
    callId: typeof envelope?.id === "string" ? envelope.id : null,
    role: typeof envelope?.role === "string" ? envelope.role : null,
    model: typeof payload?.model === "string" ? payload.model : null,
    reasoningEffort: payload?.reasoning_effort ?? null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Api = (
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) => Promise<{ status: number; body: Json; ms: number }>;

function workerApi(origin: string): Api {
  return async (method, path, body) => {
    const started = performance.now();
    const response = await fetch(`${origin}${path}`, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    const parsed = parseJson(await response.text());
    return {
      status: response.status,
      body: (parsed ?? {}) as Json,
      ms: Math.round(performance.now() - started),
    };
  };
}

const enc = encodeURIComponent;

/** Read a call's stored evidence; failed and rejected calls keep their raw response for diagnosis. */
async function evidenceOf(api: Api, ownerPath: string, callId: string) {
  const read = await api("GET", `${ownerPath}/llm-calls/${enc(callId)}`);
  const evidence = read.status === 200 ? read.body.record?.evidence : undefined;
  if (evidence === undefined) return { status: "none", detail: {}, raw: undefined };
  return {
    status: evidence.status as string,
    raw: evidence.rawResponse as unknown,
    detail:
      evidence.status === "validated"
        ? {}
        : { diagnostics: evidence.diagnostics, rawResponse: evidence.rawResponse },
  };
}

async function runProblem(api: Api, problem: CorpusProblem): Promise<ProblemRecord> {
  const slug = problem.id.replace(/^corpus:/, "");
  const run = Date.now().toString(36);
  const constructionId = `construction:smoke-${slug}-${run}`;
  const constructionPath = `/constructions/${enc(constructionId)}`;
  const callId = (name: string) => `llm-call:smoke-${slug}-${name}-${run}`;
  const instruction = DESCRIBED_STEPS[problem.id] ?? GENERIC_STEP;
  const record: ProblemRecord = {
    problemId: problem.id,
    instruction,
    sessionFrom: null,
    steps: [],
    error: null,
  };
  const step = async (
    name: string,
    role: string | null,
    id: string | null,
    ownerPath: string | null,
    send: () => ReturnType<Api>,
    summarize: (body: Json, status: number, raw: unknown) => { outcome: string; detail?: Json },
  ) => {
    const answer = await send();
    const evidence =
      id === null || ownerPath === null
        ? { status: "none", detail: {}, raw: undefined }
        : await evidenceOf(api, ownerPath, id);
    const summary = summarize(answer.body, answer.status, evidence.raw);
    record.steps.push({
      step: name,
      role,
      callId: id,
      http: answer.status,
      ms: answer.ms,
      outcome: summary.outcome,
      evidence: evidence.status,
      detail: { ...summary.detail, ...evidence.detail },
    });
    process.stdout.write(
      `${problem.id} ${name}: ${answer.status} ${summary.outcome} (${evidence.status}, ${answer.ms} ms)\n`,
    );
    return answer;
  };
  const statusOf = (body: Json, status: number) =>
    String(body.status ?? body.diagnostics?.[0]?.code ?? status);
  const preferences = { domains: [problem.domain] };

  // 1. Background: propose, revise once, accept the latest validated proposal.
  const proposed = await step(
    "background",
    "background-proposer",
    callId("background"),
    constructionPath,
    () =>
      api("POST", "/ai/background", {
        constructionId,
        id: callId("background"),
        problem: { title: problem.title, statement: problem.statement },
        preferences,
      }),
    (body, status) => ({
      outcome: statusOf(body, status),
      detail: proposalDetail(body),
    }),
  );
  let accepted = proposed.body.status === "proposed" ? proposed.body : undefined;
  if (accepted !== undefined) {
    const revised = await step(
      "background-revision",
      "background-proposer",
      callId("background-2"),
      constructionPath,
      () =>
        api("POST", "/ai/background", {
          constructionId,
          id: callId("background-2"),
          problem: { title: problem.title, statement: problem.statement },
          revision: { previousCallId: callId("background"), feedback: REVISION_FEEDBACK },
        }),
      (body, status) => ({ outcome: statusOf(body, status), detail: proposalDetail(body) }),
    );
    if (revised.body.status === "proposed") accepted = revised.body;
  }
  if (accepted === undefined) {
    record.error = "No validated background proposal; the remaining steps need one.";
    return record;
  }
  const backgroundDecisionId = `background-decision:smoke-${slug}-${run}`;
  const decided = await step(
    "background-decision",
    null,
    null,
    null,
    () =>
      api("POST", "/ai/background/decisions", {
        constructionId,
        decisionId: backgroundDecisionId,
        callId: accepted.callId,
        decision: "approved",
        rationale: "Accepted by the live smoke test.",
        decidedAt: new Date().toISOString(),
      }),
    (body, status) => ({ outcome: statusOf(body, status), detail: diagnosticsOf(body) }),
  );
  const approvedBackground =
    decided.status === 201 || decided.status === 200
      ? { decisionId: backgroundDecisionId }
      : undefined;
  const background = accepted.proposal.background;

  // 2. Library: build one for the accepted background and keep every admitted result.
  let approvedLibrary: { decisionId: string } | undefined;
  if (approvedBackground !== undefined) {
    const library = await step(
      "library",
      "librarian",
      callId("library"),
      constructionPath,
      () =>
        api("POST", "/ai/library", {
          constructionId,
          id: callId("library"),
          approvedBackground,
          packs: problem.packs,
        }),
      (body, status) => ({
        outcome: statusOf(body, status),
        detail:
          body.status === "proposed"
            ? {
                admitted: body.results.length,
                variants: body.results.reduce(
                  (sum: number, result: Json) => sum + result.variants.length,
                  0,
                ),
                rejected: body.rejected.map((result: Json) => ({
                  id: result.id,
                  codes: result.codes,
                  reasons: result.reasons,
                })),
                newConstants: body.newConstants.map((constant: Json) => constant.operator.symbol),
                rejectedConstants: body.rejectedConstants,
              }
            : diagnosticsOf(body),
      }),
    );
    const resultIds: string[] =
      library.body.status === "proposed"
        ? library.body.results.map((result: Json) => result.artifact.id)
        : [];
    if (resultIds.length > 0) {
      const libraryDecisionId = `library-decision:smoke-${slug}-${run}`;
      const kept = await step(
        "library-decision",
        null,
        null,
        null,
        () =>
          api("POST", "/ai/library/decisions", {
            constructionId,
            decisionId: libraryDecisionId,
            callId: callId("library"),
            approvedResultIds: resultIds,
            decidedAt: new Date().toISOString(),
            rationale: "Kept by the live smoke test.",
          }),
        (body, status) => ({ outcome: statusOf(body, status), detail: diagnosticsOf(body) }),
      );
      if (kept.status === 201 || kept.status === 200) {
        approvedLibrary = { decisionId: libraryDecisionId };
      }
    }
  }

  // 3. Formalize, then check and approve the drafted setup (or the reference one).
  const libraryLayerIds = ["layer:global", "layer:initial-problem"];
  const formalized = await step(
    "formalize",
    "proof-state-formalizer",
    callId("formalize"),
    constructionPath,
    () =>
      api("POST", "/ai/formalize", {
        constructionId,
        id: callId("formalize"),
        problem: { title: problem.title, statement: problem.statement },
        background,
        preferences,
        libraryLayerIds,
        packs: problem.packs,
        ...(approvedBackground === undefined ? {} : { approvedBackground }),
        ...(approvedLibrary === undefined ? {} : { approvedLibrary }),
      }),
    (body, status) => {
      const score =
        body.draft === undefined ? undefined : scoreFormalizerDraft(problem, body.draft);
      return {
        outcome: statusOf(body, status),
        detail: {
          ...diagnosticsOf(body),
          ...(body.result === undefined ? {} : { result: body.result }),
          ...(score === undefined
            ? {}
            : { matchesReference: score.matchesReference, scoreDiagnostics: score.diagnostics }),
          ...(body.draft === undefined ? {} : { draft: body.draft }),
        },
      };
    },
  );
  const references = {
    ...(approvedBackground === undefined
      ? {}
      : { approvedBackground: { constructionId, ...approvedBackground } }),
    ...(approvedLibrary === undefined
      ? {}
      : { approvedLibrary: { constructionId, ...approvedLibrary } }),
  };
  const sessionId = `session:smoke-${slug}-${run}`;
  const openSession = async (draft: unknown, from: "formalizer" | "reference") => {
    const checked = await step(
      `validate-${from}-draft`,
      null,
      null,
      null,
      () => api("POST", "/problem-drafts/validate", { draft, ...references }),
      (body, status) => ({
        outcome: body.ok === true ? "ok" : statusOf(body, status),
        detail: diagnosticsOf(body),
      }),
    );
    if (checked.body.ok !== true) return false;
    const created = await step(
      `create-session-${from}`,
      null,
      null,
      null,
      () =>
        api("POST", "/proof-sessions", {
          sessionId,
          draft,
          reviewedDigest: checked.body.review.digest,
          ...references,
        }),
      (body, status) => ({ outcome: String(status), detail: diagnosticsOf(body) }),
    );
    if (created.status !== 201) return false;
    record.sessionFrom = from;
    return true;
  };
  const opened =
    (formalized.body.status === "ready-for-review" &&
      (await openSession(formalized.body.draft, "formalizer"))) ||
    (await openSession(corpusReferenceDraft(problem), "reference"));
  if (!opened) {
    record.error = "Neither the drafted nor the reference setup could be approved.";
    return record;
  }
  const sessionPath = `/proof-sessions/${enc(sessionId)}`;
  const current = async () => (await api("GET", sessionPath)).body;

  // 4. Suggestions for the first scripted step's selections, then the shortlister.
  const root = await current();
  const nodeId: string = root.session.currentNodeId;
  const firstStep = problem.steps[0];
  const scripted =
    firstStep === undefined ? undefined : resolveSelections(root.node, firstStep.selections);
  const goal = root.node.state.goals[0];
  const conclusionSelection = {
    kind: "exact",
    anchor: {
      stateId: root.node.state.id,
      target: { kind: "goal", id: goal.id },
      statement: { kind: "conclusion" },
    },
    path: [],
  };
  const suggestionSetId = `suggestion-set:smoke-${slug}-${run}`;
  const suggested = await step(
    "suggestions",
    null,
    null,
    null,
    () =>
      api("POST", `${sessionPath}/suggestion-sets`, {
        id: suggestionSetId,
        selections: scripted ?? [conclusionSelection],
      }),
    (body, status) => ({
      outcome: String(status),
      detail: {
        selections: scripted === undefined ? "goal conclusion" : "scripted",
        displayed: body.suggestionSet?.suggestions.length ?? 0,
        ...diagnosticsOf(body),
      },
    }),
  );
  const suggestions: Json[] = suggested.body.suggestionSet?.suggestions ?? [];
  if (suggestions.length >= 2) {
    const candidateIds = suggestions.slice(0, 32).map((suggestion) => suggestion.id);
    await step(
      "shortlist",
      "move-shortlister",
      callId("shortlist"),
      sessionPath,
      () =>
        api("POST", `${sessionPath}/ai/shortlist`, {
          id: callId("shortlist"),
          expectedCurrentNodeId: nodeId,
          suggestionSetId,
          candidateIds,
          trigger: "explicit-user",
        }),
      (body, status, raw) => {
        const top = suggestions.find(
          (suggestion) => suggestion.id === body.choices?.[0]?.suggestionId,
        );
        const output = (raw as Json | undefined)?.providerOutput;
        return {
          outcome: statusOf(body, status),
          detail: {
            candidates: candidateIds.length,
            choices: body.choices,
            confidence: body.confidence,
            jevChoice: output?.choice,
            jevConfidence: output?.confidence,
            noneRelevantProbability: output?.probabilities?.[NONE_RELEVANT_CHOICE_ID],
            topArtifact: top?.artifactId,
            ...(scripted === undefined || firstStep === undefined
              ? {}
              : {
                  scriptedArtifact: firstStep.suggestion.artifactId,
                  matchesScripted: top?.artifactId === firstStep.suggestion.artifactId,
                }),
            ...diagnosticsOf(body),
          },
        };
      },
    );
  }

  // 5. Describe a step, preview it and apply it.
  const executed = await step(
    "execute",
    "move-executor",
    callId("execute"),
    sessionPath,
    () =>
      api("POST", `${sessionPath}/ai/execute`, {
        id: callId("execute"),
        expectedCurrentNodeId: nodeId,
        instruction,
        source: "user-instruction",
        target: { kind: "goal", id: goal.id },
        selections: [conclusionSelection],
      }),
    (body, status) => ({
      outcome: statusOf(body, status),
      detail: {
        steps: body.steps?.map((planned: Json) => planned.operation?.kind ?? planned.kind),
        transitionClass: body.transitionClass,
        failure: body.failure,
        result: body.result,
        ...diagnosticsOf(body),
      },
    }),
  );
  if (executed.body.status !== "previewed") return record;
  const applied = await step(
    "apply",
    null,
    null,
    null,
    () =>
      api("POST", `${sessionPath}/ai/execute/apply`, {
        callId: callId("execute"),
        expectedCurrentNodeId: nodeId,
      }),
    (body, status) => ({ outcome: statusOf(body, status), detail: diagnosticsOf(body) }),
  );
  if (applied.status !== 201) return record;

  // 6. Save the applied step as a reusable move and submit the draft for review.
  const authored = await step(
    "move-author",
    "move-author",
    callId("author"),
    sessionPath,
    () =>
      api("POST", `${sessionPath}/ai/move-author`, {
        id: callId("author"),
        executorCallId: callId("execute"),
      }),
    (body, status) => ({
      outcome: statusOf(body, status),
      detail: {
        name: body.template?.name,
        classification: body.classification?.kind,
        templateValid: body.validation?.ok,
        validationDiagnostics: body.validation?.diagnostics,
        generality: body.generality,
        result: body.result,
        ...diagnosticsOf(body),
      },
    }),
  );
  if (
    authored.body.status === "proposed" &&
    authored.body.validation?.ok === true &&
    authored.body.classification?.kind !== "principle"
  ) {
    await step(
      "submit-draft",
      null,
      null,
      null,
      () =>
        api("POST", `${sessionPath}/protocol-commands`, {
          commandId: `command:smoke-${slug}-${run}-draft`,
          actor: WEB_ACTOR,
          command: {
            kind: "author-move-draft",
            template: authored.body.template,
            payloadSource: "reviewed-authoring",
            proposal: {
              role: "move-author",
              callId: callId("author"),
              executorCallId: callId("execute"),
            },
          },
        }),
      (body, status) => ({ outcome: String(status), detail: diagnosticsOf(body) }),
    );
  }
  return record;
}

function proposalDetail(body: Json): Json {
  if (body.status !== "proposed") return { ...diagnosticsOf(body), result: body.result };
  return {
    level: body.proposal.background.level,
    domains: body.proposal.background.domains,
    maximumLevel: body.proposal.background.maximumLevel,
    constants: body.proposal.constants.map((constant: Json) => constant.operator.symbol),
  };
}

function diagnosticsOf(body: Json): Json {
  return Array.isArray(body.diagnostics) && body.diagnostics.length > 0
    ? {
        diagnostics: body.diagnostics.map((diagnostic: Json) => ({
          code: diagnostic.code,
          message: diagnostic.message,
          ...(diagnostic.path === undefined ? {} : { path: diagnostic.path }),
        })),
      }
    : {};
}

/** Resolve scripted corpus selections against a node, or `undefined` when its state differs. */
function resolveSelections(node: Json, selections: readonly CorpusSelection[]) {
  const resolved = [];
  for (const selection of selections) {
    const entries: Json[] =
      selection.target.kind === "goal" ? node.state.goals : node.state.obligations;
    const target = entries.find((entry) =>
      isDeepStrictEqual(entry.sequent.conclusion.expression, selection.target.conclusion),
    );
    if (target === undefined) return undefined;
    let statement: Json = { kind: "conclusion" };
    if (selection.statement !== "conclusion") {
      const wanted = selection.statement.hypothesis;
      const found = target.sequent.context.hypotheses.find((hypothesis: Json) =>
        isDeepStrictEqual(hypothesis.statement.expression, wanted),
      );
      if (found === undefined) return undefined;
      statement = { kind: "hypothesis", id: found.id };
    }
    resolved.push({
      kind: "exact",
      anchor: {
        stateId: node.state.id,
        target: { kind: selection.target.kind, id: target.id },
        statement,
      },
      path: selection.path ?? [],
    });
  }
  return resolved;
}

type Pricing = Readonly<Record<string, Json>>;

async function gatewayPricing(baseUrl: string): Promise<Pricing> {
  const response = await fetch(`${baseUrl}/v1/models`);
  const body = (await response.json()) as { data: Json[] };
  return Object.fromEntries(body.data.map((model) => [model.id, model.pricing ?? {}]));
}

async function gatewayBalance(baseUrl: string, apiKey: string): Promise<number | null> {
  const response = await fetch(`${baseUrl}/v1/credits`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return null;
  const body = (await response.json()) as Json;
  return Number(body.balance);
}

/** A reported cost when the gateway includes one, otherwise usage times the list prices. */
function attemptCost(attempt: Attempt, pricing: Pricing): number | null {
  const meta = attempt.meta;
  if (meta === null) return null;
  const reported =
    meta.usage?.cost ??
    meta.provider_metadata?.gateway?.cost ??
    meta.providerMetadata?.gateway?.cost;
  if (reported !== undefined && Number.isFinite(Number(reported))) return Number(reported);
  const prices = attempt.model === null ? undefined : pricing[attempt.model];
  if (prices === undefined || meta.usage === undefined) return null;
  const input = Number(meta.usage.prompt_tokens ?? meta.usage.input_tokens ?? 0);
  const cached = Number(meta.usage.prompt_tokens_details?.cached_tokens ?? 0);
  const output = Number(meta.usage.completion_tokens ?? meta.usage.output_tokens ?? 0);
  return (
    (input - cached) * Number(prices.input ?? 0) +
    cached * Number(prices.input_cache_read ?? prices.input ?? 0) +
    output * Number(prices.output ?? 0)
  );
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarize(records: readonly ProblemRecord[], attempts: readonly Attempt[]) {
  return ROLES.map((role) => {
    const steps = records.flatMap((record) => record.steps.filter((step) => step.role === role));
    const called = steps.filter((step) => step.evidence !== "none");
    const roleAttempts = attempts.filter((attempt) => attempt.role === role);
    const latencies = roleAttempts.map((attempt) => attempt.ms);
    const sum = (pick: (usage: Json) => unknown) =>
      roleAttempts.reduce(
        (total, attempt) => total + Number(pick(attempt.meta?.usage ?? {}) ?? 0),
        0,
      );
    const outcomes: Record<string, number> = {};
    for (const step of steps) outcomes[step.outcome] = (outcomes[step.outcome] ?? 0) + 1;
    return {
      role,
      calls: called.length,
      validated: called.filter((step) => step.evidence === "validated").length,
      rejected: called.filter((step) => step.evidence === "rejected").length,
      transportFailed: called.filter((step) => step.evidence === "transport-failed").length,
      outcomes,
      attempts: roleAttempts.length,
      httpFailures: roleAttempts.filter((attempt) => attempt.status !== 200).length,
      medianSeconds: median(latencies) === null ? null : median(latencies)! / 1000,
      maxSeconds: latencies.length === 0 ? null : Math.max(...latencies) / 1000,
      overDefaultTimeout: latencies.filter((ms) => ms > SLOW_MS).length,
      inputTokens: sum((usage) => usage.prompt_tokens ?? usage.input_tokens),
      outputTokens: sum((usage) => usage.completion_tokens ?? usage.output_tokens),
      reasoningTokens: sum((usage) => usage.completion_tokens_details?.reasoning_tokens),
      costUsd: roleAttempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0),
      finishReasons: [...new Set(roleAttempts.map((attempt) => attempt.finishReason))],
    };
  });
}

type RoleSummary = ReturnType<typeof summarize>[number];

function markdownSummary(
  rows: readonly RoleSummary[],
  context: Readonly<{ problems: readonly string[]; timeoutMs: number; spentUsd: number | null }>,
): string {
  const lines = [
    `Problems: ${context.problems.join(", ")}. Provider timeout: ${context.timeoutMs} ms.`,
    context.spentUsd === null ? "" : `Gateway balance change: $${context.spentUsd.toFixed(4)}.`,
    "",
    "| Role | Calls | Validated | Rejected | Transport failed | Outcomes | Median s | Max s | > 120 s | Tokens in / out (reasoning) | Cost $ |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows
      .map((row) =>
        [
          row.role,
          row.calls,
          row.validated,
          row.rejected,
          row.transportFailed,
          Object.entries(row.outcomes)
            .map(([outcome, count]) => `${outcome} ${count}`)
            .join(", "),
          row.medianSeconds?.toFixed(1) ?? "",
          row.maxSeconds?.toFixed(1) ?? "",
          row.overDefaultTimeout,
          `${row.inputTokens} / ${row.outputTokens} (${row.reasoningTokens})`,
          row.costUsd.toFixed(4),
        ].join(" | "),
      )
      .map((line) => `| ${line} |`),
  ];
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      problems: { type: "string" },
      out: { type: "string" },
    },
  });
  const key = configuredVercelApiKey(process.env);
  if (!key.ok)
    throw new Error("Set AI_GATEWAY_API_KEY (or AI_API_KEY) to run the live smoke test.");
  const problemIds = values.problems?.split(",").map((id) => id.trim()) ?? DEFAULT_PROBLEMS;
  const problems = problemIds.map((id) => {
    const problem = BENCHMARK_CORPUS.find((candidate) => candidate.id === id);
    if (problem === undefined) throw new Error(`Unknown corpus problem ${id}.`);
    return problem;
  });
  const out = values.out ?? join(tmpdir(), `proof-ai-live-smoke-${Date.now().toString(36)}`);
  await mkdir(out, { recursive: true });
  const baseUrl = VERCEL_AI_GATEWAY_BASE_URL;
  const timeoutMs = Number(process.env.PROOF_AI_TIMEOUT_MS ?? 600_000);
  const balanceBefore = await gatewayBalance(baseUrl, key.apiKey);
  const pricing = await gatewayPricing(baseUrl);
  const attempts = recordGatewayAttempts(baseUrl);
  const worker = await startProofWorker({
    ...process.env,
    PROOF_STORE: "memory",
    PROOF_HTTP_PORT: "0",
    PROOF_AI_TIMEOUT_MS: String(timeoutMs),
    PROOF_AI_MAX_CONCURRENT: process.env.PROOF_AI_MAX_CONCURRENT ?? "16",
    PROOF_AI_RATE_PER_MINUTE: process.env.PROOF_AI_RATE_PER_MINUTE ?? "600",
  });
  let records: ProblemRecord[];
  try {
    const api = workerApi(worker.origin);
    records = await Promise.all(
      problems.map(async (problem) => {
        let record: ProblemRecord;
        try {
          record = await runProblem(api, problem);
        } catch (error: unknown) {
          record = {
            problemId: problem.id,
            instruction: DESCRIBED_STEPS[problem.id] ?? GENERIC_STEP,
            sessionFrom: null,
            steps: [],
            error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          };
        }
        return record;
      }),
    );
  } finally {
    await worker.close();
  }
  for (const attempt of attempts) attempt.costUsd = attemptCost(attempt, pricing);
  const balanceAfter = await gatewayBalance(baseUrl, key.apiKey);
  for (const record of records) {
    const file = `${record.problemId.replace(/^corpus:/, "")}.json`;
    const own = attempts.filter((attempt) =>
      record.steps.some((step) => step.callId !== null && step.callId === attempt.callId),
    );
    await writeFile(join(out, file), `${JSON.stringify({ ...record, attempts: own }, null, 2)}\n`);
  }
  const rows = summarize(records, attempts);
  const spentUsd =
    balanceBefore === null || balanceAfter === null ? null : balanceBefore - balanceAfter;
  const markdown = markdownSummary(rows, { problems: problemIds, timeoutMs, spentUsd });
  await writeFile(join(out, "summary.md"), markdown);
  await writeFile(
    join(out, "summary.json"),
    `${JSON.stringify({ problems: problemIds, timeoutMs, spentUsd, roles: rows, attempts, errors: records.filter((record) => record.error !== null).map(({ problemId, error }) => ({ problemId, error })) }, null, 2)}\n`,
  );
  process.stdout.write(`\n${markdown}\nResults: ${out}\n`);
  for (const record of records) {
    if (record.error !== null) process.stdout.write(`${record.problemId}: ${record.error}\n`);
  }
}

await main();
