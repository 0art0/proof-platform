import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyTransition,
  kernelOperationSchema,
  parseKernelResultCatalog,
  type KernelResult,
} from "@proof/kernel";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  INTENTION_RELATIONS,
  deriveConditionalLemmaInquiry,
  deriveHypothesisInvestigation,
  deriveTryResultInquiry,
  planConditionalLemma,
  prepareInquiryCommand,
  usedHypotheses,
  proofNodeIdSchema,
  type DisplayedSuggestionSet,
  type InquiryCommandContext,
  type InquiryRecord,
  type ProofEdge,
  type ProofNode,
  type RecordInquiryCommandRequest,
} from ".";

const declarations = ["p", "q", "r", "a", "b", "c", "d"].map((symbol) => ({
  id: `declaration:${symbol}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

function node(
  id: string,
  goals: readonly Readonly<{
    id: string;
    conclusion: PlainMathJson;
    hypotheses?: readonly (readonly [string, PlainMathJson])[];
  }>[],
): ProofNode {
  return {
    id: proofNodeIdSchema.parse(id),
    state: executableProofStateSchema.parse({
      id: `state:${id}`,
      goals: goals.map((goal) => ({
        id: goal.id,
        sequent: {
          context: {
            declarations,
            hypotheses: (goal.hypotheses ?? []).map(([hypothesisId, expression]) => ({
              id: hypothesisId,
              statement: { expression },
            })),
          },
          conclusion: { expression: goal.conclusion },
        },
      })),
      obligations: [],
    }),
  };
}

const catalog = parseKernelResultCatalog(
  [
    {
      id: "result:conj",
      parameters: [
        { symbol: "a", sort: PROPOSITION_SORT },
        { symbol: "b", sort: PROPOSITION_SORT },
      ],
      premises: [{ expression: "a" }, { expression: "b" }],
      conclusion: { expression: ["And", "a", "b"] },
      directions: ["backward", "forward"],
    },
  ],
  [],
);
if (!catalog.ok) throw new Error(catalog.issue.message);
const results: readonly KernelResult[] = catalog.results;

type Transition = Readonly<{ parent: ProofNode; child: ProofNode; edge: ProofEdge }>;

let edgeCount = 0;
function apply(
  parent: ProofNode,
  childId: string,
  operation: Record<string, unknown>,
  suggestion?: Readonly<{ setId: string; suggestionId: string }>,
): Transition {
  const parsed = kernelOperationSchema.parse({
    ...operation,
    expectedStateId: parent.state.id,
    resultStateId: `state:${childId}`,
  });
  const result = applyTransition(parent.state, parsed, { results });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  const child: ProofNode = { id: proofNodeIdSchema.parse(childId), state: result.state };
  edgeCount += 1;
  const edge = {
    id: `edge:${childId}`,
    commandId: `command:${edgeCount}`,
    parentNodeId: parent.id,
    childNodeId: child.id,
    operation: parsed,
    transitionClass: result.transitionClass,
    ...(suggestion === undefined
      ? {}
      : { suggestionSetId: suggestion.setId, chosenSuggestionId: suggestion.suggestionId }),
  } as unknown as ProofEdge;
  return { parent, child, edge };
}

type Condition = Readonly<{
  kind: "premise" | "side-condition";
  index: number;
  description: string;
  applicationPremiseIndex?: number;
}>;

function suggestionSet(
  nodeId: string,
  conditions: readonly Condition[] | undefined,
  artifactId = "result:conj",
): DisplayedSuggestionSet {
  return {
    id: `set:${nodeId}`,
    nodeId,
    stateId: `state:${nodeId}`,
    selection: {},
    suggestions: [
      {
        id: "suggestion:conj",
        source: "result",
        artifactId,
        ...(conditions === undefined ? {} : { predictedObligations: conditions }),
      },
    ],
    variantGroups: [],
  } as unknown as DisplayedSuggestionSet;
}

const goal = (id: string) => ({ kind: "goal", id }) as const;
const human = { id: "actor:web", kind: "human" } as const;

function context(
  transitions: readonly Transition[],
  sets: readonly DisplayedSuggestionSet[],
  records: readonly InquiryRecord[] = [],
): InquiryCommandContext {
  const nodes = new Map<string, ProofNode>();
  for (const { parent, child } of transitions) {
    nodes.set(parent.id, parent);
    nodes.set(child.id, child);
  }
  return {
    actor: human,
    nodes,
    records: new Map(records.map((record) => [record.id, record])),
    suggestionSets: new Map(sets.map((set) => [set.id, set])),
    edges: new Map(
      transitions.map(({ edge }) => [
        edge.childNodeId,
        {
          parentNodeId: edge.parentNodeId,
          childNodeId: edge.childNodeId,
          transitionClass: edge.transitionClass,
        },
      ]),
    ),
    methods: { moves: new Set(), results: new Set(["result:conj"]) },
  };
}

function prepare(
  request: RecordInquiryCommandRequest,
  inquiryContext: InquiryCommandContext,
  firstSequence = 1,
): readonly InquiryRecord[] {
  const prepared = prepareInquiryCommand(request, inquiryContext, {
    firstSequence,
    recordedAt: "2026-09-28T12:00:00.000Z",
  });
  if (!prepared.ok) {
    throw new Error(
      `${prepared.diagnostics[0].code} @${prepared.diagnostics[0].recordIndex}: ${prepared.diagnostics[0].message}`,
    );
  }
  return prepared.records;
}

function derived(result: ReturnType<typeof deriveTryResultInquiry>): RecordInquiryCommandRequest {
  if (!result.ok) throw new Error(result.diagnostics[0].message);
  return result.request;
}

const root = node("node:root", [
  { id: "goal:main", conclusion: ["And", "p", "q"], hypotheses: [["hyp:p", "p"]] },
]);
const backwardSet = suggestionSet("node:root", [
  { kind: "premise", index: 1, description: "premise 2", applicationPremiseIndex: 1 },
  { kind: "side-condition", index: 0, description: "the carrier is nonempty" },
]);
const backward = apply(
  root,
  "node:backward",
  {
    kind: "apply-result-backward",
    target: goal("goal:main"),
    resultId: "result:conj",
    instantiation: { a: "p", b: "q" },
    premiseTargetIds: ["goal:premise-a", "goal:premise-b"],
  },
  { setId: backwardSet.id, suggestionId: "suggestion:conj" },
);

describe("Try this theorem", () => {
  it("creates an attempt with missing-premise objectives that validate through the command path", () => {
    const request = derived(
      deriveTryResultInquiry({
        commandId: "command:try",
        ...backward,
        suggestionSet: backwardSet,
        records: [],
      }),
    );
    expect(request.nodeId).toBe("node:root");
    const records = prepare(request, context([backward], [backwardSet]));
    const byId = new Map(records.map((record) => [record.id as string, record]));
    expect(byId.get("command:try:question")).toMatchObject({
      kind: "question",
      question: {
        form: "establish",
        proposition: { kind: "target", nodeId: "node:root", target: goal("goal:main") },
      },
    });
    expect(byId.get("command:try:objective")).toMatchObject({
      necessity: "required",
      focus: { nodeId: "node:root", target: goal("goal:main") },
    });
    expect(byId.get("command:try:attempt")).toMatchObject({
      kind: "attempt",
      objectiveId: "command:try:objective",
      method: { kind: "library-result", resultId: "result:conj" },
      suggestion: { suggestionSetId: "set:node:root", suggestionId: "suggestion:conj" },
    });
    for (const [index, target] of [
      [1, "goal:premise-a"],
      [2, "goal:premise-b"],
    ] as const) {
      expect(byId.get(`command:try:premise-${index}:objective`)).toMatchObject({
        kind: "objective",
        necessity: "required",
        focus: { nodeId: "node:backward", target: goal(target) },
        parentAttemptId: "command:try:attempt",
      });
      expect(byId.get(`command:try:premise-${index}:requires`)).toMatchObject({
        relation: "requires",
        from: ["command:try:attempt"],
        to: `command:try:premise-${index}:objective`,
        reason: {
          provenance: "method-encoded",
          method: { kind: "library-result", resultId: "result:conj" },
        },
      });
    }
    expect(byId.get("command:try:suffices")).toMatchObject({
      relation: "wouldSufficeFor",
      from: ["command:try:premise-1:question", "command:try:premise-2:question"],
      to: "command:try:question",
      support: { kind: "transition", childNodeId: "node:backward" },
    });
  });

  it("names each unmet condition from the stored match in an obstruction", () => {
    const request = derived(
      deriveTryResultInquiry({
        commandId: "command:try",
        ...backward,
        suggestionSet: backwardSet,
        records: [],
      }),
    );
    const records = prepare(request, context([backward], [backwardSet]));
    const byId = new Map(records.map((record) => [record.id as string, record]));
    // Premise 1 is a hypothesis already, so it is no obstruction; premise 2 is.
    expect(records.filter(({ kind }) => kind === "obstruction")).toHaveLength(2);
    expect(byId.get("command:try:condition:premise-2:observation")).toMatchObject({
      kind: "observation",
      references: [
        {
          kind: "result-condition",
          nodeId: "node:root",
          suggestionSetId: "set:node:root",
          suggestionId: "suggestion:conj",
          condition: { kind: "premise", index: 1 },
        },
        { kind: "target", nodeId: "node:backward", target: goal("goal:premise-b") },
      ],
      diagnostic: {
        code: "unmet-condition",
        detail:
          "Premise 2 of result:conj is not available as a hypothesis; the application made it goal goal:premise-b.",
      },
    });
    expect(byId.get("command:try:condition:premise-2:obstruction")).toMatchObject({
      attemptId: "command:try:attempt",
      cause: { kind: "observation", observationId: "command:try:condition:premise-2:observation" },
    });
    expect(byId.get("command:try:condition:premise-2:addresses")).toMatchObject({
      relation: "addresses",
      from: ["command:try:premise-2:objective"],
      to: "command:try:condition:premise-2:obstruction",
      reason: {
        provenance: "method-encoded",
        method: { kind: "inquiry-method", methodId: "try-result" },
      },
    });
    // A descriptive side condition creates no target: an obstruction nothing addresses.
    expect(byId.get("command:try:condition:side-condition-1:observation")).toMatchObject({
      diagnostic: {
        detail:
          'Side condition 1 ("the carrier is nonempty") of result:conj is not available as a hypothesis; it has no statement, so the application does not check it.',
      },
    });
    expect(byId.has("command:try:condition:side-condition-1:addresses")).toBe(false);
  });

  it("reuses an active objective focused on the target and ignores achieved ones", () => {
    const earlier = prepare(
      {
        commandId: "command:earlier",
        nodeId: "node:root",
        records: [
          {
            id: "q:main",
            kind: "question",
            question: {
              form: "establish",
              proposition: { kind: "target", nodeId: "node:root", target: goal("goal:main") },
            },
          },
          {
            id: "o:main",
            kind: "objective",
            questionId: "q:main",
            necessity: "required",
            focus: { nodeId: "node:root", target: goal("goal:main") },
          },
        ],
      } as unknown as RecordInquiryCommandRequest,
      context([backward], [backwardSet]),
    );
    const reused = derived(
      deriveTryResultInquiry({
        commandId: "command:try",
        ...backward,
        suggestionSet: backwardSet,
        records: earlier,
      }),
    );
    expect(reused.records.map(({ id }) => id)).not.toContain("command:try:objective");
    const records = prepare(reused, context([backward], [backwardSet], earlier), 3);
    expect(records.find(({ kind }) => kind === "attempt")).toMatchObject({ objectiveId: "o:main" });
    expect(records.find(({ id }) => id === "command:try:suffices")).toMatchObject({
      to: "q:main",
    });

    const achieved = prepare(
      {
        commandId: "command:achieved",
        nodeId: "node:root",
        records: [{ id: "s:main", kind: "status-change", subjectId: "o:main", status: "achieved" }],
      } as unknown as RecordInquiryCommandRequest,
      context([backward], [backwardSet], earlier),
      3,
    );
    const fresh = derived(
      deriveTryResultInquiry({
        commandId: "command:try",
        ...backward,
        suggestionSet: backwardSet,
        records: [...earlier, ...achieved],
      }),
    );
    expect(fresh.records.map(({ id }) => id)).toContain("command:try:objective");
  });

  it("handles forward application: unmet premises become obligations, matched ones are skipped", () => {
    const start = node("node:forward-root", [
      { id: "goal:main", conclusion: "r", hypotheses: [["hyp:p", "p"]] },
    ]);
    const set = suggestionSet("node:forward-root", [
      { kind: "premise", index: 0, description: "premise 1", applicationPremiseIndex: 0 },
      { kind: "premise", index: 1, description: "premise 2", applicationPremiseIndex: 1 },
    ]);
    const forward = apply(
      start,
      "node:forward",
      {
        kind: "apply-result-forward",
        target: goal("goal:main"),
        resultId: "result:conj",
        instantiation: { a: "p", b: "q" },
        premiseHypothesisIds: ["hyp:p", null],
        resultHypothesisId: "hyp:derived",
        obligationIds: ["obligation:b"],
      },
      { setId: set.id, suggestionId: "suggestion:conj" },
    );
    const request = derived(
      deriveTryResultInquiry({
        commandId: "command:fwd",
        ...forward,
        suggestionSet: set,
        records: [],
      }),
    );
    const records = prepare(request, context([forward], [set]));
    const ids = records.map(({ id }) => id as string);
    expect(ids).toContain("command:fwd:premise-2:objective");
    expect(ids).not.toContain("command:fwd:premise-1:objective");
    expect(ids).not.toContain("command:fwd:condition:premise-1:obstruction");
    expect(ids).toContain("command:fwd:condition:premise-2:obstruction");
    expect(records.find(({ id }) => id === "command:fwd:premise-2:objective")).toMatchObject({
      focus: { nodeId: "node:forward", target: { kind: "obligation", id: "obligation:b" } },
    });
    // The changed goal (a derived hypothesis) is covered by a continuation question.
    expect(records.find(({ id }) => id === "command:fwd:suffices")).toMatchObject({
      from: ["command:fwd:continuation:goal:goal:main", "command:fwd:premise-2:question"],
      to: "command:fwd:question",
    });
  });

  it("refuses transitions that did not apply the chosen result suggestion", () => {
    const result = deriveTryResultInquiry({
      commandId: "command:try",
      ...backward,
      suggestionSet: suggestionSet("node:other", undefined),
      records: [],
    });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-method-input" }] });
    const mismatched = deriveTryResultInquiry({
      commandId: "command:try",
      ...backward,
      suggestionSet: suggestionSet("node:root", undefined, "result:other"),
      records: [],
    });
    expect(mismatched).toMatchObject({
      ok: false,
      diagnostics: [{ code: "not-a-result-application" }],
    });
  });

  it("rejects result-condition references the stored match does not support", () => {
    const request = {
      commandId: "command:bad",
      nodeId: "node:root",
      records: [
        {
          id: "obs:bad",
          kind: "observation",
          references: [
            {
              kind: "result-condition",
              nodeId: "node:root",
              suggestionSetId: "set:node:root",
              suggestionId: "suggestion:conj",
              condition: { kind: "premise", index: 0 },
            },
          ],
          diagnostic: { code: "unmet-condition" },
        },
      ],
    };
    const inquiryContext = context([backward], [backwardSet]);
    const options = { firstSequence: 1, recordedAt: "2026-09-28T12:00:00.000Z" };
    expect(prepareInquiryCommand(request, inquiryContext, options)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-math-reference" }],
    });
    // An Explore question may reference a stored unmet condition too.
    const explore = {
      commandId: "command:explore",
      nodeId: "node:root",
      records: [
        {
          id: "question:explore",
          kind: "question",
          question: {
            form: "explore",
            aspect: "relationship",
            objects: [
              { ...request.records[0]!.references[0]!, condition: { kind: "premise", index: 1 } },
            ],
          },
        },
      ],
    };
    expect(prepareInquiryCommand(explore, inquiryContext, options)).toMatchObject({ ok: true });
    const elsewhere = structuredClone(request);
    elsewhere.records[0]!.references[0]!.nodeId = "node:backward";
    expect(prepareInquiryCommand(elsewhere, inquiryContext, options)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "unknown-reference" }],
    });
  });

  it("attributes no intention beyond the method's semantics (property)", () => {
    const conditionArbitrary = fc.uniqueArray(
      fc.record({
        kind: fc.constantFrom("premise" as const, "side-condition" as const),
        index: fc.integer({ min: 0, max: 2 }),
        described: fc.boolean(),
      }),
      { selector: ({ kind, index }) => `${kind}:${index}`, maxLength: 4 },
    );
    fc.assert(
      fc.property(conditionArbitrary, (entries) => {
        const conditions: Condition[] = entries.map(({ kind, index, described }) => ({
          kind,
          index,
          description: kind === "premise" ? `premise ${index + 1}` : `condition ${index + 1}`,
          ...(kind === "premise"
            ? { applicationPremiseIndex: index }
            : described
              ? { applicationPremiseIndex: 2 + index }
              : {}),
        }));
        const set = suggestionSet("node:root", conditions.length === 0 ? undefined : conditions);
        const request = derived(
          deriveTryResultInquiry({
            commandId: "command:try",
            ...backward,
            suggestionSet: set,
            records: [],
          }),
        );
        const records = prepare(request, context([backward], [set]));
        for (const record of records) {
          expect(["decision", "status-change"]).not.toContain(record.kind);
          if (record.kind !== "relationship") continue;
          expect(record.relation).not.toBe("motivatedBy");
          if (INTENTION_RELATIONS.has(record.relation) || record.reason !== undefined) {
            expect(record.reason).toMatchObject({ provenance: "method-encoded" });
          }
        }
        expect(records.filter(({ kind }) => kind === "obstruction")).toHaveLength(
          conditions.length,
        );
      }),
      { numRuns: 60 },
    );
  });
});

describe("Investigate this hypothesis", () => {
  const investigated = node("node:h", [
    {
      id: "goal:main",
      conclusion: "q",
      hypotheses: [
        ["hyp:p", "p"],
        ["hyp:pq", ["Implies", "p", "q"]],
      ],
    },
  ]);
  const inquiryContext = (records: readonly InquiryRecord[] = []): InquiryCommandContext => ({
    ...context([], []),
    nodes: new Map([[investigated.id, investigated]]),
    records: new Map(records.map((record) => [record.id, record])),
  });

  it("creates a Determine question for the target without that hypothesis, by identity", () => {
    const result = deriveHypothesisInvestigation({
      commandId: "command:hyp",
      node: investigated,
      target: goal("goal:main"),
      hypothesisId: "hyp:p",
      records: [],
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    const records = prepare(result.request, inquiryContext());
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "question",
      question: {
        form: "determine",
        proposition: {
          kind: "target",
          nodeId: "node:h",
          target: goal("goal:main"),
          withoutHypotheses: ["hyp:p"],
        },
      },
    });
    expect(JSON.stringify(records)).not.toContain('"Implies"');
    expect(records[1]).toMatchObject({ kind: "objective", necessity: "elective" });
  });

  it("tests an existing Establish question of the same target with a method-encoded reason", () => {
    const earlier = prepare(
      {
        commandId: "command:q",
        nodeId: "node:h",
        records: [
          {
            id: "q:main",
            kind: "question",
            question: {
              form: "establish",
              proposition: { kind: "target", nodeId: "node:h", target: goal("goal:main") },
            },
          },
        ],
      } as unknown as RecordInquiryCommandRequest,
      inquiryContext(),
    );
    const result = deriveHypothesisInvestigation({
      commandId: "command:hyp",
      node: investigated,
      target: goal("goal:main"),
      hypothesisId: "hyp:pq",
      records: earlier,
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    const records = prepare(result.request, inquiryContext(earlier), 2);
    expect(records.at(-1)).toMatchObject({
      kind: "relationship",
      relation: "tests",
      from: ["command:hyp:question"],
      to: "q:main",
      reason: {
        provenance: "method-encoded",
        method: { kind: "inquiry-method", methodId: "investigate-hypothesis" },
      },
    });
  });

  it("rejects a hypothesis or target that is not there", () => {
    const base = {
      commandId: "command:hyp",
      node: investigated,
      target: goal("goal:main"),
      records: [],
    };
    expect(deriveHypothesisInvestigation({ ...base, hypothesisId: "hyp:none" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "hypothesis-not-found" }],
    });
    expect(
      deriveHypothesisInvestigation({ ...base, target: goal("goal:none"), hypothesisId: "hyp:p" }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "target-not-found" }] });
  });
});

describe("Extract a conditional lemma", () => {
  const start = node("node:lemma", [
    {
      id: "goal:main",
      conclusion: ["And", "p", "q"],
      hypotheses: [
        ["hyp:p", "p"],
        ["hyp:q", "q"],
        ["hyp:r", "r"],
      ],
    },
  ]);
  const split = apply(start, "node:split", {
    kind: "split-goal-conjunction",
    target: goal("goal:main"),
    childIds: ["goal:p", "goal:q"],
  });
  const closeP = apply(split.child, "node:p", {
    kind: "close-by-hypothesis",
    target: goal("goal:p"),
    hypothesisId: "hyp:p",
  });
  const closeQ = apply(closeP.child, "node:q", {
    kind: "close-by-hypothesis",
    target: goal("goal:q"),
    hypothesisId: "hyp:q",
  });
  const nodes = [start, split.child, closeP.child, closeQ.child];
  const edges = [split.edge, closeP.edge, closeQ.edge];

  it("plans the lemma from a closed target, retaining only the hypotheses used", () => {
    const planned = planConditionalLemma({
      nodes,
      edges,
      nodeId: "node:lemma",
      target: goal("goal:main"),
    });
    if (!planned.ok) throw new Error(planned.diagnostics[0].message);
    expect(planned.plan).toMatchObject({
      conclusion: { expression: ["And", "p", "q"] },
      retainedHypothesisIds: ["hyp:p", "hyp:q"],
      unusedHypothesisIds: ["hyp:r"],
      conservativeHypothesisUse: [],
      establishingEdgeIds: ["edge:node:split", "edge:node:p", "edge:node:q"],
      backgroundInferenceEdgeIds: [],
    });
    const records = deriveConditionalLemmaInquiry({
      commandId: "command:lemma",
      plan: planned.plan,
      lemmaId: "result:derived-main",
    });
    if (!records.ok) throw new Error(records.diagnostics[0].message);
    const prepared = prepare(records.request, {
      ...context([], []),
      nodes: new Map([[start.id, start]]),
    });
    expect(prepared).toEqual([
      expect.objectContaining({
        kind: "observation",
        references: [{ kind: "target", nodeId: "node:lemma", target: goal("goal:main") }],
        note: expect.stringContaining("Conditional lemma result:derived-main"),
      }),
    ]);
    expect(prepared[0]).toMatchObject({
      note: expect.stringContaining("1 unused hypothesis(es) are not retained"),
    });
    expect(prepared.some((record) => "reason" in record)).toBe(false);
  });

  it("refuses a target that is still open in the subtree", () => {
    expect(
      planConditionalLemma({
        nodes: nodes.slice(0, 3),
        edges: edges.slice(0, 2),
        nodeId: "node:lemma",
        target: goal("goal:main"),
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "not-established" }] });
    // A sub-target closed below its own node is a lemma even though its parent is open.
    expect(
      planConditionalLemma({
        nodes: nodes.slice(0, 3),
        edges: edges.slice(0, 2),
        nodeId: "node:split",
        target: goal("goal:p"),
      }),
    ).toMatchObject({ ok: true, plan: { establishingEdgeIds: ["edge:node:p"] } });
  });

  it("refuses a closure that relies on a sorry", () => {
    const sorry = apply(closeP.child, "node:sorry", {
      kind: "mark-sorry",
      target: goal("goal:q"),
      assumptionId: "assumption:q",
    });
    expect(
      planConditionalLemma({
        nodes: [...nodes.slice(0, 3), sorry.child],
        edges: [split.edge, closeP.edge, sorry.edge],
        nodeId: "node:lemma",
        target: goal("goal:main"),
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "depends-on-sorry" }] });
  });
});

describe("Hypotheses used by a closed subtree", () => {
  const names = ["a", "b", "c", "d"] as const;
  const hypotheses = names.map((name) => [`hyp:${name}`, name] as const);

  it("keeps exactly the hypotheses a closing step names (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...names), (used) => {
        const start = node("node:prop", [{ id: "goal:g", conclusion: used, hypotheses }]);
        const close = apply(start, "node:prop:close", {
          kind: "close-by-hypothesis",
          target: goal("goal:g"),
          hypothesisId: `hyp:${used}`,
        });
        const planned = planConditionalLemma({
          nodes: [start, close.child],
          edges: [close.edge],
          nodeId: "node:prop",
          target: goal("goal:g"),
        });
        if (!planned.ok) throw new Error(planned.diagnostics[0].message);
        expect(planned.plan.retainedHypothesisIds).toEqual([`hyp:${used}`]);
        expect(planned.plan.unusedHypothesisIds).toEqual(
          names.filter((name) => name !== used).map((name) => `hyp:${name}`),
        );
      }),
    );
  });

  it("traces a hypothesis produced inside the subtree back to its source", () => {
    const start = node("node:expand", [
      {
        id: "goal:g",
        conclusion: "q",
        hypotheses: [
          ["hyp:pq", ["And", "p", "q"]],
          ["hyp:r", "r"],
        ],
      },
    ]);
    const expand = apply(start, "node:expand:split", {
      kind: "expand-hypothesis-conjunction",
      target: goal("goal:g"),
      hypothesisId: "hyp:pq",
      expandedHypothesisIds: ["hyp:p2", "hyp:q2"],
    });
    const close = apply(expand.child, "node:expand:close", {
      kind: "close-by-hypothesis",
      target: goal("goal:g"),
      hypothesisId: "hyp:q2",
    });
    const planned = planConditionalLemma({
      nodes: [start, expand.child, close.child],
      edges: [expand.edge, close.edge],
      nodeId: "node:expand",
      target: goal("goal:g"),
    });
    if (!planned.ok) throw new Error(planned.diagnostics[0].message);
    expect(planned.plan.retainedHypothesisIds).toEqual(["hyp:pq"]);
    expect(planned.plan.unusedHypothesisIds).toEqual(["hyp:r"]);
  });

  it("does not count a produced hypothesis nobody uses, nor a dropped one", () => {
    const start = node("node:drop", [
      {
        id: "goal:g",
        conclusion: ["Implies", "p", "p"],
        hypotheses: [["hyp:r", "r"]],
      },
    ]);
    const intro = apply(start, "node:drop:intro", {
      kind: "introduce-implication",
      target: goal("goal:g"),
      hypothesisId: "hyp:assume",
    });
    const close = apply(intro.child, "node:drop:close", {
      kind: "close-by-hypothesis",
      target: goal("goal:g"),
      hypothesisId: "hyp:assume",
    });
    const planned = planConditionalLemma({
      nodes: [start, intro.child, close.child],
      edges: [intro.edge, close.edge],
      nodeId: "node:drop",
      target: goal("goal:g"),
    });
    if (!planned.ok) throw new Error(planned.diagnostics[0].message);
    expect(planned.plan.retainedHypothesisIds).toEqual([]);
  });

  it("keeps every hypothesis, with the reason, when a step's usage is unknown", () => {
    const step = (evidence: string, kind: string) =>
      ({
        edgeId: "edge:unknown",
        operation: { kind },
        evidence,
      }) as never;
    const keepAll = usedHypotheses(["h1", "h2"], [step("structural", "future-operation")]);
    expect(keepAll.usedHypothesisIds).toEqual(["h1", "h2"]);
    expect(keepAll.conservative).toEqual([
      expect.objectContaining({ edgeId: "edge:unknown", operationKind: "future-operation" }),
    ]);
    const inference = usedHypotheses(
      ["h1", "h2"],
      [step("background-inference", "close-by-accepted-inference")],
    );
    expect(inference).toMatchObject({ usedHypothesisIds: ["h1", "h2"], unusedHypothesisIds: [] });
    expect(inference.conservative[0]?.reason).toMatch(/every hypothesis is kept/);
  });
});
