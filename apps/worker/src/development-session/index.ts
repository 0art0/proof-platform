import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import {
  initializeProofSession,
  loadCurrentProofSession,
  type ProofSession,
  type ProofStore,
  type RepositoryFailure,
} from "../proof-repository";

export const DEVELOPMENT_PROOF_SESSION_ID = "session:development";
export const DEVELOPMENT_ROOT_NODE_ID = "node:development-root";
export const DEVELOPMENT_ROOT_STATE_ID = "state:development-root";

const proposition = (id: string, symbol: string) => ({
  id,
  symbol,
  sort: { kind: "proposition" as const },
  role: "universal-parameter" as const,
});

/**
 * A deterministic Stage 2 fixture with genuinely local sequent contexts.
 * The goal includes duplicate occurrences and the supported associative range [0, 2).
 * Selecting its conclusion and conjunction hypothesis exercises a two-selection move.
 */
export const DEVELOPMENT_ROOT_NODE: ProofNode = deepFreeze(
  createProofNodeSchema().parse({
    id: DEVELOPMENT_ROOT_NODE_ID,
    state: {
      id: DEVELOPMENT_ROOT_STATE_ID,
      goals: [
        {
          id: "goal:development-main",
          sequent: {
            context: {
              declarations: [
                proposition("declaration:development-goal-p", "p"),
                proposition("declaration:development-goal-q", "q"),
              ],
              hypotheses: [
                {
                  id: "hypothesis:development-conjunction",
                  statement: { expression: ["And", "p", "q"] },
                },
                { id: "hypothesis:development-q", statement: { expression: "q" } },
              ],
            },
            conclusion: { expression: ["And", "p", "p", "q"] },
          },
        },
      ],
      obligations: [
        {
          id: "obligation:development-side-condition",
          sequent: {
            context: {
              declarations: [
                proposition("declaration:development-obligation-r", "r"),
                proposition("declaration:development-obligation-s", "s"),
              ],
              hypotheses: [
                { id: "hypothesis:development-obligation-r", statement: { expression: "r" } },
              ],
            },
            conclusion: { expression: ["Implies", "r", "s"] },
          },
        },
      ],
    },
  }),
);

export type EnsureDevelopmentProofSessionResult =
  | Readonly<{
      status: "ready";
      created: boolean;
      session: ProofSession;
      node: ProofNode;
    }>
  | RepositoryFailure;

/** Create the fixed development session once, without ever resetting an existing history. */
export async function ensureDevelopmentProofSession(
  store: ProofStore,
): Promise<EnsureDevelopmentProofSessionResult> {
  const existing = await loadCurrentProofSession(store, DEVELOPMENT_PROOF_SESSION_ID);
  if (existing.status === "loaded") {
    return Object.freeze({
      status: "ready" as const,
      created: false,
      session: existing.session,
      node: existing.node,
    });
  }
  if (existing.diagnostics[0].code !== "session-not-found") return existing;

  const initialized = await initializeProofSession(store, {
    sessionId: DEVELOPMENT_PROOF_SESSION_ID,
    rootNode: DEVELOPMENT_ROOT_NODE,
    operators: [],
  });
  if (initialized.status === "committed") {
    return Object.freeze({
      status: "ready" as const,
      created: true,
      session: initialized.session,
      node: initialized.node,
    });
  }

  // A concurrent initializer may have won the unique-key race, or a commit may be uncertain.
  const raced = await loadCurrentProofSession(store, DEVELOPMENT_PROOF_SESSION_ID);
  return raced.status === "loaded"
    ? Object.freeze({
        status: "ready" as const,
        created: false,
        session: raced.session,
        node: raced.node,
      })
    : initialized;
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
