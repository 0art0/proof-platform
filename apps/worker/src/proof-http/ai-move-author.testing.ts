/**
 * Fixtures for the move author's route tests: a session in which the user described a step in
 * words ("prove the contrapositive instead"), the move executor planned and applied it, and a
 * fake provider answers the move author with a general move. Everything runs against the memory
 * stores; nothing contacts a provider.
 */
import type { LlmTransport } from "@proof/llm";
import { createProofNodeSchema } from "@proof/protocol";
import type { AiRoleRuntime } from "../ai-runtime";
import { MemoryLibraryStore } from "../memory-library-store";
import { MemoryLlmCallStore } from "../memory-llm-call-store";
import { initializeProofSession } from "../proof-repository";
import { createProofHttpService, type ProofHttpService } from ".";
import type { createAiLimiter } from "./ai-rate-limit";

export const SESSION_ID = "session:author";
export const ROOT_ID = "node:author-root";
export const ROOT_STATE_ID = "state:author-root";
export const EXECUTOR_CALL_ID = "llm-call:execute-1";
export const AUTHOR_CALL_ID = "llm-call:author-1";
export const goal = { kind: "goal", id: "goal:main" } as const;

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const HUMAN = { id: "actor:human-1", kind: "human" } as const;
export const REVIEWER = { id: "actor:human-reviewer", kind: "human" } as const;
export const AGENT = { id: "actor:agent-1", kind: "agent" } as const;

const dispatch = {
  provider: "fixture",
  model: "fixture-model",
  promptVersion: "ai-move-author-test-v1",
} as const;

const proposition = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: { kind: "proposition" },
  role: "universal-parameter",
});

/**
 * The goal the user works on, `p implies q`, a second goal of a different shape the move will later
 * be used on, and a third whose contents must never reach a model.
 */
export function rootNode() {
  return createProofNodeSchema().parse({
    id: ROOT_ID,
    state: {
      id: ROOT_STATE_ID,
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: { declarations: [proposition("p", 0), proposition("q", 1)], hypotheses: [] },
            conclusion: { expression: ["Implies", "p", "q"] },
          },
        },
        {
          id: "goal:other",
          sequent: {
            context: {
              declarations: [proposition("r", 2), proposition("s", 3), proposition("t", 4)],
              hypotheses: [],
            },
            conclusion: { expression: ["Implies", ["And", "r", "s"], ["Or", "t", "r"]] },
          },
        },
        {
          id: "goal:elsewhere",
          sequent: {
            context: { declarations: [proposition("remote-secret", 5)], hypotheses: [] },
            conclusion: { expression: "remote-secret" },
          },
        },
      ],
      obligations: [],
    },
  });
}

/** The executor's plan for "prove the contrapositive instead". */
export const executorOutput = {
  result: {
    kind: "plan",
    steps: [
      {
        kind: "suffices",
        target: goal,
        proposition: ["Implies", ["Not", "q"], ["Not", "p"]],
        obligationId: "contra",
      },
    ],
    explanation: "Reduce the goal to its contrapositive.",
  },
};

const parameter = (overrides: Json) => ({
  parameter: "proposition",
  kind: "proposition",
  index: null,
  direction: null,
  expression: null,
  resultId: null,
  hypothesis: null,
  ...overrides,
});
const conclusionSelection = () => ({
  slot: "target",
  statementKind: "conclusion",
  statementLabel: null,
  path: [],
});
export const contrapositive = (antecedent: unknown, consequent: unknown) => [
  "Implies",
  ["Not", consequent],
  ["Not", antecedent],
];

/** What a model could answer: a general contrapositive move, in the provider's wire form. */
export function wireProposal(edit: (proposal: Json) => void = () => undefined): Json {
  const compound = ["Implies", ["And", "p", "r"], ["Or", "q", "r"]];
  const proposal: Json = {
    kind: "move-proposal",
    name: "Prove the contrapositive",
    description:
      "Reduce an implication goal to the implication between the negations of its parts.",
    motivation: "The user replaced the goal A implies B by its contrapositive.",
    classification: { kind: "macro", rationale: "One suffices step; no new result is needed." },
    transitionClass: "strengthening",
    contextRequirements: [],
    sideConditions: ["The selected statement is an implication."],
    requiredResultIds: [],
    metavariables: [
      { name: "A", sort: "proposition" },
      { name: "B", sort: "proposition" },
    ],
    patterns: [{ slot: "target", expression: ["Implies", "A", "B"] }],
    steps: [
      {
        id: "reduce",
        operation: "suffices",
        selections: [
          {
            slot: "target",
            target: "goal",
            statementKind: "conclusion",
            statementLabel: null,
            path: [],
            fragment: ["Implies", "A", "B"],
          },
        ],
        parameters: [parameter({ expression: contrapositive("A", "B") })],
      },
    ],
    examples: [
      {
        id: "source",
        description: "The step as the user took it.",
        outcome: "applied",
        situation: "source",
        state: null,
        selections: [conclusionSelection()],
        choices: [],
        expected: null,
      },
      {
        id: "compound",
        description: "Both parts are compound statements.",
        outcome: "applied",
        situation: "independent",
        state: {
          declarations: ["p", "q", "r"].map((symbol) => ({ symbol, sort: "proposition" })),
          hypotheses: [],
          conclusion: compound,
        },
        selections: [conclusionSelection()],
        choices: [],
        expected: {
          transitionClass: "strengthening",
          goals: [contrapositive(["And", "p", "r"], ["Or", "q", "r"])],
          obligations: [["Implies", contrapositive(["And", "p", "r"], ["Or", "q", "r"]), compound]],
        },
      },
      {
        id: "not-an-implication",
        description: "The goal is not an implication.",
        outcome: "rejected",
        situation: "independent",
        state: {
          declarations: [{ symbol: "p", sort: "proposition" }],
          hypotheses: [],
          conclusion: "p",
        },
        selections: [conclusionSelection()],
        choices: [],
        expected: null,
      },
    ],
  };
  edit(proposal);
  return proposal;
}

export function counting(output: unknown) {
  const calls: Parameters<LlmTransport>[0][] = [];
  const transport: LlmTransport = async (call) => {
    calls.push(call);
    return typeof output === "function" ? (output as (c: unknown) => unknown)(call) : output;
  };
  return { transport, calls };
}

export type AuthorScenarioOptions = {
  /** The move author's provider; absent leaves the role unconfigured. */
  author?: LlmTransport | undefined;
  /** The executor's provider; defaults to the contrapositive plan. */
  executor?: LlmTransport | undefined;
  aiLimiter?: ReturnType<typeof createAiLimiter>;
};

export type AuthorScenario = Awaited<ReturnType<typeof startAuthorScenario>>;

export async function startAuthorScenario(
  services: ProofHttpService[],
  options: AuthorScenarioOptions = {},
) {
  const store = new MemoryLibraryStore();
  const llmCalls = new MemoryLlmCallStore();
  await initializeProofSession(store, {
    sessionId: SESSION_ID,
    rootNode: rootNode(),
    metadata: {
      problem: { title: "Secret problem title", statement: "Show p implies q, secretly." },
      background: {
        level: "undergraduate",
        summary: "Logic.",
        assumptions: [],
        domains: ["logic"],
        maximumLevel: "undergraduate",
      },
      libraryLayerIds: [],
    },
  });
  const runtime = (transport: LlmTransport): AiRoleRuntime => ({ transport, dispatch });
  const service = createProofHttpService(store, {
    library: store,
    llmCalls,
    ...(options.aiLimiter === undefined ? {} : { aiLimiter: options.aiLimiter }),
    ai: {
      "move-executor": runtime(options.executor ?? counting(executorOutput).transport),
      ...(options.author === undefined ? {} : { "move-author": runtime(options.author) }),
    },
  });
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${SESSION_ID}`;
  let counter = 0;
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const post = async (path: string, body: unknown, headers: HeadersInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as Json,
    };
  };
  const command = async (actor: unknown, body: Json, basis?: Json) => {
    counter += 1;
    return post("/protocol-commands", {
      commandId: `command:author-${counter}`,
      actor,
      ...(basis === undefined ? {} : { basis }),
      command: body,
    });
  };
  const describeStep = (overrides: Json = {}) => ({
    id: EXECUTOR_CALL_ID,
    expectedCurrentNodeId: ROOT_ID,
    instruction: "prove the contrapositive instead",
    source: "user-instruction",
    target: goal,
    selections: [
      {
        kind: "exact",
        anchor: { stateId: ROOT_STATE_ID, target: goal, statement: { kind: "conclusion" } },
        path: [],
      },
    ],
    ...overrides,
  });
  return {
    store,
    llmCalls,
    origin,
    get,
    post,
    command,
    /** The user's described step: previewed, and by default applied. */
    describe: async (apply = true, overrides: Json = {}) => {
      const preview = await post("/ai/execute", describeStep(overrides));
      if (!apply) return preview;
      const callId = (overrides["id"] as string | undefined) ?? EXECUTOR_CALL_ID;
      return post("/ai/execute/apply", { callId, expectedCurrentNodeId: ROOT_ID });
    },
    propose: (overrides: Json = {}) =>
      post("/ai/move-author", {
        id: AUTHOR_CALL_ID,
        executorCallId: EXECUTOR_CALL_ID,
        ...overrides,
      }),
    author: (template: unknown, proposal?: unknown, actor: unknown = HUMAN) =>
      command(actor, {
        kind: "author-move-draft",
        template,
        payloadSource: "reviewed-authoring",
        ...(proposal === undefined ? {} : { proposal }),
      }),
    review: (draftArtifactId: string, decision: string, notes = "", actor: unknown = REVIEWER) =>
      command(actor, {
        kind: "review-move-draft",
        draftArtifactId,
        decision,
        notes,
        payloadSource: "reviewed-authoring",
      }),
    history: async () => (await get("/history")).body as { edges: { edge: Json; name: string }[] },
    current: async () => (await get("")).body,
  };
}
