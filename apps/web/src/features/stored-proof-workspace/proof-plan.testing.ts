import type { PlanView } from "./proof-plan-contract";

const by = (facts: string[], method: string | null = null) => ({
  facts,
  results: [],
  background: null,
  method,
});

const step = (id: string, form: string, extra: Record<string, unknown> = {}) => ({
  id,
  parent: null,
  form,
  claim: null,
  variables: [],
  assumptions: [],
  term: null,
  actsOn: [],
  by: by([]),
  motivation: null,
  ...extra,
});

/** Assuming p and q, show q and p: two facts, then a QED. */
export const PLAN_VIEW: PlanView = {
  status: "planned",
  callId: "llm-call:plan-1",
  plan: {
    theorem: { latex: "q \\land p", prose: "q and p" },
    sketch: "Take the conjunction apart and put it back together.",
    steps: [
      step("have-q", "have", {
        claim: { latex: "q", prose: "q" },
        actsOn: ["H1"],
        by: by(["H1"], "and elimination"),
        motivation: "The hypothesis is a conjunction.",
      }),
      step("have-p", "have", {
        claim: { latex: "p", prose: "p" },
        actsOn: ["H1"],
        by: by(["H1"], "and elimination"),
        motivation: "The other conjunct.",
      }),
      step("qed", "qed", { by: by(["have-q", "have-p"], "and introduction") }),
    ],
  },
  numbers: [
    { stepId: "have-q", number: "⟨1⟩1", level: 1 },
    { stepId: "have-p", number: "⟨1⟩2", level: 1 },
    { stepId: "qed", number: "⟨1⟩3", level: 1 },
  ],
  units: [
    { stepId: "have-q", number: "⟨1⟩1", form: "have", focus: "theorem" },
    { stepId: "have-p", number: "⟨1⟩2", form: "have", focus: "theorem" },
    { stepId: "qed", number: "⟨1⟩3", form: "qed", focus: "theorem" },
  ],
  initialState: { nodeId: "node:one", goalId: "goal:main" },
  warnings: [],
  rendered: {
    theorem: "q\\land p",
    steps: {
      "have-q": { claim: "q", term: null, assumptions: [] },
      "have-p": { claim: "p", term: null, assumptions: [] },
      qed: { claim: null, term: null, assumptions: [] },
    },
  },
};

export const CANDIDATE = {
  id: "candidate:3",
  label: "Expand conjunction hypothesis — on q\\land p; p\\land q",
  source: "move",
  artifactId: "move:expand-hypothesis-conjunction",
  selections: ["q\\land p", "p\\land q"],
};
