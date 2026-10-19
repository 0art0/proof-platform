import { expect } from "vitest";
import type { LlmTransport } from "@proof/llm";
import { setDraft } from "../problem-setup.testing";
import { MemoryLibraryStore } from "../memory-library-store";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { ProofStoreTransactionError } from "../proof-repository";
import type { LibraryStoreTransaction } from "../library-repository";
import { createProofHttpService, type ProofHttpService } from ".";
import type { AiLimiter } from "./ai-rate-limit";
import type { AiRuntime } from "../ai-runtime";

/**
 * Fixtures shared by the librarian tests: an approved background with the constant Coprime,
 * scripted librarian output, and the setup flow that turns an approved library into a session.
 */

export const services: ProofHttpService[] = [];
export const dispatch = {
  provider: "test-provider",
  model: "test-model",
  promptVersion: "library-test-v1",
} as const;

export const CONSTRUCTION = "construction:library";
export const PROBLEM = {
  title: "Consecutive integers",
  statement: "Show that m and n are coprime when m = n + 1.",
};

/** A store whose Nth library transaction (counted from `armFailure`) fails with an unknown outcome. */
export class FlakyLibraryStore extends MemoryLibraryStore {
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

export type Running = { origin: string; store: FlakyLibraryStore; calls: MemoryLlmCallStore };

export async function running(
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

export async function post(origin: string, path: string, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function json<Body>(response: Response): Promise<Body> {
  return (await response.json()) as Body;
}

// ---------------------------------------------------------------------------------------------
// Fixtures: an approved background with the constant Coprime, and librarian output
// ---------------------------------------------------------------------------------------------

export function wireOperator(overrides: Record<string, unknown> = {}) {
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

export function backgroundOutput() {
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

export const ANY_PROPOSITION = {
  section: "any",
  polarity: "any",
  role: "proposition",
} as const;

export function wireResult(slug: string, overrides: Record<string, unknown> = {}) {
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
export const SYMMETRY = wireResult("coprime-symmetry");
/** Needs Divides, so it is admitted only when the divisibility pack is selected. */
export const CANCELLATION = wireResult("coprime-cancellation", {
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
export const USES_UNKNOWN_OPERATOR = wireResult("uses-gcd", {
  statement: ["Equal", ["Gcd", "a", "b"], 1],
  patterns: [
    { expression: ["Gcd", "a", "b"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
  ],
});
export const NOT_A_PROPOSITION = wireResult("not-a-proposition", {
  statement: ["Add", "a", "b"],
  patterns: [
    { expression: ["Add", "a", "b"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
  ],
});
export const OUTSIDE_BACKGROUND = wireResult("graduate-result", {
  domains: ["topology"],
  level: "graduate",
});
export const UNREADABLE = wireResult("unreadable", { statement: [1, "a"] });

export function libraryOutput(
  results: readonly unknown[] = [SYMMETRY],
  newConstants: readonly unknown[] = [],
) {
  return { result: { kind: "library-proposal", results, newConstants } };
}

export function gcd(overrides: Record<string, unknown> = {}) {
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

export const GCD_SYMMETRY = wireResult("gcd-symmetry", {
  statement: ["Equal", ["Gcd", "a", "b"], ["Gcd", "b", "a"]],
  patterns: [
    { expression: ["Gcd", "a", "b"], direction: "forward", ...ANY_PROPOSITION, role: "term" },
  ],
});

export function backgroundRuntime(librarian?: LlmTransport): AiRuntime {
  return {
    "background-proposer": { transport: async () => backgroundOutput(), dispatch },
    ...(librarian === undefined ? {} : { librarian: { transport: librarian, dispatch } }),
  };
}

export const BACKGROUND_REFERENCE = { decisionId: "background-decision:1" };

export function libraryRequest(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    id: "llm-call:library",
    approvedBackground: BACKGROUND_REFERENCE,
    packs: ["pack:divisibility"],
    ...overrides,
  };
}

export function libraryDecision(overrides: Record<string, unknown> = {}) {
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
export async function approveBackground(origin: string) {
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

export async function librarianScenario(
  librarian: LlmTransport,
  options: Parameters<typeof running>[0] = {},
) {
  const scenario = await running({ ...options, ai: backgroundRuntime(librarian) });
  await approveBackground(scenario.origin);
  return scenario;
}

export type ProposedBody = {
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

export const LIBRARY_REFERENCE = { constructionId: CONSTRUCTION, decisionId: "library-decision:1" };
export const BACKGROUND_REF = { constructionId: CONSTRUCTION, decisionId: "background-decision:1" };

export function draft(overrides: Record<string, unknown> = {}) {
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

export async function scenario(
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

export type Review = {
  digest: string;
  operators: { symbol: string }[];
  initialLibrary?: {
    results: { id: string; name: string; statement: unknown; premises: unknown[] }[];
    variantCount: number;
    addedOperatorSymbols: string[];
  };
};

export async function check(origin: string, body: Record<string, unknown>) {
  const response = await post(origin, "/problem-drafts/validate", { draft: draft(), ...body });
  return { response, body: await json<{ review?: Review; diagnostics?: unknown[] }>(response) };
}

export async function events(origin: string, sessionId: string) {
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

/** Start a session from the approved library, as the setup page does. */
export async function startSession(
  origin: string,
  sessionId: string,
  draftOverrides: Record<string, unknown> = {},
) {
  const { body } = await check(origin, {
    draft: draft(draftOverrides),
    approvedBackground: BACKGROUND_REF,
    approvedLibrary: LIBRARY_REFERENCE,
  });
  const created = await post(origin, "/proof-sessions", {
    sessionId,
    draft: draft(draftOverrides),
    reviewedDigest: body.review!.digest,
    approvedBackground: BACKGROUND_REF,
    approvedLibrary: LIBRARY_REFERENCE,
  });
  expect(created.status).toBe(201);
}

export const conclusionSelection = {
  kind: "exact",
  anchor: {
    stateId: "state:root",
    target: { kind: "goal", id: "goal:1" },
    statement: { kind: "conclusion" },
  },
  path: [],
} as const;

export type DisplayedSet = {
  id: string;
  suggestions: { id: string; source: string; artifactId: string; patternId: string }[];
  variantGroups: { familyId: string; suggestionIds: string[] }[];
};

export async function suggest(origin: string, sessionId: string, id: string) {
  const response = await post(
    origin,
    `/proof-sessions/${encodeURIComponent(sessionId)}/suggestion-sets`,
    {
      id,
      selections: [conclusionSelection],
    },
  );
  expect(response.status).toBe(201);
  return (await json<{ suggestionSet: DisplayedSet }>(response)).suggestionSet;
}

/** Close the services the tests started. */
export async function closeServices(): Promise<void> {
  await Promise.all(services.splice(0).map((service) => service.close()));
}
