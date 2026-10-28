import { describe, expect, it } from "vitest";
import {
  NO_FITTING_ITEM_CHOICE_ID,
  NO_MOVE_CHOICE_ID,
  STEP_REALIZED_CHOICE_ID,
  buildStepTranslatorContext,
  createVercelJevStepTranslatorTransport,
  criterionLabel,
  executePreparedLlmCall,
  llmCallEvidenceSchema,
  prepareLlmCall,
  translatorQuestions,
  type PreparedLlmCall,
  type StepTranslatorContext,
} from "./index";

const STEP = {
  claim: { latex: String.raw`\neg p`, prose: "not p" },
  variables: [],
  assumptions: [],
  term: null,
  by: {
    facts: ["H1"],
    results: ["result:modus-tollens"],
    background: null,
    method: "modus tollens",
  },
  motivation: "We know p implies q and not q.",
  actsOn: [{ reference: "H1", statement: String.raw`p \implies q` }],
};
const PLAN = { callId: "llm-call:plan-1", stepId: "not-p", number: "⟨1⟩2", form: "have" as const };
const FOCUS = {
  targetId: "goal:main",
  conclusion: String.raw`\neg p`,
  hypotheses: [
    { id: "hypothesis:h1", statement: String.raw`p \implies q` },
    { id: "hypothesis:nq", statement: String.raw`\neg q` },
  ],
};

const SELECTION = {
  kind: "exact" as const,
  anchor: {
    stateId: "state:1",
    target: { kind: "goal" as const, id: "goal:main" },
    statement: { kind: "hypothesis" as const, id: "hypothesis:h1" },
  },
  path: [],
};

const ACTION: StepTranslatorContext = {
  kind: "action",
  nodeId: "node:1",
  selectionSets: [{ id: "selection-set:1", selections: [SELECTION] }],
  plan: PLAN,
  step: STEP,
  enclosingClaim: { latex: String.raw`\neg p`, prose: "not p" },
  focus: FOCUS,
  movesSoFar: [],
  candidates: [
    {
      id: "candidate:1",
      label: String.raw`Modus tollens on p \implies q`,
      source: "result",
      artifactId: "result:modus-tollens",
      selectionSetId: "selection-set:1",
      suggestionIndex: 0,
      selections: [String.raw`p \implies q`],
      reasons: ["The selection matches the result's premise."],
    },
    {
      id: "candidate:2",
      label: String.raw`Drop hypothesis p \implies q`,
      source: "move",
      artifactId: "move:drop-hypothesis",
      selectionSetId: "selection-set:1",
      suggestionIndex: 1,
      selections: [String.raw`p \implies q`],
      reasons: ["Any hypothesis can be dropped."],
    },
  ],
  offerRealized: false,
};

const MENUS: StepTranslatorContext = {
  kind: "menus",
  nodeId: "node:1",
  actionCallId: "llm-call:translate-0",
  candidateId: "candidate:1",
  plan: PLAN,
  step: STEP,
  focus: FOCUS,
  suggestion: { name: "Rewrite with equality", artifactId: "move:rewrite-with-equality" },
  menus: [
    {
      parameterId: "direction",
      label: "Direction",
      items: [
        { id: "item:forward", label: "left to right" },
        { id: "item:backward", label: "right to left" },
      ],
    },
  ],
};

function call(context: StepTranslatorContext, id = "llm-call:translate-1"): PreparedLlmCall {
  const built = buildStepTranslatorContext({ id, context });
  if (!built.ok) throw new Error(built.diagnostics[0].message);
  const prepared = prepareLlmCall(built.envelope);
  if (!prepared.ok) throw new Error("prepare");
  return prepared.call;
}

function gateway(answers: unknown, metadata?: unknown) {
  const requests: unknown[] = [];
  const fetcher = (async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        answers,
        ...(metadata === undefined ? {} : { providerMetadata: metadata }),
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  return {
    requests,
    transport: createVercelJevStepTranslatorTransport({
      apiKey: "test",
      fetch: fetcher,
      baseUrl: "https://gateway.test",
    }),
  };
}

describe("translatorQuestions", () => {
  it("offers every candidate and the reserved outcomes", () => {
    expect(Object.keys(translatorQuestions(ACTION).action!.criteria)).toEqual([
      "candidate:1",
      "candidate:2",
      NO_MOVE_CHOICE_ID,
    ]);
    expect(
      Object.keys(translatorQuestions({ ...ACTION, offerRealized: true }).action!.criteria),
    ).toContain(STEP_REALIZED_CHOICE_ID);
    const menus = translatorQuestions(MENUS);
    expect(Object.keys(menus)).toEqual(["menu-1"]);
    expect(Object.keys(menus["menu-1"]!.criteria)).toEqual([
      "item:forward",
      "item:backward",
      NO_FITTING_ITEM_CHOICE_ID,
    ]);
  });

  it("refuses a context that reuses a reserved ID", () => {
    const candidates = [{ ...ACTION.candidates[0]!, id: NO_MOVE_CHOICE_ID }];
    expect(
      buildStepTranslatorContext({ id: "llm-call:x", context: { ...ACTION, candidates } }).ok,
    ).toBe(false);
  });

  it("refuses a candidate whose selection set is not listed", () => {
    const candidates = [{ ...ACTION.candidates[0]!, selectionSetId: "selection-set:9" }];
    expect(
      buildStepTranslatorContext({ id: "llm-call:x", context: { ...ACTION, candidates } }).ok,
    ).toBe(false);
  });

  it("keeps labels within the criterion limit", () => {
    expect([...criterionLabel("x".repeat(900))]).toHaveLength(500);
    expect(criterionLabel("short")).toBe("short");
  });
});

describe("step-translator role", () => {
  it("records a validated choice with every option ranked", async () => {
    const { transport, requests } = gateway({
      action: {
        type: "choice",
        choice: "candidate:1",
        probabilities: { "candidate:1": 0.8, "candidate:2": 0.05, [NO_MOVE_CHOICE_ID]: 0.15 },
        confidence: 0.8,
      },
    });
    const evidence = await executePreparedLlmCall(call(ACTION), transport);
    expect(evidence.status).toBe("validated");
    expect(llmCallEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(evidence.output).toEqual({
      kind: "translator-choices",
      answers: {
        action: {
          choice: "candidate:1",
          confidence: 0.8,
          ranked: [
            { id: "candidate:1", probability: 0.8 },
            { id: NO_MOVE_CHOICE_ID, probability: 0.15 },
            { id: "candidate:2", probability: 0.05 },
          ],
        },
      },
    });
    expect(requests[0]).toMatchObject({
      model: "typesafe-ai/jev",
      questions: { action: { type: "choice" } },
    });
  });

  it("reads per-question confidence from the gateway metadata", async () => {
    const { transport } = gateway(
      {
        "menu-1": {
          choice: "item:forward",
          probabilities: {
            "item:forward": 0.7,
            "item:backward": 0.2,
            [NO_FITTING_ITEM_CHOICE_ID]: 0.1,
          },
        },
      },
      { typesafe: { confidence: { "menu-1": 0.66 } } },
    );
    const evidence = await executePreparedLlmCall(call(MENUS), transport);
    expect(evidence.status).toBe("validated");
    expect(evidence.output).toMatchObject({
      answers: { "menu-1": { choice: "item:forward", confidence: 0.66 } },
    });
  });

  it("rejects a choice outside the options, a non-distribution and a choice that is not the most probable", async () => {
    const cases = [
      { choice: "candidate:9", probabilities: { "candidate:9": 1 }, confidence: 0.9 },
      {
        choice: "candidate:1",
        probabilities: { "candidate:1": 0.5, "candidate:2": 0.1, [NO_MOVE_CHOICE_ID]: 0.1 },
        confidence: 0.9,
      },
      {
        choice: "candidate:2",
        probabilities: { "candidate:1": 0.6, "candidate:2": 0.3, [NO_MOVE_CHOICE_ID]: 0.1 },
        confidence: 0.9,
      },
    ];
    for (const answer of cases) {
      const evidence = await executePreparedLlmCall(
        call(ACTION),
        gateway({ action: answer }).transport,
      );
      expect(evidence.status).toBe("rejected");
    }
  });

  it("fails as a transport error when an answer has no confidence", async () => {
    const evidence = await executePreparedLlmCall(
      call(ACTION),
      gateway({ action: { choice: "candidate:1", probabilities: { "candidate:1": 1 } } }).transport,
    );
    expect(evidence.status).toBe("transport-failed");
    expect(evidence.diagnostics[0]?.subcode).toBe("missing-confidence");
  });
});
