import { describe, expect, it } from "vitest";
import { proofStateSchema, type ProofState } from "@proof/mathjson-model";
import {
  createInquiryExplainer,
  type InquiryExplanationContext,
  type InquiryReasonView,
  type InquiryRecordView,
  type InquiryRelationView,
  type InquiryTemplateId,
} from "./inquiry-explanation";
import { NATURAL, REAL, declare } from "./test-fixtures";

// A small ε–δ style inquiry. Node n0: under ε > 0, find δ with δ > 0 and δ < ε. Node n1: δ is a
// construction placeholder `m(ε)`. Node n2: the conjunction split into two obligations
// (an equivalence). Node n3: the first obligation closed by a sorry (a strengthening).

const hypothesisEps = { id: "hyp:epsilon", statement: { expression: ["Greater", "epsilon", 0] } };
const hypothesisExtra = { id: "hyp:bound", statement: { expression: ["Less", "epsilon", 1] } };
const scope = { declarations: [declare("epsilon", REAL)], hypotheses: [hypothesisEps] };
const EXISTENTIAL = [
  "Exists",
  "delta",
  ["And", ["Greater", "delta", 0], ["Less", "delta", "epsilon"]],
];
const placeholder = ["m", "epsilon"];

const n0: ProofState = proofStateSchema.parse({
  id: "state:n0",
  goals: [
    {
      id: "goal:main",
      sequent: {
        context: {
          declarations: [declare("epsilon", REAL), declare("delta", REAL)],
          hypotheses: [hypothesisEps, hypothesisExtra],
        },
        conclusion: { expression: EXISTENTIAL },
      },
    },
    {
      id: "goal:plain",
      sequent: {
        context: { declarations: [declare("epsilon", REAL)], hypotheses: [] },
        conclusion: { expression: ["Greater", "epsilon", 0] },
      },
    },
  ],
  obligations: [],
});

const task = {
  id: "task:delta",
  symbol: "m",
  displayName: "\\delta",
  sort: REAL,
  origin: {
    kind: "existential-goal",
    target: { kind: "goal", id: "goal:main" },
    statement: { expression: EXISTENTIAL },
  },
  scope,
  allowedDependencies: { declarations: ["epsilon"], tasks: ["task:aux"] },
  requirements: [
    {
      id: "creq:positive",
      role: "sufficient",
      statement: { expression: ["Greater", placeholder, 0] },
      evidence: { kind: "target", target: { kind: "goal", id: "goal:main" } },
      attemptId: "cattempt:1",
    },
    {
      id: "creq:half",
      role: "heuristic",
      statement: { expression: ["Equal", placeholder, ["Divide", "epsilon", 2]] },
      evidence: { kind: "none" },
      attemptId: "cattempt:1",
    },
  ],
  candidates: [],
  status: "partially-specified",
};
const auxiliaryTask = {
  id: "task:aux",
  symbol: "k",
  displayName: "k",
  sort: NATURAL,
  origin: { kind: "auxiliary-request", description: "an index beyond which the bound holds" },
  scope,
  allowedDependencies: { declarations: [], tasks: [] },
  requirements: [],
  candidates: [],
  status: "unresolved",
};

const n1: ProofState = proofStateSchema.parse({
  id: "state:n1",
  goals: [
    {
      id: "goal:main",
      sequent: {
        context: scope,
        conclusion: {
          expression: ["And", ["Greater", placeholder, 0], ["Less", placeholder, "epsilon"]],
        },
      },
    },
  ],
  obligations: [],
  constructions: [task, auxiliaryTask],
});

const n2: ProofState = proofStateSchema.parse({
  id: "state:n2",
  goals: [],
  obligations: [
    {
      id: "obl:positive",
      sequent: { context: scope, conclusion: { expression: ["Greater", placeholder, 0] } },
    },
    {
      id: "obl:small",
      sequent: { context: scope, conclusion: { expression: ["Less", placeholder, "epsilon"] } },
    },
  ],
  constructions: [task, auxiliaryTask],
});

const n3: ProofState = proofStateSchema.parse({ ...n2, id: "state:n3", obligations: [] });

const target = (nodeId: string, kind: "goal" | "obligation", id: string) =>
  ({ kind: "target", nodeId, target: { kind, id } }) as const;

const human = { id: "actor:web", kind: "human" } as const;
const agent = { id: "actor:agent", kind: "agent" } as const;

let sequence = 0;
function record<const Record extends object>(
  fields: Record,
  actor: InquiryRecordView["actor"] = human,
  nodeId = "node:n1",
) {
  sequence += 1;
  return { sequence, nodeId, actor, ...fields } as unknown as InquiryRecordView;
}

const qMain = record({
  id: "q:main",
  kind: "question",
  question: { form: "establish", proposition: target("node:n0", "goal", "goal:main") },
});
const oMain = record({
  id: "o:main",
  kind: "objective",
  questionId: "q:main",
  necessity: "required",
  focus: { nodeId: "node:n0", target: { kind: "goal", id: "goal:main" } },
});
const aSplit = record({
  id: "a:split",
  kind: "attempt",
  objectiveId: "o:main",
  method: { kind: "move", moveId: "move:split-and" },
  selections: [
    {
      kind: "exact",
      anchor: {
        stateId: "state:n1",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "conclusion" },
      },
      path: [0],
    },
    {
      kind: "exact",
      anchor: {
        stateId: "state:n1",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "hypothesis", id: "hyp:epsilon" },
      },
      path: [],
    },
  ],
  suggestion: { suggestionSetId: "set:1", suggestionId: "suggestion:split" },
});
const aResult = record({
  id: "a:result",
  kind: "attempt",
  objectiveId: "o:main",
  method: { kind: "library-result", resultId: "result:archimedes" },
});
const rPositive = record({
  id: "r:positive",
  kind: "requirement",
  subjectId: "a:split",
  proposition: target("node:n2", "obligation", "obl:positive"),
  role: "sufficient",
  support: { kind: "transition", childNodeId: "node:n2" },
});
const rSmall = record({
  id: "r:small",
  kind: "requirement",
  subjectId: "a:split",
  proposition: target("node:n2", "obligation", "obl:small"),
  role: "sufficient",
  support: { kind: "informal", status: "plausible", note: "Take half of ε." },
});
const rNecessary = record({
  id: "r:necessary",
  kind: "requirement",
  subjectId: "a:result",
  proposition: {
    kind: "statement",
    nodeId: "node:n0",
    target: { kind: "goal", id: "goal:main" },
    statement: { kind: "hypothesis", id: "hyp:epsilon" },
  },
  role: "necessary",
  support: {
    kind: "construction-requirement",
    nodeId: "node:n1",
    taskId: "task:delta",
    requirementId: "creq:positive",
  },
});
const qConstruct = record({
  id: "q:construct",
  kind: "question",
  question: {
    form: "construct",
    object: { kind: "construction-task", nodeId: "node:n1", taskId: "task:delta" },
  },
});
const rHeuristic = record({
  id: "r:heuristic",
  kind: "requirement",
  subjectId: "q:construct",
  proposition: {
    kind: "construction-requirement",
    nodeId: "node:n1",
    taskId: "task:delta",
    requirementId: "creq:half",
  },
  role: "heuristic",
});
const qAux = record({
  id: "q:aux",
  kind: "question",
  question: {
    form: "construct",
    object: { kind: "construction-task", nodeId: "node:n1", taskId: "task:aux" },
  },
});
const qUnassigned = record({
  id: "q:unassigned",
  kind: "question",
  question: { form: "construct", object: { kind: "unassigned", displayName: "N", sort: NATURAL } },
});
const qRole = record({
  id: "q:role",
  kind: "question",
  question: {
    form: "determine",
    proposition: {
      ...target("node:n0", "goal", "goal:main"),
      withoutHypotheses: ["hyp:bound"],
    },
  },
});
const qRefute = record({
  id: "q:refute",
  kind: "question",
  question: {
    form: "establish",
    proposition: { ...target("node:n0", "goal", "goal:main"), negated: true },
  },
});
const qNegatedPlain = record({
  id: "q:negated-plain",
  kind: "question",
  question: {
    form: "determine",
    proposition: { ...target("node:n0", "goal", "goal:plain"), negated: true },
  },
});
const qExplore = record({
  id: "q:explore",
  kind: "question",
  question: {
    form: "explore",
    aspect: "relationship",
    objects: [
      {
        kind: "occurrence",
        nodeId: "node:n1",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "conclusion" },
        path: [1],
      },
      {
        kind: "statement",
        nodeId: "node:n0",
        target: { kind: "goal", id: "goal:main" },
        statement: { kind: "hypothesis", id: "hyp:bound" },
      },
    ],
  },
});
const oElective = record({
  id: "o:elective",
  kind: "objective",
  questionId: "q:role",
  necessity: "elective",
  parentAttemptId: "a:result",
});
const obsCounterexample = record({
  id: "obs:counterexample",
  kind: "observation",
  references: [
    {
      kind: "statement",
      nodeId: "node:n0",
      target: { kind: "goal", id: "goal:main" },
      statement: { kind: "hypothesis", id: "hyp:bound" },
    },
  ],
  diagnostic: { code: "counterexample", detail: "ε = 2" },
  support: { kind: "informal", status: "checked-on-examples" },
});
const obsSearch = record({
  id: "obs:search",
  kind: "observation",
  diagnostic: { code: "search-exhausted" },
});
const obsNote = record({
  id: "obs:note",
  kind: "observation",
  note: "The bound on ε is never used.",
  support: { kind: "proof-target", nodeId: "node:n0", target: { kind: "goal", id: "goal:main" } },
});
const xUnmet = record({
  id: "x:unmet",
  kind: "obstruction",
  attemptId: "a:result",
  cause: { kind: "unmet-requirement", requirementId: "r:necessary" },
  observationIds: ["obs:search"],
  potentialResponses: [{ kind: "move", moveId: "move:split-and" }, { kind: "manual" }],
});
const xObservation = record({
  id: "x:observation",
  kind: "obstruction",
  attemptId: "a:split",
  cause: { kind: "observation", observationId: "obs:counterexample" },
});
const dHuman = record({
  id: "d:human",
  kind: "decision",
  subjectId: "o:main",
  selected: { kind: "suggestion", suggestionSetId: "set:1", suggestionId: "suggestion:split" },
  alternatives: [
    { kind: "method", method: { kind: "library-result", resultId: "result:archimedes" } },
    { kind: "record", recordId: "q:role" },
  ],
  reason: { provenance: "explicit-user", basisIds: ["obs:note"], note: "Splitting is simpler." },
});
const dAgent = record(
  {
    id: "d:agent",
    kind: "decision",
    selected: { kind: "record", recordId: "a:result" },
    reason: { provenance: "agent" },
  },
  agent,
);

const baseRecords = [
  qMain,
  oMain,
  aSplit,
  aResult,
  rPositive,
  rSmall,
  rNecessary,
  qConstruct,
  rHeuristic,
  qAux,
  qUnassigned,
  qRole,
  qRefute,
  qNegatedPlain,
  qExplore,
  oElective,
  obsCounterexample,
  obsSearch,
  obsNote,
  xUnmet,
  xObservation,
  dHuman,
  dAgent,
];

function contextWith(records: readonly InquiryRecordView[]): InquiryExplanationContext {
  return {
    nodes: new Map([
      ["node:n0", n0],
      ["node:n1", n1],
      ["node:n2", n2],
      ["node:n3", n3],
    ]),
    records: new Map(records.map((item) => [item.id, item])),
    transitions: new Map([
      ["node:n2", { transitionClass: "equivalence", evidence: "structural" }],
      ["node:n3", { transitionClass: "strengthening", evidence: "sorry" }],
    ]),
    methodNames: {
      moves: new Map([["move:split-and", "Split a conjunction"]]),
      results: new Map([["result:archimedes", "Archimedean property"]]),
    },
    suggestionLabels: new Map([["set:1", new Map([["suggestion:split", "Split the goal"]])]]),
  };
}

const reasons = {
  explicitUser: { provenance: "explicit-user", basisIds: ["obs:note"] },
  agent: { provenance: "agent", note: "The bound looked unused." },
  methodEncoded: {
    provenance: "method-encoded",
    method: { kind: "library-result", resultId: "result:archimedes" },
  },
  later: { provenance: "later-interpretation", basisIds: ["obs:counterexample"] },
} as const satisfies Record<string, InquiryReasonView>;

type RelationshipFields = Readonly<{
  relation: InquiryRelationView;
  from: readonly string[];
  to: string;
  support?: object;
  reason?: InquiryReasonView;
}>;

const relationship = (
  id: string,
  fields: RelationshipFields,
  actor: InquiryRecordView["actor"] = human,
) => record({ id, kind: "relationship", ...fields }, actor);

const relationships = [
  relationship("rel:suffice", {
    relation: "wouldSufficeFor",
    from: ["r:positive", "r:small"],
    to: "q:main",
    support: { kind: "transition", childNodeId: "node:n2" },
  }),
  relationship("rel:suffice-sorry", {
    relation: "wouldSufficeFor",
    from: ["r:small"],
    to: "r:positive",
    support: { kind: "transition", childNodeId: "node:n3" },
  }),
  relationship("rel:suffice-informal", {
    relation: "wouldSufficeFor",
    from: ["q:refute"],
    to: "q:role",
    support: { kind: "informal", status: "conjectured" },
  }),
  relationship("rel:requires", { relation: "requires", from: ["a:result"], to: "r:necessary" }),
  relationship("rel:motivated", {
    relation: "motivatedBy",
    from: ["a:split"],
    to: "obs:note",
    reason: reasons.explicitUser,
  }),
  relationship(
    "rel:motivated-agent",
    { relation: "motivatedBy", from: ["d:agent"], to: "obs:search", reason: reasons.agent },
    agent,
  ),
  relationship("rel:addresses", {
    relation: "addresses",
    from: ["q:role"],
    to: "x:unmet",
    reason: reasons.methodEncoded,
  }),
  relationship("rel:addresses-attempt", {
    relation: "addresses",
    from: ["a:split", "o:elective"],
    to: "x:unmet",
    reason: reasons.explicitUser,
  }),
  relationship("rel:specializes", { relation: "specializes", from: ["q:main"], to: "q:role" }),
  relationship("rel:generalizes", {
    relation: "generalizes",
    from: ["q:role"],
    to: "q:main",
    support: { kind: "proof-target", nodeId: "node:n0", target: { kind: "goal", id: "goal:main" } },
  }),
  relationship(
    "rel:tests",
    { relation: "tests", from: ["a:result"], to: "q:role", reason: reasons.agent },
    agent,
  ),
  relationship("rel:reuses", {
    relation: "reuses",
    from: ["a:split"],
    to: "a:result",
    reason: reasons.methodEncoded,
  }),
  ...(["motivatedBy", "addresses", "tests", "reuses"] as const).map((relation) =>
    relationship(`rel:later-${relation}`, {
      relation,
      from: ["a:result"],
      to:
        relation === "motivatedBy"
          ? "obs:counterexample"
          : relation === "addresses"
            ? "x:observation"
            : relation === "tests"
              ? "q:role"
              : "a:split",
      reason: reasons.later,
    }),
  ),
  relationship("rel:requires-later", {
    relation: "requires",
    from: ["q:main"],
    to: "o:elective",
    reason: reasons.later,
  }),
];

const statusChanges = [
  record({
    id: "s:abandoned",
    kind: "status-change",
    subjectId: "a:result",
    status: "abandoned",
    reason: { provenance: "explicit-user", basisIds: ["obs:search"], note: "Too indirect." },
  }),
  record({
    id: "s:abandoned-plain",
    kind: "status-change",
    subjectId: "a:split",
    status: "abandoned",
  }),
  record({ id: "s:resolved", kind: "status-change", subjectId: "q:main", status: "resolved" }),
  record({
    id: "s:satisfied",
    kind: "status-change",
    subjectId: "r:small",
    status: "satisfied",
    reason: reasons.methodEncoded,
  }),
  record(
    {
      id: "s:progress",
      kind: "status-change",
      subjectId: "a:split",
      status: "in-progress",
      reason: reasons.agent,
    },
    agent,
  ),
  record({ id: "s:dismissed", kind: "status-change", subjectId: "x:unmet", status: "dismissed" }),
];

const allRecords = [...baseRecords, ...relationships, ...statusChanges];
const context = contextWith(allRecords);
const explainer = createInquiryExplainer();
const text = (item: InquiryRecordView, ctx: InquiryExplanationContext = context) =>
  explainer.explain(item, ctx).text;

/** Golden sentences for every record kind, relation, and reason provenance. */
const GOLDENS: readonly (readonly [string, InquiryTemplateId, string])[] = [
  [
    "q:main",
    "question",
    "Question: establish that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$.",
  ],
  [
    "o:main",
    "objective",
    "Objective: establish that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. The proof requires this objective. It focuses on that goal.",
  ],
  [
    "a:split",
    "attempt",
    "To establish that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$, try the move “Split a conjunction” on $m(\\epsilon) > 0$ and $\\epsilon > 0$, chosen as the displayed suggestion “Split the goal”.",
  ],
  [
    "a:result",
    "attempt",
    "To establish that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$, try the result “Archimedean property”.",
  ],
  [
    "r:positive",
    "requirement:sufficient",
    "Sufficient requirement for the attempt with the move “Split a conjunction”: under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is greater than $0$. Establishing it would suffice, together with any other sufficient requirements recorded for it (evidence: the equivalence step to proof node node:n2, justified by a structural step).",
  ],
  [
    "r:small",
    "requirement:sufficient",
    "Sufficient requirement for the attempt with the move “Split a conjunction”: under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is less than $\\epsilon$. Establishing it would suffice, together with any other sufficient requirements recorded for it (informal status: plausible, not validated evidence; note: “Take half of ε.”).",
  ],
  [
    "r:necessary",
    "requirement:necessary",
    "Necessary requirement for the attempt with the result “Archimedean property”: $\\epsilon$ is greater than $0$. It is a necessary condition: it can exclude candidates but does not suffice (evidence: the sufficient construction requirement creq:positive of $\\delta$, supported by the goal goal:main, which the proof already requires).",
  ],
  [
    "q:construct",
    "question",
    "Question: construct $\\delta$, a real number, a witness for the claim that there exists $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. This construction is required to depend only on $\\epsilon$ and the construction of $k$.",
  ],
  [
    "r:heuristic",
    "requirement:heuristic",
    "Heuristic requirement for the question of constructing $\\delta$: $m(\\epsilon)$ is equal to $\\frac{\\epsilon}{2}$. It is worth investigating, with no established implication.",
  ],
  [
    "q:aux",
    "question",
    "Question: construct $k$, a natural number, requested as “an index beyond which the bound holds”. This construction is required to depend on no parameters.",
  ],
  ["q:unassigned", "question", "Question: construct a natural number $N$."],
  [
    "q:role",
    "question",
    "Question: determine whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$.",
  ],
  [
    "q:refute",
    "question",
    "Question: establish the negation of the statement that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$.",
  ],
  [
    "q:negated-plain",
    "question",
    "Question: determine whether $\\epsilon$ is not greater than $0$.",
  ],
  [
    "q:explore",
    "question",
    "Question: explore the relationship between $m(\\epsilon) < \\epsilon$ and the hypothesis that $\\epsilon$ is less than $1$.",
  ],
  [
    "o:elective",
    "objective",
    "Objective: determine whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. This objective is elective: it is not needed to finish the original proof. It was proposed by the attempt with the result “Archimedean property”.",
  ],
  [
    "obs:counterexample",
    "observation",
    "Observation about the hypothesis that $\\epsilon$ is less than $1$: a counterexample (“ε = 2”). It is supported (informal status: checked on examples, not validated evidence).",
  ],
  [
    "obs:search",
    "observation",
    "Observation: a search that ended without success, which does not show that no argument exists. It is unchecked.",
  ],
  [
    "obs:note",
    "observation",
    "Observation: “The bound on ε is never used.” It is supported (evidence: the goal goal:main of proof node node:n0, which the proof already requires).",
  ],
  [
    "x:unmet",
    "obstruction",
    "The attempt with the result “Archimedean property” is blocked because the necessary requirement that $\\epsilon$ is greater than $0$ is unmet. See also the observation of a search that ended without success, which does not show that no argument exists. Possible responses: the move “Split a conjunction” or manual work.",
  ],
  [
    "x:observation",
    "obstruction",
    "The attempt with the move “Split a conjunction” is blocked because of the observation of a counterexample (“ε = 2”).",
  ],
  [
    "d:human",
    "decision",
    "For the objective of establishing that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$, the participant selected the displayed suggestion “Split the goal” over the result “Archimedean property” and the question of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. Reason, stated explicitly by the participant: based on the observation “The bound on ε is never used.”; “Splitting is simpler.”",
  ],
  [
    "d:agent",
    "decision",
    "The agent selected the attempt with the result “Archimedean property”. Reason, recorded by the agent when it acted.",
  ],
  [
    "rel:suffice",
    "relationship:wouldSufficeFor",
    "Establishing that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is greater than $0$ and that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is less than $\\epsilon$ would establish that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ (evidence: the equivalence step to proof node node:n2, justified by a structural step).",
  ],
  [
    "rel:suffice-sorry",
    "relationship:wouldSufficeFor",
    "Establishing that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is less than $\\epsilon$ would establish that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is greater than $0$ (evidence: the strengthening step to proof node node:n3, justified by a sorry, assumed without proof).",
  ],
  [
    "rel:suffice-informal",
    "relationship:wouldSufficeFor",
    "Establishing the negation of the statement that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ would settle the question of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ (informal status: conjectured, not validated evidence).",
  ],
  [
    "rel:requires",
    "relationship:requires",
    "The attempt with the result “Archimedean property” requires the necessary requirement that $\\epsilon$ is greater than $0$.",
  ],
  [
    "rel:motivated",
    "relationship:motivatedBy",
    "The attempt with the move “Split a conjunction” was chosen in response to the observation “The bound on ε is never used.” Reason, stated explicitly by the participant: based on the observation “The bound on ε is never used.”",
  ],
  [
    "rel:motivated-agent",
    "relationship:motivatedBy",
    "The decision to select the attempt with the result “Archimedean property” was chosen in response to the observation of a search that ended without success, which does not show that no argument exists. Reason, recorded by the agent when it acted: “The bound looked unused.”",
  ],
  [
    "rel:addresses",
    "relationship:addresses",
    "To address the obstruction that the necessary requirement that $\\epsilon$ is greater than $0$ is unmet, determine whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. Reason, the objective encoded in the result “Archimedean property”, not separately stated by a participant.",
  ],
  [
    "rel:addresses-attempt",
    "relationship:addresses",
    "To address the obstruction that the necessary requirement that $\\epsilon$ is greater than $0$ is unmet, try the move “Split a conjunction” and pursue the objective of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. Reason, stated explicitly by the participant: based on the observation “The bound on ε is never used.”",
  ],
  [
    "rel:specializes",
    "relationship:specializes",
    "The question of establishing that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ is a special case of the question of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$.",
  ],
  [
    "rel:generalizes",
    "relationship:generalizes",
    "The question of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ generalizes the question of establishing that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ (evidence: the goal goal:main of proof node node:n0, which the proof already requires).",
  ],
  [
    "rel:tests",
    "relationship:tests",
    "The attempt with the result “Archimedean property” investigates the question of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. Reason, recorded by the agent when it acted: “The bound looked unused.”",
  ],
  [
    "rel:reuses",
    "relationship:reuses",
    "The attempt with the move “Split a conjunction” reuses the attempt with the result “Archimedean property”. Reason, the objective encoded in the result “Archimedean property”, not separately stated by a participant.",
  ],
  [
    "rel:later-motivatedBy",
    "relationship:motivatedBy:later-interpretation",
    "On a later interpretation, the attempt with the result “Archimedean property” can be read as motivated by the observation of a counterexample (“ε = 2”). Reason, a later interpretation, not a reason recorded at the time: based on the observation of a counterexample (“ε = 2”).",
  ],
  [
    "rel:later-addresses",
    "relationship:addresses:later-interpretation",
    "On a later interpretation, the attempt with the result “Archimedean property” can be read as addressing the obstruction arising from the observation of a counterexample (“ε = 2”). Reason, a later interpretation, not a reason recorded at the time: based on the observation of a counterexample (“ε = 2”).",
  ],
  [
    "rel:later-tests",
    "relationship:tests:later-interpretation",
    "On a later interpretation, the attempt with the result “Archimedean property” can be read as testing the question of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. Reason, a later interpretation, not a reason recorded at the time: based on the observation of a counterexample (“ε = 2”).",
  ],
  [
    "rel:later-reuses",
    "relationship:reuses:later-interpretation",
    "On a later interpretation, the attempt with the result “Archimedean property” can be read as reusing the attempt with the move “Split a conjunction”. Reason, a later interpretation, not a reason recorded at the time: based on the observation of a counterexample (“ε = 2”).",
  ],
  [
    "rel:requires-later",
    "relationship:requires",
    "The question of establishing that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ requires the objective of determining whether, under the hypothesis that $\\epsilon$ is greater than $0$ and without the hypothesis that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$. Reason, a later interpretation, not a reason recorded at the time: based on the observation of a counterexample (“ε = 2”).",
  ],
  [
    "s:abandoned",
    "status-change:abandoned-after",
    "The attempt with the result “Archimedean property” was abandoned after the observation of a search that ended without success, which does not show that no argument exists. Reason, stated explicitly by the participant: “Too indirect.”",
  ],
  [
    "s:abandoned-plain",
    "status-change",
    "The attempt with the move “Split a conjunction” was marked abandoned.",
  ],
  [
    "s:resolved",
    "status-change",
    "The question of establishing that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$ was marked resolved.",
  ],
  [
    "s:satisfied",
    "status-change",
    "The sufficient requirement that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is less than $\\epsilon$ was marked satisfied. Reason, the objective encoded in the result “Archimedean property”, not separately stated by a participant.",
  ],
  [
    "s:progress",
    "status-change",
    "The attempt with the move “Split a conjunction” was marked in progress. Reason, recorded by the agent when it acted: “The bound looked unused.”",
  ],
  [
    "s:dismissed",
    "status-change",
    "The obstruction that the necessary requirement that $\\epsilon$ is greater than $0$ is unmet was marked dismissed.",
  ],
];

describe("inquiry explanation templates", () => {
  it("covers every record in the fixture exactly once", () => {
    expect(GOLDENS.map(([id]) => id)).toEqual(allRecords.map(({ id }) => id));
  });

  it.each(GOLDENS)("%s (%s)", (id, template, expected) => {
    const item = context.records.get(id);
    if (item === undefined) throw new Error(`Missing fixture record ${id}.`);
    expect(explainer.explain(item, context)).toEqual({ recordId: id, template, text: expected });
  });

  it("renders the sufficiency template over an attempt's sufficient requirements", () => {
    expect(explainer.explainSufficiency("a:split", context)).toEqual({
      recordId: "a:split",
      template: "sufficiency",
      text: "This method would suffice if it were established that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is greater than $0$ (evidence: the equivalence step to proof node node:n2, justified by a structural step) and that, under the hypothesis that $\\epsilon$ is greater than $0$, $m(\\epsilon)$ is less than $\\epsilon$ (informal status: plausible, not validated evidence; note: “Take half of ε.”).",
    });
    expect(explainer.explainSufficiency("a:result", context)).toBeUndefined();
  });
});

describe("reason provenance", () => {
  const RELATION_ENDPOINTS: Readonly<Record<InquiryRelationView, readonly [string, string]>> = {
    wouldSufficeFor: ["r:small", "q:main"],
    requires: ["a:result", "r:necessary"],
    motivatedBy: ["a:split", "obs:note"],
    addresses: ["a:split", "x:unmet"],
    specializes: ["q:main", "q:role"],
    generalizes: ["q:role", "q:main"],
    tests: ["a:result", "q:role"],
    reuses: ["a:split", "a:result"],
  };
  const INTENTIONS = new Set<InquiryRelationView>(["motivatedBy", "addresses", "tests", "reuses"]);
  const cases = Object.entries(RELATION_ENDPOINTS).flatMap(([relation, [from, to]]) =>
    Object.entries(reasons).map(
      ([label, reason]) => [relation as InquiryRelationView, label, from, to, reason] as const,
    ),
  );

  it.each(cases)(
    "%s with a %s reason states its provenance",
    (relation, _label, from, to, reason) => {
      const actor = reason.provenance === "agent" ? agent : human;
      const item = relationship(`rel:${relation}`, { relation, from: [from], to, reason }, actor);
      const rendered = text(item);
      const later = reason.provenance === "later-interpretation";
      expect(rendered.includes("a later interpretation, not a reason recorded at the time")).toBe(
        later,
      );
      if (later && INTENTIONS.has(relation)) {
        // A later interpretation is never phrased as the contemporaneous intention.
        expect(rendered.startsWith("On a later interpretation, ")).toBe(true);
        expect(rendered).not.toMatch(/^To address|was chosen in response|investigates |reuses /);
      }
      if (reason.provenance === "method-encoded") {
        expect(rendered).toContain(
          "the objective encoded in the result “Archimedean property”, not separately stated by a participant",
        );
      }
      if (reason.provenance === "explicit-user") {
        expect(rendered).toContain("stated explicitly by the participant");
      }
      if (reason.provenance === "agent") expect(rendered).toContain("recorded by the agent");
    },
  );

  it("never renders a reason that was not recorded", () => {
    const item = relationship("rel:bare", {
      relation: "specializes",
      from: ["q:main"],
      to: "q:role",
    });
    expect(text(item)).not.toContain("Reason");
  });
});

describe("distinctions stay visible", () => {
  const stored = (id: string) => {
    const item = context.records.get(id);
    if (item === undefined) throw new Error(`Missing fixture record ${id}.`);
    return item;
  };

  it("names the transition class and a sorry as the evidence", () => {
    expect(text(stored("rel:suffice"))).toContain("the equivalence step");
    expect(text(stored("rel:suffice-sorry"))).toContain(
      "the strengthening step to proof node node:n3, justified by a sorry, assumed without proof",
    );
  });

  it("flags a weakening step as not showing sufficiency", () => {
    const weakening: InquiryExplanationContext = {
      ...context,
      transitions: new Map([["node:n2", { transitionClass: "weakening" }]]),
    };
    expect(text(rPositive, weakening)).toContain(
      "the weakening step to proof node node:n2, which does not by itself show sufficiency",
    );
  });

  it("keeps informal support visibly unvalidated", () => {
    expect(text(rSmall)).toContain("informal status: plausible, not validated evidence");
  });
});

describe("totality and determinism", () => {
  it("names missing snapshots and records by identifier", () => {
    const empty: InquiryExplanationContext = { nodes: new Map(), records: new Map() };
    for (const item of allRecords) {
      const sentence = explainer.explain(item, empty).text;
      expect(sentence).not.toMatch(/undefined|\[object/);
      expect(sentence.length).toBeGreaterThan(0);
    }
    expect(text(qMain, empty)).toBe(
      "Question: establish the conclusion of the goal goal:main of proof node node:n0.",
    );
    expect(text(aSplit, empty)).toBe(
      "For the objective o:main, try the move “move:split-and” on a selection and a selection, " +
        "chosen as the displayed suggestion suggestion:split.",
    );
    expect(text(xUnmet, empty)).toBe(
      "The inquiry record a:result is blocked because the requirement r:necessary is unmet. " +
        "See also the inquiry record obs:search. " +
        "Possible responses: the move “move:split-and” or manual work.",
    );
  });

  it("does not render selections against a different snapshot than the anchor's", () => {
    const stale = record({
      id: "a:stale",
      kind: "attempt",
      objectiveId: "o:main",
      method: { kind: "manual" },
      selections: [
        {
          kind: "exact",
          anchor: {
            stateId: "state:other",
            target: { kind: "goal", id: "goal:main" },
            statement: { kind: "conclusion" },
          },
          path: [],
        },
      ],
    });
    expect(text(stale)).toMatch(/, try manual work on a selection\.$/);
  });

  it("renders an associative selection as the selected operand range", () => {
    const sum: ProofState = proofStateSchema.parse({
      id: "state:sum",
      goals: [
        {
          id: "goal:sum",
          sequent: {
            context: {
              declarations: [declare("a", REAL), declare("b", REAL), declare("c", REAL)],
              hypotheses: [],
            },
            conclusion: { expression: ["Equal", ["Add", "a", "b", "c"], ["Add", "c", "b", "a"]] },
          },
        },
      ],
      obligations: [],
    });
    const question = record({
      id: "q:sum",
      kind: "question",
      question: { form: "establish", proposition: target("node:sum", "goal", "goal:sum") },
    });
    const objective = record({
      id: "o:sum",
      kind: "objective",
      questionId: "q:sum",
      necessity: "required",
    });
    const attempt = record(
      {
        id: "a:sum",
        kind: "attempt",
        objectiveId: "o:sum",
        method: { kind: "move", moveId: "move:commute" },
        selections: [
          {
            kind: "associative",
            anchor: {
              stateId: "state:sum",
              target: { kind: "goal", id: "goal:sum" },
              statement: { kind: "conclusion" },
            },
            containerPath: [0],
            startOperand: 1,
            endOperand: 3,
          },
        ],
      },
      human,
      "node:sum",
    );
    const sumContext: InquiryExplanationContext = {
      nodes: new Map([["node:sum", sum]]),
      records: new Map([question, objective, attempt].map((item) => [item.id, item])),
    };
    expect(text(attempt, sumContext)).toBe(
      "To establish that $a+b+c$ is equal to $c+b+a$, try the move “move:commute” on $b+c$.",
    );
    expect(text(objective, sumContext)).toBe(
      "Objective: establish that $a+b+c$ is equal to $c+b+a$. The proof requires this objective.",
    );
  });

  it("uses the presentation's relation style", () => {
    const symbols = createInquiryExplainer({ relationStyle: "symbols" });
    expect(symbols.explain(qNegatedPlain, context).text).toBe(
      "Question: determine whether $\\epsilon \\not> 0$.",
    );
  });

  it("orders records by sequence, freezes the result and does not mutate its input", () => {
    const snapshot = JSON.stringify(allRecords);
    const explained = explainer.explainAll([...allRecords].reverse(), context);
    expect(explained.map(({ recordId }) => recordId)).toEqual(allRecords.map(({ id }) => id));
    expect(Object.isFrozen(explained)).toBe(true);
    expect(Object.isFrozen(explained[0])).toBe(true);
    expect(JSON.stringify(allRecords)).toBe(snapshot);
    expect(explainer.explainAll(allRecords, context)).toEqual(explained);
  });
});

describe("method-created references", () => {
  it("names the platform's inquiry methods and result conditions of displayed suggestions", () => {
    const attempt = record({
      id: "a:try",
      kind: "attempt",
      objectiveId: "o:main",
      method: { kind: "inquiry-method", methodId: "try-result" },
      suggestion: { suggestionSetId: "set:1", suggestionId: "suggestion:split" },
    });
    const observation = record({
      id: "obs:premise",
      kind: "observation",
      references: [
        {
          kind: "result-condition",
          nodeId: "node:n1",
          suggestionSetId: "set:1",
          suggestionId: "suggestion:split",
          condition: { kind: "side-condition", index: 0 },
        },
      ],
      diagnostic: { code: "unmet-condition" },
    });
    expect(text(attempt)).toBe(
      "To establish that, under the hypotheses that $\\epsilon$ is greater than $0$ and that $\\epsilon$ is less than $1$, " +
        "there exists a real number $\\delta$ such that $\\delta$ is greater than $0$ and $\\delta$ is less than $\\epsilon$, " +
        "try the method “Try this theorem”, chosen as the displayed suggestion “Split the goal”.",
    );
    expect(text(observation)).toBe(
      "Observation about side condition 1 of the result in the displayed suggestion “Split the goal”: " +
        "an unmet condition. It is unchecked.",
    );
  });
});
