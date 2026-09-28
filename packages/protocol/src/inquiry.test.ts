import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ProofState } from "@proof/mathjson-model";
import {
  INQUIRY_RELATIONS,
  INTENTION_RELATIONS,
  REASON_PROVENANCES,
  currentInquiryStatus,
  inquiryCommandReferences,
  inquiryRecordInputFields,
  inquiryRecordListSchema,
  inquiryRecordSchema,
  prepareInquiryCommand,
  recordInquiryCommandRequestSchema,
  type InquiryCommandContext,
  type InquiryContextEdge,
  type InquiryContextNode,
  type InquiryRecord,
} from ".";

const sequent = (conclusion: unknown, hypotheses: unknown[] = []) => ({
  context: {
    declarations: [
      {
        id: "declaration:p",
        symbol: "p",
        sort: { kind: "proposition" },
        role: "universal-parameter",
      },
      {
        id: "declaration:q",
        symbol: "q",
        sort: { kind: "proposition" },
        role: "universal-parameter",
      },
    ],
    hypotheses,
  },
  conclusion: { expression: conclusion },
});

const rootNode: InquiryContextNode = {
  id: "node:root",
  state: {
    id: "state:root",
    goals: [
      {
        id: "goal:main",
        sequent: sequent(["And", "p", "q"], [{ id: "hyp:1", statement: { expression: "p" } }]),
      },
    ],
    obligations: [],
    constructions: [
      {
        id: "task:m",
        status: "partially-specified",
        requirements: [
          { id: "req:suff", role: "sufficient", evidence: { kind: "target", target: {} } },
          { id: "req:heur", role: "heuristic", evidence: { kind: "none" } },
        ],
      },
    ],
  } as unknown as ProofState,
};

const childNode: InquiryContextNode = {
  id: "node:child",
  state: {
    id: "state:child",
    goals: [],
    obligations: [
      { id: "obligation:left", sequent: sequent("p") },
      { id: "obligation:right", sequent: sequent("q") },
    ],
  } as unknown as ProofState,
};

const strengthening: InquiryContextEdge = {
  parentNodeId: "node:root",
  childNodeId: "node:child",
  transitionClass: "strengthening",
};

function context(
  overrides: Partial<InquiryCommandContext> = {},
  records: readonly InquiryRecord[] = [],
): InquiryCommandContext {
  return {
    actor: { id: "actor:web", kind: "human" },
    nodes: new Map([
      [rootNode.id, rootNode],
      [childNode.id, childNode],
    ]),
    records: new Map(records.map((record) => [record.id, record])),
    suggestionSets: new Map([
      [
        "set:1",
        {
          id: "set:1",
          nodeId: "node:root",
          suggestions: [
            { id: "suggestion:and", source: "move", artifactId: "move:split-and" },
            { id: "suggestion:result", source: "result", artifactId: "result:modus-ponens" },
          ],
        },
      ],
    ]),
    edges: new Map([[strengthening.childNodeId, strengthening]]),
    methods: { moves: new Set(["move:split-and"]), results: new Set(["result:modus-ponens"]) },
    ...overrides,
  };
}

const options = { firstSequence: 1, recordedAt: "2026-09-27T12:00:00.000Z" };
const target = (nodeId: string, kind: "goal" | "obligation", id: string) => ({
  kind: "target" as const,
  nodeId,
  target: { kind, id },
});

const establishMain = {
  id: "q:main",
  kind: "question",
  question: { form: "establish", proposition: target("node:root", "goal", "goal:main") },
} as const;
const objectiveMain = {
  id: "o:main",
  kind: "objective",
  questionId: "q:main",
  necessity: "required",
  focus: { nodeId: "node:root", target: { kind: "goal", id: "goal:main" } },
} as const;
const attemptSplit = {
  id: "a:split",
  kind: "attempt",
  objectiveId: "o:main",
  method: { kind: "move", moveId: "move:split-and" },
  suggestion: { suggestionSetId: "set:1", suggestionId: "suggestion:and" },
} as const;

function command(records: readonly unknown[], commandId = "inquiry:1", nodeId = "node:root") {
  return { commandId, nodeId, records };
}

function prepared(
  records: readonly unknown[],
  ctx: InquiryCommandContext = context(),
  commandId = "inquiry:1",
) {
  return prepareInquiryCommand(command(records, commandId), ctx, options);
}

function accepted(
  records: readonly unknown[],
  ctx?: InquiryCommandContext,
  commandId?: string,
): readonly InquiryRecord[] {
  const result = prepared(records, ctx, commandId);
  if (!result.ok) throw new Error(result.diagnostics[0].message);
  return result.records;
}

function rejectionCode(
  records: readonly unknown[],
  ctx?: InquiryCommandContext,
  commandId?: string,
): string | undefined {
  const result = prepared(records, ctx, commandId);
  return result.ok ? undefined : result.diagnostics[0].code;
}

describe("inquiry record schemas", () => {
  it("accepts every record kind in one command and rejects unknown fields", () => {
    const records = [
      establishMain,
      objectiveMain,
      attemptSplit,
      {
        id: "r:left",
        kind: "requirement",
        subjectId: "a:split",
        proposition: target("node:child", "obligation", "obligation:left"),
        role: "sufficient",
        support: { kind: "transition", childNodeId: "node:child" },
      },
      {
        id: "obs:1",
        kind: "observation",
        diagnostic: { code: "failed-match", detail: "q does not match p." },
      },
      {
        id: "x:1",
        kind: "obstruction",
        attemptId: "a:split",
        cause: { kind: "observation", observationId: "obs:1" },
      },
      {
        id: "d:1",
        kind: "decision",
        subjectId: "o:main",
        selected: { kind: "record", recordId: "a:split" },
        reason: { provenance: "explicit-user" },
      },
      {
        id: "rel:1",
        kind: "relationship",
        relation: "motivatedBy",
        from: ["a:split"],
        to: "obs:1",
        reason: { provenance: "explicit-user", basisIds: ["obs:1"] },
      },
      { id: "s:1", kind: "status-change", subjectId: "a:split", status: "blocked" },
    ];
    expect(recordInquiryCommandRequestSchema.safeParse(command(records)).success).toBe(true);
    expect(
      recordInquiryCommandRequestSchema.safeParse(command([{ ...establishMain, sequence: 1 }]))
        .success,
    ).toBe(false);
    expect(
      recordInquiryCommandRequestSchema.safeParse({ ...command([establishMain]), actor: {} })
        .success,
    ).toBe(false);
  });

  it("requires evidence or an explicit informal status for wouldSufficeFor", () => {
    const relationship = {
      id: "rel:1",
      kind: "relationship",
      relation: "wouldSufficeFor",
      from: ["q:a"],
      to: "q:b",
    };
    expect(recordInquiryCommandRequestSchema.safeParse(command([relationship])).success).toBe(
      false,
    );
    expect(
      recordInquiryCommandRequestSchema.safeParse(
        command([{ ...relationship, support: { kind: "informal", status: "conjectured" } }]),
      ).success,
    ).toBe(true);
  });

  it("keeps heuristic, necessary and sufficient requirements distinct", () => {
    const requirement = {
      id: "r:1",
      kind: "requirement",
      subjectId: "a:1",
      proposition: target("node:root", "goal", "goal:main"),
    };
    const parses = (fields: object) =>
      recordInquiryCommandRequestSchema.safeParse(command([{ ...requirement, ...fields }])).success;
    expect(parses({ role: "heuristic" })).toBe(true);
    expect(parses({ role: "heuristic", support: { kind: "informal", status: "plausible" } })).toBe(
      true,
    );
    expect(
      parses({ role: "heuristic", support: { kind: "transition", childNodeId: "node:child" } }),
    ).toBe(false);
    expect(parses({ role: "necessary" })).toBe(false);
    expect(parses({ role: "sufficient" })).toBe(false);
  });

  it("never records a decision's or status change's own reason as a later interpretation", () => {
    const later = { provenance: "later-interpretation" };
    expect(
      recordInquiryCommandRequestSchema.safeParse(
        command([
          {
            id: "d:1",
            kind: "decision",
            selected: { kind: "method", method: { kind: "manual" } },
            reason: later,
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      recordInquiryCommandRequestSchema.safeParse(
        command([
          { id: "s:1", kind: "status-change", subjectId: "q:1", status: "resolved", reason: later },
        ]),
      ).success,
    ).toBe(false);
  });

  it("requires a method exactly for method-encoded reasons and a reason for intentions", () => {
    const relationship = {
      id: "rel:1",
      kind: "relationship",
      relation: "addresses",
      from: ["a:1"],
      to: "x:1",
    };
    const parses = (reason?: object) =>
      recordInquiryCommandRequestSchema.safeParse(
        command([{ ...relationship, ...(reason === undefined ? {} : { reason }) }]),
      ).success;
    expect(parses()).toBe(false);
    expect(parses({ provenance: "method-encoded" })).toBe(false);
    expect(parses({ provenance: "method-encoded", method: { kind: "manual" } })).toBe(true);
    expect(parses({ provenance: "agent", method: { kind: "manual" } })).toBe(false);
  });

  it("rejects duplicate IDs, self references and forward references in a command", () => {
    expect(
      recordInquiryCommandRequestSchema.safeParse(command([establishMain, establishMain])).success,
    ).toBe(false);
    expect(
      recordInquiryCommandRequestSchema.safeParse(command([objectiveMain, establishMain])).success,
    ).toBe(false);
    expect(
      recordInquiryCommandRequestSchema.safeParse(
        command([{ id: "s:1", kind: "status-change", subjectId: "s:1", status: "open" }]),
      ).success,
    ).toBe(false);
  });

  it("lists what a command references, excluding records of the same command", () => {
    const request = recordInquiryCommandRequestSchema.parse(
      command([
        { ...objectiveMain, questionId: "q:earlier" },
        { ...attemptSplit, objectiveId: "o:main" },
        {
          id: "rel:1",
          kind: "relationship",
          relation: "wouldSufficeFor",
          from: ["q:left"],
          to: "q:earlier",
          support: { kind: "transition", childNodeId: "node:child" },
        },
        { id: "s:1", kind: "status-change", subjectId: "q:earlier", status: "resolved" },
      ]),
    );
    expect(inquiryCommandReferences(request)).toEqual({
      nodeIds: ["node:child", "node:root"],
      recordIds: ["q:earlier", "q:left"],
      statusSubjectIds: ["q:earlier"],
      suggestionSetIds: ["set:1"],
      transitionChildNodeIds: ["node:child"],
    });
  });
});

describe("prepareInquiryCommand", () => {
  it("builds frozen, sequenced records anchored at the command's snapshot", () => {
    const records = accepted([establishMain, objectiveMain, attemptSplit]);
    expect(records.map(({ id, sequence }) => [id, sequence])).toEqual([
      ["q:main", 1],
      ["o:main", 2],
      ["a:split", 3],
    ]);
    for (const record of records) {
      expect(record).toMatchObject({
        commandId: "inquiry:1",
        nodeId: "node:root",
        stateId: "state:root",
        actor: { id: "actor:web", kind: "human" },
        recordedAt: options.recordedAt,
      });
      expect(Object.isFrozen(record)).toBe(true);
    }
    expect(inquiryRecordInputFields(records[0]!)).toEqual(establishMain);
    expect(inquiryRecordListSchema.safeParse(records).success).toBe(true);
    expect(inquiryRecordListSchema.safeParse([...records].reverse()).success).toBe(false);
  });

  it("validates mathematical references against the stored nodes", () => {
    const question = (proposition: object) => [
      { id: "q:1", kind: "question", question: { form: "determine", proposition } },
    ];
    expect(rejectionCode(question(target("node:missing", "goal", "goal:main")))).toBe(
      "unknown-reference",
    );
    expect(rejectionCode(question(target("node:root", "goal", "goal:other")))).toBe(
      "invalid-math-reference",
    );
    expect(rejectionCode(question(target("node:root", "obligation", "goal:main")))).toBe(
      "invalid-math-reference",
    );
    expect(
      rejectionCode(
        question({ ...target("node:root", "goal", "goal:main"), withoutHypotheses: ["hyp:1"] }),
      ),
    ).toBeUndefined();
    expect(
      rejectionCode(
        question({ ...target("node:root", "goal", "goal:main"), withoutHypotheses: ["hyp:2"] }),
      ),
    ).toBe("invalid-math-reference");
    const explore = (objects: object[]) => [
      { id: "q:1", kind: "question", question: { form: "explore", objects, aspect: "structure" } },
    ];
    const occurrence = (path: number[]) => ({
      kind: "occurrence",
      nodeId: "node:root",
      target: { kind: "goal", id: "goal:main" },
      statement: { kind: "conclusion" },
      path,
    });
    expect(rejectionCode(explore([occurrence([1])]))).toBeUndefined();
    expect(rejectionCode(explore([occurrence([2])]))).toBe("invalid-math-reference");
    expect(
      rejectionCode(
        explore([
          {
            kind: "statement",
            nodeId: "node:root",
            target: { kind: "goal", id: "goal:main" },
            statement: { kind: "hypothesis", id: "hyp:1" },
          },
          {
            kind: "construction-requirement",
            nodeId: "node:root",
            taskId: "task:m",
            requirementId: "req:heur",
          },
        ]),
      ),
    ).toBeUndefined();
    expect(
      rejectionCode(
        explore([{ kind: "construction-task", nodeId: "node:child", taskId: "task:m" }]),
      ),
    ).toBe("invalid-math-reference");
  });

  it("marks an objective required only when it establishes the open target it focuses", () => {
    expect(rejectionCode([establishMain, objectiveMain])).toBeUndefined();
    expect(rejectionCode([establishMain, { ...objectiveMain, focus: undefined }])).toBe(
      "unsupported-claim",
    );
    const determine = {
      ...establishMain,
      question: { ...establishMain.question, form: "determine" },
    };
    expect(rejectionCode([determine, objectiveMain])).toBe("unsupported-claim");
    expect(rejectionCode([determine, { ...objectiveMain, necessity: "elective" }])).toBeUndefined();
    const negated = {
      ...establishMain,
      question: {
        form: "establish",
        proposition: { ...target("node:root", "goal", "goal:main"), negated: true },
      },
    };
    expect(rejectionCode([negated, objectiveMain])).toBe("unsupported-claim");
    const construct = {
      id: "q:m",
      kind: "question",
      question: {
        form: "construct",
        object: { kind: "construction-task", nodeId: "node:root", taskId: "task:m" },
      },
    };
    expect(rejectionCode([construct, { ...objectiveMain, questionId: "q:m" }])).toBeUndefined();
  });

  it("checks attempt methods and the displayed suggestion they came from", () => {
    const base = [establishMain, objectiveMain];
    expect(rejectionCode([...base, attemptSplit])).toBeUndefined();
    expect(
      rejectionCode([
        ...base,
        { ...attemptSplit, method: { kind: "move", moveId: "move:unknown" } },
      ]),
    ).toBe("invalid-method");
    expect(
      rejectionCode([
        ...base,
        { ...attemptSplit, method: { kind: "library-result", resultId: "result:modus-ponens" } },
      ]),
    ).toBe("invalid-method");
    expect(
      rejectionCode([
        ...base,
        {
          ...attemptSplit,
          suggestion: { suggestionSetId: "set:1", suggestionId: "suggestion:none" },
        },
      ]),
    ).toBe("unknown-reference");
    expect(rejectionCode([...base, { ...attemptSplit, objectiveId: "q:main" }])).toBe(
      "wrong-record-kind",
    );
    // A suggestion set anchored at another node cannot back an attempt at this anchor.
    const result = prepareInquiryCommand(
      command([{ ...attemptSplit, objectiveId: "o:earlier" }], "inquiry:2", "node:child"),
      context({}, accepted([establishMain, { ...objectiveMain, id: "o:earlier" }])),
      options,
    );
    expect(result.ok ? undefined : result.diagnostics[0].code).toBe("unknown-reference");
  });

  it("treats targets a transition carried over unchanged as its frame, not as premises", () => {
    const side = { id: "obligation:side", sequent: sequent("q") };
    const parent: InquiryContextNode = {
      id: "node:parent",
      state: {
        id: "state:parent",
        goals: [{ id: "goal:main", sequent: sequent(["And", "p", "q"]) }],
        obligations: [side],
      } as unknown as ProofState,
    };
    const child = (carried: object): InquiryContextNode => ({
      id: "node:framed",
      state: {
        id: "state:framed",
        goals: [{ id: "goal:new", sequent: sequent("p") }],
        obligations: [carried],
      } as unknown as ProofState,
    });
    const framed = (carried: object) =>
      context({
        nodes: new Map([
          [rootNode.id, rootNode],
          [parent.id, parent],
          ["node:framed", child(carried)],
        ]),
        edges: new Map([
          [
            "node:framed",
            { parentNodeId: parent.id, childNodeId: "node:framed", transitionClass: "equivalence" },
          ],
        ]),
      });
    const establish = (id: string, reference: object) => ({
      id,
      kind: "question",
      question: { form: "establish", proposition: reference },
    });
    const records = (to: string) => [
      establish("q:goal", target("node:parent", "goal", "goal:main")),
      establish("q:side", target("node:parent", "obligation", "obligation:side")),
      establish("q:new", target("node:framed", "goal", "goal:new")),
      {
        id: "rel:1",
        kind: "relationship",
        relation: "wouldSufficeFor",
        from: ["q:new"],
        to,
        support: { kind: "transition", childNodeId: "node:framed" },
      },
    ];
    expect(rejectionCode(records("q:goal"), framed(side))).toBeUndefined();
    // A carried-over target is not what the transition replaced.
    expect(rejectionCode(records("q:side"), framed(side))).toBe("unsupported-claim");
    // A target whose sequent changed is not frame: the claims must cover it.
    expect(rejectionCode(records("q:goal"), framed({ ...side, sequent: sequent("p") }))).toBe(
      "unsupported-claim",
    );
  });

  it("accepts a transition as evidence only when it really shows the claims suffice", () => {
    const left = {
      id: "q:left",
      kind: "question",
      question: {
        form: "establish",
        proposition: target("node:child", "obligation", "obligation:left"),
      },
    };
    const right = {
      id: "q:right",
      kind: "question",
      question: {
        form: "establish",
        proposition: target("node:child", "obligation", "obligation:right"),
      },
    };
    const suffices = (from: string[], fields: object = {}) => ({
      id: "rel:suffices",
      kind: "relationship",
      relation: "wouldSufficeFor",
      from,
      to: "q:main",
      support: { kind: "transition", childNodeId: "node:child" },
      ...fields,
    });
    expect(
      rejectionCode([establishMain, left, right, suffices(["q:left", "q:right"])]),
    ).toBeUndefined();
    // Establishing one premise alone does not establish the goal.
    expect(rejectionCode([establishMain, left, right, suffices(["q:left"])])).toBe(
      "unsupported-claim",
    );
    const weakening = context({
      edges: new Map([["node:child", { ...strengthening, transitionClass: "weakening" }]]),
    });
    expect(
      rejectionCode([establishMain, left, right, suffices(["q:left", "q:right"])], weakening),
    ).toBe("unsupported-claim");
    expect(
      rejectionCode(
        [establishMain, left, right, suffices(["q:left", "q:right"])],
        context({ edges: new Map() }),
      ),
    ).toBe("unknown-reference");
    expect(
      rejectionCode([
        establishMain,
        left,
        right,
        suffices(["q:left", "q:right"], {
          support: {
            kind: "proof-target",
            nodeId: "node:root",
            target: { kind: "goal", id: "goal:main" },
          },
        }),
      ]),
    ).toBe("unsupported-claim");
    expect(
      rejectionCode([
        establishMain,
        left,
        suffices(["q:left"], { support: { kind: "informal", status: "plausible" } }),
      ]),
    ).toBeUndefined();
  });

  it("checks requirement support against the role it claims", () => {
    const base = [establishMain, objectiveMain, attemptSplit];
    const requirement = (fields: object) => ({
      id: "r:1",
      kind: "requirement",
      subjectId: "a:split",
      proposition: target("node:root", "goal", "goal:main"),
      role: "sufficient",
      ...fields,
    });
    const goalSupport = {
      kind: "proof-target",
      nodeId: "node:root",
      target: { kind: "goal", id: "goal:main" },
    };
    expect(rejectionCode([...base, requirement({ support: goalSupport })])).toBeUndefined();
    expect(rejectionCode([...base, requirement({ role: "necessary", support: goalSupport })])).toBe(
      "unsupported-claim",
    );
    const cited = (requirementId: string) => ({
      kind: "construction-requirement",
      nodeId: "node:root",
      taskId: "task:m",
      requirementId,
    });
    expect(rejectionCode([...base, requirement({ support: cited("req:suff") })])).toBeUndefined();
    expect(
      rejectionCode([...base, requirement({ role: "necessary", support: cited("req:suff") })]),
    ).toBe("unsupported-claim");
    expect(
      rejectionCode([
        ...base,
        requirement({ support: { kind: "transition", childNodeId: "node:child" } }),
      ]),
    ).toBe("unsupported-claim");
    expect(
      rejectionCode([...base, requirement({ subjectId: "q:main", support: goalSupport })]),
    ).toBe("wrong-record-kind");
  });

  it("matches reason provenance to the recording actor", () => {
    const agent = context({ actor: { id: "actor:agent", kind: "agent" } });
    const decision = (provenance: string) => [
      {
        id: "d:1",
        kind: "decision",
        selected: { kind: "method", method: { kind: "manual" } },
        reason: {
          provenance,
          ...(provenance === "method-encoded" ? { method: { kind: "manual" } } : {}),
        },
      },
    ];
    expect(rejectionCode(decision("explicit-user"))).toBeUndefined();
    expect(rejectionCode(decision("agent"))).toBe("provenance-mismatch");
    expect(rejectionCode(decision("agent"), agent)).toBeUndefined();
    expect(rejectionCode(decision("explicit-user"), agent)).toBe("provenance-mismatch");
    expect(rejectionCode(decision("method-encoded"), agent)).toBeUndefined();
    const [record] = accepted(decision("explicit-user"));
    expect(
      inquiryRecordSchema.safeParse({ ...record, actor: { id: "actor:agent", kind: "agent" } })
        .success,
    ).toBe(false);
  });

  it("records later interpretations only about earlier commands", () => {
    const earlier = accepted([
      establishMain,
      objectiveMain,
      attemptSplit,
      { id: "obs:1", kind: "observation", note: "p is available." },
    ]);
    const motivated = (provenance: string, from = "a:split") => ({
      id: "rel:why",
      kind: "relationship",
      relation: "motivatedBy",
      from: [from],
      to: "obs:1",
      reason: { provenance },
    });
    const later = context({}, earlier);
    expect(rejectionCode([motivated("later-interpretation")], later, "inquiry:2")).toBeUndefined();
    expect(rejectionCode([motivated("explicit-user")], later, "inquiry:2")).toBe(
      "not-contemporaneous",
    );
    const fresh = { ...attemptSplit, id: "a:again" };
    expect(
      rejectionCode([fresh, motivated("explicit-user", "a:again")], later, "inquiry:2"),
    ).toBeUndefined();
    expect(
      rejectionCode([fresh, motivated("later-interpretation", "a:again")], later, "inquiry:2"),
    ).toBe("not-contemporaneous");
    expect(rejectionCode([establishMain], later, "inquiry:2")).toBe("record-id-conflict");
  });

  it("folds explicit status transitions and rejects no-op or foreign statuses", () => {
    const first = accepted([establishMain, objectiveMain, attemptSplit]);
    const change = (status: string, id = "s:1") => ({
      id,
      kind: "status-change",
      subjectId: "a:split",
      status,
    });
    expect(rejectionCode([change("in-progress")], context({}, first), "inquiry:2")).toBe(
      "invalid-status-change",
    );
    expect(rejectionCode([change("achieved")], context({}, first), "inquiry:2")).toBe(
      "invalid-status-change",
    );
    const second = accepted(
      [change("blocked"), change("abandoned", "s:2")],
      context({}, first),
      "inquiry:2",
    );
    const all = [
      ...first,
      ...second.map((record) => ({ ...record, sequence: record.sequence + 3 })),
    ];
    expect(currentInquiryStatus(first[2]!, all)).toBe("abandoned");
    expect(currentInquiryStatus(first[0]!, all)).toBe("open");
    expect(rejectionCode([change("abandoned", "s:3")], context({}, all), "inquiry:3")).toBe(
      "invalid-status-change",
    );
    expect(
      rejectionCode([change("in-progress", "s:3")], context({}, all), "inquiry:3"),
    ).toBeUndefined();
  });
});

describe("inquiry invariants (property)", () => {
  it("a reason is contemporaneous exactly when it is recorded with the records it explains", () => {
    const earlier = accepted([
      establishMain,
      objectiveMain,
      attemptSplit,
      { id: "obs:1", kind: "observation", note: "An observation." },
      {
        id: "x:1",
        kind: "obstruction",
        attemptId: "a:split",
        cause: { kind: "observation", observationId: "obs:1" },
      },
      {
        id: "q:other",
        kind: "question",
        question: { form: "determine", proposition: target("node:root", "goal", "goal:main") },
      },
    ]);
    const targets: Record<string, string> = {
      motivatedBy: "obs:1",
      addresses: "x:1",
      tests: "q:other",
      reuses: "obs:1",
      requires: "o:main",
      specializes: "q:other",
      generalizes: "q:other",
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...INQUIRY_RELATIONS.filter((relation) => relation !== "wouldSufficeFor")),
        fc.constantFrom(...REASON_PROVENANCES),
        fc.boolean(),
        fc.constantFrom<"human" | "agent">("human", "agent"),
        (relation, provenance, sameCommand, actorKind) => {
          const fromKind =
            relation === "specializes" || relation === "generalizes" ? "question" : "attempt";
          const fresh =
            fromKind === "question"
              ? { ...establishMain, id: "from:new" }
              : { ...attemptSplit, id: "from:new" };
          const fromId = sameCommand ? "from:new" : fromKind === "question" ? "q:main" : "a:split";
          const relationship = {
            id: "rel:p",
            kind: "relationship",
            relation,
            from: [fromId],
            to: targets[relation],
            reason: {
              provenance,
              ...(provenance === "method-encoded" ? { method: { kind: "manual" } } : {}),
            },
          };
          const ctx = context({ actor: { id: "actor:x", kind: actorKind } }, earlier);
          const result = prepared(
            sameCommand ? [fresh, relationship] : [relationship],
            ctx,
            "inquiry:p",
          );
          const actorMismatch =
            (provenance === "explicit-user" && actorKind !== "human") ||
            (provenance === "agent" && actorKind !== "agent");
          const later = provenance === "later-interpretation";
          const expectedOk =
            !actorMismatch &&
            (later ? !sameCommand : sameCommand || !INTENTION_RELATIONS.has(relation));
          expect(result.ok).toBe(expectedOk);
          if (result.ok) {
            const stored = result.records.at(-1)!;
            expect(inquiryRecordSchema.safeParse(stored).success).toBe(true);
          }
        },
      ),
    );
  });

  it("every accepted command yields consecutive sequences and schema-valid frozen records", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 5 }),
        (first, count) => {
          const records = Array.from({ length: count }, (_, index) => ({
            id: `obs:${index}`,
            kind: "observation",
            note: `Observation ${index}.`,
          }));
          const result = prepareInquiryCommand(command(records), context(), {
            ...options,
            firstSequence: first,
          });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.records.map(({ sequence }) => sequence)).toEqual(
            records.map((_, index) => first + index),
          );
          expect(inquiryRecordListSchema.safeParse(result.records).success).toBe(true);
          expect(result.records.every((record) => Object.isFrozen(record))).toBe(true);
        },
      ),
    );
  });
});
