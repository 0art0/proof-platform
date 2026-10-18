import { afterEach, describe, expect, it } from "vitest";
import type { LlmTransport, PreparedLlmCall } from "@proof/llm";
import { starterLibraryPacks } from "@proof/library";
import { setDraft } from "../problem-setup.testing";
import { MemoryLibraryStore } from "../memory-library-store";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { readLibraryProposalDecision } from "../llm-call-repository";
import { ProofStoreTransactionError } from "../proof-repository";
import type { LibraryStoreTransaction } from "../library-repository";
import { createProofHttpService, type ProofHttpService } from ".";
import { createAiLimiter, type AiLimiter } from "./ai-rate-limit";
import type { AiRuntime } from "../ai-runtime";

const services: ProofHttpService[] = [];
const dispatch = {
  provider: "test-provider",
  model: "test-model",
  promptVersion: "library-test-v1",
} as const;

const CONSTRUCTION = "construction:library";
const PROBLEM = {
  title: "Consecutive integers",
  statement: "Show that m and n are coprime when m = n + 1.",
};

/** A store whose Nth library transaction (counted from `armFailure`) fails with an unknown outcome. */
class FlakyLibraryStore extends MemoryLibraryStore {
  private failIn: number | undefined;
  transactions = 0;
  armFailure(afterSuccessfulTransactions: number): void {
    this.failIn = afterSuccessfulTransactions + 1;
    this.transactions = 0;
  }
  override async libraryTransaction<Result>(
    work: (transaction: LibraryStoreTransaction) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    if (this.failIn === this.transactions) {
      this.failIn = undefined;
      throw new ProofStoreTransactionError("commit-unknown", "Injected commit failure.");
    }
    return super.libraryTransaction(work);
  }
}

type Running = { origin: string; store: FlakyLibraryStore; calls: MemoryLlmCallStore };

async function running(
  options: {
    ai?: AiRuntime;
    calls?: MemoryLlmCallStore | null;
    aiLimiter?: AiLimiter;
    library?: boolean;
  } = {},
): Promise<Running> {
  const store = new FlakyLibraryStore();
  const calls = options.calls ?? new MemoryLlmCallStore();
  const service = createProofHttpService(store, {
    ...(options.library === false ? {} : { library: store }),
    ...(options.calls === null ? {} : { llmCalls: calls }),
    ...(options.ai === undefined ? {} : { ai: options.ai }),
    ...(options.aiLimiter === undefined ? {} : { aiLimiter: options.aiLimiter }),
  });
  services.push(service);
  return { origin: (await service.listen()).origin, store, calls };
}

async function post(origin: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json<Body>(response: Response): Promise<Body> {
  return (await response.json()) as Body;
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

// ---------------------------------------------------------------------------------------------
// Fixtures: an approved background with the constant Coprime, and librarian output
// ---------------------------------------------------------------------------------------------

function wireOperator(overrides: Record<string, unknown> = {}) {
  return {
    id: "operator:coprime",
    symbol: "Coprime",
    displayName: "coprime",
    parameters: ["integer", "integer"],
    result: "proposition",
    latex: {
      template: String.raw`#1\perp #2`,
      precedence: "relation",
      parse: { trigger: String.raw`\perp`, notation: "infix" },
    },
    naturalLanguage: { template: "#1 and #2 are coprime", negated: "#1 and #2 are not coprime" },
    ...overrides,
  };
}

function backgroundOutput() {
  return {
    result: {
      kind: "background-proposal",
      background: {
        level: "first-year undergraduate",
        summary: "Elementary number theory.",
        assumptions: ["Divisibility of integers"],
        domains: ["number theory"],
        maximumLevel: "undergraduate",
      },
      constants: [{ operator: wireOperator(), rationale: "The goal uses it." }],
    },
  };
}

const ANY_PROPOSITION = {
  section: "any",
  polarity: "any",
  role: "proposition",
} as const;

function wireResult(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    slug,
    name: `Result ${slug}`,
    description: `The general result ${slug}.`,
    domains: ["number theory"],
    level: "foundational",
    parameters: [
      { symbol: "a", sort: "integer" },
      { symbol: "b", sort: "integer" },
      { symbol: "c", sort: "integer" },
    ],
    premises: [],
    statement: ["Equivalent", ["Coprime", "a", "b"], ["Coprime", "b", "a"]],
    applicationDirections: ["forward", "backward"],
    patterns: [{ expression: ["Coprime", "a", "b"], direction: "forward", ...ANY_PROPOSITION }],
    ...overrides,
  };
}

/** Coprimality is symmetric: an equivalence, which gets a converse variant. */
const SYMMETRY = wireResult("coprime-symmetry");
/** Needs Divides, so it is admitted only when the divisibility pack is selected. */
const CANCELLATION = wireResult("coprime-cancellation", {
  premises: [
    ["Coprime", "a", "b"],
    ["Divides", "a", ["Multiply", "b", "c"]],
  ],
  statement: ["Divides", "a", "c"],
  patterns: [
    {
      expression: ["Coprime", "a", "b"],
      direction: "forward",
      section: "hypothesis",
      polarity: "negative",
      role: "proposition",
    },
    {
      expression: ["Divides", "a", "c"],
      direction: "backward",
      section: "goal",
      polarity: "positive",
      role: "proposition",
    },
  ],
});
const USES_UNKNOWN_OPERATOR = wireResult("uses-gcd", {
  statement: ["Equal", ["Gcd", "a", "b"], 1],
  patterns: [
    { expression: ["Gcd", "a", "b"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
  ],
});
const NOT_A_PROPOSITION = wireResult("not-a-proposition", {
  statement: ["Add", "a", "b"],
  patterns: [
    { expression: ["Add", "a", "b"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
  ],
});
const OUTSIDE_BACKGROUND = wireResult("graduate-result", {
  domains: ["topology"],
  level: "graduate",
});
const UNREADABLE = wireResult("unreadable", { statement: [1, "a"] });

function libraryOutput(
  results: readonly unknown[] = [SYMMETRY],
  newConstants: readonly unknown[] = [],
) {
  return { result: { kind: "library-proposal", results, newConstants } };
}

function gcd(overrides: Record<string, unknown> = {}) {
  return {
    operator: wireOperator({
      id: "operator:gcd",
      symbol: "Gcd",
      displayName: "greatest common divisor",
      result: "integer",
      latex: {
        template: String.raw`\gcd\left(#1, #2\right)`,
        precedence: "atom",
        parse: { trigger: String.raw`\gcd`, notation: "function" },
      },
      naturalLanguage: { template: "the gcd of #1 and #2", negated: null },
      ...overrides,
    }),
    rationale: "Results are stated with the greatest common divisor.",
  };
}

const GCD_SYMMETRY = wireResult("gcd-symmetry", {
  statement: ["Equal", ["Gcd", "a", "b"], ["Gcd", "b", "a"]],
  patterns: [
    { expression: ["Gcd", "a", "b"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
  ],
});

function backgroundRuntime(librarian?: LlmTransport): AiRuntime {
  return {
    "background-proposer": { transport: async () => backgroundOutput(), dispatch },
    ...(librarian === undefined ? {} : { librarian: { transport: librarian, dispatch } }),
  };
}

const BACKGROUND_REFERENCE = { decisionId: "background-decision:1" };

function libraryRequest(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    id: "llm-call:library",
    approvedBackground: BACKGROUND_REFERENCE,
    packs: ["pack:divisibility"],
    ...overrides,
  };
}

function libraryDecision(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    decisionId: "library-decision:1",
    callId: "llm-call:library",
    approvedResultIds: ["result:library-coprime-symmetry", "result:library-coprime-cancellation"],
    decidedAt: "2026-10-15T12:30:00.000Z",
    ...overrides,
  };
}

/** Run the background steps so that the construction has an approved background. */
async function approveBackground(origin: string) {
  const proposed = await post(origin, "/ai/background", {
    constructionId: CONSTRUCTION,
    id: "llm-call:background",
    problem: PROBLEM,
  });
  expect(proposed.status).toBe(200);
  const decided = await post(origin, "/ai/background/decisions", {
    constructionId: CONSTRUCTION,
    decisionId: BACKGROUND_REFERENCE.decisionId,
    callId: "llm-call:background",
    decision: "approved",
    rationale: "Matches the problem.",
    decidedAt: "2026-10-15T12:00:00.000Z",
  });
  expect(decided.status).toBe(201);
}

async function librarianScenario(
  librarian: LlmTransport,
  options: Parameters<typeof running>[0] = {},
) {
  const scenario = await running({ ...options, ai: backgroundRuntime(librarian) });
  await approveBackground(scenario.origin);
  return scenario;
}

type ProposedBody = {
  status: string;
  provenance: unknown;
  callId: string;
  replayed: boolean;
  requestKind: string;
  results: {
    artifact: {
      id: string;
      layer: string;
      approval: { status: string };
      provenance: { kind: string; role: string; contextId: string };
      renderings: { latex: string; naturalLanguage: string };
      variantFamilyId?: string;
    };
    variants: { id: string; approval: { status: string } }[];
    newConstantSymbols: string[];
  }[];
  rejected: { id: string; name: string; reasons: string[]; codes: string[] }[];
  newConstants: { operator: { symbol: string }; rationale: string; usedBy: string[] }[];
  rejectedConstants: { symbol: string; reason: string }[];
};

// ---------------------------------------------------------------------------------------------
// POST /ai/library
// ---------------------------------------------------------------------------------------------

describe("library endpoint", () => {
  it("judges every result deterministically and writes nothing to any library scope", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin, store } = await librarianScenario(async (call) => {
      seen.push(call);
      return libraryOutput([
        SYMMETRY,
        CANCELLATION,
        USES_UNKNOWN_OPERATOR,
        NOT_A_PROPOSITION,
        OUTSIDE_BACKGROUND,
        UNREADABLE,
      ]);
    });
    const response = await post(origin, "/ai/library", libraryRequest());
    expect(response.status).toBe(200);
    const body = await json<ProposedBody>(response);
    expect(body).toMatchObject({
      status: "proposed",
      provenance: { kind: "minimal-context-llm", role: "librarian" },
      callId: "llm-call:library",
      replayed: false,
      requestKind: "initial",
      newConstants: [],
      rejectedConstants: [],
    });

    // Admitted results are drafts of the initial-problem layer, generated by the librarian, with
    // deterministic renderings and variants; none claims approval yet.
    expect(body.results.map(({ artifact }) => artifact.id)).toEqual([
      "result:library-coprime-symmetry",
      "result:library-coprime-cancellation",
    ]);
    const [symmetry, cancellation] = body.results;
    expect(symmetry!.artifact).toMatchObject({
      layer: "initial-problem",
      approval: { status: "draft" },
      provenance: { kind: "generated", role: "librarian", contextId: "llm-call:library" },
      variantFamilyId: "variant-family:result:library-coprime-symmetry",
    });
    expect(symmetry!.artifact.renderings.latex).toContain(String.raw`\perp`);
    expect(symmetry!.artifact.renderings.naturalLanguage).toContain("coprime");
    expect(symmetry!.variants.map(({ id }) => id)).toEqual([
      "result:library-coprime-symmetry/converse",
    ]);
    expect(cancellation!.variants.length).toBeGreaterThan(0);
    for (const entry of body.results) {
      for (const variant of entry.variants) expect(variant.approval.status).toBe("draft");
    }
    expect(cancellation!.artifact.renderings.latex).toContain(String.raw`\vdash`);

    // Rejected items keep their plain reasons and codes.
    const rejected = new Map(body.rejected.map((item) => [item.id, item]));
    expect([...rejected.keys()].sort()).toEqual([
      "result:library-graduate-result",
      "result:library-not-a-proposition",
      "result:library-unreadable",
      "result:library-uses-gcd",
    ]);
    expect(rejected.get("result:library-uses-gcd")).toMatchObject({
      codes: ["invalid-artifact"],
      reasons: [expect.stringContaining("Gcd")],
    });
    expect(rejected.get("result:library-not-a-proposition")?.reasons[0]).toContain(
      "not a well-sorted proposition",
    );
    expect(rejected.get("result:library-graduate-result")).toMatchObject({
      codes: ["outside-background"],
    });
    expect(rejected.get("result:library-graduate-result")?.reasons.join(" ")).toMatch(
      /topology.*outside|graduate.*exceeds/,
    );
    expect(rejected.get("result:library-unreadable")).toMatchObject({ codes: ["unreadable"] });

    // The librarian saw the background, the constants to cover and the packs' results, and
    // nothing about the problem.
    expect(seen).toHaveLength(1);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "librarian") throw new Error("Expected a librarian call.");
    expect(Object.keys(envelope.context).sort()).toEqual([
      "background",
      "constants",
      "existingResults",
      "kind",
    ]);
    expect(envelope.context.kind).toBe("initial");
    expect(envelope.context.background).toMatchObject({
      level: "first-year undergraduate",
      domains: ["number theory"],
    });
    expect(envelope.context.constants.map(({ symbol }) => symbol)).toEqual(["Divides", "Coprime"]);
    const existing = envelope.context.existingResults.map(({ id }) => id);
    expect(existing).toContain("result:divides-reflexivity");
    expect(existing).toContain("result:modus-tollens");
    expect(existing).not.toContain("result:closure-extensive");
    expect(JSON.stringify(seen[0]!.messages)).not.toContain("m = n + 1");
    expect(JSON.stringify(seen[0]!.messages)).not.toContain(PROBLEM.title);
    expect(seen[0]!.messages[0].content).toContain("You are given no problem");

    // Nothing is written to any library scope, and no session exists.
    expect(await store.libraryTransaction(async (tx) => tx.listAdditionEvents(undefined))).toEqual(
      [],
    );
    expect(
      await store.libraryTransaction(async (tx) => tx.listLibraryArtifacts(undefined)),
    ).toEqual([]);
  });

  it("replays by call ID without contacting the provider and answers identically", async () => {
    let count = 0;
    const { origin } = await librarianScenario(async () => {
      count += 1;
      return libraryOutput([SYMMETRY, USES_UNKNOWN_OPERATOR]);
    });
    const first = await json<ProposedBody>(await post(origin, "/ai/library", libraryRequest()));
    const replay = await post(origin, "/ai/library", libraryRequest());
    expect(replay.status).toBe(200);
    const second = await json<ProposedBody>(replay);
    expect(second.replayed).toBe(true);
    expect({ ...second, replayed: false }).toEqual(first);
    expect(count).toBe(1);
    // The same call ID for another request is a conflict.
    const changed = await post(origin, "/ai/library", libraryRequest({ packs: [] }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ diagnostics: [{ code: "call-id-conflict" }] });
    expect(count).toBe(1);
  });

  it("reports a context request or a refusal as a non-proposal", async () => {
    for (const output of [
      {
        kind: "insufficient-context",
        requestedCategories: ["constant-detail"],
        rationale: "Too few constants.",
      },
      { kind: "declined", reason: "Everything is in the library already." },
    ]) {
      const { origin } = await librarianScenario(async () => ({ result: output }));
      const response = await post(origin, "/ai/library", libraryRequest());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: output.kind, result: output });
    }
  });

  it("surfaces a provider failure as 503 and an invalid answer as 422, recording both", async () => {
    const failing = await librarianScenario(async () => {
      throw new Error("provider down");
    });
    const failed = await post(failing.origin, "/ai/library", libraryRequest());
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ status: "transport-failed" });
    const invalid = await librarianScenario(async () => ({ result: { kind: "library-proposal" } }));
    const rejected = await post(invalid.origin, "/ai/library", libraryRequest());
    expect(rejected.status).toBe(422);
    expect(await rejected.json()).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-output" }],
    });
    // More results than the cap are an invalid answer, not a truncated one.
    const tooMany = await librarianScenario(async () =>
      libraryOutput(Array.from({ length: 41 }, (_, index) => wireResult(`r${index}`))),
    );
    expect((await post(tooMany.origin, "/ai/library", libraryRequest())).status).toBe(422);
  });

  it("answers 503 ai-disabled when the role is not configured or evidence is not stored", async () => {
    const unconfigured = await running({ ai: backgroundRuntime() });
    await approveBackground(unconfigured.origin);
    const response = await post(unconfigured.origin, "/ai/library", libraryRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "disabled",
      diagnostics: [{ code: "ai-disabled" }],
    });
    const unstored = await running({
      ai: backgroundRuntime(async () => libraryOutput()),
      calls: null,
    });
    expect((await post(unstored.origin, "/ai/library", libraryRequest())).status).toBe(503);
    expect((await post(unstored.origin, "/ai/library/decisions", libraryDecision())).status).toBe(
      503,
    );
  });

  it("reports the librarian in the capabilities only with a transport and evidence storage", async () => {
    const roles = async (origin: string) =>
      (
        (await (await fetch(`${origin}/ai/capabilities`)).json()) as {
          roles: Record<string, boolean>;
        }
      ).roles;
    expect(await roles((await running()).origin)).toMatchObject({ librarian: false });
    expect(
      await roles((await running({ ai: backgroundRuntime(async () => libraryOutput()) })).origin),
    ).toMatchObject({ librarian: true });
    expect(
      await roles(
        (await running({ ai: backgroundRuntime(async () => libraryOutput()), calls: null })).origin,
      ),
    ).toMatchObject({ librarian: false });
  });

  it("shares the cost guard: 429 with Retry-After, replays free, and recovery with the clock", async () => {
    let now = 1_000_000;
    let count = 0;
    const { origin } = await librarianScenario(
      async () => {
        count += 1;
        return libraryOutput();
      },
      { aiLimiter: createAiLimiter({ maxConcurrent: 2, ratePerMinute: 2, nowMs: () => now }) },
    );
    // The background proposal spent one token of the two; the first library call spends the other.
    expect(
      (await post(origin, "/ai/library", libraryRequest({ id: "llm-call:library-1" }))).status,
    ).toBe(200);
    const limited = await post(origin, "/ai/library", libraryRequest({ id: "llm-call:library-2" }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({
      status: "rate-limited",
      diagnostics: [{ code: "ai-rate-limited" }],
    });
    expect(count).toBe(1);
    const replay = await post(origin, "/ai/library", libraryRequest({ id: "llm-call:library-1" }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(count).toBe(1);
    now += 120_000;
    expect(
      (await post(origin, "/ai/library", libraryRequest({ id: "llm-call:library-2" }))).status,
    ).toBe(200);
    expect(count).toBe(2);
  });

  it("rejects invalid requests, and requests that carry declarations or a problem, before any call", async () => {
    let count = 0;
    const { origin } = await librarianScenario(async () => {
      count += 1;
      return libraryOutput();
    });
    const invalid: readonly Record<string, unknown>[] = [
      { approvedBackground: undefined },
      { approvedBackground: {} },
      { approvedBackground: { decisionId: "background-decision:1", constants: [wireOperator()] } },
      { approvedBackground: "background-decision:1" },
      { packs: undefined },
      { packs: ["pack:nonexistent"] },
      { packs: ["pack:divisibility", "pack:divisibility"] },
      // The librarian never sees the problem, so a request cannot carry one.
      { problem: PROBLEM },
      { background: { level: "x", summary: "y", assumptions: [] } },
      { constants: [wireOperator()] },
      { existingResults: [] },
      { kind: "initial" },
      { id: "not an id" },
    ];
    for (const overrides of invalid) {
      const response = await post(origin, "/ai/library", libraryRequest(overrides));
      expect(response.status, JSON.stringify(overrides)).toBe(400);
    }
    expect(count).toBe(0);
    expect((await fetch(`${origin}/ai/library`)).status).toBe(405);
    expect((await fetch(`${origin}/ai/library/decisions`)).status).toBe(405);
  });

  it("resolves the background by decision ID only: unknown, rejected and foreign decisions are refused", async () => {
    let count = 0;
    const { origin } = await librarianScenario(async () => {
      count += 1;
      return libraryOutput();
    });
    const unknown = await post(
      origin,
      "/ai/library",
      libraryRequest({ approvedBackground: { decisionId: "background-decision:missing" } }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ diagnostics: [{ code: "decision-not-found" }] });
    const foreign = await post(
      origin,
      "/ai/library",
      libraryRequest({ constructionId: "construction:other" }),
    );
    expect(foreign.status).toBe(404);
    await post(origin, "/ai/background/decisions", {
      constructionId: CONSTRUCTION,
      decisionId: "background-decision:rejected",
      callId: "llm-call:background",
      decision: "rejected",
      rationale: "No.",
      decidedAt: "2026-10-15T12:00:00.000Z",
    });
    const rejected = await post(
      origin,
      "/ai/library",
      libraryRequest({ approvedBackground: { decisionId: "background-decision:rejected" } }),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      diagnostics: [{ code: "decision-not-approved" }],
    });
    // A library decision is not a background decision.
    expect(count).toBe(0);
  });

  it("accepts new constants the results need, resolving them against the registry", async () => {
    const referenceToRegistry = {
      operator: wireOperator({
        id: "operator:my-closure",
        symbol: "Closure",
        parameters: ["set-of-elements"],
        result: "set-of-elements",
        latex: { template: String.raw`\bar{#1}`, precedence: "atom", parse: null },
        naturalLanguage: { template: "the closure of #1", negated: null },
      }),
      rationale: "Reuses the registry's closure.",
    };
    const closureResult = wireResult("closure-idempotent", {
      domains: ["number theory"],
      parameters: [{ symbol: "A", sort: "set-of-elements" }],
      statement: ["Equal", ["Closure", ["Closure", "A"]], ["Closure", "A"]],
      patterns: [
        {
          expression: ["Closure", ["Closure", "A"]],
          direction: "forward",
          ...ANY_PROPOSITION,
          role: "term",
        },
      ],
    });
    const { origin } = await librarianScenario(async () =>
      libraryOutput([GCD_SYMMETRY, SYMMETRY, closureResult], [gcd(), referenceToRegistry]),
    );
    const body = await json<ProposedBody>(await post(origin, "/ai/library", libraryRequest()));
    expect(body.results.map(({ artifact }) => artifact.id)).toEqual([
      "result:library-gcd-symmetry",
      "result:library-coprime-symmetry",
      "result:library-closure-idempotent",
    ]);
    expect(body.results[0]!.newConstantSymbols).toEqual(["Gcd"]);
    expect(body.results[1]!.newConstantSymbols).toEqual([]);
    expect(body.results[2]!.newConstantSymbols).toEqual(["Closure"]);
    expect(body.newConstants.map(({ operator, usedBy }) => [operator.symbol, usedBy])).toEqual([
      ["Gcd", ["result:library-gcd-symmetry"]],
      ["Closure", ["result:library-closure-idempotent"]],
    ]);
    // The reference became the registry's own declaration.
    const registry = starterLibraryPacks()
      .flatMap((pack) => pack.operators)
      .find(({ symbol }) => symbol === "Closure");
    expect(body.newConstants[1]!.operator).toEqual(registry);
    expect(body.rejectedConstants).toEqual([]);
  });

  it("sets aside a new constant that clashes with the registry and rejects the results that need it", async () => {
    const clashing = gcd({
      id: "operator:closure-clash",
      symbol: "Closure",
      parameters: ["integer"],
      result: "integer",
      latex: { template: String.raw`\overline{#1}`, precedence: "atom", parse: null },
      naturalLanguage: { template: "the closure of #1", negated: null },
    });
    const needsIt = wireResult("closure-integer", {
      statement: ["Equal", ["Closure", "a"], "a"],
      patterns: [
        { expression: ["Closure", "a"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
      ],
    });
    const { origin } = await librarianScenario(async () =>
      libraryOutput([SYMMETRY, needsIt], [clashing]),
    );
    const body = await json<ProposedBody>(await post(origin, "/ai/library", libraryRequest()));
    expect(body.results.map(({ artifact }) => artifact.id)).toEqual([
      "result:library-coprime-symmetry",
    ]);
    expect(body.newConstants).toEqual([]);
    expect(body.rejectedConstants).toMatchObject([
      { symbol: "Closure", reason: expect.stringContaining("pack:closure") },
    ]);
    expect(body.rejected).toMatchObject([
      { id: "result:library-closure-integer", reasons: [expect.stringContaining("Closure")] },
    ]);
  });

  it("refuses an answer whose new constant repeats a constant of the context", async () => {
    const { origin } = await librarianScenario(async () =>
      libraryOutput([SYMMETRY], [{ operator: wireOperator(), rationale: "Again." }]),
    );
    expect((await post(origin, "/ai/library", libraryRequest())).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------------------------
// POST /ai/library/decisions
// ---------------------------------------------------------------------------------------------

describe("library decisions", () => {
  async function proposed(
    results: readonly unknown[] = [SYMMETRY, CANCELLATION, USES_UNKNOWN_OPERATOR],
    newConstants: readonly unknown[] = [],
  ) {
    const scenario = await librarianScenario(async () => libraryOutput(results, newConstants));
    expect((await post(scenario.origin, "/ai/library", libraryRequest())).status).toBe(200);
    return scenario;
  }

  it("records the kept results by ID, idempotently, and stores no artifact", async () => {
    const { origin, calls } = await proposed();
    const kept = libraryDecision({
      approvedResultIds: ["result:library-coprime-cancellation", "result:library-coprime-symmetry"],
    });
    const recorded = await post(origin, "/ai/library/decisions", kept);
    expect(recorded.status).toBe(201);
    const body = await json<{
      status: string;
      replayed: boolean;
      decision: {
        decision: string;
        approvedManifestId: string;
        approvedResultIds: string[];
        reviewerId: string;
        rationale: string;
      };
      approvedLibrary: { approvedResultIds: string[]; variantCount: number };
    }>(recorded);
    expect(body).toMatchObject({
      status: "recorded",
      replayed: false,
      decision: {
        decision: "approved",
        approvedManifestId: "library-approval:library-decision:1",
        // Stored in the proposal's order, whatever order the client listed them in.
        approvedResultIds: [
          "result:library-coprime-symmetry",
          "result:library-coprime-cancellation",
        ],
        reviewerId: "actor:web",
      },
    });
    expect(body.approvedLibrary.variantCount).toBeGreaterThan(1);

    // The row names IDs only: it holds no statement, premise or pattern.
    const stored = await readLibraryProposalDecision(
      calls,
      { kind: "construction", id: CONSTRUCTION },
      "library-decision:1",
    );
    expect(stored.status).toBe("found");
    const text = JSON.stringify(stored.status === "found" ? stored.decision : undefined);
    for (const absent of ["statement", "premises", "patterns", "Coprime"]) {
      expect(text).not.toContain(absent);
    }

    // A retry replays, in any order; another review under the same ID is a conflict.
    const replay = await post(origin, "/ai/library/decisions", {
      ...kept,
      approvedResultIds: ["result:library-coprime-symmetry", "result:library-coprime-cancellation"],
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    const conflict = await post(
      origin,
      "/ai/library/decisions",
      libraryDecision({ approvedResultIds: ["result:library-coprime-symmetry"] }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      diagnostics: [{ code: "decision-id-conflict" }],
    });
    // Another decision may keep a different subset.
    const subset = await post(
      origin,
      "/ai/library/decisions",
      libraryDecision({
        decisionId: "library-decision:2",
        approvedResultIds: ["result:library-coprime-symmetry"],
      }),
    );
    expect(subset.status).toBe(201);
  });

  it("refuses results the gate did not admit, unknown IDs, unreviewable calls and artifacts from the client", async () => {
    const { origin } = await proposed();
    const notAdmitted = await post(
      origin,
      "/ai/library/decisions",
      libraryDecision({
        approvedResultIds: ["result:library-coprime-symmetry", "result:library-uses-gcd"],
      }),
    );
    expect(notAdmitted.status).toBe(409);
    expect(await notAdmitted.json()).toMatchObject({
      diagnostics: [{ code: "result-not-admitted", message: expect.stringContaining("uses-gcd") }],
    });
    expect(
      (
        await post(
          origin,
          "/ai/library/decisions",
          libraryDecision({ approvedResultIds: ["result:library-invented"] }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await post(origin, "/ai/library/decisions", libraryDecision({ callId: "llm-call:missing" })))
        .status,
    ).toBe(404);
    // The background call is a stored call, but not a library proposal.
    const background = await post(
      origin,
      "/ai/library/decisions",
      libraryDecision({ callId: "llm-call:background" }),
    );
    expect(background.status).toBe(409);
    expect(await background.json()).toMatchObject({
      diagnostics: [{ code: "proposal-not-reviewable" }],
    });
    expect(
      (
        await post(
          origin,
          "/ai/library/decisions",
          libraryDecision({ constructionId: "construction:other" }),
        )
      ).status,
    ).toBe(404);

    // The decision carries IDs only; mathematics sent by the client is refused outright.
    const forged = [
      { artifacts: [{ id: "result:library-evil" }] },
      { results: [] },
      { approvedResults: [{ id: "result:library-coprime-symmetry", statement: "p" }] },
      { approvedResultIds: [{ id: "result:library-coprime-symmetry", statement: "p" }] },
      { approvedResultIds: [] },
      { approvedResultIds: ["result:library-coprime-symmetry", "result:library-coprime-symmetry"] },
      { decision: "rejected" },
      { rationale: "" },
      { decidedAt: "yesterday" },
    ];
    for (const overrides of forged) {
      const response = await post(origin, "/ai/library/decisions", libraryDecision(overrides));
      expect(response.status, JSON.stringify(overrides)).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The formalizer with an approved library
// ---------------------------------------------------------------------------------------------

describe("formalizer with an approved library", () => {
  function formalizeRequest(overrides: Record<string, unknown> = {}) {
    return {
      constructionId: CONSTRUCTION,
      id: "llm-call:formalize",
      problem: PROBLEM,
      background: setDraft().background,
      preferences: setDraft().preferences,
      libraryLayerIds: ["layer:global", "layer:initial-problem"],
      packs: ["pack:divisibility"],
      approvedBackground: BACKGROUND_REFERENCE,
      approvedLibrary: { decisionId: "library-decision:1" },
      ...overrides,
    };
  }

  async function scenarioWithLibrary(
    formalizer: LlmTransport,
    results: readonly unknown[] = [SYMMETRY, CANCELLATION],
    newConstants: readonly unknown[] = [],
    approved: readonly string[] = [
      "result:library-coprime-symmetry",
      "result:library-coprime-cancellation",
    ],
  ) {
    const scenario = await running({
      ai: {
        ...backgroundRuntime(async () => libraryOutput(results, newConstants)),
        "proof-state-formalizer": { transport: formalizer, dispatch },
      },
    });
    await approveBackground(scenario.origin);
    await post(scenario.origin, "/ai/library", libraryRequest());
    expect(
      (
        await post(
          scenario.origin,
          "/ai/library/decisions",
          libraryDecision({ approvedResultIds: approved }),
        )
      ).status,
    ).toBe(201);
    return scenario;
  }

  it("shows the formalizer the packs' results followed by the approved results and their variants", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin } = await scenarioWithLibrary(async (call) => {
      seen.push(call);
      return { result: { kind: "declined", reason: "Stop after the context." } };
    });
    const response = await post(origin, "/ai/formalize", formalizeRequest());
    expect(response.status).toBe(200);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "proof-state-formalizer") throw new Error("Expected formalizer.");
    const ids = envelope.context.approvedLibrary.results.map(({ id }) => id);
    const divisibility = starterLibraryPacks()
      .find(({ id }) => id === "pack:divisibility")!
      .results.map(({ id }) => id);
    expect(ids.slice(0, divisibility.length)).toEqual(divisibility);
    expect(ids.slice(divisibility.length)).toEqual([
      "result:library-coprime-symmetry",
      "result:library-coprime-cancellation",
      "result:library-coprime-symmetry/converse",
      "result:library-coprime-cancellation/contrapositive",
      "result:library-coprime-cancellation/bundle-premises",
    ]);
    const symmetry = envelope.context.approvedLibrary.results.find(
      ({ id }) => id === "result:library-coprime-symmetry",
    );
    expect(symmetry).toMatchObject({
      name: "Result coprime-symmetry",
      statement: ["Equivalent", ["Coprime", "a", "b"], ["Coprime", "b", "a"]],
      premises: [],
    });
    expect(JSON.stringify(envelope)).not.toContain("approvedBackground");
    expect(JSON.stringify(envelope)).not.toContain("library-decision");
  });

  it("leaves the context unchanged when no library is named", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin } = await scenarioWithLibrary(async (call) => {
      seen.push(call);
      return { result: { kind: "declined", reason: "Stop after the context." } };
    });
    const response = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ approvedLibrary: undefined }),
    );
    expect(response.status).toBe(200);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "proof-state-formalizer") throw new Error("Expected formalizer.");
    expect(
      envelope.context.approvedLibrary.results.every(({ id }) => !id.includes("library-")),
    ).toBe(true);
  });

  it("resolves the library by decision ID only, and adds the new constants the kept results apply", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin } = await scenarioWithLibrary(
      async (call) => {
        seen.push(call);
        return { result: { kind: "declined", reason: "Stop after the context." } };
      },
      [GCD_SYMMETRY, SYMMETRY],
      [gcd()],
      ["result:library-gcd-symmetry"],
    );
    const unknown = await post(
      origin,
      "/ai/formalize",
      formalizeRequest({ approvedLibrary: { decisionId: "library-decision:missing" } }),
    );
    expect(unknown.status).toBe(404);
    // A background decision is not a library decision, and the reverse.
    expect(
      (
        await post(
          origin,
          "/ai/formalize",
          formalizeRequest({ approvedLibrary: { decisionId: "background-decision:1" } }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          origin,
          "/ai/formalize",
          formalizeRequest({ approvedBackground: { decisionId: "library-decision:1" } }),
        )
      ).status,
    ).toBe(404);
    for (const smuggled of [
      { approvedLibrary: { decisionId: "library-decision:1", results: [] } },
      { approvedLibrary: { constructionId: CONSTRUCTION } },
      { approvedLibrary: ["result:library-coprime-symmetry"] },
    ]) {
      expect((await post(origin, "/ai/formalize", formalizeRequest(smuggled))).status).toBe(400);
    }
    expect(seen).toHaveLength(0);

    const ok = await post(origin, "/ai/formalize", formalizeRequest());
    expect(ok.status).toBe(200);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "proof-state-formalizer") throw new Error("Expected formalizer.");
    // Only the kept result's new constant joins the operators; the other result is not shown.
    expect(envelope.context.approvedLibrary.operators.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Coprime",
      "Gcd",
    ]);
    const shown = envelope.context.approvedLibrary.results.map(({ id }) => id);
    expect(shown).toContain("result:library-gcd-symmetry");
    expect(shown).not.toContain("result:library-coprime-symmetry");
  });
});

// ---------------------------------------------------------------------------------------------
// Setup: Check setup and Start exploring with an approved library
// ---------------------------------------------------------------------------------------------

describe("problem setup with an approved library", () => {
  const LIBRARY_REFERENCE = { constructionId: CONSTRUCTION, decisionId: "library-decision:1" };
  const BACKGROUND_REF = { constructionId: CONSTRUCTION, decisionId: "background-decision:1" };

  function draft(overrides: Record<string, unknown> = {}) {
    return setDraft({
      background: {
        level: "first-year undergraduate",
        summary: "Elementary number theory.",
        assumptions: [],
        domains: ["number theory"],
        maximumLevel: "undergraduate",
      },
      preferences: undefined,
      packs: ["pack:divisibility"],
      declarations: [
        { symbol: "m", sort: "integer" },
        { symbol: "n", sort: "integer" },
      ],
      hypotheses: [],
      goals: [{ format: "latex", latex: String.raw`m \perp n` }],
      ...overrides,
    });
  }

  async function scenario(
    results: readonly unknown[] = [SYMMETRY, CANCELLATION],
    newConstants: readonly unknown[] = [],
    approved: readonly string[] = [
      "result:library-coprime-symmetry",
      "result:library-coprime-cancellation",
    ],
  ) {
    const started = await librarianScenario(async () => libraryOutput(results, newConstants));
    await post(started.origin, "/ai/library", libraryRequest());
    expect(
      (
        await post(
          started.origin,
          "/ai/library/decisions",
          libraryDecision({ approvedResultIds: approved }),
        )
      ).status,
    ).toBe(201);
    return started;
  }

  type Review = {
    digest: string;
    operators: { symbol: string }[];
    initialLibrary?: {
      results: { id: string; name: string; statement: unknown; premises: unknown[] }[];
      variantCount: number;
      addedOperatorSymbols: string[];
    };
  };

  async function check(origin: string, body: Record<string, unknown>) {
    const response = await post(origin, "/problem-drafts/validate", { draft: draft(), ...body });
    return { response, body: await json<{ review?: Review; diagnostics?: unknown[] }>(response) };
  }

  async function events(origin: string, sessionId: string) {
    const response = await fetch(
      `${origin}/proof-sessions/${encodeURIComponent(sessionId)}/library/events`,
    );
    expect(response.status).toBe(200);
    return (
      await json<{
        events: {
          id: string;
          sequence: number;
          layer: string;
          sessionId: string;
          occurredAt: string;
          origin: { kind: string; actorId?: string };
          admission: { decision: string };
          artifact: { id: string; approval: { status: string; reviewerId?: string } };
        }[];
      }>(response)
    ).events;
  }

  it("shows the approved results in the review and covers them with its digest", async () => {
    const { origin, store } = await scenario();
    const withoutLibrary = await check(origin, { approvedBackground: BACKGROUND_REF });
    expect(withoutLibrary.response.status).toBe(200);
    expect(withoutLibrary.body.review).not.toHaveProperty("initialLibrary");

    const checked = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(checked.response.status).toBe(200);
    const review = checked.body.review!;
    expect(review.initialLibrary?.results.map(({ id }) => id)).toEqual([
      "result:library-coprime-symmetry",
      "result:library-coprime-cancellation",
    ]);
    expect(review.initialLibrary?.results[0]).toMatchObject({
      name: "Result coprime-symmetry",
      statement: ["Equivalent", ["Coprime", "a", "b"], ["Coprime", "b", "a"]],
    });
    expect(review.initialLibrary?.variantCount).toBe(3);
    expect(review.initialLibrary?.addedOperatorSymbols).toEqual([]);
    expect(review.digest).not.toBe(withoutLibrary.body.review!.digest);
    // The check writes nothing: no session exists, and the library holds no addition.
    expect(store.transactions).toBe(0);
    expect(await store.libraryTransaction(async (tx) => tx.listAdditionEvents(undefined))).toEqual(
      [],
    );
  });

  it("creates the session and records the approved results and variants exactly once, replay included", async () => {
    const { origin } = await scenario();
    const { body } = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    const approval = {
      sessionId: "session:library",
      draft: draft(),
      reviewedDigest: body.review!.digest,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    };
    const created = await post(origin, "/proof-sessions", approval);
    expect(created.status).toBe(201);

    const recorded = await events(origin, "session:library");
    expect(recorded.map(({ artifact }) => artifact.id)).toEqual([
      "result:library-coprime-symmetry",
      "result:library-coprime-cancellation",
      "result:library-coprime-symmetry/converse",
      "result:library-coprime-cancellation/contrapositive",
      "result:library-coprime-cancellation/bundle-premises",
    ]);
    recorded.forEach((event, index) => {
      expect(event).toMatchObject({
        sequence: index,
        layer: "initial-problem",
        sessionId: "session:library",
        occurredAt: "2026-10-15T12:30:00.000Z",
        origin: { kind: "setup", actorId: "actor:web" },
        admission: { decision: "admitted" },
        artifact: { approval: { status: "approved", reviewerId: "actor:web" } },
      });
      expect(event.id).toBe(
        `library-addition:session:library:library-decision:1:${event.artifact.id}`,
      );
    });

    // The session library lists them as stored additions.
    const library = await json<{ entries: { source: string; artifact: { id: string } }[] }>(
      await fetch(`${origin}/proof-sessions/session%3Alibrary/library`),
    );
    const stored = library.entries
      .filter(({ source }) => source === "stored-library")
      .map(({ artifact }) => artifact.id);
    expect(stored).toEqual(recorded.map(({ artifact }) => artifact.id));

    // A replay of the same approval adds nothing.
    const replay = await post(origin, "/proof-sessions", approval);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(await events(origin, "session:library")).toEqual(recorded);
  });

  it("finishes an interrupted recording when the same approval is repeated, adding each result once", async () => {
    const { origin, store } = await scenario();
    const { body } = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    const approval = {
      sessionId: "session:interrupted",
      draft: draft(),
      reviewedDigest: body.review!.digest,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    };
    // The library store fails after the first two additions of the new session.
    store.armFailure(2);
    const interrupted = await post(origin, "/proof-sessions", approval);
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({
      diagnostics: [{ code: "initial-library-incomplete" }],
    });
    // The session exists, with part of its library.
    const partial = await events(origin, "session:interrupted");
    expect(partial).toHaveLength(2);

    const finished = await post(origin, "/proof-sessions", approval);
    expect(finished.status).toBe(200);
    expect(await finished.json()).toMatchObject({ replayed: true });
    const complete = await events(origin, "session:interrupted");
    expect(complete).toHaveLength(5);
    expect(complete.slice(0, 2)).toEqual(partial);
    expect(new Set(complete.map(({ artifact }) => artifact.id)).size).toBe(5);
    expect(new Set(complete.map(({ id }) => id)).size).toBe(5);

    // And once more changes nothing.
    expect((await post(origin, "/proof-sessions", approval)).status).toBe(200);
    expect(await events(origin, "session:interrupted")).toEqual(complete);
  });

  it("records only the kept results, and adds only the new constants they apply", async () => {
    const { origin } = await scenario(
      [GCD_SYMMETRY, SYMMETRY],
      [gcd()],
      ["result:library-coprime-symmetry"],
    );
    const { body } = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(body.review!.initialLibrary?.addedOperatorSymbols).toEqual([]);
    expect(body.review!.operators.map(({ symbol }) => symbol)).not.toContain("Gcd");
    expect(
      (
        await post(origin, "/proof-sessions", {
          sessionId: "session:kept",
          draft: draft(),
          reviewedDigest: body.review!.digest,
          approvedBackground: BACKGROUND_REF,
          approvedLibrary: LIBRARY_REFERENCE,
        })
      ).status,
    ).toBe(201);
    expect((await events(origin, "session:kept")).map(({ artifact }) => artifact.id)).toEqual([
      "result:library-coprime-symmetry",
      "result:library-coprime-symmetry/converse",
    ]);
  });

  it("adds a new constant that a kept result applies to the session's operators", async () => {
    const { origin } = await scenario([GCD_SYMMETRY], [gcd()], ["result:library-gcd-symmetry"]);
    const { body } = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(body.review!.initialLibrary?.addedOperatorSymbols).toEqual(["Gcd"]);
    expect(body.review!.operators.map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Coprime",
      "Gcd",
    ]);
    const created = await post(origin, "/proof-sessions", {
      sessionId: "session:gcd",
      draft: draft(),
      reviewedDigest: body.review!.digest,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(created.status).toBe(201);
    expect(
      (await json<{ session: { operators: { symbol: string }[] } }>(created)).session.operators.map(
        ({ symbol }) => symbol,
      ),
    ).toEqual(["Divides", "Coprime", "Gcd"]);
    expect((await events(origin, "session:gcd"))[0]).toMatchObject({
      artifact: { id: "result:library-gcd-symmetry" },
      admission: { decision: "admitted" },
    });
    // The setup cannot use the new constant's notation without the library that adds it.
    const without = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      draft: draft({ goals: [{ format: "latex", latex: String.raw`\gcd(m, n) = 1` }] }),
    });
    expect(without.response.status).toBe(422);
    const withLibrary = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
      draft: draft({ goals: [{ format: "latex", latex: String.raw`\gcd(m, n) = 1` }] }),
    });
    expect(withLibrary.response.status).toBe(200);
  });

  it("treats a review made without the library, or with another one, as stale", async () => {
    const { origin, store } = await scenario();
    const bare = await check(origin, { approvedBackground: BACKGROUND_REF });
    const stale = await post(origin, "/proof-sessions", {
      sessionId: "session:stale",
      draft: draft(),
      reviewedDigest: bare.body.review!.digest,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ diagnostics: [{ code: "review-stale" }] });
    expect(store.transactions).toBe(0);
    // A library with fewer kept results is another library.
    await post(
      origin,
      "/ai/library/decisions",
      libraryDecision({
        decisionId: "library-decision:2",
        approvedResultIds: ["result:library-coprime-symmetry"],
      }),
    );
    const reviewed = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    const other = await post(origin, "/proof-sessions", {
      sessionId: "session:other",
      draft: draft(),
      reviewedDigest: reviewed.body.review!.digest,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: { ...LIBRARY_REFERENCE, decisionId: "library-decision:2" },
    });
    expect(other.status).toBe(409);
  });

  it("reports results that the setup's operators or layers cannot take, with the check", async () => {
    const { origin } = await scenario();
    // The cancellation result applies Divides, which the divisibility pack provides.
    const noPack = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
      draft: draft({ packs: [] }),
    });
    expect(noPack.response.status).toBe(422);
    expect(noPack.body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "approved-library-invalid",
          path: ["approvedLibrary"],
          message: expect.stringContaining("Result coprime-cancellation"),
        }),
      ]),
    );
    const noLayer = await check(origin, {
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
      draft: draft({ libraryLayerIds: ["layer:global"] }),
    });
    expect(noLayer.response.status).toBe(422);
    expect(noLayer.body.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "approved-library-invalid",
          path: ["libraryLayerIds"],
        }),
      ]),
    );
    // Approval repeats the check and writes nothing.
    const refused = await post(origin, "/proof-sessions", {
      sessionId: "session:refused",
      draft: draft({ packs: [] }),
      reviewedDigest: `sha256:${"0".repeat(64)}`,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(refused.status).toBe(422);
    expect((await fetch(`${origin}/proof-sessions/session%3Arefused/library`)).status).toBe(404);
  });

  it("refuses an unresolvable, malformed or client-supplied library on the setup routes", async () => {
    const { origin } = await scenario();
    const missing = { constructionId: CONSTRUCTION, decisionId: "library-decision:missing" };
    expect(
      (await check(origin, { approvedBackground: BACKGROUND_REF, approvedLibrary: missing }))
        .response.status,
    ).toBe(404);
    expect(
      (
        await post(origin, "/proof-sessions", {
          sessionId: "session:x",
          draft: draft(),
          reviewedDigest: `sha256:${"0".repeat(64)}`,
          approvedBackground: BACKGROUND_REF,
          approvedLibrary: missing,
        })
      ).status,
    ).toBe(404);
    // A background decision does not name a library, and another construction's does not either.
    expect(
      (
        await check(origin, {
          approvedBackground: BACKGROUND_REF,
          approvedLibrary: { constructionId: CONSTRUCTION, decisionId: "background-decision:1" },
        })
      ).response.status,
    ).toBe(404);
    expect(
      (
        await check(origin, {
          approvedBackground: BACKGROUND_REF,
          approvedLibrary: { ...LIBRARY_REFERENCE, constructionId: "construction:other" },
        })
      ).response.status,
    ).toBe(404);
    for (const malformed of [
      { constructionId: CONSTRUCTION },
      { ...LIBRARY_REFERENCE, results: [] },
      { ...LIBRARY_REFERENCE, artifacts: [{ id: "result:evil" }] },
      "library-decision:1",
    ]) {
      expect(
        (await check(origin, { approvedLibrary: malformed })).response.status,
        JSON.stringify(malformed),
      ).toBe(400);
      expect(
        (
          await post(origin, "/proof-sessions", {
            sessionId: "session:x",
            draft: draft(),
            reviewedDigest: `sha256:${"0".repeat(64)}`,
            approvedLibrary: malformed,
          })
        ).status,
        JSON.stringify(malformed),
      ).toBe(400);
    }
  });

  it("answers 503 on the setup routes when library or evidence storage is not available", async () => {
    const withoutLibrary = await running({
      ai: backgroundRuntime(async () => libraryOutput()),
      library: false,
    });
    await approveBackground(withoutLibrary.origin);
    const unavailable = await check(withoutLibrary.origin, { approvedLibrary: LIBRARY_REFERENCE });
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body).toMatchObject({ diagnostics: [{ code: "library-unavailable" }] });
    const withoutEvidence = await running({ calls: null });
    expect(
      (await check(withoutEvidence.origin, { approvedLibrary: LIBRARY_REFERENCE })).response.status,
    ).toBe(503);
  });
});
