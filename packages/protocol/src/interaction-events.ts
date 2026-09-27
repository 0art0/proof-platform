/**
 * Interaction events and definition references (refinement §12.1–§12.2).
 *
 * Suggestions, selections, previews and focus changes happen without a proof-state transition.
 * They are recorded as an ordered, node-anchored log: the worker assigns each event a per-session
 * monotonic sequence number, and a client-chosen event ID makes recording idempotent.
 *
 * A preview records content hashes of the move and library definitions it was built from, so an
 * apply can detect that the approved definitions changed and regenerate the preview.
 */
import {
  proofStateIdSchema,
  stableIdentifierSchema,
  statementIdSchema,
} from "@proof/mathjson-model";
import { z } from "zod";
import { menuChoicesSchema, menuParameterIdSchema } from "./parameter-menus";

// Local copies of the branded identifiers in `index.ts`: the brands are structural, so values
// parsed here are interchangeable with those schemas' outputs without an import cycle.
const actorIdSchema = stableIdentifierSchema.brand("ActorId");
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");
const suggestionSetIdSchema = stableIdentifierSchema.brand("SuggestionSetId");
const suggestionIdSchema = stableIdentifierSchema.brand("SuggestionId");
const movePreviewIdSchema = stableIdentifierSchema.brand("MovePreviewId");

export const interactionEventIdSchema = stableIdentifierSchema.brand("InteractionEventId");
export type InteractionEventId = z.infer<typeof interactionEventIdSchema>;

/** `sha256:` followed by the hex digest of a definition's canonical JSON. */
export const definitionHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Definition hashes are sha256 content hashes.");
export type DefinitionHash = z.infer<typeof definitionHashSchema>;

export const definitionKindSchema = z.enum(["move", "library-result"]);
export type DefinitionKind = z.infer<typeof definitionKindSchema>;

export const definitionReferenceSchema = z
  .object({ kind: definitionKindSchema, id: stableIdentifierSchema, hash: definitionHashSchema })
  .strict();
export type DefinitionReference = z.infer<typeof definitionReferenceSchema>;

function definitionKey(reference: Readonly<{ kind: string; id: string }>): string {
  return `${reference.kind}\u0000${reference.id}`;
}

/** The approved definitions a preview used, unique and ordered by kind then ID. */
export const definitionReferencesSchema = z
  .array(definitionReferenceSchema)
  .min(1)
  .max(8)
  .superRefine((references, context) => {
    const keys = references.map(definitionKey);
    const sorted = [...keys].sort();
    if (new Set(keys).size !== keys.length || keys.some((key, index) => key !== sorted[index])) {
      context.addIssue({
        code: "custom",
        message: "Definition references must be unique and ordered by kind and ID.",
      });
    }
  });

/** One definition whose content differs between a stale preview and its regeneration. */
export const definitionChangeSchema = z
  .object({
    kind: definitionKindSchema,
    id: stableIdentifierSchema,
    /** Absent when the regenerated preview uses a definition the stale one did not. */
    staleHash: definitionHashSchema.optional(),
    /** Absent when the regenerated preview no longer uses the definition. */
    currentHash: definitionHashSchema.optional(),
  })
  .strict()
  .refine(
    ({ staleHash, currentHash }) => staleHash !== currentHash,
    "A definition change must change the hash.",
  );
export type DefinitionChange = z.infer<typeof definitionChangeSchema>;

/** The definitions whose hashes differ between two previews, ordered by kind then ID. */
export function definitionChanges(
  stale: readonly DefinitionReference[],
  current: readonly DefinitionReference[],
): DefinitionChange[] {
  const staleByKey = new Map(stale.map((reference) => [definitionKey(reference), reference]));
  const currentByKey = new Map(current.map((reference) => [definitionKey(reference), reference]));
  return [...new Set([...staleByKey.keys(), ...currentByKey.keys()])]
    .sort()
    .flatMap((key): DefinitionChange[] => {
      const before = staleByKey.get(key);
      const after = currentByKey.get(key);
      const reference = before ?? after;
      if (reference === undefined || before?.hash === after?.hash) return [];
      return [
        {
          kind: reference.kind,
          id: reference.id,
          ...(before === undefined ? {} : { staleHash: before.hash }),
          ...(after === undefined ? {} : { currentHash: after.hash }),
        },
      ];
    });
}

const statementAnchorSchema = z
  .object({
    stateId: proofStateIdSchema,
    target: z.object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema }).strict(),
    statement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("conclusion") }).strict(),
      z.object({ kind: z.literal("hypothesis"), id: statementIdSchema }).strict(),
    ]),
  })
  .strict();
const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);

/** A snapshot-anchored selection as the client reported it (no resolved fragment). */
export const interactionSelectionSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("exact"), anchor: statementAnchorSchema, path: operandPathSchema })
    .strict(),
  z
    .object({
      kind: z.literal("associative"),
      anchor: statementAnchorSchema,
      containerPath: operandPathSchema,
      startOperand: z.number().int().nonnegative(),
      endOperand: z.number().int().nonnegative(),
      displayRange: z
        .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
        .refine(([start, end]) => end > start, "A display range must be nonempty and ordered.")
        .optional(),
    })
    .strict()
    .refine(
      ({ startOperand, endOperand }) => endOperand - startOperand >= 2,
      "An associative range must contain at least two operands.",
    ),
]);
export type InteractionSelection = z.infer<typeof interactionSelectionSchema>;

const focusTargetSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
  .strict();

/** Kind-specific fields of the events a client may record. */
const clientPayloadShapes = {
  "selection-changed": { selections: z.array(interactionSelectionSchema).max(16) },
  "suggestions-requested": { suggestionSetId: suggestionSetIdSchema },
  "suggestions-displayed": {
    suggestionSetId: suggestionSetIdSchema,
    /** The suggestion IDs actually shown, in display order. */
    suggestionIds: z.array(suggestionIdSchema).max(64),
  },
  "preview-requested": {
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
    commandId: commandIdSchema,
    menuChoices: menuChoicesSchema.optional(),
  },
  "preview-rejected": {
    previewId: movePreviewIdSchema,
    reason: z.enum(["dismissed", "superseded", "selection-changed"]),
  },
  "menu-expanded": {
    suggestionSetId: suggestionSetIdSchema,
    suggestionId: suggestionIdSchema,
    /** The parameter menu expanded; absent for the suggestion's missing-input summary. */
    parameterId: menuParameterIdSchema.optional(),
  },
  "focus-changed": { target: focusTargetSchema },
  "objective-changed": { objective: z.string().min(1).max(500) },
  "interaction-ended-without-action": {
    suggestionSetId: suggestionSetIdSchema.optional(),
    reason: z.enum(["selection-cleared", "dismissed", "navigated"]),
  },
} as const;

/** Recorded only by the worker, inside the transaction that regenerates a stale preview. */
const regeneratedPayloadShape = {
  commandId: commandIdSchema,
  stalePreviewId: movePreviewIdSchema,
  previewId: movePreviewIdSchema,
  operationChanged: z.boolean(),
  changedDefinitions: z.array(definitionChangeSchema).max(16),
} as const;

export const CLIENT_INTERACTION_EVENT_KINDS = Object.freeze(
  Object.keys(clientPayloadShapes) as (keyof typeof clientPayloadShapes)[],
);
export type ClientInteractionEventKind = keyof typeof clientPayloadShapes;
export type InteractionEventKind = ClientInteractionEventKind | "preview-regenerated";

const requestBaseShape = { id: interactionEventIdSchema, nodeId: proofNodeIdSchema } as const;

function requestVariant<Kind extends ClientInteractionEventKind>(kind: Kind) {
  return z
    .object({ ...requestBaseShape, kind: z.literal(kind), ...clientPayloadShapes[kind] })
    .strict();
}

/** What a client sends: the event ID, anchor node, kind and payload. The worker adds the rest. */
export const recordInteractionEventRequestSchema = z.discriminatedUnion("kind", [
  requestVariant("selection-changed"),
  requestVariant("suggestions-requested"),
  requestVariant("suggestions-displayed"),
  requestVariant("preview-requested"),
  requestVariant("preview-rejected"),
  requestVariant("menu-expanded"),
  requestVariant("focus-changed"),
  requestVariant("objective-changed"),
  requestVariant("interaction-ended-without-action"),
]);
export type RecordInteractionEventRequest = z.infer<typeof recordInteractionEventRequestSchema>;

const recordedBaseShape = {
  ...requestBaseShape,
  /** Per-session, strictly increasing, assigned by the worker under the session lock. */
  sequence: z.number().int().min(1),
  /** The anchor node's proof-state snapshot. */
  stateId: proofStateIdSchema,
  actor: z.object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) }).strict(),
  recordedAt: z.string().datetime({ offset: true }),
} as const;

function recordedVariant<Kind extends ClientInteractionEventKind>(kind: Kind) {
  return z
    .object({ ...recordedBaseShape, kind: z.literal(kind), ...clientPayloadShapes[kind] })
    .strict();
}

export const interactionEventSchema = z
  .discriminatedUnion("kind", [
    recordedVariant("selection-changed"),
    recordedVariant("suggestions-requested"),
    recordedVariant("suggestions-displayed"),
    recordedVariant("preview-requested"),
    recordedVariant("preview-rejected"),
    recordedVariant("menu-expanded"),
    recordedVariant("focus-changed"),
    recordedVariant("objective-changed"),
    recordedVariant("interaction-ended-without-action"),
    z
      .object({
        ...recordedBaseShape,
        kind: z.literal("preview-regenerated"),
        ...regeneratedPayloadShape,
      })
      .strict(),
  ])
  .superRefine((event, context) => {
    if (event.kind === "selection-changed") {
      if (event.selections.some(({ anchor }) => anchor.stateId !== event.stateId)) {
        context.addIssue({
          code: "custom",
          message: "Every selection must be anchored to the event's proof-state snapshot.",
        });
      }
    }
    if (event.kind === "suggestions-displayed") {
      if (new Set(event.suggestionIds).size !== event.suggestionIds.length) {
        context.addIssue({ code: "custom", message: "Displayed suggestion IDs must be unique." });
      }
    }
    if (event.kind === "preview-regenerated" && event.stalePreviewId === event.previewId) {
      context.addIssue({
        code: "custom",
        message: "A regenerated preview must have a new preview ID.",
      });
    }
  });
export type InteractionEvent = z.infer<typeof interactionEventSchema>;

const WORKER_ASSIGNED_FIELDS = ["sequence", "stateId", "actor", "recordedAt"] as const;

/** The client-owned fields of a recorded event, for idempotent replay comparison. */
export function interactionEventRequestFields(
  event: InteractionEvent,
): Readonly<Record<string, unknown>> {
  // The worker-assigned fields are excluded; everything else was supplied by the client.
  const fields: Record<string, unknown> = { ...event };
  for (const key of WORKER_ASSIGNED_FIELDS) delete fields[key];
  return fields;
}

export const interactionEventListSchema = z
  .array(interactionEventSchema)
  .superRefine((events, context) => {
    for (let index = 1; index < events.length; index += 1) {
      if ((events[index]?.sequence ?? 0) <= (events[index - 1]?.sequence ?? 0)) {
        context.addIssue({
          code: "custom",
          message: "Interaction events must be listed in strictly increasing sequence order.",
        });
        return;
      }
    }
  });

/** A stale preview was regenerated instead of applied; the client must confirm the new one. */
export const previewRegeneratedResponseSchema = z
  .object({
    status: z.literal("preview-regenerated"),
    stalePreviewId: movePreviewIdSchema,
    /** Validated by the caller with `createMovePreviewSchema({ operators })`. */
    preview: z.unknown(),
    diagnostics: z.tuple([
      z.object({ code: z.literal("preview-regenerated"), message: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type PreviewRegeneratedResponse = z.infer<typeof previewRegeneratedResponseSchema>;
