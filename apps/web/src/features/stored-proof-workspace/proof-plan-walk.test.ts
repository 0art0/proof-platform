import { describe, expect, it } from "vitest";
import {
  afterApplied,
  afterTranslation,
  continueFrom,
  currentUnit,
  focusUnknown,
  missingMoveReport,
  skipUnit,
  startWalk,
  unitStart,
  walkFinished,
} from "./proof-plan-walk";
import { CANDIDATE, PLAN_VIEW } from "./proof-plan.testing";
import type { PlanView } from "./proof-plan-contract";

const proposed = {
  status: "proposed" as const,
  callId: "llm-call:t1",
  confidence: 0.9,
  actor: { kind: "agent" as const },
  choice: CANDIDATE,
  alternatives: [],
  menuChoices: {},
  preview: { nodeId: "node:one", transitionClass: "equivalence" as const },
};

describe("walking a plan", () => {
  it("starts at the first unit on the theorem's goal", () => {
    const walk = startWalk(PLAN_VIEW, "node:one");
    expect(currentUnit(walk)?.stepId).toBe("have-q");
    expect(unitStart(walk)).toEqual({ nodeId: "node:one", focusTargetId: "goal:main" });
  });

  it("keeps a unit's start across its moves and advances when it is realized", () => {
    let walk = startWalk(PLAN_VIEW, "node:one");
    walk = afterTranslation(walk, proposed);
    walk = afterApplied(walk, CANDIDATE.label, "node:two");
    expect(walk).toMatchObject({
      index: 0,
      nodeId: "node:two",
      start: { nodeId: "node:one", focusTargetId: "goal:main" },
      movesSoFar: [CANDIDATE.label],
    });
    walk = afterTranslation(walk, {
      status: "realized",
      outputs: { focusTargetId: "goal:main", produced: ["hypothesis:q"] },
    });
    expect(walk).toMatchObject({ index: 1, movesSoFar: [], refs: { "have-q": ["hypothesis:q"] } });
    expect(walk.start).toBeUndefined();
    expect(walk.records["have-q"]).toEqual({ status: "realized", moves: [CANDIDATE.label] });
    expect(unitStart(walk)).toEqual({ nodeId: "node:two", focusTargetId: "goal:main" });
  });

  it("maps case goals to their focus keys", () => {
    const view: PlanView = {
      ...PLAN_VIEW,
      units: [
        { stepId: "split", number: "⟨1⟩1", form: "cases", focus: "theorem" },
        { stepId: "qed-a", number: "⟨3⟩1", form: "qed", focus: "case:a" },
      ],
    };
    let walk = startWalk(view, "node:one");
    walk = afterTranslation(walk, {
      status: "realized",
      outputs: { caseTargets: { a: "goal:a", b: "goal:b" }, produced: [] },
    });
    expect(walk.focus).toMatchObject({ "case:a": "goal:a", "case:b": "goal:b" });
    expect(unitStart(walk)).toEqual({ nodeId: "node:one", focusTargetId: "goal:a" });
  });

  it("stops at a missing move, reports it, and moves on only when skipped", () => {
    let walk = startWalk(PLAN_VIEW, "node:one");
    walk = afterTranslation(walk, {
      status: "no-move",
      reason: "No displayed action carries out this step.",
      callId: "llm-call:t1",
      candidateCount: 12,
      alternatives: [{ ...CANDIDATE, probability: 0.2 }],
    });
    expect(walk.index).toBe(0);
    expect(missingMoveReport(walk, PLAN_VIEW).entries).toEqual([
      expect.objectContaining({
        number: "⟨1⟩1",
        status: "no-move",
        claim: "q",
        candidateCount: 12,
        bestCandidates: [{ label: CANDIDATE.label, probability: 0.2 }],
      }),
    ]);
    walk = skipUnit(walk);
    expect(walk.index).toBe(1);
    expect(walk.records["have-q"]).toMatchObject({ status: "no-move", skipped: true });
  });

  it("advances past an unsupported step by itself", () => {
    const walk = afterTranslation(startWalk(PLAN_VIEW, "node:one"), {
      status: "unsupported",
      reason: "needs a claim (cut) move",
    });
    expect(walk.index).toBe(1);
    expect(missingMoveReport(walk, PLAN_VIEW).entries[0]).toMatchObject({ status: "unsupported" });
  });

  it("reports a unit whose focus is unknown as stuck, and continues from another node", () => {
    const view: PlanView = {
      ...PLAN_VIEW,
      units: [{ stepId: "qed-a", number: "⟨3⟩1", form: "qed", focus: "case:a" }],
    };
    const walk = startWalk(view, "node:one");
    expect(unitStart(walk)).toBeUndefined();
    expect(focusUnknown(walk).records["qed-a"]?.status).toBe("stuck");
    expect(continueFrom(walk, "node:nine")).toMatchObject({ nodeId: "node:nine", movesSoFar: [] });
  });

  it("finishes after the last unit", () => {
    let walk = startWalk(PLAN_VIEW, "node:one");
    for (let index = 0; index < 3; index += 1) walk = skipUnit(walk);
    expect(walkFinished(walk)).toBe(true);
    expect(currentUnit(walk)).toBeUndefined();
  });
});
