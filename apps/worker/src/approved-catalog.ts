import { CORE_LOGIC_RESULTS, type LibraryResult } from "@proof/library";
import { approvedKernelResults } from "@proof/moves";
import type { ProtocolEnvironment } from "@proof/protocol";

/**
 * The approved library results the worker retrieves from and applies. Retrieval and
 * materialization must share one catalog, so a displayed result suggestion always names a
 * result the kernel environment can instantiate.
 */
export const APPROVED_LIBRARY_RESULTS: readonly LibraryResult[] = CORE_LOGIC_RESULTS;

/** Adapt the approved catalog to kernel results in a session's operator environment. */
export function approvedResultEnvironment(
  operators: NonNullable<ProtocolEnvironment["operators"]>,
): NonNullable<ProtocolEnvironment["results"]> | undefined {
  const adapted = approvedKernelResults(APPROVED_LIBRARY_RESULTS, { operators });
  return adapted.ok ? adapted.results : undefined;
}
