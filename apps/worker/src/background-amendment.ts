/**
 * A person's edits to a background proposal, recorded with their approval of it.
 *
 * The approval of a background names the stored proposal exactly as the model returned it; an
 * amendment beside it is the background as the person approved it. The edits are deliberately
 * narrow, so that everything built from the proposal stays valid and follows them
 * deterministically:
 *
 * - the profile (level, summary, assumptions, domains, maximum level) may be rewritten;
 * - a constant may be removed, never added;
 * - a kept constant keeps its ID, symbol and signature: only its presentation (display name,
 *   LaTeX template and trigger, natural-language templates) may change, and its LaTeX must still
 *   render exactly its operands and be typeset by MathLive.
 *
 * Because symbols and signatures never change, a library built from the proposal still means the
 * same thing: its results are re-rendered with the edited notation, and those that apply a removed
 * constant no longer pass the setup's gate.
 */
import {
  backgroundProposalSchema,
  isUsableOperatorTemplate,
  type BackgroundProposal,
} from "@proof/llm";
import { jsonValueEquals } from "@proof/mathjson-model";
import { backgroundProfileSchema, operatorDeclarationSchema } from "@proof/protocol";
import { z } from "zod";

/** What a client sends: the edited profile and the kept constants' edited declarations. */
export const backgroundAmendmentRequestSchema = z
  .object({
    background: backgroundProfileSchema,
    constants: z.array(operatorDeclarationSchema).max(32),
  })
  .strict();
export type BackgroundAmendmentRequest = z.infer<typeof backgroundAmendmentRequestSchema>;

export type AmendmentResult =
  | Readonly<{ ok: true; amended: BackgroundProposal }>
  | Readonly<{ ok: false; message: string }>;

/**
 * The amended proposal, or why the edits are not allowed. Constants keep the proposal's order and
 * rationales. Pure.
 */
export function amendBackgroundProposal(
  proposal: BackgroundProposal,
  input: unknown,
): AmendmentResult {
  const request = backgroundAmendmentRequestSchema.safeParse(input);
  if (!request.success) {
    const first = request.error.issues[0];
    return {
      ok: false,
      message: `The background edits are not valid${first === undefined ? "" : `: ${first.message}`}`,
    };
  }
  const issue = amendmentIssue(proposal, request.data.constants);
  if (issue !== undefined) return { ok: false, message: issue };
  const edited = new Map(request.data.constants.map((operator) => [operator.id, operator]));
  const amended = backgroundProposalSchema.safeParse({
    kind: "background-proposal",
    background: request.data.background,
    constants: proposal.constants.flatMap(({ operator, rationale }) => {
      const kept = edited.get(operator.id);
      return kept === undefined ? [] : [{ operator: kept, rationale }];
    }),
  });
  if (!amended.success) {
    const first = amended.error.issues[0];
    return {
      ok: false,
      message: `The edited background breaks a rule: ${first?.message ?? "it is invalid"}`,
    };
  }
  return { ok: true, amended: amended.data };
}

/**
 * Why an amendment is not one of `proposal`, or undefined when it is. Used both when an amendment
 * is requested and whenever a stored one is read back.
 */
export function amendmentIssue(
  proposal: BackgroundProposal,
  constants: readonly z.infer<typeof operatorDeclarationSchema>[],
): string | undefined {
  const seen = new Set<string>();
  for (const operator of constants) {
    if (seen.has(operator.id)) return `The constant ${operator.symbol} is edited twice.`;
    seen.add(operator.id);
    const original = proposal.constants.find(({ operator: { id } }) => id === operator.id);
    if (original === undefined) {
      return `The constant ${operator.symbol} was not proposed; constants can be removed, not added.`;
    }
    if (original.operator.symbol !== operator.symbol) {
      return `The constant ${original.operator.symbol} cannot be renamed; edit its display name or notation instead.`;
    }
    if (!jsonValueEquals(original.operator.signature, operator.signature)) {
      return `The signature of ${operator.symbol} cannot change.`;
    }
    const template = operator.presentation?.latex?.template;
    if (
      template !== undefined &&
      !isUsableOperatorTemplate(template, operator.signature.parameters.length)
    ) {
      return `The LaTeX of ${operator.symbol} must be valid and show each of its ${operator.signature.parameters.length} operands.`;
    }
  }
  return undefined;
}
