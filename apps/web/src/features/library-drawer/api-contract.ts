import { isPlainMathJson, stableIdentifierSchema, type PlainMathJson } from "@proof/mathjson-model";
import { z } from "zod";

/**
 * The read-only library views the worker serves (design plan §17.1, roadmap N32). The web
 * boundary checks the shape it renders; the worker owns full artifact validation.
 */

const expressionSchema = z.custom<PlainMathJson>(isPlainMathJson, "Invalid MathJSON.");
const statementSchema = z.object({ expression: expressionSchema }).passthrough();

export const LIBRARY_LAYERS = [
  "global",
  "initial-problem",
  "proof-time-background",
  "derived",
  "move-discovery-draft",
] as const;
export type LibraryLayerName = (typeof LIBRARY_LAYERS)[number];

export const LIBRARY_KINDS = ["definition", "result", "technique", "move"] as const;

export const libraryProvenanceViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("curated"), source: z.string() }).passthrough(),
  z.object({ kind: z.literal("imported"), source: z.string() }).passthrough(),
  z.object({ kind: z.literal("generated"), role: z.string(), contextId: z.string() }).passthrough(),
  z
    .object({ kind: z.literal("derived"), sessionId: z.string(), proofNodeId: z.string() })
    .passthrough(),
  z
    .object({
      kind: z.literal("derived-variant"),
      sourceId: z.string(),
      transformation: z.string(),
    })
    .passthrough(),
]);

export const libraryApprovalViewSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }).passthrough(),
  z.object({ status: z.literal("rejected"), reason: z.string() }).passthrough(),
  z.object({ status: z.literal("approved"), reviewerId: z.string() }).passthrough(),
]);

const classificationSchema = z
  .object({ domains: z.array(z.string()), level: z.string() })
  .passthrough();

export const libraryArtifactViewSchema = z
  .object({
    id: stableIdentifierSchema,
    kind: z.enum(LIBRARY_KINDS),
    name: z.string(),
    description: z.string(),
    layer: z.enum(LIBRARY_LAYERS),
    renderings: z.object({ latex: z.string(), naturalLanguage: z.string() }).passthrough(),
    classification: classificationSchema,
    provenance: libraryProvenanceViewSchema,
    approval: libraryApprovalViewSchema,
    related: z.array(z.object({ kind: z.string(), id: z.string() }).passthrough()),
    priority: z.number(),
    parameters: z.array(z.object({ symbol: z.string() }).passthrough()).optional(),
    statement: statementSchema.optional(),
    premises: z.array(statementSchema).optional(),
    sideConditions: z
      .array(z.object({ id: z.string(), description: z.string() }).passthrough())
      .optional(),
    applicationDirections: z.array(z.enum(["forward", "backward"])).optional(),
    variantFamilyId: z.string().optional(),
    steps: z.array(z.string()).optional(),
  })
  .passthrough();
export type LibraryArtifactView = z.infer<typeof libraryArtifactViewSchema>;

export const libraryEntrySchema = z
  .object({
    source: z.enum(["approved-catalog", "stored-library"]),
    artifact: libraryArtifactViewSchema,
  })
  .strict();
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

export const variantFamilyViewSchema = z
  .object({ id: z.string(), name: z.string(), memberIds: z.array(z.string()) })
  .passthrough();
export type VariantFamilyView = z.infer<typeof variantFamilyViewSchema>;

export const sessionLibrarySchema = z
  .object({
    sessionId: stableIdentifierSchema,
    readOnly: z.boolean(),
    entries: z.array(libraryEntrySchema),
    variantFamilies: z.array(variantFamilyViewSchema),
  })
  .strict();
export type SessionLibrary = z.infer<typeof sessionLibrarySchema>;

export const libraryAdditionEventViewSchema = z
  .object({
    id: z.string(),
    sequence: z.number(),
    occurredAt: z.string(),
    layer: z.enum(LIBRARY_LAYERS),
    origin: z.object({ kind: z.string(), actorId: z.string().optional() }).passthrough(),
    classification: classificationSchema,
    admission: z.discriminatedUnion("decision", [
      z.object({ decision: z.literal("admitted"), diagnostics: z.array(z.unknown()) }),
      z.object({
        decision: z.literal("rejected"),
        diagnostics: z.array(z.object({ code: z.string(), message: z.string() }).passthrough()),
      }),
    ]),
    approval: libraryApprovalViewSchema,
    artifact: libraryArtifactViewSchema,
  })
  .passthrough();
export type LibraryAdditionEventView = z.infer<typeof libraryAdditionEventViewSchema>;

export const sessionLibraryEventsSchema = z
  .object({
    sessionId: stableIdentifierSchema,
    readOnly: z.boolean(),
    events: z.array(libraryAdditionEventViewSchema),
  })
  .strict();
export type SessionLibraryEvents = z.infer<typeof sessionLibraryEventsSchema>;
