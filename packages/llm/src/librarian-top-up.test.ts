import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DIVISIBILITY_OPERATOR_DECLARATIONS } from "@proof/library";
import { problemSetupSort } from "@proof/protocol";
import {
  MAX_LIBRARIAN_ACTIVATED_CONSTANTS,
  MAX_LIBRARIAN_SITUATION_SELECTIONS,
  buildLibrarianContext,
  buildLibrarianSituation,
  librarianContextConstants,
  llmContextEnvelopeSchema,
  prepareLlmCall,
  preparedLlmCallSchema,
  validateLlmOutput,
  type PreparedLlmCall,
} from "./index";
import { LIBRARIAN_PREVIOUS_SYSTEM_MESSAGE, LIBRARIAN_SYSTEM_MESSAGE } from "./librarian";

/**
 * The librarian's top-up request kinds (`docs/ai-agents-architecture.md` section 2): `new-constants`
 * and `no-relevant-results`, their contexts, the abstracted local situation (design plan section
 * 15.3), and the readability of calls recorded before these kinds existed.
 */

const BACKGROUND = {
  level: "first-year undergraduate",
  summary: "Elementary number theory.",
  assumptions: [],
  domains: ["number theory"],
  maximumLevel: "undergraduate",
};
const EXISTING = [
  {
    id: "result:divides-reflexivity",
    name: "Reflexivity of divisibility",
    statement: ["Divides", "a", "a"],
  },
];
const INTEGER = problemSetupSort("integer");
const GCD = {
  id: "operator:gcd",
  symbol: "Gcd",
  signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
};

const SITUATION = {
  selections: [
    {
      expression: ["Divides", "x1", "x2"],
      variables: [
        { symbol: "x1", sort: INTEGER },
        { symbol: "x2", sort: INTEGER },
      ],
      position: { polarity: "positive", role: "proposition" },
    },
  ],
};

function topUp(kind: "new-constants" | "no-relevant-results", overrides = {}) {
  return {
    id: "llm-call:top-up",
    kind,
    background: BACKGROUND,
    constants: DIVISIBILITY_OPERATOR_DECLARATIONS,
    existingResults: EXISTING,
    ...(kind === "new-constants" ? { newConstants: [GCD] } : { situation: SITUATION }),
    ...overrides,
  };
}

function prepared(kind: "new-constants" | "no-relevant-results", overrides = {}): PreparedLlmCall {
  const built = buildLibrarianContext(topUp(kind, overrides));
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const call = prepareLlmCall(built.envelope);
  if (!call.ok) throw new Error(call.diagnostics[0].message);
  return call.call;
}

describe("new-constants context", () => {
  it("carries the old active constants, the newly activated ones and the library, nothing else", () => {
    const built = buildLibrarianContext(topUp("new-constants"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(Object.keys(built.envelope.context).sort()).toEqual([
      "background",
      "constants",
      "existingResults",
      "kind",
      "newConstants",
    ]);
    expect(llmContextEnvelopeSchema.safeParse(built.envelope).success).toBe(true);
    if (built.envelope.context.kind !== "new-constants") return;
    expect(librarianContextConstants(built.envelope.context).map(({ symbol }) => symbol)).toEqual([
      "Divides",
      "Gcd",
    ]);
  });

  it("needs at least one and at most a bounded number of distinct, previously inactive constants", () => {
    const many = Array.from({ length: MAX_LIBRARIAN_ACTIVATED_CONSTANTS + 1 }, (_, index) => ({
      ...GCD,
      id: `operator:c${index}`,
      symbol: `C${index}`,
    }));
    for (const overrides of [
      { newConstants: [] },
      { newConstants: undefined },
      { newConstants: [GCD, GCD] },
      { newConstants: [DIVISIBILITY_OPERATOR_DECLARATIONS[0]] },
      { newConstants: many },
      { situation: SITUATION },
      { newConstants: [{ ...GCD, extra: true }] },
    ]) {
      expect(
        buildLibrarianContext(topUp("new-constants", overrides)),
        JSON.stringify(overrides),
      ).toMatchObject({ ok: false });
    }
  });

  it("refuses a proposal that declares a constant the proof has just activated", () => {
    const call = prepared("new-constants");
    const wireGcd = {
      id: "operator:other-gcd",
      symbol: "Gcd",
      displayName: "gcd",
      parameters: ["integer", "integer"],
      result: "integer",
      latex: {
        template: String.raw`\gcd\left(#1, #2\right)`,
        precedence: "atom",
        parse: { trigger: String.raw`\gcd`, notation: "function" },
      },
      naturalLanguage: { template: "the gcd of #1 and #2", negated: null },
    };
    const output = {
      result: {
        kind: "library-proposal",
        results: [],
        newConstants: [{ operator: wireGcd, rationale: "Again." }],
      },
    };
    expect(validateLlmOutput(call, output)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-output" }],
    });
    // A new constant that repeats nothing in the context is still an ordinary new constant.
    const lcm = {
      ...wireGcd,
      id: "operator:lcm",
      symbol: "Lcm",
      latex: {
        template: String.raw`\operatorname{lcm}\left(#1, #2\right)`,
        precedence: "atom",
        parse: { trigger: String.raw`\operatorname{lcm}`, notation: "function" },
      },
    };
    expect(
      validateLlmOutput(call, {
        result: {
          kind: "library-proposal",
          results: [
            {
              slug: "lcm-symmetry",
              name: "Lcm symmetry",
              description: "Lcm is symmetric.",
              domains: ["number theory"],
              level: "foundational",
              parameters: [
                { symbol: "a", sort: "integer" },
                { symbol: "b", sort: "integer" },
              ],
              premises: [],
              statement: ["Equal", ["Lcm", "a", "b"], ["Lcm", "b", "a"]],
              applicationDirections: ["forward"],
              patterns: [
                {
                  expression: ["Lcm", "a", "b"],
                  direction: "forward",
                  section: "any",
                  polarity: "any",
                  role: "term",
                },
              ],
            },
          ],
          newConstants: [{ operator: lcm, rationale: "Needed." }],
        },
      }),
    ).toMatchObject({ ok: true });
  });
});

describe("no-relevant-results context", () => {
  it("carries the active constants, the library and only the abstracted situation", () => {
    const call = prepared("no-relevant-results");
    const context = call.envelope.role === "librarian" ? call.envelope.context : undefined;
    expect(Object.keys(context ?? {}).sort()).toEqual([
      "background",
      "constants",
      "existingResults",
      "kind",
      "situation",
    ]);
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (typeof value === "object" && value !== null) {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key);
          visit(child);
        }
      }
    };
    visit(context);
    for (const forbidden of [
      "problem",
      "title",
      "goal",
      "goals",
      "hypotheses",
      "history",
      "suggestions",
      "nodeId",
      "stateId",
      "anchor",
      "target",
      "location",
      "path",
      "declarations",
      "obligations",
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(preparedLlmCallSchema.safeParse(call).success).toBe(true);
  });

  it("refuses a situation with a location, identifier or other field, and bounds its size", () => {
    const [first] = SITUATION.selections;
    const tooMany = Array.from({ length: MAX_LIBRARIAN_SITUATION_SELECTIONS + 1 }, () => first);
    for (const situation of [
      { selections: [] },
      { selections: tooMany },
      { selections: [{ ...first, location: { target: { kind: "goal", id: "goal:1" } } }] },
      { selections: [{ ...first, id: "selection:1" }] },
      { selections: [{ ...first, hypotheses: [] }] },
      { selections: [{ ...first, position: { polarity: "positive" } }] },
      { selections: [first], goals: [] },
      { selections: [first], problem: "Show that m divides n." },
    ]) {
      expect(
        buildLibrarianContext(topUp("no-relevant-results", { situation })),
        JSON.stringify(situation),
      ).toMatchObject({ ok: false });
    }
    expect(
      buildLibrarianContext(topUp("no-relevant-results", { newConstants: [GCD] })),
    ).toMatchObject({ ok: false });
  });
});

describe("system message", () => {
  it("explains the request kinds and keeps the original message as its prefix", () => {
    const call = prepared("new-constants");
    expect(call.messages[0].content).toBe(LIBRARIAN_SYSTEM_MESSAGE);
    expect(LIBRARIAN_SYSTEM_MESSAGE.startsWith(LIBRARIAN_PREVIOUS_SYSTEM_MESSAGE)).toBe(true);
    for (const phrase of ["context.kind", "context.newConstants", "context.situation", "top-up"]) {
      expect(LIBRARIAN_SYSTEM_MESSAGE, phrase).toContain(phrase);
    }
    expect(LIBRARIAN_SYSTEM_MESSAGE).toContain("You are given no problem");
  });

  it("still reads a call recorded with the message from before the top-up kinds", () => {
    const call = prepared("new-constants");
    const initial = buildLibrarianContext({
      id: "llm-call:old",
      kind: "initial",
      background: BACKGROUND,
      constants: DIVISIBILITY_OPERATOR_DECLARATIONS,
      existingResults: EXISTING,
    });
    if (!initial.ok) throw new Error("Expected an initial context.");
    const old = {
      ...call,
      id: "llm-call:old",
      envelope: initial.envelope,
      messages: [
        { role: "system", content: LIBRARIAN_PREVIOUS_SYSTEM_MESSAGE },
        { role: "user", content: JSON.stringify(initial.envelope) },
      ],
    };
    expect(preparedLlmCallSchema.safeParse(old).success).toBe(true);
    expect(
      preparedLlmCallSchema.safeParse({
        ...old,
        messages: [
          { role: "system", content: `${LIBRARIAN_PREVIOUS_SYSTEM_MESSAGE} Approve.` },
          old.messages[1],
        ],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The abstracted situation
// ---------------------------------------------------------------------------------------------

function declaration(symbol: string) {
  return { id: `declaration:${symbol}`, symbol, sort: INTEGER, role: "universal-parameter" };
}

function selection(
  fragment: unknown,
  symbols: readonly string[],
  position = { polarity: "positive", role: "proposition" },
) {
  return {
    kind: "exact",
    anchor: {
      stateId: "state:private",
      target: { kind: "goal", id: "goal:private" },
      statement: { kind: "hypothesis", id: "hypothesis:private" },
    },
    path: [1, 0],
    fragment,
    declarations: symbols.map(declaration),
    position,
  };
}

describe("buildLibrarianSituation", () => {
  const operators = DIVISIBILITY_OPERATOR_DECLARATIONS;

  it("keeps the fragment, the sorts of its variables and its position, and nothing that locates it", () => {
    const situation = buildLibrarianSituation(
      [selection(["Divides", "m", "n"], ["m", "n", "k"])],
      operators,
    );
    expect(situation).toEqual({
      selections: [
        {
          expression: ["Divides", "x1", "x2"],
          variables: [
            { symbol: "x1", sort: INTEGER },
            { symbol: "x2", sort: INTEGER },
          ],
          position: { polarity: "positive", role: "proposition" },
        },
      ],
    });
    const text = JSON.stringify(situation);
    for (const hidden of [
      "private",
      "state",
      "goal",
      "hypothesis",
      "path",
      "declaration",
      '"m"',
      '"n"',
      '"k"',
    ]) {
      expect(text, hidden).not.toContain(hidden);
    }
  });

  it("uses one set of neutral names across fragments, in order of first appearance", () => {
    const situation = buildLibrarianSituation(
      [
        selection(["Divides", "q", "p"], ["p", "q"]),
        selection(["Divides", "p", ["Add", "q", "r"]], ["p", "q", "r"], {
          polarity: "negative",
          role: "proposition",
        }),
      ],
      operators,
    );
    expect(situation?.selections.map(({ expression }) => expression)).toEqual([
      ["Divides", "x1", "x2"],
      ["Divides", "x2", ["Add", "x1", "x3"]],
    ]);
    expect(situation?.selections[1]?.variables.map(({ symbol }) => symbol)).toEqual([
      "x2",
      "x1",
      "x3",
    ]);
    expect(situation?.selections[1]?.position.polarity).toBe("negative");
  });

  it("does not rename a bound variable, avoids names already in use, and leaves operators alone", () => {
    const bound = buildLibrarianSituation(
      [selection(["ForAll", "t", ["Divides", "t", "m"]], ["m", "t"])],
      operators,
    );
    expect(bound?.selections[0]?.expression).toEqual(["ForAll", "t", ["Divides", "t", "x1"]]);
    const taken = buildLibrarianSituation(
      [selection(["Divides", "x1", "m"], ["m", "x1"])],
      operators,
    );
    // `x1` is already a symbol of the fragment, so the first neutral name is a fresh one.
    expect(taken?.selections[0]?.expression).toEqual(["Divides", "x2", "x3"]);
  });

  it("describes nothing when a selection is malformed, or there are none or too many", () => {
    expect(buildLibrarianSituation([], operators)).toBeUndefined();
    expect(
      buildLibrarianSituation([{ fragment: ["Divides", "m", "n"] }], operators),
    ).toBeUndefined();
    expect(buildLibrarianSituation(["m"], operators)).toBeUndefined();
    expect(
      buildLibrarianSituation(
        Array.from({ length: MAX_LIBRARIAN_SITUATION_SELECTIONS + 1 }, () =>
          selection(["Divides", "m", "n"], ["m", "n"]),
        ),
        operators,
      ),
    ).toBeUndefined();
  });

  it("does not depend on the names of the problem's variables", () => {
    const names = ["m", "n", "p", "q", "r", "s", "u", "v", "w", "z"];
    const rename = (value: unknown, mapping: ReadonlyMap<string, string>): unknown =>
      Array.isArray(value)
        ? value.map((child, index) => (index === 0 ? child : rename(child, mapping)))
        : typeof value === "string"
          ? (mapping.get(value) ?? value)
          : value;
    fc.assert(
      fc.property(
        fc.shuffledSubarray(names, { minLength: 3, maxLength: 3 }),
        fc.shuffledSubarray(names, { minLength: 3, maxLength: 3 }),
        fc.integer({ min: 0, max: 2 }),
        (left, right, seed) => {
          const base = ["Divides", ["Add", left[0], left[seed]], ["Multiply", left[1], left[2]]];
          const mapping = new Map(left.map((name, index) => [name, right[index] as string]));
          const renamed = rename(base, mapping);
          const one = buildLibrarianSituation([selection(base, left)], operators);
          const other = buildLibrarianSituation([selection(renamed, right)], operators);
          expect(one).toBeDefined();
          expect(other).toEqual(one);
        },
      ),
      { numRuns: 100 },
    );
  });
});
