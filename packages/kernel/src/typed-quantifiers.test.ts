import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  executableProofStateSchema,
  freeSymbolNames,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { alphaEquivalent, applyTransition, KERNEL_TRANSITION_CLASSES } from "./index";

const real = { kind: "named", id: "sort:real" } as const;
const declarations = ["a", "b", "y"].map((symbol) => ({
  id: `decl:${symbol}`,
  symbol,
  sort: real,
  role: "universal-parameter",
}));

function stateOf(
  conclusion: PlainMathJson,
  hypotheses: readonly (readonly [string, PlainMathJson])[] = [],
  localDeclarations: readonly unknown[] = declarations,
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:before",
    goals: [
      {
        id: "goal:0",
        sequent: {
          context: {
            declarations: localDeclarations,
            hypotheses: hypotheses.map(([id, expression]) => ({ id, statement: { expression } })),
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  });
}

const target = { kind: "goal", id: "goal:0" } as const;
const base = { expectedStateId: "state:before", resultStateId: "state:after", target } as const;

function run(input: ExecutableProofState, operation: Record<string, unknown>) {
  return applyTransition(input, { ...base, ...operation });
}

const lastHypothesis = (state: ExecutableProofState): PlainMathJson | undefined =>
  state.goals[0]?.sequent.context.hypotheses.at(-1)?.statement.expression;

describe("typed quantifier operations", () => {
  describe("introduce-universal", () => {
    const goal: PlainMathJson = [
      "ForAll",
      ["Element", "x", "RealNumbers"],
      ["Less", "x", ["Add", "x", 1]],
    ];
    const ids = { parameterDeclarationId: "decl:new", membershipHypothesisId: "hyp:member" };

    it("declares a fresh parameter, adds x in S, and opens the body", () => {
      const result = run(stateOf(goal), { kind: "introduce-universal", ...ids });
      expect(result).toMatchObject({ ok: true, transitionClass: "equivalence" });
      if (!result.ok) return;
      const sequent = result.state.goals[0]?.sequent;
      expect(sequent?.context.declarations.at(-1)).toEqual({
        id: "decl:new",
        symbol: "x",
        sort: real,
        role: "universal-parameter",
      });
      expect(sequent?.context.hypotheses).toEqual([
        { id: "hyp:member", statement: { expression: ["Element", "x", "RealNumbers"] } },
      ]);
      expect(sequent?.conclusion.expression).toEqual(["Less", "x", ["Add", "x", 1]]);
    });

    it("renames the parameter when the bound name is already declared", () => {
      const result = run(stateOf(["ForAll", ["Element", "a", "RealNumbers"], ["Less", "a", "b"]]), {
        kind: "introduce-universal",
        ...ids,
      });
      expect(result).toMatchObject({
        ok: true,
        state: {
          goals: [
            {
              sequent: {
                context: {
                  declarations: [{}, {}, {}, { symbol: "a_1" }],
                  hypotheses: [{ statement: { expression: ["Element", "a_1", "RealNumbers"] } }],
                },
                conclusion: { expression: ["Less", "a_1", "b"] },
              },
            },
          ],
        },
      });
    });

    it("needs both IDs and fresh IDs", () => {
      expect(run(stateOf(goal), { kind: "introduce-universal" })).toMatchObject({
        ok: false,
        diagnostics: [{ code: "arity-mismatch" }],
      });
      expect(
        run(stateOf(goal), {
          kind: "introduce-universal",
          ...ids,
          parameterDeclarationId: "decl:a",
        }),
      ).toMatchObject({ ok: false, diagnostics: [{ code: "identifier-collision" }] });
    });

    it("keeps untyped behaviour: the parameter must already be declared", () => {
      expect(
        run(
          stateOf(
            ["ForAll", "x", ["Equal", "x", "x"]],
            [],
            [...declarations, { id: "decl:x", symbol: "x", sort: real, role: "local-witness" }],
          ),
          { kind: "introduce-universal" },
        ),
      ).toMatchObject({ ok: false, diagnostics: [{ code: "rule-not-applicable" }] });
    });
  });

  describe("instantiate-universal-hypothesis", () => {
    const universal: PlainMathJson = [
      "ForAll",
      ["Element", "x", "RealNumbers"],
      ["Less", "x", ["Add", "x", 1]],
    ];
    const operation = {
      kind: "instantiate-universal-hypothesis",
      hypothesisId: "hyp:all",
      term: "a",
      resultHypothesisId: "hyp:instance",
      membershipObligationId: "obligation:member",
    };

    it("creates a binder-membership obligation, as a strengthening, when t in S is not known", () => {
      const result = run(stateOf("True", [["hyp:all", universal]]), operation);
      expect(result).toMatchObject({ ok: true, transitionClass: "strengthening" });
      if (!result.ok) return;
      expect(result.state.obligations).toMatchObject([
        {
          id: "obligation:member",
          provenance: { kind: "binder-membership", hypothesisId: "hyp:all" },
          sequent: { conclusion: { expression: ["Element", "a", "RealNumbers"] } },
        },
      ]);
      expect(lastHypothesis(result.state)).toEqual(["Less", "a", ["Add", "a", 1]]);
    });

    it("discharges the membership from an alpha-equivalent hypothesis", () => {
      const result = run(
        stateOf("True", [
          ["hyp:all", universal],
          ["hyp:member", ["Element", "a", "RealNumbers"]],
        ]),
        operation,
      );
      expect(result).toMatchObject({ ok: true, transitionClass: "equivalence" });
      if (result.ok) expect(result.state.obligations).toEqual([]);
    });

    it("needs an obligation ID only when the membership is undischarged", () => {
      const withoutId = Object.fromEntries(
        Object.entries(operation).filter(([key]) => key !== "membershipObligationId"),
      );
      expect(run(stateOf("True", [["hyp:all", universal]]), withoutId)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "arity-mismatch" }],
      });
      expect(
        run(
          stateOf("True", [
            ["hyp:all", universal],
            ["hyp:member", ["Element", "a", "RealNumbers"]],
          ]),
          withoutId,
        ),
      ).toMatchObject({ ok: true });
    });

    it("places the obligation after the derived target when instantiating inside an obligation", () => {
      const input = executableProofStateSchema.parse({
        id: "state:before",
        goals: [],
        obligations: [
          {
            id: "obligation:0",
            sequent: {
              context: {
                declarations,
                hypotheses: [{ id: "hyp:all", statement: { expression: universal } }],
              },
              conclusion: { expression: "True" },
            },
          },
        ],
      });
      const result = applyTransition(input, {
        ...base,
        ...operation,
        target: { kind: "obligation", id: "obligation:0" },
      });
      expect(result).toMatchObject({
        ok: true,
        transitionClass: "strengthening",
        state: { obligations: [{ id: "obligation:0" }, { id: "obligation:member" }] },
      });
    });

    it("rejects an ill-sorted term", () => {
      const result = run(stateOf("True", [["hyp:all", universal]]), { ...operation, term: "True" });
      expect(result.ok).toBe(false);
    });
  });

  describe("choose-existential-witness", () => {
    it("strengthens the goal to t in S and the body at t", () => {
      const result = run(stateOf(["Exists", ["Element", "x", "RealNumbers"], ["Less", "a", "x"]]), {
        kind: "choose-existential-witness",
        witness: ["Add", "a", 1],
      });
      expect(result).toMatchObject({
        ok: true,
        transitionClass: "strengthening",
        state: {
          goals: [
            {
              sequent: {
                conclusion: {
                  expression: [
                    "And",
                    ["Element", ["Add", "a", 1], "RealNumbers"],
                    ["Less", "a", ["Add", "a", 1]],
                  ],
                },
              },
            },
          ],
        },
      });
    });

    it("does not capture a free symbol of the witness", () => {
      const result = run(
        stateOf([
          "Exists",
          ["Element", "x", "RealNumbers"],
          ["Exists", ["Element", "y", "RealNumbers"], ["Less", "x", "y"]],
        ]),
        { kind: "choose-existential-witness", witness: "y" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const conclusion = result.state.goals[0]?.sequent.conclusion.expression as PlainMathJson;
      expect(freeSymbolNames(conclusion)).toContain("y");
      const inner = (conclusion as readonly PlainMathJson[])[2] as readonly PlainMathJson[];
      expect(inner[0]).toBe("Exists");
      expect(inner[2]).not.toEqual(["Less", "y", "y"]);
    });
  });

  describe("unpack-existential-hypothesis", () => {
    const existential: PlainMathJson = [
      "Exists",
      ["Element", "x", "RealNumbers"],
      ["Less", "a", "x"],
    ];
    const operation = {
      kind: "unpack-existential-hypothesis",
      hypothesisId: "hyp:ex",
      resultHypothesisId: "hyp:body",
      witnessDeclarationId: "decl:w",
      membershipHypothesisId: "hyp:member",
    };

    it("introduces a fresh witness with its membership and the body", () => {
      const result = run(stateOf("True", [["hyp:ex", existential]]), operation);
      expect(result).toMatchObject({ ok: true, transitionClass: "equivalence" });
      if (!result.ok) return;
      const sequent = result.state.goals[0]?.sequent;
      expect(sequent?.context.declarations.at(-1)).toMatchObject({
        symbol: "x",
        role: "local-witness",
      });
      expect(sequent?.context.hypotheses).toMatchObject([
        { id: "hyp:member", statement: { expression: ["Element", "x", "RealNumbers"] } },
        { id: "hyp:body", statement: { expression: ["Less", "a", "x"] } },
      ]);
    });

    it("renames the witness when the bound name is taken", () => {
      const result = run(
        stateOf("True", [
          ["hyp:ex", ["Exists", ["Element", "b", "RealNumbers"], ["Less", "a", "b"]]],
        ]),
        operation,
      );
      expect(result).toMatchObject({
        ok: true,
        state: {
          goals: [
            {
              sequent: {
                context: {
                  hypotheses: [
                    { statement: { expression: ["Element", "b_1", "RealNumbers"] } },
                    { statement: { expression: ["Less", "a", "b_1"] } },
                  ],
                },
              },
            },
          ],
        },
      });
    });

    it("needs both IDs", () => {
      const withoutId = Object.fromEntries(
        Object.entries(operation).filter(([key]) => key !== "witnessDeclarationId"),
      );
      expect(run(stateOf("True", [["hyp:ex", existential]]), withoutId)).toMatchObject({
        ok: false,
        diagnostics: [{ code: "arity-mismatch" }],
      });
    });
  });

  describe("properties", () => {
    const binderNames = fc.constantFrom("x", "u", "v", "w", "t");
    const terms = fc.constantFrom<PlainMathJson>("a", "b", ["Add", "a", "b"], ["Add", "a", 1], "y");

    it("instantiation ignores the bound name; obligations appear exactly when undischarged; no capture", () => {
      fc.assert(
        fc.property(binderNames, binderNames, terms, fc.boolean(), (first, second, term, known) => {
          const universal = (name: string): PlainMathJson => [
            "ForAll",
            ["Element", name, "RealNumbers"],
            ["Exists", ["Element", "y", "RealNumbers"], ["Less", name, ["Add", "y", 1]]],
          ];
          const membership: readonly (readonly [string, PlainMathJson])[] = known
            ? [["hyp:member", ["Element", term, "RealNumbers"]]]
            : [];
          const outcome = (name: string) =>
            run(stateOf("True", [["hyp:all", universal(name)], ...membership]), {
              kind: "instantiate-universal-hypothesis",
              hypothesisId: "hyp:all",
              term,
              resultHypothesisId: "hyp:instance",
              membershipObligationId: "obligation:member",
            });
          const left = outcome(first);
          const right = outcome(second);
          expect(left.ok && right.ok).toBe(true);
          if (!left.ok || !right.ok) return;
          const instance = lastHypothesis(left.state) as PlainMathJson;
          expect(alphaEquivalent(instance, lastHypothesis(right.state) as PlainMathJson)).toBe(
            true,
          );
          // Capture avoidance: the free `y` of the term stays free in the instance.
          if (term === "y") expect(freeSymbolNames(instance)).toContain("y");
          expect(left.state.obligations).toHaveLength(known ? 0 : 1);
          expect(left.transitionClass).toBe(known ? "equivalence" : "strengthening");
          expect(KERNEL_TRANSITION_CLASSES["instantiate-universal-hypothesis"]).toContain(
            left.transitionClass,
          );
        }),
        { numRuns: 200 },
      );
    });

    it("a typed instance is the plain substitution of the term", () => {
      fc.assert(
        fc.property(binderNames, terms, (name, term) => {
          const result = run(
            stateOf("True", [
              [
                "hyp:all",
                ["ForAll", ["Element", name, "RealNumbers"], ["Less", name, ["Add", name, 1]]],
              ],
            ]),
            {
              kind: "instantiate-universal-hypothesis",
              hypothesisId: "hyp:all",
              term,
              resultHypothesisId: "hyp:instance",
              membershipObligationId: "obligation:member",
            },
          );
          expect(result.ok).toBe(true);
          if (result.ok)
            expect(lastHypothesis(result.state)).toEqual(["Less", term, ["Add", term, 1]]);
        }),
        { numRuns: 100 },
      );
    });

    it("introduce-universal is invariant under renaming the bound variable", () => {
      fc.assert(
        fc.property(binderNames, binderNames, (first, second) => {
          const outcome = (name: string) =>
            run(
              stateOf([
                "ForAll",
                ["Element", name, "RealNumbers"],
                ["Less", name, ["Add", name, "a"]],
              ]),
              {
                kind: "introduce-universal",
                parameterDeclarationId: "decl:new",
                membershipHypothesisId: "hyp:member",
              },
            );
          const left = outcome(first);
          const right = outcome(second);
          expect(left.ok && right.ok).toBe(true);
          if (!left.ok || !right.ok) return;
          const normalized = (name: string, state: ExecutableProofState): unknown => {
            const sequent = state.goals[0]?.sequent;
            return JSON.parse(
              JSON.stringify([
                sequent?.conclusion.expression,
                sequent?.context.hypotheses,
                sequent?.context.declarations.at(-1)?.symbol,
              ]).replaceAll(`"${name}"`, '"#"'),
            );
          };
          expect(normalized(first, left.state)).toEqual(normalized(second, right.state));
          expect(left.transitionClass).toBe("equivalence");
        }),
        { numRuns: 100 },
      );
    });
  });
});
