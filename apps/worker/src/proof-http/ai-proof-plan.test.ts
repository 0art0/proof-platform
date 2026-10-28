import { afterEach, describe, expect, it } from "vitest";
import {
  NO_MOVE_CHOICE_ID,
  translatorQuestions,
  type LlmTransport,
  type ProofPlanProposal,
  type ProofPlanStep,
  type StepTranslatorContext,
} from "@proof/llm";
import { createProofNodeSchema } from "@proof/protocol";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { InspectableMemoryProofStore } from "../memory-proof-store.testing";
import { initializeProofSession, type ProofStore } from "../proof-repository";
import type { AiRuntime } from "../ai-runtime";
import { createProofHttpService, type ProofHttpService } from ".";

const SESSION_ID = "session:plan";
const ROOT_ID = "node:plan-root";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const proposition = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

/** Assuming p and q, show q and p. */
function rootNode() {
  return createProofNodeSchema().parse({
    id: ROOT_ID,
    state: {
      id: "state:plan-root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: [proposition("p", 0), proposition("q", 1)],
              hypotheses: [{ id: "hypothesis:pq", statement: { expression: ["And", "p", "q"] } }],
            },
            conclusion: { expression: ["And", "q", "p"] },
          },
        },
      ],
      obligations: [],
    },
  });
}

function step(
  overrides: Partial<ProofPlanStep> & Pick<ProofPlanStep, "id" | "form">,
): ProofPlanStep {
  return {
    parent: null,
    claim: null,
    variables: [],
    assumptions: [],
    term: null,
    actsOn: [],
    by: { facts: [], results: [], background: null, method: null },
    motivation: null,
    ...overrides,
  };
}

const PLAN: ProofPlanProposal = {
  kind: "proof-plan",
  theorem: { latex: String.raw`q \land p`, prose: "q and p" },
  sketch: "Take the conjunction apart and put it back together in the other order.",
  steps: [
    step({
      id: "have-q",
      form: "have",
      claim: { latex: "q", prose: "q" },
      actsOn: ["H1"],
      by: { facts: ["H1"], results: [], background: null, method: "and elimination" },
      motivation: "The hypothesis is a conjunction; its parts are what the goal is built from.",
    }),
    step({
      id: "have-p",
      form: "have",
      claim: { latex: "p", prose: "p" },
      actsOn: ["H1"],
      by: { facts: ["H1"], results: [], background: null, method: "and elimination" },
      motivation: "The other conjunct.",
    }),
    step({
      id: "qed",
      form: "qed",
      actsOn: ["goal", "have-q", "have-p"],
      by: {
        facts: ["have-q", "have-p"],
        results: [],
        background: null,
        method: "and introduction",
      },
    }),
  ],
};

/** A scripted Jev: picks the first candidate whose artifact is in `prefer`, or a reserved outcome. */
function scriptedJev(script: {
  prefer?: readonly string[];
  outcome?: string;
  confidence?: number;
}) {
  const calls: StepTranslatorContext[] = [];
  const transport: LlmTransport = async (call) => {
    const envelope = call.envelope;
    if (envelope.role !== "step-translator") return null;
    const context = envelope.context;
    calls.push(context);
    const questions = translatorQuestions(context);
    const providerOutput: Record<string, unknown> = {};
    for (const [questionId, question] of Object.entries(questions)) {
      const options = Object.keys(question.criteria);
      let choice = options[0]!;
      if (context.kind === "action") {
        const preferred = (script.prefer ?? [])
          .map((artifact) => context.candidates.find(({ artifactId }) => artifactId === artifact))
          .find((candidate) => candidate !== undefined);
        choice = script.outcome ?? preferred?.id ?? NO_MOVE_CHOICE_ID;
      }
      const confidence = script.confidence ?? 0.9;
      const rest = (1 - confidence) / (options.length - 1);
      providerOutput[questionId] = {
        choice,
        confidence,
        probabilities: Object.fromEntries(
          options.map((id) => [id, id === choice ? confidence : rest]),
        ),
      };
    }
    return {
      kind: "jev-choices",
      providerRequest: { model: "fixture-jev", state: envelope, questions },
      providerOutput,
    };
  };
  return { transport, calls };
}

async function startScenario(
  options: {
    plan?: unknown;
    jev?: ReturnType<typeof scriptedJev>;
    ai?: boolean;
    planner?: LlmTransport;
    planAnswerWaitMs?: number;
  } = {},
) {
  const store = new InspectableMemoryProofStore();
  const llmCalls = new MemoryLlmCallStore();
  await initializeProofSession(store, {
    sessionId: SESSION_ID,
    rootNode: rootNode(),
    metadata: {
      problem: { title: "Swap", statement: "Assuming p and q, show q and p." },
      background: { level: "undergraduate", summary: "Logic.", assumptions: [] },
      libraryLayerIds: [],
    },
  });
  const jev = options.jev ?? scriptedJev({ prefer: [] });
  const ai: AiRuntime = {
    "proof-planner": {
      transport:
        options.planner ??
        (async () => ({
          result: { ...((options.plan as ProofPlanProposal | undefined) ?? PLAN), kind: "proof" },
        })),
      dispatch: { provider: "fixture", model: "fixture-planner", promptVersion: "test" },
    },
    "step-translator": {
      transport: jev.transport,
      dispatch: {
        provider: "fixture",
        model: "fixture-jev",
        promptVersion: "test",
        minimumConfidence: 0.5,
      },
    },
  };
  const service = createProofHttpService(store as ProofStore, {
    llmCalls,
    ...(options.ai === false ? {} : { ai }),
    ...(options.planAnswerWaitMs === undefined
      ? {}
      : { planAnswerWaitMs: options.planAnswerWaitMs }),
  });
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${SESSION_ID}`;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const currentNodeId = async () => (await get("")).body.node.id as string;
  /** The recorded commands, as text, to read who stands behind each one. */
  const commands = () =>
    JSON.stringify([...(store.commands as unknown as { values(): Iterable<unknown> }).values()]);
  return { get, post, currentNodeId, jev, commands };
}

type Scenario = Awaited<ReturnType<typeof startScenario>>;

/**
 * Walk the plan the way the web application does: for each unit, translate and apply until the
 * unit is realized, carrying the focus and the step labels' hypotheses forward.
 */
async function walk(scenario: Scenario, planCallId: string, units: readonly Json[]) {
  const refs: Record<string, string[]> = {};
  const focusByKey: Record<string, string> = { theorem: "goal:main" };
  const statuses: string[] = [];
  let call = 0;
  for (const unit of units) {
    const start = {
      nodeId: await scenario.currentNodeId(),
      focusTargetId: focusByKey[unit.focus]!,
    };
    const movesSoFar: string[] = [];
    for (;;) {
      call += 1;
      const translated = await scenario.post("/ai/proof-plan/translate", {
        id: `llm-call:translate-${call}`,
        planCallId,
        stepId: unit.stepId,
        expectedCurrentNodeId: await scenario.currentNodeId(),
        start,
        movesSoFar,
        refs,
      });
      expect(translated.status).toBe(200);
      const { status } = translated.body;
      if (status === "proposed") {
        const applied = await scenario.post("/ai/proof-plan/apply", {
          callId: translated.body.callId,
          candidateId: translated.body.choice.id,
          expectedCurrentNodeId: translated.body.preview.nodeId,
        });
        expect(applied.status).toBe(201);
        movesSoFar.push(translated.body.choice.label);
        continue;
      }
      statuses.push(`${unit.stepId}:${status}:${movesSoFar.length}`);
      if (status === "realized") {
        const outputs = translated.body.outputs;
        refs[unit.stepId] = outputs.produced;
        if (outputs.focusTargetId !== undefined) focusByKey[unit.focus] = outputs.focusTargetId;
      }
      break;
    }
  }
  return statuses;
}

describe("proof plans", () => {
  it("writes a plan and reports its Lamport numbers and units", async () => {
    const scenario = await startScenario();
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    expect(planned.status).toBe(200);
    expect(planned.body.status).toBe("planned");
    expect(planned.body.numbers.map(({ number }: Json) => number)).toEqual([
      "⟨1⟩1",
      "⟨1⟩2",
      "⟨1⟩3",
    ]);
    expect(planned.body.units.map(({ stepId }: Json) => stepId)).toEqual([
      "have-q",
      "have-p",
      "qed",
    ]);
    expect(planned.body.warnings).toEqual([]);

    const read = await scenario.get("/ai/proof-plan/llm-call:plan-1");
    expect(read.status).toBe(200);
    expect(read.body.plan).toEqual(PLAN);
  });

  it("answers 202 while a slow planner works, and serves the plan by its call ID once stored", async () => {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scenario = await startScenario({
      planAnswerWaitMs: 20,
      planner: async () => {
        await released;
        return { result: { ...PLAN, kind: "proof" } };
      },
    });
    const started = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-slow",
      expectedCurrentNodeId: ROOT_ID,
    });
    expect(started).toMatchObject({
      status: 202,
      body: { status: "planning", callId: "llm-call:plan-slow" },
    });
    expect((await scenario.get("/ai/proof-plan/llm-call:plan-slow")).body.status).toBe("planning");
    release();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const read = await scenario.get("/ai/proof-plan/llm-call:plan-slow");
      if (read.body.status !== "planning") {
        expect(read.body).toMatchObject({ status: "planned", plan: PLAN });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("The plan was never stored.");
  });

  it("walks the plan to a solved proof with Jev's choices, applied as the planning agent", async () => {
    const jev = scriptedJev({
      prefer: [
        "move:expand-hypothesis-conjunction",
        "move:split-goal-conjunction",
        "move:close-by-hypothesis",
      ],
    });
    const scenario = await startScenario({ jev });
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    const statuses = await walk(scenario, planned.body.callId, planned.body.units);
    // have-q takes one move; have-p already holds; the QED splits and closes both halves.
    expect(statuses).toEqual(["have-q:realized:1", "have-p:realized:0", "qed:realized:3"]);
    const session = await scenario.get("");
    expect(session.body.node.state.goals).toEqual([]);
    expect(scenario.commands()).toContain('"id":"actor:proof-planner","kind":"agent"');

    // Jev saw only the step, the focused goal and the candidates: never the problem text.
    const seen = JSON.stringify(jev.calls);
    expect(seen).not.toContain("Assuming p and q");
    expect(jev.calls[0]).toMatchObject({
      kind: "action",
      plan: { stepId: "have-q", number: "⟨1⟩1" },
    });
    // Sorries are never offered.
    expect(seen).not.toContain("move:mark-sorry");
  });

  it("realizes a QED without a move when an earlier step's move already closed its goal", async () => {
    const jev = scriptedJev({
      prefer: [
        "move:expand-hypothesis-conjunction",
        "move:split-goal-conjunction",
        "move:close-by-hypothesis",
      ],
    });
    const scenario = await startScenario({ jev });
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    // Walk have-q and have-p, then close the goal by walking the QED once; a second QED request
    // started at the root still finds the goal closed.
    await walk(scenario, planned.body.callId, planned.body.units);
    const translated = await scenario.post("/ai/proof-plan/translate", {
      id: "llm-call:translate-again",
      planCallId: planned.body.callId,
      stepId: "qed",
      expectedCurrentNodeId: await scenario.currentNodeId(),
      start: { nodeId: ROOT_ID, focusTargetId: "goal:main" },
      movesSoFar: [],
      refs: {},
    });
    expect(translated.body).toMatchObject({ status: "realized", outputs: { produced: [] } });
  });

  it("reports a missing move when Jev finds no displayed action for the step", async () => {
    const scenario = await startScenario({ jev: scriptedJev({ outcome: NO_MOVE_CHOICE_ID }) });
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    const translated = await scenario.post("/ai/proof-plan/translate", {
      id: "llm-call:translate-1",
      planCallId: planned.body.callId,
      stepId: "have-q",
      expectedCurrentNodeId: ROOT_ID,
      start: { nodeId: ROOT_ID, focusTargetId: "goal:main" },
      movesSoFar: [],
      refs: {},
    });
    expect(translated.body).toMatchObject({
      status: "no-move",
      number: "⟨1⟩1",
      focus: { targetId: "goal:main" },
    });
    expect(translated.body.candidateCount).toBeGreaterThan(0);
    expect(translated.body.alternatives.length).toBeGreaterThan(0);
  });

  it("asks the person to choose when Jev is unsure, and applies their choice as a human command", async () => {
    const scenario = await startScenario({
      jev: scriptedJev({ prefer: ["move:expand-hypothesis-conjunction"], confidence: 0.3 }),
    });
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    const request = {
      id: "llm-call:translate-1",
      planCallId: planned.body.callId,
      stepId: "have-q",
      expectedCurrentNodeId: ROOT_ID,
      start: { nodeId: ROOT_ID, focusTargetId: "goal:main" },
      movesSoFar: [],
      refs: {},
    };
    const uncertain = await scenario.post("/ai/proof-plan/translate", request);
    expect(uncertain.body.status).toBe("uncertain");
    const pick = uncertain.body.alternatives.find(
      ({ artifactId }: Json) => artifactId === "move:expand-hypothesis-conjunction",
    );
    expect(pick).toBeDefined();
    const chosen = await scenario.post("/ai/proof-plan/translate", {
      ...request,
      chosenCandidateId: pick.id,
    });
    expect(chosen.body).toMatchObject({
      status: "proposed",
      replayed: true,
      actor: { kind: "human" },
    });
    const applied = await scenario.post("/ai/proof-plan/apply", {
      callId: chosen.body.callId,
      candidateId: pick.id,
      expectedCurrentNodeId: ROOT_ID,
    });
    expect(applied.status).toBe(201);
    expect(scenario.commands()).not.toContain("actor:proof-planner");
    expect(scenario.commands()).toContain('"id":"actor:web","kind":"human"');
  });

  it("marks a local lemma as unsupported without a model call", async () => {
    const plan: ProofPlanProposal = {
      ...PLAN,
      steps: [
        step({
          id: "lemma",
          form: "assume",
          claim: { latex: "q", prose: "q" },
          assumptions: [{ latex: "p", prose: "p" }],
          motivation: "A local lemma.",
        }),
        step({
          id: "lemma-qed",
          parent: "lemma",
          form: "qed",
          by: { facts: ["H1"], results: [], background: null, method: null },
        }),
        ...PLAN.steps,
      ],
    };
    const jev = scriptedJev({});
    const scenario = await startScenario({ plan, jev });
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    const translated = await scenario.post("/ai/proof-plan/translate", {
      id: "llm-call:translate-1",
      planCallId: planned.body.callId,
      stepId: "lemma",
      expectedCurrentNodeId: ROOT_ID,
      start: { nodeId: ROOT_ID, focusTargetId: "goal:main" },
      movesSoFar: [],
      refs: {},
    });
    expect(translated.body.status).toBe("unsupported");
    expect(translated.body.reason).toContain("claim (cut) move");
    expect(jev.calls).toHaveLength(0);
  });

  it("records a plan that breaks a rule as rejected", async () => {
    const scenario = await startScenario({ plan: { ...PLAN, steps: PLAN.steps.slice(0, 2) } });
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    expect(planned.status).toBe(422);
    expect(planned.body.diagnostics[0].message).toBe(
      "The proof of the theorem must end with a qed step.",
    );
  });

  it("refuses stale, unconfigured and foreign requests", async () => {
    const scenario = await startScenario();
    expect(
      (
        await scenario.post("/ai/proof-plan", {
          id: "llm-call:plan-1",
          expectedCurrentNodeId: "node:other",
        })
      ).status,
    ).toBe(409);
    const planned = await scenario.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    const apply = await scenario.post("/ai/proof-plan/apply", {
      callId: planned.body.callId,
      candidateId: "candidate:1",
      expectedCurrentNodeId: ROOT_ID,
    });
    expect(apply.body.status).toBe("not-applicable");

    const disabled = await startScenario({ ai: false });
    const refused = await disabled.post("/ai/proof-plan", {
      id: "llm-call:plan-1",
      expectedCurrentNodeId: ROOT_ID,
    });
    expect(refused.status).toBe(503);
  });
});
