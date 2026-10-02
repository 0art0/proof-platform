/**
 * Parameter-menu payloads (design plan §13, §17.4; refinement §11).
 *
 * A client never sends an expression for a move parameter. It names a menu item by its
 * content-derived ID, and the worker regenerates the menus from the snapshot and rejects any
 * ID that is not in them. The menus shown for a transition, and the IDs chosen from them, are
 * stored with the preview, command and edge, so history is read back rather than recomputed.
 */
import {
  CONSTRUCTION_REQUIREMENT_ROLES,
  constructionRequirementEvidenceSchema,
  plainMathJsonSchema,
  stableIdentifierSchema,
  statementIdSchema,
} from "@proof/mathjson-model";
import { z } from "zod";

/** `menu-item:` followed by a 16-hex-digit content hash (see `@proof/moves` materialization). */
export const menuItemIdSchema = z
  .string()
  .regex(/^menu-item:[0-9a-f]{16}$/, "Menu item IDs are content-derived menu identifiers.");
export type MenuItemId = z.infer<typeof menuItemIdSchema>;

/** A move parameter ID, e.g. `disjunctIndex`, `direction` or `instantiation/p`. */
export const menuParameterIdSchema = stableIdentifierSchema;

const MAX_MENU_CHOICES = 32;

/** Parameter ID → chosen menu item ID. Values are menu item IDs only, never expressions. */
export const menuChoicesSchema = z
  .record(menuParameterIdSchema, menuItemIdSchema)
  .refine(
    (choices) => Object.keys(choices).length <= MAX_MENU_CHOICES,
    `At most ${MAX_MENU_CHOICES} menu choices are accepted.`,
  );
export type MenuChoices = z.infer<typeof menuChoicesSchema>;

const statementTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conclusion") }).strict(),
  z.object({ kind: z.literal("hypothesis"), id: statementIdSchema }).strict(),
]);

const menuLabelSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("math"), expression: plainMathJsonSchema }).strict(),
]);

const rewriteSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hypothesis"), hypothesisId: statementIdSchema }).strict(),
  z
    .object({
      kind: z.literal("result"),
      resultId: stableIdentifierSchema,
      instantiation: z.record(z.string().min(1), plainMathJsonSchema),
    })
    .strict(),
]);

const menuValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("index"), index: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("term"), expression: plainMathJsonSchema }).strict(),
  z.object({ kind: z.literal("proposition"), expression: plainMathJsonSchema }).strict(),
  z.object({ kind: z.literal("direction"), direction: z.enum(["forward", "backward"]) }).strict(),
  z.object({ kind: z.literal("rewrite-source"), source: rewriteSourceSchema }).strict(),
  z.object({ kind: z.literal("result"), resultId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("assumption"), assumptionId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("attestation"), attestationId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("generated-ids"), ids: z.array(stableIdentifierSchema) }).strict(),
  z.object({ kind: z.literal("construction-task"), taskId: stableIdentifierSchema }).strict(),
  z
    .object({ kind: z.literal("construction-candidate"), candidateId: stableIdentifierSchema })
    .strict(),
  z
    .object({
      kind: z.literal("construction-requirement"),
      role: z.enum(CONSTRUCTION_REQUIREMENT_ROLES),
      expression: plainMathJsonSchema,
      evidence: constructionRequirementEvidenceSchema,
    })
    .strict(),
  z.object({ kind: z.literal("symbols"), symbols: z.array(z.string().min(1)) }).strict(),
]);

const menuItemOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("selection"), slotId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("declaration"), declarationId: stableIdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal("subterm-of"),
      statement: statementTargetSchema,
      path: z.array(z.number().int().nonnegative()),
    })
    .strict(),
  z.object({ kind: z.literal("conclusion") }).strict(),
  z.object({ kind: z.literal("hypothesis"), hypothesisId: statementIdSchema }).strict(),
  z.object({ kind: z.literal("assumption"), assumptionId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("result"), resultId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("attestation") }).strict(),
  z.object({ kind: z.literal("rule") }).strict(),
  z.object({ kind: z.literal("generated") }).strict(),
  z.object({ kind: z.literal("construction"), taskId: stableIdentifierSchema }).strict(),
]);

export const parameterMenuItemSchema = z
  .object({
    id: menuItemIdSchema,
    label: menuLabelSchema,
    value: menuValueSchema,
    origin: menuItemOriginSchema,
  })
  .strict();
export type ParameterMenuItemRecord = z.infer<typeof parameterMenuItemSchema>;

export const parameterMenuSchema = z
  .object({
    parameterId: menuParameterIdSchema,
    label: z.string().min(1),
    automatic: z.boolean(),
    items: z.array(parameterMenuItemSchema),
  })
  .strict()
  .superRefine((menu, context) => {
    const ids = menu.items.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Menu item IDs must be unique in a menu." });
    }
  });
export type ParameterMenuRecord = z.infer<typeof parameterMenuSchema>;

export const parameterMenusSchema = z.array(parameterMenuSchema).superRefine((menus, context) => {
  const ids = menus.map(({ parameterId }) => parameterId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Each parameter has at most one menu." });
  }
});

/**
 * The menus displayed for one materialized move and the item IDs chosen from them. Every
 * choice must name an item of the recorded menu for its parameter.
 */
export const moveMenuSelectionSchema = z
  .object({ menus: parameterMenusSchema, choices: menuChoicesSchema })
  .strict()
  .superRefine((selection, context) => {
    for (const [parameterId, itemId] of Object.entries(selection.choices)) {
      const menu = selection.menus.find((candidate) => candidate.parameterId === parameterId);
      if (menu === undefined || !menu.items.some(({ id }) => id === itemId)) {
        context.addIssue({
          code: "custom",
          message: `The choice for ${parameterId} is not an item of its recorded menu.`,
        });
      }
    }
  });
export type MoveMenuSelection = z.infer<typeof moveMenuSelectionSchema>;

/**
 * The response to a preview or apply request whose move still needs menu choices: the menus
 * for the current choices and the parameters still to choose. Nothing was recorded.
 */
export const moveRequiresInputResponseSchema = z
  .object({
    status: z.literal("requires-input"),
    suggestionSetId: stableIdentifierSchema,
    chosenSuggestionId: stableIdentifierSchema,
    menus: parameterMenusSchema,
    missingParameters: z.array(menuParameterIdSchema).min(1),
    diagnostics: z.tuple([
      z.object({ code: z.literal("requires-input"), message: z.string().min(1) }).strict(),
    ]),
  })
  .strict()
  .superRefine((response, context) => {
    const menuIds = new Set(response.menus.map(({ parameterId }) => parameterId));
    if (!response.missingParameters.every((parameterId) => menuIds.has(parameterId))) {
      context.addIssue({ code: "custom", message: "Every missing parameter needs its menu." });
    }
  });
export type MoveRequiresInputResponse = z.infer<typeof moveRequiresInputResponseSchema>;
