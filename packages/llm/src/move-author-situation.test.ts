import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { abstractSituation, type Situation } from "./move-author-situation";

/** The deterministic abstraction of an applied step (design plan section 15.3). */

const declaration = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

function input(names: readonly [string, string, string], target = "goal") {
  const [a, b, unused] = names;
  const goalId = "goal:main";
  return {
    target: { kind: target as "goal" | "obligation", id: goalId },
    selections: [
      {
        location: {
          target: { kind: target, id: goalId },
          statement: { kind: "conclusion" as const },
          occurrence: { kind: "exact" as const, path: [] },
        },
        expression: b as never,
      },
    ],
    sequent: {
      // `a` is declared but nothing the step uses mentions it.
      declarations: [declaration(a, 0), declaration(b, 1), declaration(unused, 2)] as never,
      hypotheses: [
        { id: "hypothesis:used", expression: b as never },
        { id: "hypothesis:unused", expression: unused as never },
      ],
      conclusion: b as never,
    },
    operators: [],
    results: [],
    steps: [
      {
        kind: "close-by-hypothesis",
        target: { kind: target, id: goalId },
        hypothesisId: "hypothesis:used",
      },
    ] as never,
  };
}

function situationOf(value: ReturnType<typeof input>): Situation {
  const result = abstractSituation(value);
  if (!result.ok) throw new Error(result.reason);
  return result.situation;
}

describe("abstractSituation", () => {
  it("keeps what the step uses, names it neutrally and runs the plan through the kernel", () => {
    const situation = situationOf(input(["alpha", "beta", "gamma"]));
    expect(situation.restricted).toBe(true);
    expect(situation.before.id).toBe("goal:situation");
    expect(situation.before.conclusion).toEqual("P");
    expect(situation.before.hypotheses).toEqual([{ id: "hypothesis:1", expression: "P" }]);
    expect(situation.before.declarations.map(({ symbol }) => symbol)).toEqual(["P"]);
    expect(situation.plan[0]).toMatchObject({ hypothesisId: "hypothesis:1" });
    // The step closes the goal: nothing is left.
    expect(situation.after.goals).toEqual([]);
    expect(situation.after.transitionClass).toBe("equivalence");
    expect(JSON.stringify(situation)).not.toMatch(/alpha|beta|gamma|unused/);
  });

  it("shows an obligation target as a goal and says so", () => {
    const situation = situationOf(input(["alpha", "beta", "gamma"], "obligation"));
    expect(situation.targetKind).toBe("obligation");
    expect(situation.before.id).toBe("goal:situation");
  });

  it("does not depend on the names the problem used (property)", () => {
    const names = ["u", "v", "w", "s", "t", "m", "n", "alpha", "beta", "gamma", "x1", "y2"];
    const reference = JSON.stringify(situationOf(input(["alpha", "beta", "gamma"])));
    fc.assert(
      fc.property(fc.shuffledSubarray(names, { minLength: 3, maxLength: 3 }), (chosen) => {
        const [a, b, c] = chosen as [string, string, string];
        expect(JSON.stringify(situationOf(input([a, b, c])))).toBe(reference);
      }),
      { numRuns: 40 },
    );
  });

  it("is deterministic and never mutates its input", () => {
    const value = input(["alpha", "beta", "gamma"]);
    const before = JSON.stringify(value);
    const first = JSON.stringify(situationOf(value));
    expect(JSON.stringify(situationOf(value))).toBe(first);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("gives no situation for a plan the sequent does not run", () => {
    const value = input(["alpha", "beta", "gamma"]);
    const broken = {
      ...value,
      steps: [{ kind: "close-true", target: value.target }] as never,
    };
    expect(abstractSituation(broken)).toMatchObject({ ok: false });
  });
});
