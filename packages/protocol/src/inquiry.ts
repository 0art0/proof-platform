/**
 * Inquiry records (refinement §3–§4, §6): what a participant is trying to accomplish with the
 * mathematics, recorded beside the proof tree without changing proof state.
 *
 * Records reference proof nodes, their goals, obligations, statements, subexpressions and
 * construction tasks by identity; they never copy MathJSON. A command records one or more
 * records atomically at an anchor node. Records are static history: a later change is a new
 * record (a relationship or an explicit status change), never a rewrite.
 *
 * Reasons carry their provenance. An explicit user choice, an agent decision and an objective
 * encoded in the chosen method are contemporaneous: they are recorded with the action they explain.
 * A later interpretation is recorded afterwards and only about records of earlier commands.
 */
import {
  constructionRequirementIdSchema,
  constructionTaskIdSchema,
  proofStateIdSchema,
  sortSchema,
  stableIdentifierSchema,
  statementIdSchema,
  type ProofState,
} from "@proof/mathjson-model";
import { expressionAtPath } from "@proof/selections";
import { z } from "zod";
import { interactionSelectionSchema } from "./interaction-events";

// Local copies of the branded identifiers in `index.ts` (structural brands, no import cycle).
const actorIdSchema = stableIdentifierSchema.brand("ActorId");
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");
const suggestionSetIdSchema = stableIdentifierSchema.brand("SuggestionSetId");
const suggestionIdSchema = stableIdentifierSchema.brand("SuggestionId");

export const inquiryRecordIdSchema = stableIdentifierSchema.brand("InquiryRecordId");
export type InquiryRecordId = z.infer<typeof inquiryRecordIdSchema>;

export const INQUIRY_RECORD_KINDS = Object.freeze([
  "question",
  "objective",
  "attempt",
  "requirement",
  "observation",
  "obstruction",
  "decision",
  "relationship",
  "status-change",
] as const);
export type InquiryRecordKind = (typeof INQUIRY_RECORD_KINDS)[number];

export const QUESTION_FORMS = Object.freeze([
  "establish",
  "construct",
  "determine",
  "explore",
] as const);
export type QuestionForm = (typeof QUESTION_FORMS)[number];

export const INQUIRY_RELATIONS = Object.freeze([
  "wouldSufficeFor",
  "requires",
  "motivatedBy",
  "addresses",
  "specializes",
  "generalizes",
  "tests",
  "reuses",
] as const);
export type InquiryRelation = (typeof INQUIRY_RELATIONS)[number];

/**
 * Relations that attribute an intention to their `from` records. They always carry a reason, and
 * the reason is contemporaneous exactly when the `from` records are recorded in the same command.
 */
export const INTENTION_RELATIONS: ReadonlySet<InquiryRelation> = new Set([
  "motivatedBy",
  "addresses",
  "tests",
  "reuses",
]);

export const REASON_PROVENANCES = Object.freeze([
  "explicit-user",
  "agent",
  "method-encoded",
  "later-interpretation",
] as const);
export type ReasonProvenance = (typeof REASON_PROVENANCES)[number];

/** The statuses of each record kind that has a lifecycle; the first is the initial status. */
export const INQUIRY_STATUSES = Object.freeze({
  question: Object.freeze(["open", "resolved", "abandoned"] as const),
  objective: Object.freeze(["active", "achieved", "suspended", "abandoned"] as const),
  attempt: Object.freeze(["in-progress", "succeeded", "blocked", "abandoned"] as const),
  requirement: Object.freeze(["open", "satisfied", "withdrawn"] as const),
  obstruction: Object.freeze(["open", "addressed", "dismissed"] as const),
});
export type InquiryStatusSubjectKind = keyof typeof INQUIRY_STATUSES;
const ALL_STATUSES = [...new Set(Object.values(INQUIRY_STATUSES).flat())] as [string, ...string[]];

const targetReferenceSchema = z
  .object({ kind: z.enum(["goal", "obligation"]), id: statementIdSchema })
  .strict();
const statementSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("conclusion") }).strict(),
  z.object({ kind: z.literal("hypothesis"), id: statementIdSchema }).strict(),
]);
const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);

function uniqueArray<Item extends z.ZodType>(item: Item, min: number, max: number) {
  return z
    .array(item)
    .min(min)
    .max(max)
    .refine(
      (items) => new Set(items.map((value) => JSON.stringify(value))).size === items.length,
      "Entries must be unique.",
    );
}

/**
 * A reference to mathematics stored in a proof node: a goal or obligation (its sequent), one of
 * its statements, a subexpression at an operand path, a construction task, or a requirement of
 * one. The worker validates every reference against the stored node.
 */
export const inquiryMathReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("target"), nodeId: proofNodeIdSchema, target: targetReferenceSchema })
    .strict(),
  z
    .object({
      kind: z.literal("statement"),
      nodeId: proofNodeIdSchema,
      target: targetReferenceSchema,
      statement: statementSelectorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("occurrence"),
      nodeId: proofNodeIdSchema,
      target: targetReferenceSchema,
      statement: statementSelectorSchema,
      path: operandPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("construction-task"),
      nodeId: proofNodeIdSchema,
      taskId: constructionTaskIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("construction-requirement"),
      nodeId: proofNodeIdSchema,
      taskId: constructionTaskIdSchema,
      requirementId: constructionRequirementIdSchema,
    })
    .strict(),
]);
export type InquiryMathReference = z.infer<typeof inquiryMathReferenceSchema>;

/**
 * A proposition by reference. A `target` is the target's whole sequent, optionally without some
 * of its hypotheses (the statement investigated when testing a hypothesis's role). `negated`
 * refers to the negation, so a refutation is an `Establish` of a negated reference.
 */
export const propositionReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("target"),
      nodeId: proofNodeIdSchema,
      target: targetReferenceSchema,
      withoutHypotheses: uniqueArray(statementIdSchema, 1, 16).optional(),
      negated: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("statement"),
      nodeId: proofNodeIdSchema,
      target: targetReferenceSchema,
      statement: statementSelectorSchema,
      negated: z.literal(true).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("construction-requirement"),
      nodeId: proofNodeIdSchema,
      taskId: constructionTaskIdSchema,
      requirementId: constructionRequirementIdSchema,
      negated: z.literal(true).optional(),
    })
    .strict(),
]);
export type PropositionReference = z.infer<typeof propositionReferenceSchema>;

/** A method tried or proposed: an approved move, an approved library result, or manual work. */
export const methodReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("move"), moveId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("library-result"), resultId: stableIdentifierSchema }).strict(),
  z.object({ kind: z.literal("manual") }).strict(),
]);
export type MethodReference = z.infer<typeof methodReferenceSchema>;

const displayedSuggestionReferenceSchema = z
  .object({ suggestionSetId: suggestionSetIdSchema, suggestionId: suggestionIdSchema })
  .strict();

export const INFORMAL_SUPPORT_STATUSES = Object.freeze([
  "conjectured",
  "plausible",
  "checked-on-examples",
] as const);

/**
 * Why a logical claim holds. `transition` cites a stored kernel transition (equivalence or
 * strengthening) whose child targets suffice for its parent's. `proof-target` records that the
 * proposition is a target the proof state already requires. `construction-requirement` cites an
 * N11 requirement with its established role. `informal` is an explicit, visible informal status
 * and never counts as validated evidence.
 */
export const logicalSupportSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("transition"), childNodeId: proofNodeIdSchema }).strict(),
  z
    .object({
      kind: z.literal("proof-target"),
      nodeId: proofNodeIdSchema,
      target: targetReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("construction-requirement"),
      nodeId: proofNodeIdSchema,
      taskId: constructionTaskIdSchema,
      requirementId: constructionRequirementIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("informal"),
      status: z.enum(INFORMAL_SUPPORT_STATUSES),
      note: z.string().min(1).max(1000).optional(),
    })
    .strict(),
]);
export type LogicalSupport = z.infer<typeof logicalSupportSchema>;

/** A reason with its provenance. A method-encoded reason names the method that encodes it. */
export const inquiryReasonSchema = z
  .object({
    provenance: z.enum(REASON_PROVENANCES),
    /** Records the reason rests on, such as observations. */
    basisIds: uniqueArray(inquiryRecordIdSchema, 0, 16).optional(),
    method: methodReferenceSchema.optional(),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine(
    ({ provenance, method }) => (provenance === "method-encoded") === (method !== undefined),
    "A method-encoded reason names its method, and only such a reason does.",
  );
export type InquiryReason = z.infer<typeof inquiryReasonSchema>;

/** A reason recorded with the action it explains; later interpretations are excluded. */
const contemporaneousReasonSchema = inquiryReasonSchema.refine(
  ({ provenance }) => provenance !== "later-interpretation",
  "This reason is recorded with its action, so it cannot be a later interpretation.",
);

const questionFormSchema = z.discriminatedUnion("form", [
  z.object({ form: z.literal("establish"), proposition: propositionReferenceSchema }).strict(),
  z
    .object({
      form: z.literal("construct"),
      /** An N11 construction task, or an object still to be introduced as one. */
      object: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("construction-task"),
            nodeId: proofNodeIdSchema,
            taskId: constructionTaskIdSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("unassigned"),
            displayName: z.string().min(1).max(100),
            sort: sortSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  z.object({ form: z.literal("determine"), proposition: propositionReferenceSchema }).strict(),
  z
    .object({
      form: z.literal("explore"),
      objects: uniqueArray(inquiryMathReferenceSchema, 1, 16),
      aspect: z.enum(["structure", "relationship", "hypothesis", "family"]),
    })
    .strict(),
]);
export type InquiryQuestion = z.infer<typeof questionFormSchema>;

const decisionOptionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), recordId: inquiryRecordIdSchema }).strict(),
  z.object({ kind: z.literal("suggestion"), ...displayedSuggestionReferenceSchema.shape }).strict(),
  z.object({ kind: z.literal("method"), method: methodReferenceSchema }).strict(),
]);
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const OBSERVATION_DIAGNOSTIC_CODES = Object.freeze([
  "unmet-condition",
  "failed-match",
  "forbidden-dependency",
  "counterexample",
  "search-exhausted",
  "uncertain",
] as const);

/** The kind-specific fields of each record, shared by requests and stored records. */
const payloadShapes = {
  question: { question: questionFormSchema },
  objective: {
    questionId: inquiryRecordIdSchema,
    /** `required` only when the objective focuses an open target the proof itself requires. */
    necessity: z.enum(["required", "elective"]),
    focus: z
      .object({ nodeId: proofNodeIdSchema, target: targetReferenceSchema })
      .strict()
      .optional(),
    /** The attempt that proposed this objective, for an attempt's child objectives. */
    parentAttemptId: inquiryRecordIdSchema.optional(),
  },
  attempt: {
    objectiveId: inquiryRecordIdSchema,
    method: methodReferenceSchema,
    /** Selections at the anchor node's snapshot. */
    selections: z.array(interactionSelectionSchema).max(16).optional(),
    /** The displayed suggestion that was chosen, at the anchor node. */
    suggestion: displayedSuggestionReferenceSchema.optional(),
  },
  requirement: {
    /** An attempt, or a `construct` question. */
    subjectId: inquiryRecordIdSchema,
    proposition: propositionReferenceSchema,
    role: z.enum(["necessary", "sufficient", "heuristic"]),
    support: logicalSupportSchema.optional(),
  },
  observation: {
    references: uniqueArray(inquiryMathReferenceSchema, 0, 16).optional(),
    diagnostic: z
      .object({
        code: z.enum(OBSERVATION_DIAGNOSTIC_CODES),
        detail: z.string().min(1).max(1000).optional(),
      })
      .strict()
      .optional(),
    note: z.string().min(1).max(2000).optional(),
    /** Absent means the observation is unchecked. */
    support: logicalSupportSchema.optional(),
  },
  obstruction: {
    attemptId: inquiryRecordIdSchema,
    cause: z.discriminatedUnion("kind", [
      z
        .object({ kind: z.literal("unmet-requirement"), requirementId: inquiryRecordIdSchema })
        .strict(),
      z.object({ kind: z.literal("observation"), observationId: inquiryRecordIdSchema }).strict(),
    ]),
    /** Further observations, referenced rather than duplicated. */
    observationIds: uniqueArray(inquiryRecordIdSchema, 0, 16).optional(),
    potentialResponses: uniqueArray(methodReferenceSchema, 0, 8).optional(),
  },
  decision: {
    /** The question, objective, attempt or obstruction the decision is about. */
    subjectId: inquiryRecordIdSchema.optional(),
    selected: decisionOptionSchema,
    alternatives: uniqueArray(decisionOptionSchema, 0, 16).optional(),
    reason: contemporaneousReasonSchema.optional(),
  },
  relationship: {
    relation: z.enum(INQUIRY_RELATIONS),
    from: uniqueArray(inquiryRecordIdSchema, 1, 16),
    to: inquiryRecordIdSchema,
    support: logicalSupportSchema.optional(),
    reason: inquiryReasonSchema.optional(),
  },
  "status-change": {
    subjectId: inquiryRecordIdSchema,
    status: z.enum(ALL_STATUSES),
    reason: contemporaneousReasonSchema.optional(),
  },
} as const satisfies Record<InquiryRecordKind, z.ZodRawShape>;

const requestBaseShape = { id: inquiryRecordIdSchema } as const;

function requestVariant<Kind extends InquiryRecordKind>(kind: Kind) {
  return z.object({ ...requestBaseShape, kind: z.literal(kind), ...payloadShapes[kind] }).strict();
}

function addPayloadIssues(
  record: Readonly<Record<string, unknown>> & { kind: InquiryRecordKind },
  context: z.RefinementCtx,
): void {
  const issue = payloadIssue(record as InquiryRecordInput);
  if (issue !== undefined) context.addIssue({ code: "custom", message: issue });
}

/** Invariants that need only the record itself. */
function payloadIssue(record: InquiryRecordInput): string | undefined {
  switch (record.kind) {
    case "requirement":
      if (record.role === "heuristic") {
        return record.support === undefined || record.support.kind === "informal"
          ? undefined
          : "A heuristic requirement has no established implication, so no logical support.";
      }
      return record.support === undefined
        ? "A necessary or sufficient requirement needs evidence or an explicit informal status."
        : undefined;
    case "observation":
      return record.references === undefined &&
        record.diagnostic === undefined &&
        record.note === undefined
        ? "An observation needs mathematical references, a diagnostic, or a note."
        : undefined;
    case "decision": {
      const key = JSON.stringify(record.selected);
      return (record.alternatives ?? []).some((option) => JSON.stringify(option) === key)
        ? "The selected option cannot also be an alternative."
        : undefined;
    }
    case "relationship":
      if (record.from.includes(record.to))
        return "A relationship cannot relate a record to itself.";
      if (record.relation === "wouldSufficeFor" && record.support === undefined) {
        return "wouldSufficeFor is a mathematical claim: it needs evidence or an explicit informal status.";
      }
      if (INTENTION_RELATIONS.has(record.relation) && record.reason === undefined) {
        return `${record.relation} attributes an intention, so it records a reason and its provenance.`;
      }
      return undefined;
    default:
      return undefined;
  }
}

export const inquiryRecordInputSchema = z
  .discriminatedUnion("kind", [
    requestVariant("question"),
    requestVariant("objective"),
    requestVariant("attempt"),
    requestVariant("requirement"),
    requestVariant("observation"),
    requestVariant("obstruction"),
    requestVariant("decision"),
    requestVariant("relationship"),
    requestVariant("status-change"),
  ])
  .superRefine(addPayloadIssues);
export type InquiryRecordInput = z.infer<typeof inquiryRecordInputSchema>;

/**
 * One inquiry command: records recorded atomically at an anchor node. A record may reference
 * records of earlier commands and earlier records of this command, never later ones.
 */
export const recordInquiryCommandRequestSchema = z
  .object({
    commandId: commandIdSchema,
    nodeId: proofNodeIdSchema,
    records: z.array(inquiryRecordInputSchema).min(1).max(32),
  })
  .strict()
  .superRefine(({ records }, context) => {
    const ids = records.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Record IDs in a command must be unique." });
    }
    records.forEach((record, index) => {
      const later = new Set<string>(ids.slice(index));
      if (inquiryRecordReferenceIds(record).some((id) => later.has(id))) {
        context.addIssue({
          code: "custom",
          message: "A record may reference only earlier records.",
          path: ["records", index],
        });
      }
    });
  });
export type RecordInquiryCommandRequest = z.infer<typeof recordInquiryCommandRequestSchema>;

const storedBaseShape = {
  ...requestBaseShape,
  /** Per-session, strictly increasing, assigned by the worker under the session lock. */
  sequence: z.number().int().min(1),
  commandId: commandIdSchema,
  /** The anchor node and its snapshot: the local context the command was recorded in. */
  nodeId: proofNodeIdSchema,
  stateId: proofStateIdSchema,
  actor: z.object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) }).strict(),
  recordedAt: z.string().datetime({ offset: true }),
} as const;

function storedVariant<Kind extends InquiryRecordKind>(kind: Kind) {
  return z.object({ ...storedBaseShape, kind: z.literal(kind), ...payloadShapes[kind] }).strict();
}

export const inquiryRecordSchema = z
  .discriminatedUnion("kind", [
    storedVariant("question"),
    storedVariant("objective"),
    storedVariant("attempt"),
    storedVariant("requirement"),
    storedVariant("observation"),
    storedVariant("obstruction"),
    storedVariant("decision"),
    storedVariant("relationship"),
    storedVariant("status-change"),
  ])
  .superRefine((record, context) => {
    addPayloadIssues(record, context);
    for (const reason of recordReasons(record)) {
      const issue = provenanceActorIssue(reason, record.actor.kind);
      if (issue !== undefined) context.addIssue({ code: "custom", message: issue });
    }
  });
export type InquiryRecord = z.infer<typeof inquiryRecordSchema>;

export const inquiryRecordListSchema = z
  .array(inquiryRecordSchema)
  .superRefine((records, context) => {
    for (let index = 1; index < records.length; index += 1) {
      if ((records[index]?.sequence ?? 0) <= (records[index - 1]?.sequence ?? 0)) {
        context.addIssue({
          code: "custom",
          message: "Inquiry records must be listed in strictly increasing sequence order.",
        });
        return;
      }
    }
  });

const STORED_ONLY_FIELDS = [
  "sequence",
  "commandId",
  "nodeId",
  "stateId",
  "actor",
  "recordedAt",
] as const;

/** The request fields of a stored record, for idempotent replay comparison. */
export function inquiryRecordInputFields(record: InquiryRecord): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = { ...record };
  for (const key of STORED_ONLY_FIELDS) delete fields[key];
  return fields;
}

function recordReasons(record: InquiryRecordInput): InquiryReason[] {
  return "reason" in record && record.reason !== undefined ? [record.reason] : [];
}

function provenanceActorIssue(
  reason: InquiryReason,
  actorKind: "human" | "agent",
): string | undefined {
  if (reason.provenance === "explicit-user" && actorKind !== "human") {
    return "An explicit-user reason must be recorded by a human participant.";
  }
  if (reason.provenance === "agent" && actorKind !== "agent") {
    return "An agent reason must be recorded by an agent.";
  }
  return undefined;
}

function supportNodeIds(support: LogicalSupport | undefined): string[] {
  if (support === undefined || support.kind === "informal") return [];
  return support.kind === "transition" ? [support.childNodeId] : [support.nodeId];
}

/** Every proof node an input references (excluding the command's anchor). */
export function inquiryRecordNodeIds(record: InquiryRecordInput): readonly string[] {
  const ids: string[] = [];
  switch (record.kind) {
    case "question": {
      const question = record.question;
      if (question.form === "establish" || question.form === "determine") {
        ids.push(question.proposition.nodeId);
      } else if (question.form === "construct") {
        if (question.object.kind === "construction-task") ids.push(question.object.nodeId);
      } else {
        ids.push(...question.objects.map(({ nodeId }) => nodeId));
      }
      break;
    }
    case "objective":
      if (record.focus !== undefined) ids.push(record.focus.nodeId);
      break;
    case "requirement":
      ids.push(record.proposition.nodeId, ...supportNodeIds(record.support));
      break;
    case "observation":
      ids.push(
        ...(record.references ?? []).map(({ nodeId }) => nodeId),
        ...supportNodeIds(record.support),
      );
      break;
    case "relationship":
      ids.push(...supportNodeIds(record.support));
      break;
    default:
      break;
  }
  return [...new Set(ids)].sort();
}

/** Every inquiry record an input references. */
export function inquiryRecordReferenceIds(record: InquiryRecordInput): readonly string[] {
  const ids: string[] = [];
  const reasonIds = (reason: InquiryReason | undefined) => ids.push(...(reason?.basisIds ?? []));
  switch (record.kind) {
    case "objective":
      ids.push(record.questionId);
      if (record.parentAttemptId !== undefined) ids.push(record.parentAttemptId);
      break;
    case "attempt":
      ids.push(record.objectiveId);
      break;
    case "requirement":
      ids.push(record.subjectId);
      break;
    case "obstruction":
      ids.push(
        record.attemptId,
        record.cause.kind === "unmet-requirement"
          ? record.cause.requirementId
          : record.cause.observationId,
        ...(record.observationIds ?? []),
      );
      break;
    case "decision":
      if (record.subjectId !== undefined) ids.push(record.subjectId);
      for (const option of [record.selected, ...(record.alternatives ?? [])]) {
        if (option.kind === "record") ids.push(option.recordId);
      }
      reasonIds(record.reason);
      break;
    case "relationship":
      ids.push(...record.from, record.to);
      reasonIds(record.reason);
      break;
    case "status-change":
      ids.push(record.subjectId);
      reasonIds(record.reason);
      break;
    default:
      break;
  }
  return [...new Set(ids)].sort();
}

/** Every displayed suggestion set an input references. */
export function inquiryRecordSuggestionSetIds(record: InquiryRecordInput): readonly string[] {
  const ids: string[] = [];
  if (record.kind === "attempt" && record.suggestion !== undefined) {
    ids.push(record.suggestion.suggestionSetId);
  }
  if (record.kind === "decision") {
    for (const option of [record.selected, ...(record.alternatives ?? [])]) {
      if (option.kind === "suggestion") ids.push(option.suggestionSetId);
    }
  }
  return [...new Set(ids)].sort();
}

/** What the worker must load to validate a command: nodes, earlier records, sets, edges. */
export type InquiryCommandReferences = Readonly<{
  nodeIds: readonly string[];
  /** Records of earlier commands (references to records of this command are excluded). */
  recordIds: readonly string[];
  /** Earlier records whose current status a status change of this command depends on. */
  statusSubjectIds: readonly string[];
  suggestionSetIds: readonly string[];
  /** Child nodes of the transitions cited as support; their edges' parents are needed too. */
  transitionChildNodeIds: readonly string[];
}>;

export function inquiryCommandReferences(
  request: RecordInquiryCommandRequest,
): InquiryCommandReferences {
  const local = new Set<string>(request.records.map(({ id }) => id));
  const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
  const supports = request.records.flatMap((record) =>
    "support" in record && record.support !== undefined ? [record.support] : [],
  );
  return {
    nodeIds: sorted([request.nodeId, ...request.records.flatMap(inquiryRecordNodeIds)]),
    recordIds: sorted(
      request.records.flatMap(inquiryRecordReferenceIds).filter((id) => !local.has(id)),
    ),
    statusSubjectIds: sorted(
      request.records.flatMap((record) =>
        record.kind === "status-change" && !local.has(record.subjectId) ? [record.subjectId] : [],
      ),
    ),
    suggestionSetIds: sorted(request.records.flatMap(inquiryRecordSuggestionSetIds)),
    transitionChildNodeIds: sorted(
      supports.flatMap((support) => (support.kind === "transition" ? [support.childNodeId] : [])),
    ),
  };
}

/** The current status of a record, folding the status changes among `records`. */
export function currentInquiryStatus(
  subject: Readonly<{ id: string; kind: InquiryRecordKind }>,
  records: Iterable<InquiryRecord>,
): string | undefined {
  const statuses = statusesFor(subject.kind);
  if (statuses === undefined) return undefined;
  let latest: InquiryRecord | undefined;
  for (const record of records) {
    if (record.kind !== "status-change" || record.subjectId !== subject.id) continue;
    if (latest === undefined || record.sequence > latest.sequence) latest = record;
  }
  return latest?.kind === "status-change" ? latest.status : statuses[0];
}

function statusesFor(kind: InquiryRecordKind): readonly string[] | undefined {
  return kind in INQUIRY_STATUSES ? INQUIRY_STATUSES[kind as InquiryStatusSubjectKind] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Validation against stored data
// ---------------------------------------------------------------------------------------------

export type InquiryContextNode = Readonly<{ id: string; state: ProofState }>;
export type InquiryContextSuggestionSet = Readonly<{
  id: string;
  nodeId: string;
  suggestions: readonly Readonly<{ id: string; source: "result" | "move"; artifactId: string }>[];
}>;
export type InquiryContextEdge = Readonly<{
  parentNodeId: string;
  childNodeId: string;
  transitionClass: "equivalence" | "strengthening" | "weakening";
}>;

/**
 * Stored data a command is validated against. Anything missing from a map does not exist.
 * `records` holds the referenced records of earlier commands and, for each status subject, its
 * earlier status changes.
 */
export type InquiryCommandContext = Readonly<{
  actor: Readonly<{ id: string; kind: "human" | "agent" }>;
  nodes: ReadonlyMap<string, InquiryContextNode>;
  records: ReadonlyMap<string, InquiryRecord>;
  suggestionSets: ReadonlyMap<string, InquiryContextSuggestionSet>;
  /** Stored transitions keyed by child node ID. */
  edges: ReadonlyMap<string, InquiryContextEdge>;
  /** Approved method definitions. */
  methods: Readonly<{ moves: ReadonlySet<string>; results: ReadonlySet<string> }>;
}>;

export type InquiryDiagnosticCode =
  | "invalid-inquiry-command"
  | "unknown-reference"
  | "wrong-record-kind"
  | "invalid-math-reference"
  | "unsupported-claim"
  | "invalid-method"
  | "provenance-mismatch"
  | "not-contemporaneous"
  | "invalid-status-change"
  | "record-id-conflict";

export type InquiryDiagnostic = Readonly<{
  code: InquiryDiagnosticCode;
  message: string;
  /** The index of the offending record in the command, when there is one. */
  recordIndex?: number;
}>;

export type PrepareInquiryCommandResult =
  | Readonly<{ ok: true; records: readonly InquiryRecord[]; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [InquiryDiagnostic] }>;

class InquiryRejection extends Error {
  constructor(
    readonly code: InquiryDiagnosticCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: InquiryDiagnosticCode, message: string): never {
  throw new InquiryRejection(code, message);
}

/**
 * Validate a command against stored data and build its records with consecutive sequence numbers
 * starting at `firstSequence`. Pure: the worker loads the context and persists the result.
 */
export function prepareInquiryCommand(
  requestInput: unknown,
  context: InquiryCommandContext,
  options: Readonly<{ firstSequence: number; recordedAt: string }>,
): PrepareInquiryCommandResult {
  const parsed = recordInquiryCommandRequestSchema.safeParse(requestInput);
  if (!parsed.success) {
    return failure({
      code: "invalid-inquiry-command",
      message: parsed.error.issues[0]?.message ?? "The inquiry command is invalid.",
    });
  }
  const request = parsed.data;
  const anchor = context.nodes.get(request.nodeId);
  if (anchor === undefined) {
    return failure({ code: "unknown-reference", message: "The anchor proof node does not exist." });
  }
  const validator = new CommandValidator(request, anchor, context);
  const records: InquiryRecord[] = [];
  for (const [index, input] of request.records.entries()) {
    try {
      validator.check(input);
      const stored = inquiryRecordSchema.safeParse({
        ...input,
        sequence: options.firstSequence + index,
        commandId: request.commandId,
        nodeId: request.nodeId,
        stateId: anchor.state.id,
        actor: context.actor,
        recordedAt: options.recordedAt,
      });
      if (!stored.success) {
        reject(
          "invalid-inquiry-command",
          stored.error.issues[0]?.message ?? "The inquiry record failed validation.",
        );
      }
      validator.accept(stored.data);
      records.push(stored.data);
    } catch (error: unknown) {
      if (error instanceof InquiryRejection) {
        return failure({ code: error.code, message: error.message, recordIndex: index });
      }
      throw error;
    }
  }
  return { ok: true, records: deepFreeze(records), diagnostics: [] };
}

function failure(diagnostic: InquiryDiagnostic): PrepareInquiryCommandResult {
  return { ok: false, diagnostics: [diagnostic] };
}

type RecordOf<Kind extends InquiryRecordKind> = Extract<InquiryRecord, { kind: Kind }>;

class CommandValidator {
  private readonly local = new Map<string, InquiryRecord>();

  constructor(
    private readonly request: RecordInquiryCommandRequest,
    private readonly anchor: InquiryContextNode,
    private readonly context: InquiryCommandContext,
  ) {}

  accept(record: InquiryRecord): void {
    this.local.set(record.id, record);
  }

  check(input: InquiryRecordInput): void {
    if (this.context.records.has(input.id)) {
      reject("record-id-conflict", "The record ID is already used by another inquiry command.");
    }
    for (const reason of recordReasons(input)) this.checkReason(reason);
    switch (input.kind) {
      case "question":
        return this.checkQuestion(input.question);
      case "objective":
        return this.checkObjective(input);
      case "attempt":
        return this.checkAttempt(input);
      case "requirement":
        return this.checkRequirement(input);
      case "observation":
        (input.references ?? []).forEach((reference) => this.checkMathReference(reference));
        if (input.support !== undefined) this.checkSupportExists(input.support);
        return;
      case "obstruction":
        this.recordOf(input.attemptId, ["attempt"]);
        if (input.cause.kind === "unmet-requirement") {
          this.recordOf(input.cause.requirementId, ["requirement"]);
        } else {
          this.recordOf(input.cause.observationId, ["observation"]);
        }
        (input.observationIds ?? []).forEach((id) => this.recordOf(id, ["observation"]));
        (input.potentialResponses ?? []).forEach((method) => this.checkMethod(method));
        return;
      case "decision":
        if (input.subjectId !== undefined) {
          this.recordOf(input.subjectId, ["question", "objective", "attempt", "obstruction"]);
        }
        [input.selected, ...(input.alternatives ?? [])].forEach((option) =>
          this.checkDecisionOption(option),
        );
        return;
      case "relationship":
        return this.checkRelationship(input);
      case "status-change":
        return this.checkStatusChange(input);
    }
  }

  private lookup(id: string): InquiryRecord | undefined {
    return this.local.get(id) ?? this.context.records.get(id);
  }

  private recordOf<Kind extends InquiryRecordKind>(
    id: string,
    kinds: readonly Kind[],
  ): RecordOf<Kind> {
    const record = this.lookup(id);
    if (record === undefined) {
      reject("unknown-reference", `The inquiry record ${id} does not exist.`);
    }
    if (!(kinds as readonly string[]).includes(record.kind)) {
      reject(
        "wrong-record-kind",
        `The inquiry record ${id} is a ${record.kind}, not a ${kinds.join(" or ")}.`,
      );
    }
    return record as RecordOf<Kind>;
  }

  private node(nodeId: string): InquiryContextNode {
    const node = this.context.nodes.get(nodeId);
    if (node === undefined) reject("unknown-reference", `The proof node ${nodeId} does not exist.`);
    return node;
  }

  private target(nodeId: string, target: Readonly<{ kind: string; id: string }>) {
    const state = this.node(nodeId).state;
    const found = (target.kind === "goal" ? state.goals : state.obligations).find(
      ({ id }) => id === target.id,
    );
    if (found === undefined) {
      reject(
        "invalid-math-reference",
        `The ${target.kind} ${target.id} is not a target of proof node ${nodeId}.`,
      );
    }
    return found;
  }

  private statementExpression(
    nodeId: string,
    target: Readonly<{ kind: string; id: string }>,
    statement: z.infer<typeof statementSelectorSchema>,
  ) {
    const sequent = this.target(nodeId, target).sequent;
    if (statement.kind === "conclusion") return sequent.conclusion.expression;
    const hypothesis = sequent.context.hypotheses.find(({ id }) => id === statement.id);
    if (hypothesis === undefined) {
      reject("invalid-math-reference", `The hypothesis ${statement.id} is not in that target.`);
    }
    return hypothesis.statement.expression;
  }

  private constructionTask(nodeId: string, taskId: string) {
    const task = (this.node(nodeId).state.constructions ?? []).find(({ id }) => id === taskId);
    if (task === undefined) {
      reject(
        "invalid-math-reference",
        `The construction task ${taskId} is not in proof node ${nodeId}.`,
      );
    }
    return task;
  }

  private constructionRequirement(nodeId: string, taskId: string, requirementId: string) {
    const requirement = this.constructionTask(nodeId, taskId).requirements.find(
      ({ id }) => id === requirementId,
    );
    if (requirement === undefined) {
      reject(
        "invalid-math-reference",
        `The construction requirement ${requirementId} is not in task ${taskId}.`,
      );
    }
    return requirement;
  }

  private checkMathReference(reference: InquiryMathReference): void {
    switch (reference.kind) {
      case "target":
        this.target(reference.nodeId, reference.target);
        return;
      case "statement":
        this.statementExpression(reference.nodeId, reference.target, reference.statement);
        return;
      case "occurrence": {
        const expression = this.statementExpression(
          reference.nodeId,
          reference.target,
          reference.statement,
        );
        if (expressionAtPath(expression, reference.path) === undefined) {
          reject("invalid-math-reference", "The occurrence path does not exist in the statement.");
        }
        return;
      }
      case "construction-task":
        this.constructionTask(reference.nodeId, reference.taskId);
        return;
      case "construction-requirement":
        this.constructionRequirement(reference.nodeId, reference.taskId, reference.requirementId);
        return;
    }
  }

  private checkProposition(proposition: PropositionReference): void {
    if (proposition.kind === "target") {
      const found = this.target(proposition.nodeId, proposition.target);
      const hypotheses = new Set(found.sequent.context.hypotheses.map(({ id }) => id));
      if ((proposition.withoutHypotheses ?? []).some((id) => !hypotheses.has(id))) {
        reject("invalid-math-reference", "Only hypotheses of the target can be omitted.");
      }
      return;
    }
    if (proposition.kind === "statement") {
      this.statementExpression(proposition.nodeId, proposition.target, proposition.statement);
      return;
    }
    this.constructionRequirement(proposition.nodeId, proposition.taskId, proposition.requirementId);
  }

  private checkQuestion(question: InquiryQuestion): void {
    switch (question.form) {
      case "establish":
      case "determine":
        this.checkProposition(question.proposition);
        return;
      case "construct":
        if (question.object.kind === "construction-task") {
          this.constructionTask(question.object.nodeId, question.object.taskId);
        }
        return;
      case "explore":
        question.objects.forEach((object) => this.checkMathReference(object));
        return;
    }
  }

  private checkObjective(input: Extract<InquiryRecordInput, { kind: "objective" }>): void {
    const question = this.recordOf(input.questionId, ["question"]).question;
    if (input.parentAttemptId !== undefined) this.recordOf(input.parentAttemptId, ["attempt"]);
    if (input.focus !== undefined) this.target(input.focus.nodeId, input.focus.target);
    if (input.necessity === "elective") return;
    // An elective question never becomes an obligation; `required` needs the proof to require it.
    const focus = input.focus;
    if (focus === undefined) {
      reject("unsupported-claim", "A required objective must focus an open target of the proof.");
    }
    if (question.form === "establish") {
      const proposition = question.proposition;
      if (
        proposition.kind !== "target" ||
        proposition.nodeId !== focus.nodeId ||
        proposition.target.kind !== focus.target.kind ||
        proposition.target.id !== focus.target.id ||
        proposition.withoutHypotheses !== undefined ||
        proposition.negated !== undefined
      ) {
        reject(
          "unsupported-claim",
          "A required objective must establish exactly the target it focuses.",
        );
      }
      return;
    }
    if (question.form === "construct" && question.object.kind === "construction-task") {
      const task = this.constructionTask(focus.nodeId, question.object.taskId);
      if (task.status === "unresolved" || task.status === "partially-specified") return;
      reject("unsupported-claim", "A required construction objective needs an open task.");
    }
    reject(
      "unsupported-claim",
      "Only an Establish of a focused target or a Construct of an open task can be required.",
    );
  }

  private checkMethod(method: MethodReference): void {
    if (method.kind === "move" && !this.context.methods.moves.has(method.moveId)) {
      reject("invalid-method", `The move ${method.moveId} is not an approved move.`);
    }
    if (method.kind === "library-result" && !this.context.methods.results.has(method.resultId)) {
      reject("invalid-method", `The result ${method.resultId} is not an approved library result.`);
    }
  }

  /** A displayed suggestion recorded at the command's anchor node. */
  private suggestion(reference: z.infer<typeof displayedSuggestionReferenceSchema>) {
    const set = this.context.suggestionSets.get(reference.suggestionSetId);
    if (set === undefined || set.nodeId !== this.anchor.id) {
      reject(
        "unknown-reference",
        "The suggestion set does not exist at the command's anchor node.",
      );
    }
    const suggestion = set.suggestions.find(({ id }) => id === reference.suggestionId);
    if (suggestion === undefined) {
      reject("unknown-reference", "The suggestion was not displayed in that suggestion set.");
    }
    return suggestion;
  }

  private checkAttempt(input: Extract<InquiryRecordInput, { kind: "attempt" }>): void {
    this.recordOf(input.objectiveId, ["objective"]);
    this.checkMethod(input.method);
    for (const { anchor } of input.selections ?? []) {
      if (anchor.stateId !== this.anchor.state.id) {
        reject("invalid-math-reference", "Selections must be anchored to the anchor snapshot.");
      }
      this.target(this.anchor.id, anchor.target);
    }
    if (input.suggestion === undefined) return;
    const suggestion = this.suggestion(input.suggestion);
    const method = input.method;
    const matches =
      (method.kind === "move" &&
        suggestion.source === "move" &&
        suggestion.artifactId === method.moveId) ||
      (method.kind === "library-result" &&
        suggestion.source === "result" &&
        suggestion.artifactId === method.resultId);
    if (!matches) {
      reject("invalid-method", "The chosen suggestion does not name the attempt's method.");
    }
  }

  private checkRequirement(input: Extract<InquiryRecordInput, { kind: "requirement" }>): void {
    const subject = this.recordOf(input.subjectId, ["attempt", "question"]);
    if (subject.kind === "question" && subject.question.form !== "construct") {
      reject("wrong-record-kind", "Only an attempt or a Construct question has requirements.");
    }
    this.checkProposition(input.proposition);
    const support = input.support;
    if (support === undefined || support.kind === "informal") return;
    const proposition = input.proposition;
    switch (support.kind) {
      case "proof-target": {
        this.target(support.nodeId, support.target);
        if (
          input.role !== "sufficient" ||
          proposition.kind !== "target" ||
          proposition.nodeId !== support.nodeId ||
          proposition.target.kind !== support.target.kind ||
          proposition.target.id !== support.target.id ||
          proposition.withoutHypotheses !== undefined ||
          proposition.negated !== undefined
        ) {
          reject(
            "unsupported-claim",
            "A proof target supports only a sufficient requirement that is that very target.",
          );
        }
        return;
      }
      case "transition": {
        const edge = this.sufficingEdge(support.childNodeId);
        if (
          input.role !== "sufficient" ||
          proposition.nodeId !== edge.childNodeId ||
          proposition.negated !== undefined
        ) {
          reject(
            "unsupported-claim",
            "A transition supports only a sufficient requirement on a target of its child node.",
          );
        }
        return;
      }
      case "construction-requirement": {
        const cited = this.constructionRequirement(
          support.nodeId,
          support.taskId,
          support.requirementId,
        );
        if (cited.role !== input.role || cited.evidence.kind === "none") {
          reject(
            "unsupported-claim",
            "The cited construction requirement does not establish this role.",
          );
        }
        return;
      }
    }
  }

  private sufficingEdge(childNodeId: string): InquiryContextEdge {
    this.node(childNodeId);
    const edge = this.context.edges.get(childNodeId);
    if (edge === undefined) {
      reject("unknown-reference", `No stored transition leads to proof node ${childNodeId}.`);
    }
    if (edge.transitionClass === "weakening") {
      reject("unsupported-claim", "A weakening transition does not show that its child suffices.");
    }
    return edge;
  }

  private checkSupportExists(support: LogicalSupport): void {
    switch (support.kind) {
      case "transition":
        this.sufficingEdge(support.childNodeId);
        return;
      case "proof-target":
        this.target(support.nodeId, support.target);
        return;
      case "construction-requirement":
        this.constructionRequirement(support.nodeId, support.taskId, support.requirementId);
        return;
      case "informal":
        return;
    }
  }

  private checkDecisionOption(option: DecisionOption): void {
    if (option.kind === "record") {
      this.recordOf(option.recordId, ["question", "objective", "attempt"]);
    } else if (option.kind === "suggestion") {
      this.suggestion(option);
    } else {
      this.checkMethod(option.method);
    }
  }

  private checkReason(reason: InquiryReason): void {
    const issue = provenanceActorIssue(reason, this.context.actor.kind);
    if (issue !== undefined) reject("provenance-mismatch", issue);
    (reason.basisIds ?? []).forEach((id) => this.recordOf(id, INQUIRY_RECORD_KINDS));
    if (reason.method !== undefined) this.checkMethod(reason.method);
  }

  private checkRelationship(input: Extract<InquiryRecordInput, { kind: "relationship" }>): void {
    const kinds = RELATION_KINDS[input.relation];
    const from = input.from.map((id) => this.recordOf(id, kinds.from));
    const to = this.recordOf(input.to, kinds.to);
    const inThisCommand = input.from.map((id) => this.local.has(id));
    const reason = input.reason;
    if (reason?.provenance === "later-interpretation") {
      if (inThisCommand.some(Boolean)) {
        reject(
          "not-contemporaneous",
          "A later interpretation can only concern records of earlier commands.",
        );
      }
    } else if (INTENTION_RELATIONS.has(input.relation) && !inThisCommand.every(Boolean)) {
      reject(
        "not-contemporaneous",
        `A contemporaneous ${input.relation} reason must be recorded with the records it explains; ` +
          "commentary on earlier records is a later interpretation.",
      );
    }
    if (input.support !== undefined) this.checkRelationshipSupport(input, from, to);
  }

  private checkRelationshipSupport(
    input: Extract<InquiryRecordInput, { kind: "relationship" }>,
    from: readonly InquiryRecord[],
    to: InquiryRecord,
  ): void {
    const support = input.support;
    if (support === undefined || support.kind === "informal") return;
    if (input.relation !== "wouldSufficeFor") {
      this.checkSupportExists(support);
      return;
    }
    switch (support.kind) {
      case "proof-target":
        reject(
          "unsupported-claim",
          "A proof target is not evidence that some claims suffice for another.",
        );
        break;
      case "construction-requirement": {
        const cited = this.constructionRequirement(
          support.nodeId,
          support.taskId,
          support.requirementId,
        );
        if (cited.role !== "sufficient" || cited.evidence.kind === "none") {
          reject(
            "unsupported-claim",
            "The cited construction requirement is not established sufficient.",
          );
        }
        return;
      }
      case "transition": {
        // Targets are independent sequents, and a kernel transition rewrites one target while
        // carrying the others over unchanged. So the claims must cover every target the
        // transition created or changed, and the conclusion must be the parent target it
        // replaced; unchanged carried-over targets are the frame, not premises.
        const edge = this.sufficingEdge(support.childNodeId);
        const parent = targetsByKey(this.node(edge.parentNodeId).state);
        const child = targetsByKey(this.node(edge.childNodeId).state);
        const carried = (
          key: string,
          from: ReadonlyMap<string, unknown>,
          into: ReadonlyMap<string, unknown>,
        ) => into.has(key) && canonicalJson(from.get(key)) === canonicalJson(into.get(key));
        const covered = new Set<string>();
        for (const record of from) {
          const target = plainTargetOf(record);
          if (target === undefined || target.nodeId !== edge.childNodeId) {
            reject(
              "unsupported-claim",
              "Each sufficient claim must be a target of the transition's child node.",
            );
          }
          covered.add(targetKey(target.target));
        }
        const conclusion = plainTargetOf(to);
        if (
          [...child.keys()].some((key) => !covered.has(key) && !carried(key, child, parent)) ||
          conclusion === undefined ||
          conclusion.nodeId !== edge.parentNodeId ||
          !parent.has(targetKey(conclusion.target)) ||
          carried(targetKey(conclusion.target), parent, child)
        ) {
          reject(
            "unsupported-claim",
            "The claims must cover every target the transition created or changed, and the " +
              "conclusion must be the parent target it replaced.",
          );
        }
        return;
      }
    }
  }

  private checkStatusChange(input: Extract<InquiryRecordInput, { kind: "status-change" }>): void {
    const subject = this.recordOf(input.subjectId, [
      "question",
      "objective",
      "attempt",
      "requirement",
      "obstruction",
    ]);
    const statuses = statusesFor(subject.kind) ?? [];
    if (!statuses.includes(input.status)) {
      reject("invalid-status-change", `A ${subject.kind} cannot have status ${input.status}.`);
    }
    const current = currentInquiryStatus(subject, [
      ...this.context.records.values(),
      ...this.local.values(),
    ]);
    if (current === input.status) {
      reject("invalid-status-change", `The ${subject.kind} already has status ${input.status}.`);
    }
  }
}

/** The record kinds each relation connects. */
const RELATION_KINDS: Readonly<
  Record<
    InquiryRelation,
    Readonly<{ from: readonly InquiryRecordKind[]; to: readonly InquiryRecordKind[] }>
  >
> = {
  wouldSufficeFor: { from: ["question", "requirement"], to: ["question", "requirement"] },
  requires: { from: ["attempt", "question"], to: ["requirement", "question", "objective"] },
  motivatedBy: {
    from: ["question", "objective", "attempt", "decision"],
    to: ["observation", "obstruction", "requirement", "decision"],
  },
  addresses: { from: ["attempt", "question", "objective"], to: ["obstruction"] },
  specializes: { from: ["question"], to: ["question"] },
  generalizes: { from: ["question"], to: ["question"] },
  tests: { from: ["attempt", "question"], to: ["question", "requirement"] },
  reuses: { from: ["attempt"], to: ["attempt", "observation"] },
};

/** The unmodified target an Establish question or a requirement refers to, if it is one. */
function plainTargetOf(
  record: InquiryRecord,
): Readonly<{ nodeId: string; target: Readonly<{ kind: string; id: string }> }> | undefined {
  const proposition =
    record.kind === "requirement"
      ? record.proposition
      : record.kind === "question" && record.question.form === "establish"
        ? record.question.proposition
        : undefined;
  if (
    proposition?.kind !== "target" ||
    proposition.withoutHypotheses !== undefined ||
    proposition.negated !== undefined
  ) {
    return undefined;
  }
  return proposition;
}

function targetKey(target: Readonly<{ kind: string; id: string }>): string {
  return `${target.kind}\u0000${target.id}`;
}

function targetsByKey(state: ProofState): ReadonlyMap<string, unknown> {
  return new Map<string, unknown>([
    ...state.goals.map((goal): [string, unknown] => [
      targetKey({ kind: "goal", id: goal.id }),
      goal,
    ]),
    ...state.obligations.map((obligation): [string, unknown] => [
      targetKey({ kind: "obligation", id: obligation.id }),
      obligation,
    ]),
  ]);
}

/** JSON with sorted object keys, so stored copies compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach((child: unknown) => deepFreeze(child));
    Object.freeze(value);
  }
  return value;
}
