/**
 * The "Setup progress" steps of the new-problem page, derived purely from the form's state. Nothing
 * here calls the proof service: a step is done when the form already holds what it asks for, so
 * the list is a reading of the form and never a second source of truth.
 */
export type SetupStepId = "problem" | "background" | "library" | "setup" | "review";

/** How one statement row reads: nothing entered, notation recognized, or notation not recognized. */
export type StatementKind = "empty" | "parsed" | "error";

export type SetupStepState = "done" | "current" | "todo";

export type SetupStep = Readonly<{
  id: SetupStepId;
  label: string;
  state: SetupStepState;
  /** A short line under the label. */
  status: string;
  /** The DOM id of the section the step links to (`SETUP_SECTION`). */
  target: string;
  /** Optional steps never block "Check setup". */
  optional: boolean;
}>;

/** The ids of the sections the steps link to; the form puts them on the matching elements. */
export const SETUP_SECTION = Object.freeze({
  problem: "setup-problem",
  /** The AI background step, which is always on the page. */
  background: "setup-background",
  /** The hand-entered background fields, used when no background proposer is configured. */
  backgroundFields: "setup-background-fields",
  library: "setup-library",
  setup: "setup-known",
  /** The "Check setup" bar, before a review exists. */
  check: "setup-check",
  review: "setup-review",
});

export type SetupProgressInput = Readonly<{
  /** Which AI roles the proof service offers; without them the steps are entered by hand. */
  ai: Readonly<{ background: boolean; library: boolean }>;
  /** The problem statement has text. */
  statementFilled: boolean;
  /** The user accepted a proposed background. */
  backgroundAccepted: boolean;
  /** The assumed level and what the reader is expected to know are both filled in. */
  backgroundFieldsFilled: boolean;
  /** How many results the user approved for the library; undefined if none were approved. */
  approvedLibraryResults: number | undefined;
  /** Every variable row has a name (no rows is fine). */
  declarationsFilled: boolean;
  hypotheses: readonly StatementKind[];
  goals: readonly StatementKind[];
  /** A checked setup is on screen. */
  reviewed: boolean;
  /** The checked setup still matches the form and can be started. */
  approvable: boolean;
}>;

export function deriveSetupProgress(input: SetupProgressInput): readonly SetupStep[] {
  const problemDone = input.statementFilled;
  const backgroundDone = input.backgroundAccepted || input.backgroundFieldsFilled;
  // A library is built from an accepted background, so it needs the background proposer too.
  const libraryShown = input.ai.library && input.ai.background;
  const libraryDone = input.approvedLibraryResults !== undefined;
  const setup = assessSetup(input);

  // The step to work on next. A checked setup is always the review; the optional library is
  // offered only until the setup is filled in, after which skipping it is the user's call.
  const libraryOffered = libraryShown && backgroundDone && !libraryDone && !setup.done;
  const current: SetupStepId = input.reviewed
    ? "review"
    : !problemDone
      ? "problem"
      : !backgroundDone
        ? "background"
        : libraryOffered
          ? "library"
          : !setup.done
            ? "setup"
            : "review";

  const stateOf = (id: SetupStepId, done: boolean): SetupStepState =>
    done ? "done" : id === current ? "current" : "todo";

  const steps: SetupStep[] = [
    {
      id: "problem",
      label: "Problem",
      state: stateOf("problem", problemDone),
      status: problemDone ? "Statement entered" : "Enter the problem statement",
      target: SETUP_SECTION.problem,
      optional: false,
    },
    {
      id: "background",
      label: "Background",
      state: stateOf("background", backgroundDone),
      status: backgroundDone
        ? input.backgroundAccepted
          ? "Accepted"
          : "Entered by hand"
        : input.ai.background
          ? "Suggest a background, or enter one"
          : "Enter what the reader may assume",
      target: input.ai.background ? SETUP_SECTION.background : SETUP_SECTION.backgroundFields,
      optional: false,
    },
  ];
  if (libraryShown) {
    const count = input.approvedLibraryResults ?? 0;
    steps.push({
      id: "library",
      label: "Library",
      state: stateOf("library", libraryDone),
      status: libraryDone
        ? `Approved: ${count} ${count === 1 ? "result" : "results"}`
        : input.reviewed
          ? "Skipped"
          : "Optional",
      target: SETUP_SECTION.library,
      optional: true,
    });
  }
  steps.push(
    {
      id: "setup",
      label: "Setup",
      state: stateOf("setup", setup.done),
      status: setup.status,
      target: SETUP_SECTION.setup,
      optional: false,
    },
    {
      id: "review",
      label: "Review & start",
      // Nothing is "done" here: once the session starts, the page is left.
      state: current === "review" ? "current" : "todo",
      status: input.reviewed
        ? input.approvable
          ? "Ready to start"
          : "Check the setup again"
        : "Check your setup",
      target: input.reviewed ? SETUP_SECTION.review : SETUP_SECTION.check,
      optional: false,
    },
  );
  return steps;
}

/** The setup is done when every variable is named and every statement is entered and recognized. */
function assessSetup(
  input: Pick<SetupProgressInput, "declarationsFilled" | "hypotheses" | "goals">,
): Readonly<{ done: boolean; status: string }> {
  const { hypotheses, goals } = input;
  const statements = [...hypotheses, ...goals];
  if (goals.length === 0 || goals.includes("empty")) {
    return { done: false, status: "Enter what to prove" };
  }
  if (hypotheses.includes("empty")) {
    return { done: false, status: "Fill in or remove the empty hypothesis" };
  }
  if (statements.includes("error")) {
    return { done: false, status: "Fix the notation that was not recognized" };
  }
  if (!input.declarationsFilled) {
    return { done: false, status: "Name each variable, or remove its row" };
  }
  return {
    done: true,
    status: `${count(hypotheses.length, "hypothesis", "hypotheses")}, ${count(goals.length, "goal", "goals")}`,
  };
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
