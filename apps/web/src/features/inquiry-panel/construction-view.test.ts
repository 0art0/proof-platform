import { describe, expect, it } from "vitest";
import { constructionTaskModel, evidenceText, sortLabel } from "./construction-view";
import { makeTask } from "./inquiry-fixtures.testing";

describe("constructionTaskModel", () => {
  it("groups requirements by role, always listing all three in a fixed order", () => {
    const model = constructionTaskModel(makeTask(), []);
    expect(model.roles.map(({ role }) => role)).toEqual(["necessary", "sufficient", "heuristic"]);
    expect(
      model.roles.map(({ requirements }) => requirements.map(({ id }) => id as string)),
    ).toEqual([["requirement:positive"], ["requirement:small"], ["requirement:half"]]);
    expect(model.statusLabel).toBe("Partially specified");
    expect(model.open).toBe(true);

    const empty = constructionTaskModel(makeTask({ requirements: [], status: "unresolved" }), []);
    expect(empty.roles.every(({ requirements }) => requirements.length === 0)).toBe(true);
    expect(empty.statusLabel).toBe("Unresolved");
  });

  it("states what each role does and does not establish", () => {
    const [necessary, sufficient, heuristic] = constructionTaskModel(makeTask(), []).roles;
    expect(necessary?.meaning).toMatch(/do not finish the task/);
    expect(sufficient?.meaning).toMatch(/would finish the task/);
    expect(heuristic?.meaning).toMatch(/never assumptions or obligations/);
  });

  it("describes evidence from the stored requirement without judging it", () => {
    const { requirements } = constructionTaskModel(makeTask(), []).roles[0]!;
    expect(evidenceText(requirements[0]!)).toMatchObject({ kind: "attestation" });
    expect(evidenceText(requirements[0]!).text).toMatch(/not judged by the kernel/);
    const model = constructionTaskModel(makeTask(), []);
    expect(evidenceText(model.roles[1]!.requirements[0]!).kind).toBe("target");
    expect(evidenceText(model.roles[2]!.requirements[0]!)).toEqual({
      kind: "none",
      text: "no implication established",
    });
  });

  it("reports origin, scope, sort and allowed dependencies including named tasks", () => {
    const other = makeTask({ id: "construction-task:other", displayName: "N" });
    const dependent = makeTask({
      allowedDependencies: { declarations: ["eps"], tasks: ["construction-task:other"] },
    });
    const model = constructionTaskModel(dependent, [other, dependent]);
    expect(model.origin).toEqual({
      kind: "existential-goal",
      text: "the existential goal goal:main",
    });
    expect(model.sort).toBe("sort:real");
    expect(model.scope).toEqual([{ symbol: "eps", sort: "sort:real" }]);
    expect(model.dependencies).toEqual({
      declarations: ["eps"],
      tasks: [{ id: "construction-task:other", displayName: "N" }],
    });

    const auxiliary = constructionTaskModel(
      makeTask({ origin: { kind: "auxiliary-request", description: "a bound" } }),
      [],
    );
    expect(auxiliary.origin).toEqual({
      kind: "auxiliary-request",
      text: "an auxiliary request: a bound",
    });
  });

  it("shows candidates and how a closed task ended", () => {
    const resolved = constructionTaskModel(
      makeTask({
        status: "resolved",
        candidates: [{ id: "candidate:1", value: ["Divide", "eps", 2], attemptId: "attempt:3" }],
        resolution: {
          candidateId: "candidate:1",
          attemptId: "attempt:3",
          obligationIds: ["obligation:a"],
        },
      }),
      [],
    );
    expect(resolved.open).toBe(false);
    expect(resolved.candidates).toHaveLength(1);
    expect(resolved.outcome).toBe(
      "Resolved by candidate candidate:1; 1 sufficient requirement(s) became obligations.",
    );
    const abandoned = constructionTaskModel(
      makeTask({ status: "abandoned", abandonment: { attemptId: "attempt:4" } }),
      [],
    );
    expect(abandoned.outcome).toBe("Abandoned; the record is kept.");
  });

  it("labels sorts", () => {
    expect(sortLabel({ kind: "proposition" })).toBe("proposition");
    expect(
      sortLabel({
        kind: "function",
        signature: {
          parameters: [{ kind: "named", id: "sort:real" }],
          result: { kind: "proposition" },
        },
      } as never),
    ).toBe("(sort:real) → proposition");
  });
});
