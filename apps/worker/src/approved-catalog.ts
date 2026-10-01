import {
  CORE_LOGIC_RESULTS,
  libraryPacksForOperators,
  type LibraryResult,
  type VariantFamily,
} from "@proof/library";
import { createHash } from "node:crypto";
import { HAND_AUTHORED_MOVES, approvedKernelResults, type MoveDefinition } from "@proof/moves";
import type { AuthoredMoveTemplate } from "@proof/moves/authoring";
import type { DefinitionHash, ProtocolEnvironment } from "@proof/protocol";

type Operators = NonNullable<ProtocolEnvironment["operators"]>;

export type ApprovedCatalog = Readonly<{
  results: readonly LibraryResult[];
  variantFamilies: readonly VariantFamily[];
  /** The approved results adapted to kernel results, or undefined when adaptation fails. */
  kernelResults: NonNullable<ProtocolEnvironment["results"]> | undefined;
}>;

const CACHE_LIMIT = 64;
const cache = new Map<string, ApprovedCatalog>();

/**
 * The approved library results the worker retrieves from and applies in a session's operator
 * environment: the core logic pack and every starter pack whose operators the session declares
 * identically. Retrieval and materialization must share this one catalog, so a displayed result
 * suggestion always names a result the kernel environment can instantiate.
 */
export function approvedCatalog(operators: Operators): ApprovedCatalog {
  const key = JSON.stringify(operators);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const packs = libraryPacksForOperators(operators);
  const catalog = adaptApprovedCatalog(
    operators,
    [...CORE_LOGIC_RESULTS, ...packs.flatMap((pack) => pack.results)],
    packs.flatMap((pack) => pack.variantFamilies),
  );
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, catalog);
  return catalog;
}

/** Adapt the approved catalog to kernel results in a session's operator environment. */
export function approvedResultEnvironment(
  operators: Operators,
): NonNullable<ProtocolEnvironment["results"]> | undefined {
  return approvedCatalog(operators).kernelResults;
}

/** An approved multi-step macro: its template and the first-step projection retrieval indexes. */
export type MacroDefinition = Readonly<{
  /** The first step's contract under the macro's ID. Retrieval only; never applicable alone. */
  move: MoveDefinition;
  template: AuthoredMoveTemplate;
}>;

/**
 * The approved definitions a worker retrieves, previews and applies with. Production uses
 * `APPROVED_DEFINITIONS`; tests inject another catalog to change a definition between preview
 * and apply (refinement §12.2).
 */
export type DefinitionCatalog = Readonly<{
  moves: readonly MoveDefinition[];
  /**
   * Approved multi-step macros (N35). They are kept apart from `moves` on purpose: `moves` is
   * what the command path accepts as a single-edge move, while a macro is applied as a sequence of
   * ordinary commands. Retrieval indexes `moves` plus each macro's first-step projection.
   */
  macros?: readonly MacroDefinition[];
  catalog(operators: Operators): ApprovedCatalog;
}>;

export const APPROVED_DEFINITIONS: DefinitionCatalog = Object.freeze({
  moves: HAND_AUTHORED_MOVES,
  catalog: approvedCatalog,
});

/** Adapt a definition catalog to an approved catalog with kernel results. */
export function adaptApprovedCatalog(
  operators: Operators,
  results: readonly LibraryResult[],
  variantFamilies: readonly VariantFamily[] = [],
): ApprovedCatalog {
  const adapted = approvedKernelResults(results, { operators });
  return Object.freeze({
    results: Object.freeze([...results]),
    variantFamilies: Object.freeze([...variantFamilies]),
    kernelResults: adapted.ok ? adapted.results : undefined,
  });
}

/** `sha256:` hex digest of a definition's canonical JSON (object keys sorted, no whitespace). */
export function definitionHash(definition: unknown): DefinitionHash {
  return `sha256:${createHash("sha256").update(canonicalJson(definition)).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
