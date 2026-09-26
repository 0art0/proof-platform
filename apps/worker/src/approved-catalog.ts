import {
  CORE_LOGIC_RESULTS,
  libraryPacksForOperators,
  type LibraryResult,
  type VariantFamily,
} from "@proof/library";
import { approvedKernelResults } from "@proof/moves";
import type { ProtocolEnvironment } from "@proof/protocol";

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
  const results = [...CORE_LOGIC_RESULTS, ...packs.flatMap((pack) => pack.results)];
  const adapted = approvedKernelResults(results, { operators });
  const catalog: ApprovedCatalog = Object.freeze({
    results: Object.freeze(results),
    variantFamilies: Object.freeze(packs.flatMap((pack) => pack.variantFamilies)),
    kernelResults: adapted.ok ? adapted.results : undefined,
  });
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
