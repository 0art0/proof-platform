/**
 * Fixtures for the constant-activation tests: a session whose setup operators are `Divides` only
 * and whose library holds results that need the library constants `Gcd` and `Lcm`.
 *
 * Every result concludes `Divides(a, Multiply(a, b))`, so each can be applied backward to any goal
 * of the form `Divides(p, Multiply(p, q))`. They differ in their premises: `plain` has none,
 * `gcd` needs `Gcd(a, b) = 1`, `lcm` needs `Lcm(a, b) = Multiply(a, b)`, and `both` needs both. A
 * step that applies one therefore activates exactly the constants of its premises.
 */
import { createLibraryResultSchema, starterLibraryPacks, type LibraryResult } from "@proof/library";
import type { OperatorDeclaration } from "@proof/mathjson-model";
import {
  actorSchema,
  createProofNodeSchema,
  problemSetupSort,
  type Actor,
  type ProofNode,
} from "@proof/protocol";
import { APPROVED_DEFINITIONS, type DefinitionCatalog } from "./approved-catalog";
import { addLibraryArtifact } from "./library-repository";
import { MemoryLibraryStore } from "./memory-library-store";
import { sessionDefinitions } from "./move-authoring";
import {
  executeProofCommand,
  initializeProofSession,
  loadCurrentProofSession,
  type ProofSession,
} from "./proof-repository";

export const SESSION = "session:constants";
export const INTEGER = problemSetupSort("integer");
export const human = actorSchema.parse({ kind: "human", id: "actor:human" });
export const agent = actorSchema.parse({ kind: "agent", id: "actor:agent" });

export const DIVIDES: OperatorDeclaration = (() => {
  const divides = starterLibraryPacks()
    .flatMap((pack) => pack.operators)
    .find(({ symbol }) => symbol === "Divides");
  if (divides === undefined) throw new Error("The divisibility pack declares Divides.");
  return divides;
})();

function constant(symbol: string, trigger: string, displayName: string): OperatorDeclaration {
  return {
    id: `operator:${symbol.toLowerCase()}`,
    symbol,
    signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
    presentation: {
      displayName,
      latex: {
        template: `\\operatorname{${trigger}}\\left(#1, #2\\right)`,
        precedence: "atom",
        parse: { trigger: `\\operatorname{${trigger}}`, notation: "function" },
      },
      naturalLanguage: [{ template: `the ${trigger} of #1 and #2`, proposition: false }],
    },
  } as unknown as OperatorDeclaration;
}
export const GCD = constant("Gcd", "gcd", "greatest common divisor");
export const LCM = constant("Lcm", "lcm", "least common multiple");

const parameter = (symbol: string) => ({
  id: `declaration:result-${symbol}`,
  symbol,
  sort: INTEGER,
  role: "universal-parameter" as const,
});

export type ResultKey = "plain" | "gcd" | "lcm" | "both";
export const RESULT_KEYS: readonly ResultKey[] = ["plain", "gcd", "lcm", "both"];

/** The constants each result needs, in declaration order. */
export const NEEDS: Readonly<Record<ResultKey, readonly OperatorDeclaration[]>> = {
  plain: [],
  gcd: [GCD],
  lcm: [LCM],
  both: [GCD, LCM],
};
const PREMISES: Readonly<Record<ResultKey, readonly unknown[]>> = {
  plain: [],
  gcd: [["Equal", ["Gcd", "a", "b"], 1]],
  lcm: [["Equal", ["Lcm", "a", "b"], ["Multiply", "a", "b"]]],
  both: [
    ["Equal", ["Gcd", "a", "b"], 1],
    ["Equal", ["Lcm", "a", "b"], ["Multiply", "a", "b"]],
  ],
};

export const resultId = (key: ResultKey) => `result:test-${key}`;

export function libraryResult(key: ResultKey, overrides: Record<string, unknown> = {}) {
  const operators = NEEDS[key];
  return createLibraryResultSchema({ operators: [DIVIDES] }).parse({
    kind: "result",
    id: resultId(key),
    name: `Multiples (${key})`,
    description: `A number divides its multiples (${key}).`,
    renderings: {
      latex: String.raw`a \mid ab`,
      naturalLanguage: "a divides a times b.",
    },
    classification: { domains: ["number theory"], level: "foundational" },
    provenance: { kind: "curated", source: "test" },
    approval: { status: "approved", reviewerId: "actor:web" },
    layer: "initial-problem",
    related: [],
    priority: 50,
    parameters: [parameter("a"), parameter("b")],
    statement: { expression: ["Divides", "a", ["Multiply", "a", "b"]] },
    premises: PREMISES[key].map((expression) => ({ expression })),
    sideConditions: [],
    applicationDirections: ["backward"],
    patterns: [
      {
        id: `pattern:test-${key}`,
        expression: ["Divides", "a", ["Multiply", "a", "b"]],
        direction: "backward",
        requirement: { section: "goal", polarity: "positive", role: "proposition" },
      },
    ],
    ...(operators.length === 0 ? {} : { operators }),
    ...overrides,
  }) as LibraryResult;
}

export const ROOT_NODE_ID = "node:root";

/** A root node with `goals` goals, `goal:1` to `goal:n`, each `Divides(p_i, Multiply(p_i, q))`. */
export function rootNode(goals: number): ProofNode {
  const declarations = [...Array.from({ length: goals }, (_, index) => `p${index + 1}`), "q"].map(
    (symbol) => ({
      id: `declaration:${symbol}`,
      symbol,
      sort: INTEGER,
      role: "universal-parameter",
    }),
  );
  return createProofNodeSchema({ operators: [DIVIDES] }).parse({
    id: ROOT_NODE_ID,
    state: {
      id: "state:root",
      goals: Array.from({ length: goals }, (_, index) => ({
        id: `goal:${index + 1}`,
        sequent: {
          context: { declarations, hypotheses: [] },
          conclusion: {
            expression: ["Divides", `p${index + 1}`, ["Multiply", `p${index + 1}`, "q"]],
          },
        },
      })),
      obligations: [],
    },
  });
}

export const METADATA = {
  problem: { title: "Multiples", statement: "A number divides its multiples." },
  background: {
    level: "undergraduate",
    summary: "Elementary number theory.",
    assumptions: [],
    domains: ["number theory"],
    maximumLevel: "undergraduate",
  },
  libraryLayerIds: ["layer:initial-problem"],
};

export type Scenario = Readonly<{
  store: MemoryLibraryStore;
  definitions: DefinitionCatalog;
}>;

/**
 * A session with `goals` open goals whose library holds the given results (a recorded
 * `initial-problem` addition each), and the definitions a request for it would use.
 */
export async function scenario(
  goals: number,
  keys: readonly ResultKey[] = RESULT_KEYS,
  sessionId = SESSION,
  store: MemoryLibraryStore = new MemoryLibraryStore(),
): Promise<Scenario> {
  const initialized = await initializeProofSession(store, {
    sessionId,
    rootNode: rootNode(goals),
    operators: [DIVIDES],
    metadata: METADATA,
  });
  if (initialized.status !== "committed") throw new Error(JSON.stringify(initialized));
  for (const key of keys) {
    const added = await addLibraryArtifact(store, {
      id: `library-addition:${sessionId}:${key}`,
      sessionId,
      occurredAt: "2026-10-19T09:00:00.000Z",
      layer: "initial-problem",
      origin: { kind: "setup", actorId: "actor:web" },
      artifact: libraryResult(key),
    });
    if (added.status !== "recorded" || !added.admitted) throw new Error(JSON.stringify(added));
  }
  return { store, definitions: await sessionDefinitions(APPROVED_DEFINITIONS, store, sessionId) };
}

export async function current(
  store: MemoryLibraryStore,
  sessionId = SESSION,
): Promise<Readonly<{ session: ProofSession; node: ProofNode }>> {
  const loaded = await loadCurrentProofSession(store, sessionId);
  if (loaded.status !== "loaded") throw new Error(JSON.stringify(loaded));
  return loaded;
}

/** A raw `apply-result-backward` command for goal `goal:<goal>` with the given result. */
export async function applyCommand(
  store: MemoryLibraryStore,
  input: Readonly<{
    key: ResultKey;
    goal: number;
    commandId: string;
    actor?: Actor;
    sessionId?: string;
    /** Override the result ID (for a result the catalog does not know). */
    resultId?: string;
    /** Instantiate the result for another goal's parameter, which the kernel refuses. */
    mismatchedGoal?: number;
  }>,
): Promise<Record<string, unknown>> {
  const { node } = await current(store, input.sessionId);
  const n = input.commandId.replace(/[^a-z0-9]+/gi, "-");
  return {
    commandId: input.commandId,
    kind: "apply-kernel-operation",
    actor: input.actor ?? human,
    parentNodeId: node.id,
    resultNodeId: `node:${n}`,
    edgeId: `edge:${n}`,
    eventId: `event:${n}`,
    operation: {
      kind: "apply-result-backward",
      expectedStateId: node.state.id,
      resultStateId: `state:${n}`,
      target: { kind: "goal", id: `goal:${input.goal}` },
      resultId: input.resultId ?? resultId(input.key),
      instantiation: { a: `p${input.mismatchedGoal ?? input.goal}`, b: "q" },
      premiseTargetIds: PREMISES[input.key].map((_, index) => `statement:${n}:premise-${index}`),
    },
  };
}

/** Apply a result to a goal through the command service, as a human unless told otherwise. */
export async function apply(
  scene: Scenario,
  input: Parameters<typeof applyCommand>[1],
  now?: () => Date,
) {
  const command = await applyCommand(scene.store, input);
  const actor = input.actor ?? human;
  return executeProofCommand(
    scene.store,
    input.sessionId ?? SESSION,
    command,
    actor,
    scene.definitions,
    now === undefined ? {} : { now },
  );
}

export async function activations(store: MemoryLibraryStore, sessionId = SESSION) {
  return store.transaction((transaction) =>
    transaction.listConstantActivations(sessionId as never),
  ) as Promise<
    readonly {
      sequence: number;
      symbol: string;
      commandId: string;
      edgeId: string;
      nodeId: string;
      resultId: string;
      transitionSequence: number;
      activatedAt: string;
    }[]
  >;
}
