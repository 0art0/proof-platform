/**
 * Manual problem and session creation (design plan §4.1, §4.4 without the formalizer; roadmap
 * N26).
 *
 * A problem draft is plain client data until it is approved: the problem statement, the
 * reader's background profile, domain and notation preferences, the active library layers and
 * packs, and an initial proof state entered by hand. Declarations choose their sort from a fixed
 * menu; hypotheses and goals are LaTeX (parsed through the Compute Engine by the worker) or plain
 * MathJSON. Validation turns a draft into a review: the exact root node, operator environment and
 * session metadata that approval would store, plus a digest of them. Approval sends the draft
 * back with that digest; the worker re-validates, refuses a digest that no longer matches, and
 * only then creates the session and its root node in one transaction. This is the only place
 * `setup` payloads enter a session (see `command-protocol.ts`).
 */
import {
  plainMathJsonSchema,
  sortSchema,
  stableIdentifierSchema,
  type Sort,
} from "@proof/mathjson-model";
import { LIBRARY_PACK_IDS, backgroundProfileSchema, libraryLayerSchema } from "@proof/library";
import { z } from "zod";
import { proofSessionMetadataSchema } from "./session-metadata";

/** A declaration's sort, chosen from a menu rather than typed as JSON. */
export type ProblemSetupSortChoice = Readonly<{ id: string; label: string; sort: Sort }>;

const named = (id: string, ...args: Sort[]): Sort =>
  sortSchema.parse(
    args.length === 0 ? { kind: "named", id } : { kind: "named", id, arguments: args },
  );
const REAL: Sort = named("sort:real");
const ELEMENT: Sort = named("sort:element");
const PROPOSITION: Sort = { kind: "proposition" };

/**
 * The sort menu. The starter packs are stated over `sort:real`, sets of `sort:element` and
 * `sort:integer` (library `packs.ts`), so those choices are the ones results can match.
 */
export const PROBLEM_SETUP_SORT_CHOICES: readonly ProblemSetupSortChoice[] = deepFreeze([
  { id: "proposition", label: "Proposition", sort: PROPOSITION },
  { id: "real", label: "Real number", sort: REAL },
  { id: "integer", label: "Integer", sort: named("sort:integer") },
  { id: "natural", label: "Natural number", sort: named("sort:natural") },
  { id: "rational", label: "Rational number", sort: named("sort:rational") },
  { id: "element", label: "Element", sort: ELEMENT },
  { id: "set-of-elements", label: "Set of elements", sort: named("sort:set", ELEMENT) },
  { id: "set-of-reals", label: "Set of real numbers", sort: named("sort:set", REAL) },
  {
    id: "real-function",
    label: "Function ℝ → ℝ",
    sort: sortSchema.parse({ kind: "function", signature: { parameters: [REAL], result: REAL } }),
  },
  {
    id: "real-predicate",
    label: "Predicate on ℝ",
    sort: sortSchema.parse({
      kind: "function",
      signature: { parameters: [REAL], result: PROPOSITION },
    }),
  },
  {
    id: "element-predicate",
    label: "Predicate on elements",
    sort: sortSchema.parse({
      kind: "function",
      signature: { parameters: [ELEMENT], result: PROPOSITION },
    }),
  },
]);

export const PROBLEM_SETUP_SORT_IDS = [
  "proposition",
  "real",
  "integer",
  "natural",
  "rational",
  "element",
  "set-of-elements",
  "set-of-reals",
  "real-function",
  "real-predicate",
  "element-predicate",
] as const;
export const problemSetupSortIdSchema = z.enum(PROBLEM_SETUP_SORT_IDS);
export type ProblemSetupSortId = z.infer<typeof problemSetupSortIdSchema>;

/** The sort a menu choice stands for. */
export function problemSetupSort(id: ProblemSetupSortId): Sort {
  const choice = PROBLEM_SETUP_SORT_CHOICES.find((candidate) => candidate.id === id);
  if (choice === undefined) throw new Error(`Unknown sort choice ${id}.`);
  return choice.sort;
}

export type ProblemSetupLayerChoice = Readonly<{
  id: string;
  layer: z.infer<typeof libraryLayerSchema>;
  label: string;
  description: string;
}>;

/**
 * The library layers a new session may activate, as session layer IDs. Move-discovery drafts are
 * never active, so they are not offered.
 */
export const PROBLEM_SETUP_LAYER_CHOICES: readonly ProblemSetupLayerChoice[] = deepFreeze([
  {
    id: "layer:global",
    layer: "global",
    label: "Global library",
    description: "Reviewed results shared by every session, including the starter packs.",
  },
  {
    id: "layer:initial-problem",
    layer: "initial-problem",
    label: "Initial problem library",
    description: "Results added for this problem before proof discovery begins.",
  },
  {
    id: "layer:proof-time-background",
    layer: "proof-time-background",
    label: "Proof-time background",
    description: "Background results admitted while the proof is in progress.",
  },
  {
    id: "layer:derived",
    layer: "derived",
    label: "Derived results",
    description: "Lemmas extracted from closed branches of this session.",
  },
]);
export const PROBLEM_SETUP_LAYER_IDS = [
  "layer:global",
  "layer:initial-problem",
  "layer:proof-time-background",
  "layer:derived",
] as const;
export const problemSetupLayerIdSchema = z.enum(PROBLEM_SETUP_LAYER_IDS);

export const problemSetupPackIdSchema = z.enum(LIBRARY_PACK_IDS);
export type ProblemSetupPackId = z.infer<typeof problemSetupPackIdSchema>;

/** Symbols are plain identifiers (MathJSON symbols such as `x`, `x_1` or `alpha`). */
export const problemSetupSymbolSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/, "A symbol is a letter followed by letters, digits or _.");

/** One hypothesis or goal, as LaTeX to parse or as plain MathJSON. */
export const problemStatementInputSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("latex"), latex: z.string().min(1).max(4_000) }).strict(),
  z.object({ format: z.literal("mathjson"), expression: plainMathJsonSchema }).strict(),
]);
export type ProblemStatementInput = z.infer<typeof problemStatementInputSchema>;

const shortTextSchema = z.string().trim().min(1).max(500);

export const problemDraftSchema = z
  .object({
    problem: z
      .object({ title: shortTextSchema, statement: z.string().trim().min(1).max(20_000) })
      .strict(),
    background: backgroundProfileSchema,
    preferences: z
      .object({
        domains: z.array(shortTextSchema).max(64).optional(),
        notation: z.array(shortTextSchema).max(64).optional(),
      })
      .strict()
      .optional(),
    libraryLayerIds: z.array(problemSetupLayerIdSchema).max(PROBLEM_SETUP_LAYER_IDS.length),
    packs: z.array(problemSetupPackIdSchema).max(LIBRARY_PACK_IDS.length),
    declarations: z
      .array(
        z.object({ symbol: problemSetupSymbolSchema, sort: problemSetupSortIdSchema }).strict(),
      )
      .max(64),
    hypotheses: z.array(problemStatementInputSchema).max(64),
    goals: z.array(problemStatementInputSchema).min(1).max(16),
  })
  .strict();
export type ProblemDraft = z.infer<typeof problemDraftSchema>;

export const PROBLEM_SETUP_DIAGNOSTIC_CODES = [
  "invalid-draft",
  "duplicate-choice",
  "pack-operator-conflict",
  "duplicate-symbol",
  "reserved-symbol",
  "operator-symbol",
  "latex-parse-failed",
  "pack-not-selected",
  "undeclared-symbol",
  "not-a-proposition",
  "invalid-root-state",
] as const;
export const problemSetupDiagnosticCodeSchema = z.enum(PROBLEM_SETUP_DIAGNOSTIC_CODES);
export type ProblemSetupDiagnosticCode = z.infer<typeof problemSetupDiagnosticCodeSchema>;

/** A precise draft problem: `path` locates the draft field it concerns. */
export const problemSetupDiagnosticSchema = z
  .object({
    code: problemSetupDiagnosticCodeSchema,
    message: z.string().min(1),
    path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  })
  .strict();
export type ProblemSetupDiagnostic = z.infer<typeof problemSetupDiagnosticSchema>;

export const problemSetupDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * What approval would store. `rootNode` is validated by consumers with
 * `createProofNodeSchema({ operators })`, since its schema depends on the operators.
 */
export const problemSetupReviewSchema = z
  .object({
    rootNode: z.unknown(),
    operators: z.array(z.unknown()),
    metadata: proofSessionMetadataSchema,
    /** Every pack the catalog offers for these operators, including always-active packs. */
    activePackIds: z.array(problemSetupPackIdSchema),
    digest: problemSetupDigestSchema,
  })
  .strict();
export type ProblemSetupReview = z.infer<typeof problemSetupReviewSchema>;

/** `POST /problem-drafts/validate` body. */
export const problemDraftValidationRequestSchema = z.object({ draft: z.unknown() }).strict();

export const problemDraftValidationResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), review: problemSetupReviewSchema }).strict(),
  z
    .object({ ok: z.literal(false), diagnostics: z.array(problemSetupDiagnosticSchema).min(1) })
    .strict(),
]);
export type ProblemDraftValidationResponse = z.infer<typeof problemDraftValidationResponseSchema>;

/**
 * `POST /proof-sessions`: approve a reviewed draft. The client chooses `sessionId` once per
 * review, so a retried approval is idempotent; `reviewedDigest` is the digest the user saw.
 */
export const problemApprovalRequestSchema = z
  .object({
    sessionId: stableIdentifierSchema,
    draft: z.unknown(),
    reviewedDigest: problemSetupDigestSchema,
  })
  .strict();
export type ProblemApprovalRequest = z.infer<typeof problemApprovalRequestSchema>;

export type ProblemSetupPackOption = Readonly<{
  id: ProblemSetupPackId;
  name: string;
  description: string;
  domain: string;
  /** Packs without notation are always in the catalog; the others need their operators. */
  alwaysActive: boolean;
  operators: readonly unknown[];
}>;

/** `GET /problem-setup/options`: the menus of the entry form. */
export const problemSetupOptionsSchema = z
  .object({
    sorts: z.array(
      z
        .object({ id: problemSetupSortIdSchema, label: z.string().min(1), sort: sortSchema })
        .strict(),
    ),
    layers: z.array(
      z
        .object({
          id: problemSetupLayerIdSchema,
          layer: libraryLayerSchema,
          label: z.string().min(1),
          description: z.string().min(1),
        })
        .strict(),
    ),
    packs: z.array(
      z
        .object({
          id: problemSetupPackIdSchema,
          name: z.string().min(1),
          description: z.string().min(1),
          domain: z.string().min(1),
          alwaysActive: z.boolean(),
          operators: z.array(z.unknown()),
        })
        .strict(),
    ),
  })
  .strict();
export type ProblemSetupOptions = z.infer<typeof problemSetupOptionsSchema>;

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
