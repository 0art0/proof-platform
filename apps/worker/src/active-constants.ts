/**
 * Active constants of a session (`docs/ai-agents-architecture.md` section 2, top-ups).
 *
 * The constants of a session are its operator declarations. Those from the accepted background and
 * the starter packs are active from the start. An operator that joined the session only because an
 * approved initial-library result applies it (`metadata.libraryConstants`, recorded at approval) is
 * declared but dormant: no proof step has used it, and the library has no results written about
 * it. It becomes active when a committed step first applies a library result that uses it.
 *
 * That is not a new record. The committed step already is the append-only record: its edge names the
 * library result it applied (`apply-result-*` operations, or a rewrite whose source is a result),
 * and the edge carries the session's transition sequence. So activation is a deterministic read
 * of the retained history, in sequence order: the first edge whose result mentions a dormant
 * constant activates it, and later edges activate nothing new. Backtracking does not undo it (the
 * discovery tree keeps every edge); deleting the step that activated a constant does, as it
 * removes the step's record.
 *
 * The request for a `new-constants` top-up is a separate HTTP call made after the step committed.
 * Nothing here calls a model, and nothing runs inside a proof transaction.
 */
import type { LibraryResult } from "@proof/library";
import type { OperatorDeclaration, PlainMathJson } from "@proof/mathjson-model";
import type { ProofEdge } from "@proof/protocol";
import { listLlmCalls, type LlmCallStore } from "./llm-call-repository";
import { loadProofHistory, type ProofSession, type ProofStore } from "./proof-repository";

/** A dormant constant that a committed step made active, and the step that did. */
export type ConstantActivation = Readonly<{
  symbol: string;
  edgeId: string;
  /** The node the activating step created. */
  nodeId: string;
  resultId: string;
  /** The step's transition sequence, when it was stored with one. */
  sequence: number | undefined;
}>;

export type SessionConstants = Readonly<{
  /** The operators in play: everything declared except the dormant ones. */
  active: readonly OperatorDeclaration[];
  /** Declared by the approved initial library only, and not yet applied by any step. */
  dormant: readonly OperatorDeclaration[];
  /** Constants activated by committed steps, in the order they were activated. */
  activations: readonly ConstantActivation[];
}>;

/** The symbols of the session's operators that only the approved initial library introduced. */
export function libraryConstantSymbols(session: Pick<ProofSession, "metadata" | "operators">) {
  const declared = new Set(session.operators.map(({ symbol }) => symbol));
  return (session.metadata?.libraryConstants ?? []).filter((symbol) => declared.has(symbol));
}

/** The library results a kernel operation applies (none for a structural step). */
export function appliedResultIds(operation: ProofEdge["operation"]): readonly string[] {
  switch (operation.kind) {
    case "apply-result-backward":
    case "apply-result-forward":
      return [operation.resultId];
    case "rewrite-with-equivalence":
    case "rewrite-with-implication":
      return operation.source.kind === "result" ? [operation.source.resultId] : [];
    default:
      return [];
  }
}

/** Every symbol an expression mentions, operator heads included. */
export function mentionedSymbols(expression: PlainMathJson, symbols = new Set<string>()) {
  if (typeof expression === "string") {
    symbols.add(expression);
  } else if (Array.isArray(expression)) {
    expression.forEach((child) => mentionedSymbols(child as PlainMathJson, symbols));
  } else if (typeof expression === "object" && expression !== null) {
    if ("sym" in expression && typeof expression.sym === "string") symbols.add(expression.sym);
    if ("fn" in expression) {
      (expression.fn as readonly PlainMathJson[]).forEach((child) =>
        mentionedSymbols(child, symbols),
      );
    }
  }
  return symbols;
}

/** The symbols a library result's statement, premises and patterns mention. */
export function resultSymbols(result: LibraryResult): ReadonlySet<string> {
  const symbols = new Set<string>();
  mentionedSymbols(result.statement.expression, symbols);
  result.premises.forEach(({ expression }) => mentionedSymbols(expression, symbols));
  result.patterns.forEach(({ expression }) => mentionedSymbols(expression, symbols));
  return symbols;
}

/**
 * Split a session's operators into active and dormant, and find the steps that activated the
 * dormant ones. `edges` may be in any order; they are read by transition sequence.
 */
export function deriveSessionConstants(
  input: Readonly<{
    operators: readonly OperatorDeclaration[];
    /** `metadata.libraryConstants` of the session. */
    libraryConstants: readonly string[];
    edges: readonly ProofEdge[];
    results: readonly LibraryResult[];
  }>,
): SessionConstants {
  const dormantSymbols = new Set(input.libraryConstants);
  const symbolsOf = new Map<string, ReadonlySet<string>>(
    input.results.map((result) => [result.id as string, resultSymbols(result)]),
  );
  const ordered = input.edges
    .map((edge, position) => ({ edge, position }))
    .sort(
      (left, right) =>
        (left.edge.sequence ?? Number.MAX_SAFE_INTEGER) -
          (right.edge.sequence ?? Number.MAX_SAFE_INTEGER) || left.position - right.position,
    );

  const activations: ConstantActivation[] = [];
  const activated = new Set<string>();
  for (const { edge } of ordered) {
    for (const resultId of appliedResultIds(edge.operation)) {
      const symbols = symbolsOf.get(resultId);
      if (symbols === undefined) continue;
      for (const symbol of [...symbols].sort()) {
        if (!dormantSymbols.has(symbol) || activated.has(symbol)) continue;
        activated.add(symbol);
        activations.push({
          symbol,
          edgeId: edge.id,
          nodeId: edge.childNodeId,
          resultId,
          sequence: edge.sequence,
        });
      }
    }
  }
  const isDormant = ({ symbol }: OperatorDeclaration) =>
    dormantSymbols.has(symbol) && !activated.has(symbol);
  return {
    active: input.operators.filter((operator) => !isDormant(operator)),
    dormant: input.operators.filter(isDormant),
    activations,
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
      constants: SessionConstants;
    }>
  | Readonly<{
      status: "rejected" | "uncertain";
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>;

/** Read a session's retained history and derive its constants against the given results. */
export async function loadSessionConstants(
  store: ProofStore,
  sessionId: string,
  results: readonly LibraryResult[],
): Promise<LoadedSessionConstants> {
  const history = await loadProofHistory(store, sessionId);
  if (history.status !== "loaded") return history;
  const { session } = history;
  return {
    status: "loaded",
    session,
    constants: deriveSessionConstants({
      operators: session.operators,
      libraryConstants: libraryConstantSymbols(session),
      edges: history.edges.map(({ edge }) => edge),
      results,
    }),
  };
}
