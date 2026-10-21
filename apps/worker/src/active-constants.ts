/**
 * The constants of a session as the records say (`docs/ai-agents-architecture.md` section 2).
 *
 * - **Active** constants are the session's effective operators: its setup operators (origin
 *   `setup`) and the constants committed steps activated (origin `activated`), in that order.
 * - **Available** constants are the library constants (`LibraryResult.operators`) that the
 *   session's library results declare and the effective operators do not: dormant until a
 *   committed step applies a result that needs them.
 * - **Activations** are the append-only records of that happening, each naming the step (command,
 *   edge and node), the library result it applied and the activation's sequence. They persist
 *   after backtracking or deleting the step.
 *
 * Nothing here calls a model or reads the proof history: activation is a record written by the
 * command service in the step's own transaction (`proof-repository.ts`).
 */
import type { LibraryResult } from "@proof/library";
import type { OperatorDeclaration } from "@proof/mathjson-model";
import type { ConstantActivation } from "@proof/protocol";
import type { DefinitionCatalog } from "./approved-catalog";
import { listLlmCalls, type LlmCallStore } from "./llm-call-repository";
import {
  loadSession,
  transactionFailure,
  type ProofSession,
  type ProofStore,
} from "./proof-repository";
import { availableConstants, catalogOperators } from "./session-constants";

export type ActiveConstant = Readonly<{
  symbol: string;
  operator: OperatorDeclaration;
  origin: "setup" | "activated";
}>;

export type AvailableConstant = Readonly<{
  symbol: string;
  operator: OperatorDeclaration;
  /** The library results that apply the constant (applying one activates it). */
  results: readonly Readonly<{ id: string; name: string }>[];
}>;

export type ActivatedConstant = Readonly<{
  symbol: string;
  sequence: number;
  commandId: string;
  edgeId: string;
  nodeId: string;
  resultId: string;
  /** The library result's name when the catalog still knows it. */
  resultName: string | null;
  transitionSequence: number;
  activatedAt: string;
}>;

export type SessionConstants = Readonly<{
  active: readonly ActiveConstant[];
  available: readonly AvailableConstant[];
  activated: readonly ActivatedConstant[];
}>;

/** Describe a session's constants from its setup operators, activation records and library. */
export function describeSessionConstants(
  input: Readonly<{
    setupOperators: readonly OperatorDeclaration[];
    activations: readonly ConstantActivation[];
    definitions: DefinitionCatalog;
  }>,
): SessionConstants {
  const { setupOperators, activations, definitions } = input;
  const activatedSymbols = new Set(activations.map(({ symbol }) => symbol));
  const effective = [...setupOperators, ...activations.map(({ declaration }) => declaration)];
  const wide = catalogOperators(effective, definitions);
  const results: readonly LibraryResult[] = definitions.catalog(wide).results;
  const nameOf = new Map<string, string>(results.map(({ id, name }) => [id, name]));
  return {
    active: effective.map((operator) => ({
      symbol: operator.symbol,
      operator,
      origin: activatedSymbols.has(operator.symbol) ? "activated" : "setup",
    })),
    available: availableConstants(effective, definitions).map((operator) => ({
      symbol: operator.symbol,
      operator,
      // Generated variants of a result are not listed beside it.
      results: results
        .filter(
          (result) =>
            result.provenance.kind !== "derived-variant" &&
            result.operators?.some(({ symbol }) => symbol === operator.symbol),
        )
        .map(({ id, name }) => ({ id, name })),
    })),
    activated: activations.map((activation) => ({
      symbol: activation.symbol,
      sequence: activation.sequence,
      commandId: activation.commandId,
      edgeId: activation.edgeId,
      nodeId: activation.nodeId,
      resultId: activation.resultId,
      resultName: nameOf.get(activation.resultId) ?? null,
      transitionSequence: activation.transitionSequence,
      activatedAt: activation.activatedAt,
    })),
  };
}

/**
 * The newly activated constants that a recorded `new-constants` top-up already covered, with the
 * call that did: a session-owned librarian call whose validated output (a proposal, a context
 * request or a refusal alike) was recorded. A call that failed in transport or was rejected
 * covers nothing, so it can be asked again under a new call ID.
 */
export async function coveredConstants(
  llmCalls: LlmCallStore,
  sessionId: string,
): Promise<ReadonlyMap<string, string> | undefined> {
  const listed = await listLlmCalls(llmCalls, { kind: "proof-session", id: sessionId });
  if (listed.status !== "found") return undefined;
  const covered = new Map<string, string>();
  for (const record of listed.records) {
    if (
      record.status !== "completed" ||
      record.role !== "librarian" ||
      record.evidence.status !== "validated"
    ) {
      continue;
    }
    const { envelope } = record.preparedCall;
    if (envelope.role !== "librarian" || envelope.context.kind !== "new-constants") continue;
    for (const { symbol } of envelope.context.newConstants) {
      if (!covered.has(symbol)) covered.set(symbol, record.id);
    }
  }
  return covered;
}

export type LoadedSessionConstants =
  | Readonly<{
      status: "loaded";
      session: ProofSession;
      setupOperators: readonly OperatorDeclaration[];
      activations: readonly ConstantActivation[];
      constants: SessionConstants;
    }>
  | Readonly<{
      status: "rejected" | "uncertain";
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>;

/** Read a session's constants against the library catalog the request is scoped to. */
export async function loadSessionConstants(
  store: ProofStore,
  sessionId: string,
  definitions: DefinitionCatalog,
): Promise<LoadedSessionConstants> {
  try {
    return await store.transaction(async (transaction) => {
      const loaded = await loadSession(
        transaction,
        sessionId as Parameters<typeof loadSession>[1],
        definitions,
      );
      if (!loaded.ok) return loaded.failure;
      return {
        status: "loaded" as const,
        session: loaded.session,
        setupOperators: loaded.setupOperators,
        activations: loaded.activations,
        constants: describeSessionConstants({
          setupOperators: loaded.setupOperators,
          activations: loaded.activations,
          definitions,
        }),
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The session's constants could not be read.");
  }
}
