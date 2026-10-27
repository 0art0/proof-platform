import { describe, expect, it } from "vitest";
import {
  SETUP_SECTION,
  deriveSetupProgress,
  type SetupProgressInput,
  type SetupStep,
  type SetupStepId,
} from "./setup-progress";

const EMPTY: SetupProgressInput = {
  ai: { background: false, library: false },
  statementFilled: false,
  backgroundAccepted: false,
  backgroundFieldsFilled: false,
  approvedLibraryResults: undefined,
  declarationsFilled: false,
  hypotheses: [],
  goals: ["empty"],
  reviewed: false,
  approvable: false,
};

/** The form once the problem, background and setup are entered, before any check. */
const FILLED: SetupProgressInput = {
  ...EMPTY,
  statementFilled: true,
  backgroundFieldsFilled: true,
  declarationsFilled: true,
  hypotheses: ["parsed"],
  goals: ["parsed"],
};

const AI = { background: true, library: true };

function steps(input: Partial<SetupProgressInput>): readonly SetupStep[] {
  return deriveSetupProgress({ ...EMPTY, ...input });
}

const ids = (list: readonly SetupStep[]) => list.map(({ id }) => id);
const byId = (list: readonly SetupStep[], id: SetupStepId) => {
  const step = list.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`No ${id} step`);
  return step;
};
const current = (list: readonly SetupStep[]) =>
  list.filter(({ state }) => state === "current").map(({ id }) => id);

describe("deriveSetupProgress without AI", () => {
  it("starts at the problem, with the background entered by hand and no library step", () => {
    const list = steps({});
    expect(ids(list)).toEqual(["problem", "background", "setup", "review"]);
    expect(current(list)).toEqual(["problem"]);
    expect(byId(list, "problem")).toMatchObject({
      state: "current",
      status: "Enter the problem statement",
      target: SETUP_SECTION.problem,
    });
    expect(byId(list, "background")).toMatchObject({
      state: "todo",
      status: "Enter what the reader may assume",
      target: SETUP_SECTION.backgroundFields,
    });
    expect(byId(list, "review").state).toBe("todo");
  });

  it("moves to the background once the statement is entered", () => {
    const list = steps({ statementFilled: true });
    expect(byId(list, "problem")).toMatchObject({ state: "done", status: "Statement entered" });
    expect(current(list)).toEqual(["background"]);
  });

  it("counts the hand-entered level and summary as the background", () => {
    const list = steps({ statementFilled: true, backgroundFieldsFilled: true });
    expect(byId(list, "background")).toMatchObject({ state: "done", status: "Entered by hand" });
    expect(current(list)).toEqual(["setup"]);
    expect(byId(list, "setup").status).toBe("Enter what to prove");
  });

  it("finishes the setup only when every variable is named and every statement is recognized", () => {
    const base = { ...FILLED };
    expect(current(deriveSetupProgress(base))).toEqual(["review"]);
    expect(byId(deriveSetupProgress(base), "setup")).toMatchObject({
      state: "done",
      status: "1 hypothesis, 1 goal",
    });

    const unnamed = deriveSetupProgress({ ...base, declarationsFilled: false });
    expect(byId(unnamed, "setup")).toMatchObject({
      state: "current",
      status: "Name each variable, or remove its row",
    });

    const unreadable = deriveSetupProgress({ ...base, goals: ["parsed", "error"] });
    expect(byId(unreadable, "setup")).toMatchObject({
      state: "current",
      status: "Fix the notation that was not recognized",
    });

    const blankHypothesis = deriveSetupProgress({ ...base, hypotheses: ["empty"] });
    expect(byId(blankHypothesis, "setup").status).toBe("Fill in or remove the empty hypothesis");

    const noGoal = deriveSetupProgress({ ...base, goals: [] });
    expect(byId(noGoal, "setup").status).toBe("Enter what to prove");
  });

  it("allows a setup without hypotheses", () => {
    const list = deriveSetupProgress({ ...FILLED, hypotheses: [] });
    expect(byId(list, "setup")).toMatchObject({ state: "done", status: "0 hypotheses, 1 goal" });
  });

  it("makes the review current once everything else is done, and links to the check bar", () => {
    const list = deriveSetupProgress(FILLED);
    expect(current(list)).toEqual(["review"]);
    expect(byId(list, "review")).toMatchObject({
      status: "Check your setup",
      target: SETUP_SECTION.check,
    });
  });

  it("never marks the review done", () => {
    const list = deriveSetupProgress({ ...FILLED, reviewed: true, approvable: true });
    expect(list.filter(({ state }) => state === "done").map(({ id }) => id)).toEqual([
      "problem",
      "background",
      "setup",
    ]);
    expect(byId(list, "review")).toMatchObject({
      state: "current",
      status: "Ready to start",
      target: SETUP_SECTION.review,
    });
  });

  it("asks for another check when the reviewed setup no longer matches", () => {
    const list = deriveSetupProgress({ ...FILLED, reviewed: true, approvable: false });
    expect(byId(list, "review").status).toBe("Check the setup again");
  });
});

describe("deriveSetupProgress with AI", () => {
  it("points the background at the AI step and suggests one", () => {
    const list = steps({ ai: AI, statementFilled: true });
    expect(ids(list)).toEqual(["problem", "background", "library", "setup", "review"]);
    expect(byId(list, "background")).toMatchObject({
      state: "current",
      status: "Suggest a background, or enter one",
      target: SETUP_SECTION.background,
    });
    expect(byId(list, "library")).toMatchObject({
      state: "todo",
      status: "Optional",
      optional: true,
    });
  });

  it("marks an accepted background done and offers the optional library next", () => {
    const list = steps({ ai: AI, statementFilled: true, backgroundAccepted: true });
    expect(byId(list, "background")).toMatchObject({ state: "done", status: "Accepted" });
    expect(current(list)).toEqual(["library"]);
    expect(byId(list, "library")).toMatchObject({
      status: "Optional",
      target: SETUP_SECTION.library,
    });
  });

  it("marks an approved library done with its size", () => {
    const one = steps({
      ai: AI,
      statementFilled: true,
      backgroundAccepted: true,
      approvedLibraryResults: 1,
    });
    expect(byId(one, "library")).toMatchObject({ state: "done", status: "Approved: 1 result" });
    expect(current(one)).toEqual(["setup"]);

    const three = steps({
      ai: AI,
      statementFilled: true,
      backgroundAccepted: true,
      approvedLibraryResults: 3,
    });
    expect(byId(three, "library").status).toBe("Approved: 3 results");
  });

  it("stops offering the library once the setup is filled in, and calls it skipped after a check", () => {
    const filled = deriveSetupProgress({ ...FILLED, ai: AI, backgroundAccepted: true });
    expect(byId(filled, "library")).toMatchObject({ state: "todo", status: "Optional" });
    expect(current(filled)).toEqual(["review"]);

    const reviewed = deriveSetupProgress({
      ...FILLED,
      ai: AI,
      backgroundAccepted: true,
      reviewed: true,
      approvable: true,
    });
    expect(byId(reviewed, "library")).toMatchObject({ state: "todo", status: "Skipped" });
    expect(current(reviewed)).toEqual(["review"]);
  });

  it("omits the library when only the background proposer is configured", () => {
    const list = steps({ ai: { background: true, library: false }, statementFilled: true });
    expect(ids(list)).toEqual(["problem", "background", "setup", "review"]);
    expect(byId(list, "background").target).toBe(SETUP_SECTION.background);
  });

  it("omits the library when the librarian has no background proposer to build from", () => {
    const list = steps({ ai: { background: false, library: true }, statementFilled: true });
    expect(ids(list)).toEqual(["problem", "background", "setup", "review"]);
    expect(byId(list, "background").target).toBe(SETUP_SECTION.backgroundFields);
  });

  it("has exactly one current step in every combination of the form's state", () => {
    const flags = [false, true];
    for (const statementFilled of flags)
      for (const backgroundAccepted of flags)
        for (const backgroundFieldsFilled of flags)
          for (const library of flags)
            for (const reviewed of flags)
              for (const goals of [[], ["empty"], ["parsed"], ["error"]] as const) {
                const list = deriveSetupProgress({
                  ...EMPTY,
                  ai: { background: true, library },
                  statementFilled,
                  backgroundAccepted,
                  backgroundFieldsFilled,
                  declarationsFilled: true,
                  goals,
                  reviewed,
                  approvable: reviewed,
                });
                expect(current(list)).toHaveLength(1);
                expect(new Set(list.map(({ target }) => target)).size).toBe(list.length);
              }
  });
});
