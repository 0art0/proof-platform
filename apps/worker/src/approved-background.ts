/**
 * The constants of an approved background (`docs/ai-agents-architecture.md` sections 1 and 3).
 *
 * A user accepts a background proposal by recording an approval decision on the stored proposer
 * call. Everything downstream that uses the accepted constants (the formalizer, the setup check
 * and the session approval) names that decision and lets the worker resolve the constants from
 * storage; a client never supplies operator declarations of its own.
 */
import { starterLibraryPacks, type LibraryPack } from "@proof/library";
import { stableIdentifierSchema, type OperatorDeclaration } from "@proof/protocol";
import { z } from "zod";
import {
  readApprovedBackground,
  type ApprovedBackground,
  type LlmCallStore,
} from "./llm-call-repository";

/** Names an approved background decision of the request's own construction (formalizer). */
export const approvedBackgroundReferenceSchema = z
  .object({ decisionId: stableIdentifierSchema })
  .strict();

/** Names an approved background decision of a construction (setup check and session approval). */
export const constructionApprovedBackgroundSchema = z
  .object({ constructionId: stableIdentifierSchema, decisionId: stableIdentifierSchema })
  .strict();

export type RegistryResolution = Readonly<{
  /** The constants as the session uses them: registry references replaced by the registry's own. */
  constants: readonly OperatorDeclaration[];
  /** Human-readable clashes with the registry; empty when the constants may be used. */
  conflicts: readonly string[];
}>;

/**
 * Check proposed constants against the global operator registry (the starter packs' operators).
 *
 * - A constant with a registry operator's symbol and the same signature is a *reference* to that
 *   operator: the registry's declaration (its presentation and parse trigger) is used instead of
 *   the proposed one, so a pack and the background never declare one symbol two ways.
 * - The same symbol with another signature, or another symbol that reuses a registry operator's ID
 *   or LaTeX parse trigger, is a clash.
 *
 * Reserved built-in symbols cannot reach this point: no declaration can carry one.
 */
export function resolveAgainstRegistry(
  constants: readonly OperatorDeclaration[],
  packs: readonly LibraryPack[] = starterLibraryPacks(),
): RegistryResolution {
  const registry = packs.flatMap((pack) => pack.operators.map((operator) => ({ pack, operator })));
  const conflicts = new Set<string>();
  const resolved = constants.map((constant) => {
    const trigger = constant.presentation?.latex?.parse?.trigger;
    const same = registry.find(({ operator }) => operator.symbol === constant.symbol);
    if (same !== undefined) {
      if (canonicalJson(same.operator.signature) === canonicalJson(constant.signature)) {
        return same.operator;
      }
      conflicts.add(
        `${constant.symbol} is already an operator of the pack ${same.pack.id} with a different signature.`,
      );
      return constant;
    }
    const idClash = registry.find(({ operator }) => operator.id === constant.id);
    if (idClash !== undefined) {
      conflicts.add(
        `The ID ${constant.id} of ${constant.symbol} is already used by ${idClash.operator.symbol} of the pack ${idClash.pack.id}.`,
      );
    }
    const triggerClash =
      trigger === undefined
        ? undefined
        : registry.find(({ operator }) => operator.presentation?.latex?.parse?.trigger === trigger);
    if (triggerClash !== undefined) {
      conflicts.add(
        `The LaTeX trigger ${trigger} of ${constant.symbol} is already used by ${triggerClash.operator.symbol} of the pack ${triggerClash.pack.id}.`,
      );
    }
    return constant;
  });
  // Two proposed constants may resolve to the same registry operator only through one symbol, and
  // symbols are unique in a proposal, so no further deduplication is needed.
  return { constants: resolved, conflicts: [...conflicts] };
}

export type LoadedApprovedConstants =
  | Readonly<{
      ok: true;
      constants: readonly OperatorDeclaration[];
      approved: ApprovedBackground;
    }>
  | Readonly<{
      ok: false;
      status: 400 | 404 | 409 | 503;
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>;

/** Read the constants of an approved background decision from storage. */
export async function loadApprovedConstants(
  llmCalls: LlmCallStore | undefined,
  constructionId: string,
  decisionId: string,
): Promise<LoadedApprovedConstants> {
  if (llmCalls === undefined) {
    return {
      ok: false,
      status: 503,
      diagnostics: [{ code: "ai-disabled", message: "LLM evidence storage is unavailable." }],
    };
  }
  const read = await readApprovedBackground(
    llmCalls,
    { kind: "construction", id: constructionId },
    decisionId,
  );
  if (read.status === "found") {
    const resolution = resolveAgainstRegistry(
      read.approved.proposal.constants.map(({ operator }) => operator),
    );
    if (resolution.conflicts.length > 0) {
      return {
        ok: false,
        status: 409,
        diagnostics: [
          {
            code: "approved-constant-conflict",
            message: resolution.conflicts.join(" "),
          },
        ],
      };
    }
    return { ok: true, constants: resolution.constants, approved: read.approved };
  }
  const [diagnostic] = read.diagnostics;
  const status =
    read.status === "uncertain"
      ? 503
      : diagnostic.code === "decision-not-found"
        ? 404
        : diagnostic.code === "decision-not-approved"
          ? 409
          : 400;
  return { ok: false, status, diagnostics: [diagnostic] };
}

/** JSON with sorted object keys, so structurally equal values compare equal. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
