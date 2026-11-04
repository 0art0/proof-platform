import { afterEach, describe, expect, it } from "vitest";
import type { LlmTransport, PreparedLlmCall } from "@proof/llm";
import {
  BACKGROUND_REF,
  CONSTRUCTION,
  LIBRARY_REFERENCE,
  PROBLEM,
  SYMMETRY,
  backgroundRuntime,
  check,
  draft,
  json,
  libraryDecision,
  libraryOutput,
  post,
  running,
  services,
} from "./ai-library.testing";

/**
 * The streamlined problem entry: a library is built from a background proposal while the person
 * reviews it, the person approves the background with their edits, and the edits reach the
 * library deterministically.
 */

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const PROPOSAL = { callId: "llm-call:background" };

/** A proposed (not yet decided) background, with a librarian that records what it was sent. */
async function proposed(seen: PreparedLlmCall[] = []) {
  const librarian: LlmTransport = async (call) => {
    seen.push(call);
    return libraryOutput([SYMMETRY]);
  };
  const scenario = await running({ ai: backgroundRuntime(librarian) });
  const background = await post(scenario.origin, "/ai/background", {
    constructionId: CONSTRUCTION,
    id: PROPOSAL.callId,
    problem: PROBLEM,
  });
  expect(background.status).toBe(200);
  return scenario;
}

function libraryFromProposal(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    id: "llm-call:library",
    backgroundProposal: PROPOSAL,
    packs: ["pack:divisibility"],
    ...overrides,
  };
}

const COPRIME_EDITED = {
  id: "operator:coprime",
  symbol: "Coprime",
  signature: {
    parameters: [
      { kind: "named", id: "sort:integer" },
      { kind: "named", id: "sort:integer" },
    ],
    result: { kind: "proposition" },
  },
  presentation: {
    displayName: "coprime to",
    latex: {
      template: String.raw`\operatorname{cop}\left(#1, #2\right)`,
      precedence: "atom",
      parse: { trigger: String.raw`\operatorname{cop}`, notation: "function" },
    },
    naturalLanguage: [{ template: "#1 is coprime to #2", negated: "#1 is not coprime to #2" }],
  },
};

const EDITED_PROFILE = {
  level: "second-year undergraduate",
  summary: "Divisibility and coprimality of integers.",
  assumptions: ["Divisibility of integers", "Euclid's lemma"],
  domains: ["number theory"],
  maximumLevel: "undergraduate",
};

function decision(overrides: Record<string, unknown> = {}) {
  return {
    constructionId: CONSTRUCTION,
    decisionId: BACKGROUND_REF.decisionId,
    callId: PROPOSAL.callId,
    decision: "approved",
    rationale: "Accepted with edits.",
    decidedAt: "2026-11-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("library built from a background proposal under review", () => {
  it("uses the proposal's background and constants, and never the problem", async () => {
    const seen: PreparedLlmCall[] = [];
    const { origin } = await proposed(seen);
    const built = await post(origin, "/ai/library", libraryFromProposal());
    expect(built.status).toBe(200);
    const body = await json<{ status: string; results: { artifact: { id: string } }[] }>(built);
    expect(body.status).toBe("proposed");
    expect(body.results.map(({ artifact }) => artifact.id)).toEqual([
      "result:library-coprime-symmetry",
    ]);
    expect(seen).toHaveLength(1);
    const envelope = seen[0]!.envelope;
    if (envelope.role !== "librarian" || envelope.context.kind !== "initial") {
      throw new Error("Expected an initial librarian call.");
    }
    expect(envelope.context.background.summary).toBe("Elementary number theory.");
    expect(envelope.context.constants.map(({ symbol }) => symbol)).toContain("Coprime");
    // The barrier holds: nothing of the problem reaches the librarian.
    expect(JSON.stringify(seen[0]!.messages)).not.toContain(PROBLEM.statement);
    expect(JSON.stringify(seen[0]!.messages)).not.toContain(PROBLEM.title);
  });

  it("needs exactly one source, and only a validated proposal of the construction", async () => {
    const { origin } = await proposed();
    const both = libraryFromProposal({ approvedBackground: { decisionId: "background-decision:x" } });
    expect((await post(origin, "/ai/library", both)).status).toBe(400);
    const { backgroundProposal: _omitted, ...neither } = libraryFromProposal();
    expect((await post(origin, "/ai/library", neither)).status).toBe(400);
    const unknown = libraryFromProposal({ backgroundProposal: { callId: "llm-call:nothing" } });
    expect((await post(origin, "/ai/library", unknown)).status).toBe(404);
    const foreign = await post(
      origin,
      "/ai/library",
      libraryFromProposal({ constructionId: "construction:other" }),
    );
    expect(foreign.status).toBe(404);
    // A library call is not a background proposal.
    expect((await post(origin, "/ai/library", libraryFromProposal())).status).toBe(200);
    const notAProposal = await post(
      origin,
      "/ai/library",
      libraryFromProposal({ id: "llm-call:library-2", backgroundProposal: { callId: "llm-call:library" } }),
    );
    expect(notAProposal.status).toBe(409);
  });
});

describe("approving an edited background", () => {
  it("records the edits beside the exact proposal and resolves the edited background", async () => {
    const { origin } = await proposed();
    const approved = await post(
      origin,
      "/ai/background/decisions",
      decision({ amendment: { background: EDITED_PROFILE, constants: [COPRIME_EDITED] } }),
    );
    expect(approved.status).toBe(201);
    const body = await json<{
      decision: { proposal: { constants: { operator: { presentation: { displayName: string } } }[] }; amendment: unknown };
    }>(approved);
    // The decision names the model's own answer; the edits sit beside it.
    expect(body.decision.proposal.constants[0]?.operator.presentation.displayName).toBe("coprime");
    expect(body.decision.amendment).toMatchObject({ background: { level: "second-year undergraduate" } });

    // The edited notation is the notation the setup reads.
    const edited = await check(origin, {
      draft: draft({
        background: EDITED_PROFILE,
        goals: [{ format: "latex", latex: String.raw`\operatorname{cop}\left(m, n\right)` }],
      }),
      approvedBackground: BACKGROUND_REF,
    });
    expect(edited.response.status).toBe(200);
    const original = await check(origin, {
      draft: draft({ background: EDITED_PROFILE }),
      approvedBackground: BACKGROUND_REF,
    });
    expect(original.response.status).toBe(422);

    // A retried decision with the same edits replays; other edits under the same ID conflict.
    const replay = await post(
      origin,
      "/ai/background/decisions",
      decision({ amendment: { background: EDITED_PROFILE, constants: [COPRIME_EDITED] } }),
    );
    expect(replay.status).toBe(200);
    const conflict = await post(
      origin,
      "/ai/background/decisions",
      decision({ amendment: { background: EDITED_PROFILE, constants: [] } }),
    );
    expect(conflict.status).toBe(409);
  });

  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ["renames a constant", [{ ...COPRIME_EDITED, symbol: "Cop" }]],
    [
      "changes a signature",
      [
        {
          ...COPRIME_EDITED,
          signature: { ...COPRIME_EDITED.signature, result: { kind: "named", id: "sort:integer" } },
          presentation: { ...COPRIME_EDITED.presentation, naturalLanguage: [{ template: "c(#1, #2)" }] },
        },
      ],
    ],
    ["adds a constant", [COPRIME_EDITED, { ...COPRIME_EDITED, id: "operator:new", symbol: "New" }]],
    [
      "uses an invented LaTeX command",
      [
        {
          ...COPRIME_EDITED,
          presentation: {
            ...COPRIME_EDITED.presentation,
            latex: {
              template: String.raw`\Cop{#1}{#2}`,
              precedence: "atom",
              parse: { trigger: String.raw`\Cop`, notation: "function" },
            },
          },
        },
      ],
    ],
    [
      "drops an operand from the LaTeX",
      [
        {
          ...COPRIME_EDITED,
          presentation: {
            ...COPRIME_EDITED.presentation,
            latex: { template: String.raw`\operatorname{cop}\left(#1\right)`, precedence: "atom" },
          },
        },
      ],
    ],
  ];
  it.each(refused)("refuses edits that %s", async (_label, constants) => {
    const { origin } = await proposed();
    const response = await post(
      origin,
      "/ai/background/decisions",
      decision({ amendment: { background: EDITED_PROFILE, constants } }),
    );
    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ diagnostics: [{ code: "invalid-amendment" }] });
  });

  it("refuses edits on a rejection", async () => {
    const { origin } = await proposed();
    const response = await post(
      origin,
      "/ai/background/decisions",
      decision({ decision: "rejected", amendment: { background: EDITED_PROFILE, constants: [] } }),
    );
    expect(response.status).toBe(400);
  });
});

describe("edits reach a library built from the proposal", () => {
  async function libraryThenApproval(constants: readonly unknown[]) {
    const scenario = await proposed();
    const { origin } = scenario;
    expect((await post(origin, "/ai/library", libraryFromProposal())).status).toBe(200);
    expect(
      (
        await post(
          origin,
          "/ai/library/decisions",
          libraryDecision({ approvedResultIds: ["result:library-coprime-symmetry"] }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await post(
          origin,
          "/ai/background/decisions",
          decision({ amendment: { background: EDITED_PROFILE, constants } }),
        )
      ).status,
    ).toBe(201);
    return scenario;
  }

  it("renders the library's results with the edited notation when the session starts", async () => {
    const { origin } = await libraryThenApproval([COPRIME_EDITED]);
    const setup = draft({
      background: EDITED_PROFILE,
      goals: [{ format: "latex", latex: String.raw`\operatorname{cop}\left(m, n\right)` }],
    });
    const { response, body } = await check(origin, {
      draft: setup,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(response.status).toBe(200);
    const created = await post(origin, "/proof-sessions", {
      sessionId: "session:edited",
      draft: setup,
      reviewedDigest: body.review!.digest,
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(created.status).toBe(201);
    const events = await fetch(`${origin}/proof-sessions/session%3Aedited/library/events`);
    const recorded = JSON.stringify(await events.json());
    expect(recorded).toContain(String.raw`\\operatorname{cop}`);
    expect(recorded).not.toContain(String.raw`\\perp`);
  });

  it("reports a kept result that applies a removed constant", async () => {
    const { origin } = await libraryThenApproval([]);
    const { response, body } = await check(origin, {
      draft: draft({
        background: EDITED_PROFILE,
        goals: [{ format: "latex", latex: "m = n" }],
      }),
      approvedBackground: BACKGROUND_REF,
      approvedLibrary: LIBRARY_REFERENCE,
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(body.diagnostics)).toContain("approved-library-invalid");
  });
});

describe("published prompts", () => {
  it("shows the exact system message of each problem-entry role", async () => {
    const { origin } = await proposed();
    const response = await fetch(`${origin}/ai/prompts`);
    expect(response.status).toBe(200);
    const body = await json<{
      roles: Record<string, { systemMessage: string; promptVersion: string | null }>;
    }>(response);
    expect(Object.keys(body.roles).sort()).toEqual([
      "background-proposer",
      "librarian",
      "proof-state-formalizer",
    ]);
    expect(body.roles["background-proposer"]?.systemMessage).toContain("Notation standards");
    expect(body.roles["librarian"]?.systemMessage).toContain("You are given no problem");
    expect(body.roles["background-proposer"]?.promptVersion).toBe("library-test-v1");
    expect(body.roles["proof-state-formalizer"]?.promptVersion).toBeNull();
    expect((await post(origin, "/ai/prompts", {})).status).toBe(405);
  });
});
