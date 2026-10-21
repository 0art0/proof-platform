import { expect } from "vitest";
import type { LibrarianContext, PreparedLlmCall } from "@proof/llm";
import {
  ANY_PROPOSITION,
  GCD_SYMMETRY,
  gcd,
  json,
  libraryDecision,
  libraryOutput,
  libraryRequest,
  librarianScenario,
  post,
  startSession,
  suggest,
  wireResult,
} from "./ai-library.testing";

/**
 * Fixtures for the top-up tests: a session that starts from an approved initial library whose
 * result needs the constant Gcd, so Gcd is declared but dormant until a step applies that result,
 * with the librarian scripted per request kind.
 */

export const SESSION = "session:top-up";
export const SESSION_URL = `/proof-sessions/${encodeURIComponent(SESSION)}`;
export const GOAL_DIVIDES = [{ format: "latex", latex: String.raw`m \mid n` }];

/** `b | a` exactly when `gcd(a, b) = b`; applying it uses Gcd. */
export const GCD_DIVIDES = wireResult("gcd-divides", {
  statement: ["Equivalent", ["Divides", "b", "a"], ["Equal", ["Gcd", "a", "b"], "b"]],
  patterns: [{ expression: ["Divides", "b", "a"], direction: "forward", ...ANY_PROPOSITION }],
});
/** The same statement under other parameter names. */
export const GCD_DIVIDES_AGAIN = wireResult("gcd-divides-again", {
  statement: ["Equivalent", ["Divides", "x", "y"], ["Equal", ["Gcd", "y", "x"], "x"]],
  parameters: [
    { symbol: "x", sort: "integer" },
    { symbol: "y", sort: "integer" },
  ],
  patterns: [{ expression: ["Divides", "x", "y"], direction: "forward", ...ANY_PROPOSITION }],
});
/** True and general, but about no constant a proof just activated. */
export const SCALING = wireResult("divides-scaling", {
  statement: [
    "Implies",
    ["Divides", "a", "b"],
    ["Divides", ["Multiply", "a", "c"], ["Multiply", "b", "c"]],
  ],
  patterns: [
    {
      expression: ["Divides", ["Multiply", "a", "c"], ["Multiply", "b", "c"]],
      direction: "backward",
      section: "goal",
      polarity: "positive",
      role: "proposition",
    },
  ],
});
export const LCM_GCD = wireResult("lcm-gcd", {
  statement: ["Equal", ["Multiply", ["Gcd", "a", "b"], ["Lcm", "a", "b"]], ["Multiply", "a", "b"]],
  patterns: [
    {
      expression: ["Multiply", ["Gcd", "a", "b"], ["Lcm", "a", "b"]],
      direction: "forward",
      ...ANY_PROPOSITION,
      role: "term",
    },
  ],
});
export function lcm() {
  return gcd({
    id: "operator:lcm",
    symbol: "Lcm",
    displayName: "least common multiple",
    latex: {
      template: String.raw`\operatorname{lcm}\left(#1, #2\right)`,
      precedence: "atom",
      parse: { trigger: String.raw`\operatorname{lcm}`, notation: "function" },
    },
    naturalLanguage: { template: "the lcm of #1 and #2", negated: null },
  });
}

export type Scripted = { calls: PreparedLlmCall[]; topUps: PreparedLlmCall[] };

export type Started = Awaited<ReturnType<typeof librarianScenario>> & Scripted;

/** An answer for a top-up call; the default offers one result about Gcd. */
export type Answer = (call: PreparedLlmCall) => unknown;

/** A session whose approved initial library holds `gcd-divides`, which needs the constant Gcd. */
export async function topUpScenario(
  answer: Answer = () => libraryOutput([GCD_SYMMETRY]),
  options: Parameters<typeof librarianScenario>[1] = {},
  draftOverrides: Record<string, unknown> = {},
): Promise<Started> {
  const scripted: Scripted = { calls: [], topUps: [] };
  const started = await librarianScenario(async (call) => {
    scripted.calls.push(call);
    if (call.envelope.role === "librarian" && call.envelope.context.kind === "initial") {
      return libraryOutput([GCD_DIVIDES], [gcd()]);
    }
    scripted.topUps.push(call);
    return answer(call);
  }, options);
  await post(started.origin, "/ai/library", libraryRequest());
  expect(
    (
      await post(
        started.origin,
        "/ai/library/decisions",
        libraryDecision({ approvedResultIds: ["result:library-gcd-divides"] }),
      )
    ).status,
  ).toBe(201);
  await startSession(started.origin, SESSION, { goals: GOAL_DIVIDES, ...draftOverrides });
  return Object.assign(started, scripted);
}

export async function topUp(origin: string, body: Record<string, unknown>) {
  const response = await post(origin, `${SESSION_URL}/ai/library/top-up`, body);
  return { response, body: await json<Record<string, any>>(response) }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export type ConstantsBody = {
  readOnly: boolean;
  active: { symbol: string; origin: "setup" | "activated"; operator: { id: string } }[];
  available: {
    symbol: string;
    operator: { id: string };
    results: { id: string; name: string }[];
  }[];
  activated: {
    symbol: string;
    sequence: number;
    commandId: string;
    edgeId: string;
    nodeId: string;
    resultId: string;
    resultName: string | null;
    transitionSequence: number;
    activatedAt: string;
    topUp: { callId: string } | null;
  }[];
};
export async function constants(origin: string): Promise<ConstantsBody> {
  const response = await fetch(`${origin}${SESSION_URL}/library/constants`);
  expect(response.status).toBe(200);
  return json<ConstantsBody>(response);
}

export type EventBody = {
  id: string;
  sequence: number;
  layer: string;
  occurredAt: string;
  origin: { kind: string; actorId?: string };
  admission: { decision: string };
  artifact: {
    id: string;
    approval: { status: string; reviewerId?: string };
    operators?: { symbol: string }[];
  };
};
export async function events(origin: string): Promise<EventBody[]> {
  const response = await fetch(`${origin}${SESSION_URL}/library/events`);
  expect(response.status).toBe(200);
  return (await json<{ events: EventBody[] }>(response)).events;
}

/** Apply the library result to the goal, which activates its constants. */
export async function applyGcdDivides(origin: string) {
  const set = await suggest(origin, SESSION, "suggestion-set:before");
  const chosen = set.suggestions.find(
    ({ artifactId }) => artifactId === "result:library-gcd-divides",
  );
  expect(chosen, JSON.stringify(set.suggestions.map((s) => s.artifactId))).toBeDefined();
  const command = {
    commandId: "command:apply-gcd-divides",
    suggestionSetId: set.id,
    chosenSuggestionId: chosen!.id,
  };
  const applied = await post(origin, `${SESSION_URL}/commands`, command);
  expect(applied.status, JSON.stringify(await applied.clone().json())).toBe(201);
  return { set, command };
}

export function librarianContext(call: PreparedLlmCall): LibrarianContext {
  if (call.envelope.role !== "librarian") throw new Error("Expected a librarian call.");
  return call.envelope.context;
}
