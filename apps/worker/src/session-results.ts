/**
 * The results a session adds to its own retrieval and application catalog (design plan §12.4:
 * "a result added during a session becomes available from that time onward").
 *
 * The approved catalog (`approved-catalog.ts`) holds the core logic pack and the starter packs whose
 * operators the session declares. Results a session records itself join it here, so that one
 * catalog serves retrieval, materialization, apply and the move executor's context:
 *
 * - admitted results of the `initial-problem` layer (the approved initial library, with its
 *   generated variants) and of the `proof-time-background` layer (top-ups and other proof-time
 *   additions);
 * - approved conditional lemmas of the `derived` layer (N44, `conditional-lemmas.ts`).
 *
 * A result that the kernel cannot instantiate in the operators it is asked about is not offered
 * (it never crashes the session), and a catalog that cannot be adapted as a whole falls back to
 * the base catalog. A result that needs library constants (`LibraryResult.operators`) is offered
 * only for operators that declare them; the catalog lists those constants as `libraryConstants`
 * so that retrieval can ask about the effective operators extended with them. Stored suggestion
 * sets are never rewritten: only a suggestion request made after a result was added sees it.
 */
import {
  variantFamilySchema,
  type LibraryArtifact,
  type LibraryResult,
  type VariantFamily,
} from "@proof/library";
import { approvedKernelResults } from "@proof/moves";
import {
  adaptApprovedCatalog,
  type ApprovedCatalog,
  type DefinitionCatalog,
} from "./approved-catalog";
import { extendOperators, libraryConstantsOf } from "./session-constants";

/** Layers whose admitted results are part of a session's catalog (besides approved lemmas). */
export const SESSION_RESULT_LAYERS = ["initial-problem", "proof-time-background"] as const;

/**
 * The approved results among a session's stored library artifacts that its `initial-problem` and
 * `proof-time-background` layers hold, in the order they were listed. The repository admits
 * only approved artifacts to these layers; the check here keeps the catalog independent of that.
 */
export function sessionLibraryResults(
  artifacts: readonly LibraryArtifact[],
): readonly LibraryResult[] {
  return artifacts.filter(
    (artifact): artifact is LibraryResult =>
      artifact.kind === "result" &&
      (SESSION_RESULT_LAYERS as readonly string[]).includes(artifact.layer) &&
      artifact.approval.status === "approved",
  );
}

/**
 * A definition catalog whose approved results also include `results`. A result is left out when
 * it repeats an ID of the base catalog, or when the kernel cannot instantiate it in the
 * session's operators (for example an operator the session does not declare). Variant families
 * of the added results are added with them; retrieval requires every family to have at least
 * two members in the catalog, so a result whose family does not is catalogued without it.
 */
export function withSessionResults(
  base: DefinitionCatalog,
  results: readonly LibraryResult[],
): DefinitionCatalog {
  if (results.length === 0) return base;
  const cache = new Map<string, ApprovedCatalog>();
  const libraryConstants = extendOperators(
    base.libraryConstants ?? [],
    libraryConstantsOf(results),
  );
  return Object.freeze({
    ...base,
    ...(libraryConstants.length === 0 ? {} : { libraryConstants }),
    catalog(operators: Parameters<DefinitionCatalog["catalog"]>[0]) {
      const key = JSON.stringify(operators);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const approved = base.catalog(operators);
      const taken = new Set(approved.results.map(({ id }) => id));
      const usable = results.filter((result) => {
        if (taken.has(result.id) || result.approval.status !== "approved") return false;
        taken.add(result.id);
        return approvedKernelResults([result], { operators }).ok;
      });
      let catalog = approved;
      if (usable.length > 0) {
        const { members, families } = withFamilies(usable, approved.variantFamilies);
        const adapted = adaptApprovedCatalog(
          operators,
          [...approved.results, ...members],
          [...approved.variantFamilies, ...families],
        );
        // The session's own results never make the catalog unusable.
        if (adapted.kernelResults !== undefined) catalog = adapted;
      }
      cache.set(key, catalog);
      return catalog;
    },
  });
}

function withFamilies(
  results: readonly LibraryResult[],
  baseFamilies: readonly VariantFamily[],
): Readonly<{ members: readonly LibraryResult[]; families: readonly VariantFamily[] }> {
  const taken = new Set<string>(baseFamilies.map(({ id }) => id));
  const grouped = new Map<string, LibraryResult[]>();
  for (const result of results) {
    if (result.variantFamilyId === undefined) continue;
    grouped.set(result.variantFamilyId, [...(grouped.get(result.variantFamilyId) ?? []), result]);
  }
  const families: VariantFamily[] = [];
  for (const [id, members] of grouped) {
    if (taken.has(id)) continue;
    const source = members.find(({ provenance }) => provenance.kind !== "derived-variant");
    const parsed = variantFamilySchema.safeParse({
      id,
      name: `${(source ?? members[0])?.name ?? id} variants`,
      memberIds: members.map((member) => member.id),
    });
    if (parsed.success) families.push(parsed.data);
  }
  const kept = new Set(families.map(({ id }) => id as string));
  return {
    members: results.map((result) =>
      result.variantFamilyId === undefined || kept.has(result.variantFamilyId)
        ? result
        : withoutFamily(result),
    ),
    families,
  };
}

function withoutFamily(result: LibraryResult): LibraryResult {
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "variantFamilyId"),
  ) as LibraryResult;
}
