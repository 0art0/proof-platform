/**
 * The complete command protocol (design plan §18, §20.3; roadmap N25).
 *
 * Humans and stateful proof agents send one command envelope for every mutation. The envelope
 * names its actor, an optional alias basis, and one command. The worker resolves compact aliases
 * to stored identities, enforces the payload-source rule, and dispatches to the existing
 * repository command (kernel transition, delete, backtrack, replay, inquiry, library addition).
 * No command here writes state itself; every function in this module is pure.
 *
 * Aliases are derived from a stored snapshot only, so observing the same snapshot twice yields
 * the same aliases:
 *
 * - `g1…` goals and `o1…` obligations, in state order;
 * - `h1…` hypotheses by first appearance (goals, then obligations, context order);
 * - `s1…` the suggestions of one displayed suggestion set, in display order;
 * - `m1…` the items of one parameter menu, in menu order (numbered per parameter).
 *
 * A reference that matches the alias pattern is always read as an alias. An alias resolved
 * against the session's current node needs `basis.nodeId` equal to that node; otherwise the
 * command is stale and rejected rather than guessed.
 *
 * Payload sources (design plan §4.4; refinement §11): new mathematical content enters only from
 * setup, approved generators, validated operations, or reviewed authoring. In this envelope:
 *
 * - `setup` content enters only when a session is initialized, never through a command;
 * - `approved-generator` output is chosen by menu item ID or alias, never sent as raw MathJSON;
 * - `validated-operation` content is referenced by occurrence in a stored snapshot, or sent raw
 *   and accepted only when it occurs verbatim in the snapshot the command acts on;
 * - `reviewed-authoring` is accepted only from a human actor.
 */
import {
  plainMathJsonSchema,
  proofStateIdSchema,
  stableIdentifierSchema,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { libraryLayerSchema } from "@proof/library";
import { z } from "zod";
import { expressionAtPath } from "@proof/selections";
import { INQUIRY_RECORD_KINDS, inquiryRecordInputSchema } from "./inquiry";
import {
  menuItemIdSchema,
  menuParameterIdSchema,
  parameterMenuItemSchema,
  type ParameterMenuRecord,
} from "./parameter-menus";
import { replayOverrideSchema } from "./semantic-replay";
import type { DisplayedSuggestionSet, ProofStateDelta } from "./index";

// Local copies of the branded identifiers in `index.ts`: the brands are structural, so values
// parsed here are interchangeable with those schemas' outputs without an import cycle.
const actorIdSchema = stableIdentifierSchema.brand("ActorId");
const commandIdSchema = stableIdentifierSchema.brand("CommandId");
const proofNodeIdSchema = stableIdentifierSchema.brand("ProofNodeId");
const suggestionSetIdSchema = stableIdentifierSchema.brand("SuggestionSetId");
const suggestionIdSchema = stableIdentifierSchema.brand("SuggestionId");

const protocolActorSchema = z
  .object({ id: actorIdSchema, kind: z.enum(["human", "agent"]) })
  .strict();
export type ProtocolActor = z.infer<typeof protocolActorSchema>;

// ---------------------------------------------------------------------------------------------
// Aliases
// ---------------------------------------------------------------------------------------------

const ALIAS_PATTERN = /^[gohsm][1-9][0-9]{0,3}$/;

/** `g`, `o`, `h`, `s` or `m` followed by a positive index. */
export const snapshotAliasSchema = z.string().regex(ALIAS_PATTERN, "Not a snapshot alias.");
export type SnapshotAlias = z.infer<typeof snapshotAliasSchema>;

export type AliasKind = "goal" | "obligation" | "hypothesis" | "suggestion" | "menu-item";

const ALIAS_PREFIX: Readonly<Record<AliasKind, string>> = {
  goal: "g",
  obligation: "o",
  hypothesis: "h",
  suggestion: "s",
  "menu-item": "m",
};

/** Whether a reference is an alias (as opposed to a stored identifier). */
export function isAliasReference(reference: string): boolean {
  return ALIAS_PATTERN.test(reference);
}

function aliasKindOf(reference: string): AliasKind | undefined {
  if (!isAliasReference(reference)) return undefined;
  const prefix = reference[0];
  return (Object.keys(ALIAS_PREFIX) as AliasKind[]).find((kind) => ALIAS_PREFIX[kind] === prefix);
}

const aliasEntrySchema = z
  .object({ alias: snapshotAliasSchema, id: stableIdentifierSchema })
  .strict();
export type AliasEntry = z.infer<typeof aliasEntrySchema>;

export const snapshotAliasTableSchema = z
  .object({
    nodeId: proofNodeIdSchema,
    stateId: proofStateIdSchema,
    goals: z.array(aliasEntrySchema),
    obligations: z.array(aliasEntrySchema),
    hypotheses: z.array(aliasEntrySchema),
  })
  .strict();
export type SnapshotAliasTable = z.infer<typeof snapshotAliasTableSchema>;

/** The parts of a snapshot aliases and summaries read; structural, so tests can build them. */
export type SnapshotView = Readonly<{
  id: string;
  state: Readonly<{
    id: string;
    goals: readonly TargetView[];
    obligations: readonly TargetView[];
    assumptions?:
      | readonly Readonly<{
          id: string;
          statement: Readonly<{ expression: PlainMathJson }>;
          origin: Readonly<{ kind: string }>;
        }>[]
      | undefined;
  }>;
}>;

type TargetView = Readonly<{
  id: string;
  sequent: Readonly<{
    context: Readonly<{
      hypotheses: readonly Readonly<{
        id: string;
        statement: Readonly<{ expression: PlainMathJson }>;
      }>[];
    }>;
    conclusion: Readonly<{ expression: PlainMathJson }>;
  }>;
}>;

function numbered(ids: readonly string[], kind: AliasKind): AliasEntry[] {
  return ids.map((id, index) => ({ alias: `${ALIAS_PREFIX[kind]}${index + 1}`, id }));
}

/** Derive the aliases of one stored snapshot. Deterministic in the snapshot alone. */
export function deriveSnapshotAliases(node: SnapshotView): SnapshotAliasTable {
  const hypothesisIds: string[] = [];
  const seen = new Set<string>();
  for (const target of [...node.state.goals, ...node.state.obligations]) {
    for (const hypothesis of target.sequent.context.hypotheses) {
      if (seen.has(hypothesis.id)) continue;
      seen.add(hypothesis.id);
      hypothesisIds.push(hypothesis.id);
    }
  }
  return deepFreeze({
    nodeId: node.id,
    stateId: node.state.id,
    goals: numbered(
      node.state.goals.map(({ id }) => id),
      "goal",
    ),
    obligations: numbered(
      node.state.obligations.map(({ id }) => id),
      "obligation",
    ),
    hypotheses: numbered(hypothesisIds, "hypothesis"),
  }) as SnapshotAliasTable;
}

/**
 * Aliases of a displayed suggestion set. `displayedIds` is the display order recorded by a
 * `suggestions-displayed` event; without it the stored set order is used.
 */
export function deriveSuggestionAliases(
  suggestionSet: Pick<DisplayedSuggestionSet, "suggestions">,
  displayedIds?: readonly string[],
): readonly AliasEntry[] {
  const stored = suggestionSet.suggestions.map(({ id }) => id as string);
  const order =
    displayedIds === undefined ? stored : displayedIds.filter((id) => stored.includes(id));
  return deepFreeze(numbered(order, "suggestion"));
}

/** Per-parameter aliases of displayed menu items, in menu order. */
export function deriveMenuAliases(
  menus: readonly Pick<ParameterMenuRecord, "parameterId" | "items">[],
): readonly Readonly<{ parameterId: string; items: readonly AliasEntry[] }>[] {
  return deepFreeze(
    menus.map((menu) => ({
      parameterId: menu.parameterId,
      items: numbered(
        menu.items.map(({ id }) => id),
        "menu-item",
      ),
    })),
  );
}

export type CommandProtocolDiagnosticCode =
  | "invalid-envelope"
  | "unknown-alias"
  | "unknown-reference"
  | "stale-alias"
  | "basis-required"
  | "payload-source-required"
  | "payload-source-rejected";

export type CommandProtocolDiagnostic = Readonly<{
  code: CommandProtocolDiagnosticCode;
  message: string;
}>;

export type Resolution<Value> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; diagnostic: CommandProtocolDiagnostic }>;

function resolved<Value>(value: Value): Resolution<Value> {
  return { ok: true, value };
}

function unresolved<Value>(
  code: CommandProtocolDiagnosticCode,
  message: string,
): Resolution<Value> {
  return { ok: false, diagnostic: { code, message } };
}

export type TargetIdentity = Readonly<{ kind: "goal" | "obligation"; id: string }>;

/** A goal or obligation: an alias (`g1`, `o2`), a stored ID, or `{ kind, id }`. */
export const targetReferenceSchema = z.union([
  stableIdentifierSchema,
  z.object({ kind: z.enum(["goal", "obligation"]), id: stableIdentifierSchema }).strict(),
]);
export type TargetReference = z.infer<typeof targetReferenceSchema>;

/** `conclusion`, or a hypothesis alias (`h2`) or stored hypothesis ID. */
export const statementReferenceSchema = stableIdentifierSchema;
export type StatementReference = z.infer<typeof statementReferenceSchema>;

export function resolveTargetReference(
  node: SnapshotView,
  table: SnapshotAliasTable,
  reference: TargetReference,
): Resolution<TargetIdentity> {
  if (typeof reference !== "string") {
    const collection = reference.kind === "goal" ? node.state.goals : node.state.obligations;
    return collection.some(({ id }) => id === reference.id)
      ? resolved({ kind: reference.kind, id: reference.id })
      : unresolved(
          "unknown-reference",
          `No ${reference.kind} ${reference.id} in the snapshot ${table.stateId}.`,
        );
  }
  const kind = aliasKindOf(reference);
  if (kind !== undefined) {
    if (kind !== "goal" && kind !== "obligation") {
      return unresolved("unknown-alias", `The alias ${reference} does not name a target.`);
    }
    const entry = (kind === "goal" ? table.goals : table.obligations).find(
      ({ alias }) => alias === reference,
    );
    return entry === undefined
      ? unresolved("unknown-alias", `The snapshot ${table.stateId} has no ${kind} ${reference}.`)
      : resolved({ kind, id: entry.id });
  }
  if (node.state.goals.some(({ id }) => id === reference)) {
    return resolved({ kind: "goal", id: reference });
  }
  if (node.state.obligations.some(({ id }) => id === reference)) {
    return resolved({ kind: "obligation", id: reference });
  }
  return unresolved(
    "unknown-reference",
    `No goal or obligation ${reference} in the snapshot ${table.stateId}.`,
  );
}

export type StatementIdentity =
  Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: string }>;

/** Resolve a statement of one target: `conclusion`, or a hypothesis in its context. */
export function resolveStatementReference(
  node: SnapshotView,
  table: SnapshotAliasTable,
  target: TargetIdentity,
  reference: StatementReference | undefined,
): Resolution<StatementIdentity> {
  if (reference === undefined || reference === "conclusion") {
    return resolved({ kind: "conclusion" });
  }
  const hypothesisId = resolveHypothesisId(table, reference);
  if (!hypothesisId.ok) return hypothesisId;
  const entry = findTarget(node, target);
  if (
    entry === undefined ||
    !entry.sequent.context.hypotheses.some(({ id }) => id === hypothesisId.value)
  ) {
    return unresolved(
      "unknown-reference",
      `The hypothesis ${reference} is not in the context of ${target.kind} ${target.id}.`,
    );
  }
  return resolved({ kind: "hypothesis", id: hypothesisId.value });
}

/** Resolve a hypothesis alias to its ID; a stored ID is returned unchanged. */
export function resolveHypothesisId(
  table: SnapshotAliasTable,
  reference: string,
): Resolution<string> {
  const kind = aliasKindOf(reference);
  if (kind === undefined) return resolved(reference);
  if (kind !== "hypothesis") {
    return unresolved("unknown-alias", `The alias ${reference} does not name a hypothesis.`);
  }
  const entry = table.hypotheses.find(({ alias }) => alias === reference);
  return entry === undefined
    ? unresolved("unknown-alias", `The snapshot ${table.stateId} has no hypothesis ${reference}.`)
    : resolved(entry.id);
}

/** Resolve a suggestion alias (`s3`) or stored suggestion ID against a displayed set. */
export function resolveSuggestionReference(
  suggestionSet: Pick<DisplayedSuggestionSet, "id" | "suggestions">,
  aliases: readonly AliasEntry[],
  reference: string,
): Resolution<string> {
  const kind = aliasKindOf(reference);
  if (kind === undefined) {
    return suggestionSet.suggestions.some(({ id }) => id === reference)
      ? resolved(reference)
      : unresolved(
          "unknown-reference",
          `The suggestion ${reference} is not in the displayed set ${suggestionSet.id}.`,
        );
  }
  if (kind !== "suggestion") {
    return unresolved("unknown-alias", `The alias ${reference} does not name a suggestion.`);
  }
  const entry = aliases.find(({ alias }) => alias === reference);
  return entry === undefined
    ? unresolved(
        "unknown-alias",
        `The displayed suggestion set ${suggestionSet.id} has no suggestion ${reference}.`,
      )
    : resolved(entry.id);
}

/** Resolve a menu-item alias (`m2`) against the displayed menu of one parameter. */
export function resolveMenuItemReference(
  menu: Pick<ParameterMenuRecord, "parameterId" | "items">,
  reference: string,
): Resolution<string> {
  const kind = aliasKindOf(reference);
  if (kind === undefined) return resolved(reference);
  if (kind !== "menu-item") {
    return unresolved("unknown-alias", `The alias ${reference} does not name a menu item.`);
  }
  const entry = deriveMenuAliases([menu])[0]?.items.find(({ alias }) => alias === reference);
  return entry === undefined
    ? unresolved(
        "unknown-alias",
        `The menu for ${menu.parameterId} has no item ${reference} (it has ${menu.items.length}).`,
      )
    : resolved(entry.id);
}

function findTarget(node: SnapshotView, target: TargetIdentity): TargetView | undefined {
  return (target.kind === "goal" ? node.state.goals : node.state.obligations).find(
    ({ id }) => id === target.id,
  );
}

// ---------------------------------------------------------------------------------------------
// Math payloads and their sources
// ---------------------------------------------------------------------------------------------

export const payloadSourceSchema = z.enum([
  "setup",
  "approved-generator",
  "validated-operation",
  "reviewed-authoring",
]);
export type PayloadSource = z.infer<typeof payloadSourceSchema>;

const operandPathSchema = z.array(z.number().int().nonnegative()).max(64);

/** An occurrence in a stored snapshot: `nodeId` defaults to the session's current node. */
export const mathOccurrenceSchema = z
  .object({
    nodeId: proofNodeIdSchema.optional(),
    target: targetReferenceSchema,
    statement: statementReferenceSchema.optional(),
    path: operandPathSchema.optional(),
  })
  .strict();
export type MathOccurrence = z.infer<typeof mathOccurrenceSchema>;

/** Mathematics referenced by occurrence (preferred), or sent raw with its declared source. */
export const mathPayloadSchema = z.union([
  z.object({ occurrence: mathOccurrenceSchema }).strict(),
  z.object({ expression: plainMathJsonSchema, source: payloadSourceSchema }).strict(),
]);
export type MathPayload = z.infer<typeof mathPayloadSchema>;

/** The subexpression at an operand path (0-based operand indices, as selections use). */
export function subexpressionAt(
  expression: PlainMathJson,
  path: readonly number[],
): PlainMathJson | undefined {
  return expressionAtPath(expression, [...path]);
}

/** Read an occurrence from a snapshot: the statement's subexpression at the path. */
export function readOccurrence(
  node: SnapshotView,
  table: SnapshotAliasTable,
  occurrence: Omit<MathOccurrence, "nodeId">,
): Resolution<PlainMathJson> {
  const target = resolveTargetReference(node, table, occurrence.target);
  if (!target.ok) return target;
  const statement = resolveStatementReference(node, table, target.value, occurrence.statement);
  if (!statement.ok) return statement;
  const entry = findTarget(node, target.value);
  const expression =
    statement.value.kind === "conclusion"
      ? entry?.sequent.conclusion.expression
      : entry?.sequent.context.hypotheses.find(
          ({ id }) => statement.value.kind === "hypothesis" && id === statement.value.id,
        )?.statement.expression;
  const found =
    expression === undefined ? undefined : subexpressionAt(expression, occurrence.path ?? []);
  return found === undefined
    ? unresolved(
        "unknown-reference",
        `No subexpression at [${(occurrence.path ?? []).join(", ")}] of the referenced statement.`,
      )
    : resolved(found);
}

/** Whether `expression` occurs verbatim in a statement of the snapshot. */
export function occursInSnapshot(node: SnapshotView, expression: PlainMathJson): boolean {
  const statements: PlainMathJson[] = [];
  for (const target of [...node.state.goals, ...node.state.obligations]) {
    statements.push(target.sequent.conclusion.expression);
    target.sequent.context.hypotheses.forEach(({ statement }) =>
      statements.push(statement.expression),
    );
  }
  (node.state.assumptions ?? []).forEach(({ statement }) => statements.push(statement.expression));
  const wanted = canonicalJson(expression);
  const visit = (candidate: unknown): boolean => {
    if (canonicalJson(candidate) === wanted) return true;
    return Array.isArray(candidate) && candidate.slice(1).some(visit);
  };
  return statements.some(visit);
}

/**
 * Enforce the payload-source rule for one raw MathJSON payload the actor sent for the snapshot
 * `node`. References by occurrence and menu items never reach this check.
 */
export function checkRawPayloadSource(input: {
  expression: PlainMathJson;
  source: PayloadSource | undefined;
  actor: ProtocolActor;
  node: SnapshotView;
}): Resolution<PlainMathJson> {
  switch (input.source) {
    case undefined:
      return unresolved(
        "payload-source-required",
        "Raw MathJSON needs a payload source; reference an occurrence or a menu item instead.",
      );
    case "setup":
      return unresolved(
        "payload-source-rejected",
        "Setup content enters only when a session is initialized, not through a command.",
      );
    case "approved-generator":
      return unresolved(
        "payload-source-rejected",
        "Approved-generator output is chosen by menu item from a displayed suggestion, not sent as raw MathJSON.",
      );
    case "validated-operation":
      return occursInSnapshot(input.node, input.expression)
        ? resolved(input.expression)
        : unresolved(
            "payload-source-rejected",
            `The expression does not occur in the snapshot ${input.node.state.id}, so no validated operation produced it.`,
          );
    case "reviewed-authoring":
      return input.actor.kind === "human"
        ? resolved(input.expression)
        : unresolved(
            "payload-source-rejected",
            "Reviewed authoring is accepted only from a human actor; an agent references existing mathematics.",
          );
  }
}

/** Fields of a kernel operation that carry MathJSON, as `[field path, expression]` pairs. */
export function kernelOperationMathPayloads(
  operation: Readonly<Record<string, unknown>>,
): readonly (readonly [string, PlainMathJson])[] {
  const payloads: [string, PlainMathJson][] = [];
  for (const field of ["proposition", "term", "witness", "value"] as const) {
    if (operation[field] !== undefined) payloads.push([field, operation[field] as PlainMathJson]);
  }
  const addInstantiation = (prefix: string, value: unknown): void => {
    if (!isRecord(value)) return;
    for (const [symbol, expression] of Object.entries(value)) {
      payloads.push([`${prefix}.${symbol}`, expression as PlainMathJson]);
    }
  };
  addInstantiation("instantiation", operation.instantiation);
  if (isRecord(operation.source))
    addInstantiation("source.instantiation", operation.source.instantiation);
  return payloads;
}

// ---------------------------------------------------------------------------------------------
// Command envelope
// ---------------------------------------------------------------------------------------------

const exactSelectionReferenceSchema = z
  .object({
    target: targetReferenceSchema,
    statement: statementReferenceSchema.optional(),
    path: operandPathSchema.optional(),
  })
  .strict();

const associativeSelectionReferenceSchema = z
  .object({
    target: targetReferenceSchema,
    statement: statementReferenceSchema.optional(),
    containerPath: operandPathSchema,
    startOperand: z.number().int().nonnegative(),
    endOperand: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    ({ startOperand, endOperand }) => endOperand - startOperand >= 2,
    "An associative range must contain at least two operands.",
  );

/** A selection in the current snapshot, by alias or stored ID. */
export const selectionReferenceSchema = z.union([
  exactSelectionReferenceSchema,
  associativeSelectionReferenceSchema,
]);
export type SelectionReference = z.infer<typeof selectionReferenceSchema>;

/** Parameter ID → menu item alias (`m2`) or content-derived menu item ID. */
const menuChoiceReferencesSchema = z
  .record(menuParameterIdSchema, z.union([snapshotAliasSchema, menuItemIdSchema]))
  .refine((choices) => Object.keys(choices).length <= 32, "At most 32 menu choices.");

const moveChoiceShape = {
  /** A suggestion alias (`s3`) or suggestion ID of the displayed set. */
  suggestion: stableIdentifierSchema,
  /** Defaults to `basis.suggestionSetId`, then to the latest set displayed at the current node. */
  suggestionSetId: suggestionSetIdSchema.optional(),
  menuChoices: menuChoiceReferencesSchema.optional(),
} as const;

/**
 * The lemma's ID, classification and LaTeX/natural-language renderings are derived by the worker
 * from the proof state; a caller may only suggest a display name (N44).
 */
const conditionalLemmaShape = z.object({ name: z.string().min(1).max(200).optional() }).strict();

const commandSchemas = [
  z
    .object({
      kind: z.literal("request-suggestions"),
      selections: z.array(selectionReferenceSchema).min(1).max(16),
    })
    .strict(),
  z.object({ kind: z.literal("preview"), ...moveChoiceShape }).strict(),
  z
    .object({
      kind: z.literal("apply"),
      ...moveChoiceShape,
      /** Apply a result suggestion as "Try this theorem" (refinement §3.4). */
      inquiryMethod: z.literal("try-result").optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("kernel-operation"),
      /**
       * A kernel or construction operation. `target` and hypothesis-ID fields may be aliases;
       * `expectedStateId` defaults to the current snapshot and `resultStateId` to
       * `state:<commandId>`. Every MathJSON field is checked against `payloadSource`.
       */
      operation: z
        .record(z.string(), z.unknown())
        .refine((operation) => typeof operation.kind === "string", "The operation needs a kind."),
      payloadSource: payloadSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("case-split"),
      target: targetReferenceSchema,
      proposition: mathPayloadSchema,
    })
    .strict(),
  z.object({ kind: z.literal("sorry"), target: targetReferenceSchema }).strict(),
  z
    .object({
      kind: z.literal("delete-previous-move"),
      confirmDescendants: z.boolean().optional(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("backtrack"), targetNodeId: proofNodeIdSchema }).strict(),
  z
    .object({
      kind: z.literal("backtrack-with-information"),
      /** Defaults to the current node; aliases below resolve against its snapshot. */
      sourceNodeId: proofNodeIdSchema.optional(),
      sourceTarget: targetReferenceSchema.optional(),
      proposition: mathPayloadSchema,
      ancestorNodeId: proofNodeIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("replay"),
      source: z.object({ fromNodeId: proofNodeIdSchema, toNodeId: proofNodeIdSchema }).strict(),
      targetNodeId: proofNodeIdSchema.optional(),
      /** Resolved against the target node's snapshot. */
      focus: targetReferenceSchema.optional(),
      overrides: z.array(replayOverrideSchema).max(64).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("record-inquiry"),
      /** Defaults to the current node. Records reference stored identities, not aliases. */
      nodeId: proofNodeIdSchema.optional(),
      records: z.array(inquiryRecordInputSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      kind: z.literal("investigate-hypothesis"),
      nodeId: proofNodeIdSchema.optional(),
      target: targetReferenceSchema,
      hypothesis: stableIdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("extract-conditional-lemma"),
      nodeId: proofNodeIdSchema.optional(),
      target: targetReferenceSchema,
      lemma: conditionalLemmaShape.optional(),
    })
    .strict(),
  z
    .object({
      /** Decide a saved conditional-lemma draft: the acting human is the reviewer (N44). */
      kind: z.literal("review-conditional-lemma"),
      draftArtifactId: stableIdentifierSchema,
      decision: z.enum(["approved", "rejected"]),
      notes: z.string().max(4_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("add-library-result"),
      layer: libraryLayerSchema,
      /** Validated by the library admission gate in the session's operator environment. */
      artifact: z.record(z.string(), z.unknown()),
      payloadSource: payloadSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      /** Save an authored move template as a draft (validated by `@proof/moves` on approval). */
      kind: z.literal("author-move-draft"),
      template: z.record(z.string(), z.unknown()),
      payloadSource: payloadSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      /** Decide a draft: the acting human is the reviewer. */
      kind: z.literal("review-move-draft"),
      draftArtifactId: stableIdentifierSchema,
      decision: z.enum(["approved", "rejected", "changes-requested"]),
      notes: z.string().max(4_000),
      payloadSource: payloadSourceSchema.optional(),
    })
    .strict(),
] as const;

export const protocolCommandSchema = z.discriminatedUnion("kind", commandSchemas);
export type ProtocolCommand = z.infer<typeof protocolCommandSchema>;
export type ProtocolCommandKind = ProtocolCommand["kind"];

export const PROTOCOL_COMMAND_KINDS: readonly ProtocolCommandKind[] = Object.freeze(
  commandSchemas.map((schema) => schema.shape.kind.value),
);

/** Commands that act at the current node and so need `basis.nodeId` (the expected cursor). */
export const CURSOR_BOUND_COMMAND_KINDS: readonly ProtocolCommandKind[] = Object.freeze([
  "kernel-operation",
  "case-split",
  "sorry",
  "delete-previous-move",
  "backtrack",
  "backtrack-with-information",
  "replay",
]);

export const aliasBasisSchema = z
  .object({ nodeId: proofNodeIdSchema, suggestionSetId: suggestionSetIdSchema.optional() })
  .strict();
export type AliasBasis = z.infer<typeof aliasBasisSchema>;

/** One mutation, by a human or an agent, through the single command service. */
export const protocolCommandEnvelopeSchema = z
  .object({
    commandId: commandIdSchema,
    actor: protocolActorSchema,
    /** The observed node (and displayed suggestion set) that aliases and cursors refer to. */
    basis: aliasBasisSchema.optional(),
    command: protocolCommandSchema,
  })
  .strict();
export type ProtocolCommandEnvelope = z.infer<typeof protocolCommandEnvelopeSchema>;

// ---------------------------------------------------------------------------------------------
// Compact text, summaries and deltas
// ---------------------------------------------------------------------------------------------

/** A compact, LaTeX-free functional rendering of plain MathJSON: `Implies(And(P, Q), P)`. */
export function compactMathText(expression: unknown): string {
  if (typeof expression === "string") return expression;
  if (typeof expression === "number") return String(expression);
  if (Array.isArray(expression)) {
    const [head, ...operands] = expression as unknown[];
    const name = typeof head === "string" ? head : compactMathText(head);
    return `${name}(${operands.map(compactMathText).join(", ")})`;
  }
  if (isRecord(expression)) {
    if (typeof expression.sym === "string") return expression.sym;
    if (typeof expression.str === "string") return JSON.stringify(expression.str);
    if (expression.num !== undefined) return String(expression.num);
    if (Array.isArray(expression.fn)) return compactMathText(expression.fn);
  }
  return JSON.stringify(expression);
}

const compactTargetSchema = z
  .object({
    alias: snapshotAliasSchema,
    kind: z.enum(["goal", "obligation"]),
    id: stableIdentifierSchema,
    conclusion: z.string(),
    hypotheses: z.array(snapshotAliasSchema),
  })
  .strict();
export type CompactTarget = z.infer<typeof compactTargetSchema>;

const compactHypothesisSchema = z
  .object({ alias: snapshotAliasSchema, id: stableIdentifierSchema, statement: z.string() })
  .strict();

/** Open targets and hypotheses of a snapshot, with aliases and compact text. */
export function compactTargets(
  node: SnapshotView,
  table: SnapshotAliasTable = deriveSnapshotAliases(node),
): Readonly<{
  targets: readonly CompactTarget[];
  hypotheses: readonly z.infer<typeof compactHypothesisSchema>[];
}> {
  const hypothesisAlias = new Map(table.hypotheses.map(({ alias, id }) => [id, alias]));
  const statements = new Map<string, PlainMathJson>();
  const targets = (["goal", "obligation"] as const).flatMap((kind) =>
    (kind === "goal" ? node.state.goals : node.state.obligations).map((target, index) => {
      target.sequent.context.hypotheses.forEach(({ id, statement }) => {
        if (!statements.has(id)) statements.set(id, statement.expression);
      });
      return {
        alias: `${ALIAS_PREFIX[kind]}${index + 1}`,
        kind,
        id: target.id,
        conclusion: compactMathText(target.sequent.conclusion.expression),
        hypotheses: target.sequent.context.hypotheses.map(
          ({ id }) => hypothesisAlias.get(id) ?? id,
        ),
      };
    }),
  );
  const hypotheses = table.hypotheses.map(({ alias, id }) => ({
    alias,
    id,
    statement: compactMathText(statements.get(id)),
  }));
  return deepFreeze({ targets, hypotheses });
}

const compactSuggestionSchema = z
  .object({
    alias: snapshotAliasSchema,
    id: suggestionIdSchema,
    source: z.enum(["result", "move"]),
    artifactId: stableIdentifierSchema,
    patternId: stableIdentifierSchema,
    name: z.string().min(1),
    applicability: z.enum(["applicable", "requires-input"]),
    transitionClass: z.enum(["equivalence", "strengthening", "weakening"]).optional(),
  })
  .strict();
export type CompactSuggestion = z.infer<typeof compactSuggestionSchema>;

export const displayedSuggestionsViewSchema = z
  .object({
    suggestionSetId: suggestionSetIdSchema,
    /** The `suggestions-displayed` event that fixed the display order, when there is one. */
    eventSequence: z.number().int().min(1).optional(),
    suggestions: z.array(compactSuggestionSchema),
  })
  .strict();
export type DisplayedSuggestionsView = z.infer<typeof displayedSuggestionsViewSchema>;

/** The displayed suggestions of one set with their aliases, in display order. */
export function compactSuggestions(
  suggestionSet: DisplayedSuggestionSet,
  options: Readonly<{
    displayedIds?: readonly string[];
    eventSequence?: number;
    transitionClasses?: ReadonlyMap<string, "equivalence" | "strengthening" | "weakening">;
  }> = {},
): DisplayedSuggestionsView {
  const aliases = deriveSuggestionAliases(suggestionSet, options.displayedIds);
  const byId = new Map(suggestionSet.suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const suggestions = aliases.flatMap(({ alias, id }) => {
    const suggestion = byId.get(id as DisplayedSuggestionSet["suggestions"][number]["id"]);
    if (suggestion === undefined) return [];
    const transitionClass = options.transitionClasses?.get(id);
    return [
      {
        alias,
        id: suggestion.id,
        source: suggestion.source,
        artifactId: suggestion.artifactId,
        patternId: suggestion.patternId,
        name: suggestion.name,
        applicability: suggestion.applicability,
        ...(transitionClass === undefined ? {} : { transitionClass }),
      },
    ];
  });
  return deepFreeze({
    suggestionSetId: suggestionSet.id,
    ...(options.eventSequence === undefined ? {} : { eventSequence: options.eventSequence }),
    suggestions,
  }) as DisplayedSuggestionsView;
}

/** Compact summary lines: no LaTeX and no MathJSON, one line per target, hypothesis, suggestion. */
export function summarizeSnapshot(
  node: SnapshotView,
  displayed?: DisplayedSuggestionsView,
): readonly string[] {
  const table = deriveSnapshotAliases(node);
  const { targets, hypotheses } = compactTargets(node, table);
  const lines = [
    `node ${node.id} state ${node.state.id}: ${node.state.goals.length} goal(s), ${node.state.obligations.length} obligation(s)`,
    ...targets.map(
      (target) =>
        `${target.alias} ${target.kind} ${target.id}: ${target.conclusion}` +
        (target.hypotheses.length === 0 ? "" : ` [${target.hypotheses.join(" ")}]`),
    ),
    ...hypotheses.map(
      (hypothesis) => `${hypothesis.alias} ${hypothesis.id}: ${hypothesis.statement}`,
    ),
    ...(node.state.assumptions ?? []).map(
      (assumption) =>
        `assumption ${assumption.id} (${assumption.origin.kind}): ${compactMathText(assumption.statement.expression)}`,
    ),
  ];
  if (node.state.goals.length === 0 && node.state.obligations.length === 0) {
    lines.push("no open targets");
  }
  if (displayed !== undefined) {
    lines.push(`displayed ${displayed.suggestionSetId}:`);
    displayed.suggestions.forEach((suggestion) =>
      lines.push(
        `${suggestion.alias} ${suggestion.source} ${suggestion.artifactId} "${suggestion.name}" ${suggestion.applicability}` +
          (suggestion.transitionClass === undefined ? "" : ` ${suggestion.transitionClass}`),
      ),
    );
  }
  return Object.freeze(lines);
}

const compactCollectionDeltaSchema = z
  .object({
    added: z.array(compactTargetSchema),
    removed: z.array(stableIdentifierSchema),
    updated: z.array(compactTargetSchema),
  })
  .strict();

/** The change between two stored snapshots, with the aliases of the later one. */
export const snapshotDeltaSchema = z
  .object({
    from: z.object({ nodeId: proofNodeIdSchema, stateId: proofStateIdSchema }).strict(),
    to: z.object({ nodeId: proofNodeIdSchema, stateId: proofStateIdSchema }).strict(),
    goals: compactCollectionDeltaSchema,
    obligations: compactCollectionDeltaSchema,
    assumptionsAdded: z.array(stableIdentifierSchema),
    assumptionsRemoved: z.array(stableIdentifierSchema),
  })
  .strict();
export type SnapshotDelta = z.infer<typeof snapshotDeltaSchema>;

/** Compare two stored snapshots by statement identity; no history is recomputed. */
export function snapshotDelta(from: SnapshotView, to: SnapshotView): SnapshotDelta {
  const table = deriveSnapshotAliases(to);
  const { targets } = compactTargets(to, table);
  const collection = (kind: "goal" | "obligation") => {
    const before = new Map(
      (kind === "goal" ? from.state.goals : from.state.obligations).map((entry) => [
        entry.id,
        canonicalJson(entry),
      ]),
    );
    const after = kind === "goal" ? to.state.goals : to.state.obligations;
    const afterIds = new Set(after.map(({ id }) => id));
    const compact = new Map(
      targets.filter((target) => target.kind === kind).map((target) => [target.id, target]),
    );
    const added: CompactTarget[] = [];
    const updated: CompactTarget[] = [];
    for (const entry of after) {
      const target = compact.get(entry.id);
      if (target === undefined) continue;
      const previous = before.get(entry.id);
      if (previous === undefined) added.push(target);
      else if (previous !== canonicalJson(entry)) updated.push(target);
    }
    return {
      added,
      removed: [...before.keys()].filter((id) => !afterIds.has(id)),
      updated,
    };
  };
  const assumptionIds = (node: SnapshotView) => (node.state.assumptions ?? []).map(({ id }) => id);
  const beforeAssumptions = new Set(assumptionIds(from));
  const afterAssumptions = new Set(assumptionIds(to));
  return deepFreeze({
    from: { nodeId: from.id, stateId: from.state.id },
    to: { nodeId: to.id, stateId: to.state.id },
    goals: collection("goal"),
    obligations: collection("obligation"),
    assumptionsAdded: [...afterAssumptions].filter((id) => !beforeAssumptions.has(id)),
    assumptionsRemoved: [...beforeAssumptions].filter((id) => !afterAssumptions.has(id)),
  }) as SnapshotDelta;
}

/** Statement-ID summary of a snapshot delta, in the kernel's `ProofStateDelta` shape. */
export function snapshotDeltaIds(delta: SnapshotDelta): ProofStateDelta {
  const ids = (collection: SnapshotDelta["goals"]) => ({
    added: collection.added.map(({ id }) => id),
    removed: collection.removed,
    updated: collection.updated.map(({ id }) => id),
  });
  return { goals: ids(delta.goals), obligations: ids(delta.obligations) } as ProofStateDelta;
}

// ---------------------------------------------------------------------------------------------
// Responses and observations
// ---------------------------------------------------------------------------------------------

export const protocolCursorSchema = z
  .object({
    nodeId: proofNodeIdSchema,
    stateId: proofStateIdSchema,
    /** The last interaction-event sequence of the session (0 when none). */
    eventSequence: z.number().int().nonnegative(),
    /** The last inquiry-record sequence of the session (0 when none). */
    inquirySequence: z.number().int().nonnegative(),
  })
  .strict();
export type ProtocolCursor = z.infer<typeof protocolCursorSchema>;

export const protocolDiagnosticsResponseSchema = z
  .object({
    diagnostics: z.tuple([
      z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
    ]),
  })
  .strict();

/** A committed (or replayed) envelope command. `result` is the dispatched command's payload. */
export const protocolCommandResponseSchema = z
  .object({
    commandId: commandIdSchema,
    kind: z.enum(PROTOCOL_COMMAND_KINDS as [ProtocolCommandKind, ...ProtocolCommandKind[]]),
    actor: protocolActorSchema,
    replayed: z.boolean(),
    cursor: protocolCursorSchema,
    aliases: snapshotAliasTableSchema,
    /** From the node current before the command to the node current after it. */
    delta: snapshotDeltaSchema,
    result: z.record(z.string(), z.unknown()),
  })
  .strict();
export type ProtocolCommandResponse = z.infer<typeof protocolCommandResponseSchema>;

export const aliasedParameterMenuSchema = z
  .object({
    parameterId: menuParameterIdSchema,
    label: z.string().min(1),
    automatic: z.boolean(),
    items: z.array(parameterMenuItemSchema.extend({ alias: snapshotAliasSchema })),
  })
  .strict();

/** A preview or apply whose move still needs menu choices; nothing was recorded. */
export const protocolRequiresInputResponseSchema = z
  .object({
    status: z.literal("requires-input"),
    commandId: commandIdSchema,
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
    menus: z.array(aliasedParameterMenuSchema),
    missingParameters: z.array(menuParameterIdSchema).min(1),
    diagnostics: z.tuple([
      z.object({ code: z.literal("requires-input"), message: z.string().min(1) }).strict(),
    ]),
  })
  .strict();
export type ProtocolRequiresInputResponse = z.infer<typeof protocolRequiresInputResponseSchema>;

/** Menus with their per-parameter item aliases. */
export function aliasMenus(
  menus: readonly ParameterMenuRecord[],
): z.infer<typeof aliasedParameterMenuSchema>[] {
  return menus.map((menu) => ({
    ...menu,
    items: menu.items.map((item, index) => ({ ...item, alias: `m${index + 1}` })),
  }));
}

const observedSessionSchema = z
  .object({
    id: stableIdentifierSchema,
    rootNodeId: proofNodeIdSchema,
    currentNodeId: proofNodeIdSchema,
  })
  .strict();

export const observeViewSchema = z.enum(["full", "summary", "delta"]);
export type ObserveView = z.infer<typeof observeViewSchema>;

/** `view=full`: the stored snapshot, aliases, open targets and the displayed suggestions. */
export const observeFullResponseSchema = z
  .object({
    view: z.literal("full"),
    session: observedSessionSchema,
    /** Validated by the caller with `createProofNodeSchema({ operators })`. */
    node: z.unknown(),
    aliases: snapshotAliasTableSchema,
    targets: z.array(compactTargetSchema),
    hypotheses: z.array(compactHypothesisSchema),
    displayed: displayedSuggestionsViewSchema.optional(),
    cursor: protocolCursorSchema,
  })
  .strict();

/** `view=summary`: compact text only. */
export const observeSummaryResponseSchema = z
  .object({
    view: z.literal("summary"),
    session: observedSessionSchema,
    lines: z.array(z.string()),
    cursor: protocolCursorSchema,
  })
  .strict();

/** `view=delta`: what changed since a node and event/inquiry sequences an earlier cursor named. */
export const observeDeltaResponseSchema = z
  .object({
    view: z.literal("delta"),
    session: observedSessionSchema,
    /** How the current node relates to the `since` node in the discovery tree. */
    relation: z.enum(["same", "descendant", "ancestor", "other"]),
    /** Edges from the `since` node down to the current node (descendant only). */
    path: z.array(
      z
        .object({
          edgeId: stableIdentifierSchema,
          commandId: commandIdSchema,
          childNodeId: proofNodeIdSchema,
          moveId: stableIdentifierSchema.optional(),
          transitionClass: z.enum(["equivalence", "strengthening", "weakening"]),
        })
        .strict(),
    ),
    delta: snapshotDeltaSchema,
    aliases: snapshotAliasTableSchema,
    interactionEvents: z.array(
      z
        .object({
          sequence: z.number().int().min(1),
          id: stableIdentifierSchema,
          kind: z.string().min(1),
          nodeId: proofNodeIdSchema,
          actor: protocolActorSchema,
        })
        .strict(),
    ),
    inquiryRecords: z.array(
      z
        .object({
          sequence: z.number().int().min(1),
          id: stableIdentifierSchema,
          kind: z.enum(INQUIRY_RECORD_KINDS),
          nodeId: proofNodeIdSchema,
          actor: protocolActorSchema,
        })
        .strict(),
    ),
    cursor: protocolCursorSchema,
  })
  .strict();

export const observeResponseSchema = z.discriminatedUnion("view", [
  observeFullResponseSchema,
  observeSummaryResponseSchema,
  observeDeltaResponseSchema,
]);
export type ObserveResponse = z.infer<typeof observeResponseSchema>;

/** Query of `GET …/observe`: `view`, and for a delta `sinceNode`, `afterEvent`, `afterInquiry`. */
export const observeQuerySchema = z
  .object({
    view: observeViewSchema.default("full"),
    sinceNode: proofNodeIdSchema.optional(),
    afterEvent: z.number().int().nonnegative().optional(),
    afterInquiry: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((query, context) => {
    const deltaOnly =
      query.sinceNode !== undefined ||
      query.afterEvent !== undefined ||
      query.afterInquiry !== undefined;
    if (query.view === "delta" && query.sinceNode === undefined) {
      context.addIssue({ code: "custom", message: "A delta observation needs sinceNode." });
    }
    if (query.view !== "delta" && deltaOnly) {
      context.addIssue({ code: "custom", message: "Only a delta observation takes a cursor." });
    }
  });
export type ObserveQuery = z.infer<typeof observeQuerySchema>;

// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((child) => deepFreeze(child));
  }
  return value;
}
