/**
 * Strict runtime parsing of kernel operations and their targets. A kernel operation is parsed in
 * fixed phases, and the first failing phase decides the diagnostic: the shape of the object, its
 * exact key set, the base fields, the validity of each field present, and last the construction of
 * the detached operation. The field checks run in a fixed order across all kinds; a kind only has
 * the fields its key set allows.
 */
import {
  assumptionIdSchema,
  attestationIdSchema,
  plainMathJsonSchema,
  proofStateIdSchema,
  stableIdentifierSchema,
  statementIdSchema,
} from "@proof/mathjson-model";
import { CONSTRUCTION_OPERATION_KINDS, parseConstructionOperation } from "./constructions";
import {
  copyRewriteLens,
  isRewriteLens,
  parseRewriteSource,
  type RewriteLens,
  type RewriteSource,
} from "./deep-rewrite";
import type {
  KernelOperation,
  KernelOperationKind,
  OperationBase,
  TransitionStatementTarget,
  TransitionTarget,
} from "./index";
import {
  copyInstantiation,
  copyOperandPath,
  copyOptionalStatementIds,
  copyPlainMathJson,
  copyStatementIdPair,
  copyStatementIds,
  isInstantiation,
  isOperandPath,
  isOptionalStatementIdArray,
  isStatementIdArray,
  optionalDeclarationId,
  optionalStatementId,
} from "./operation-fields";
import type { OperationOfKind } from "./operations/shared";
import { kernelResultIdSchema } from "./results";
import { hasExactKeys, isStrictRecord } from "./runtime";
import {
  createRuntimeSchema,
  runtimeFailure,
  type RuntimeParseResult,
  type RuntimeSchema,
} from "./runtime-schema";

export const transitionTargetSchema: RuntimeSchema<TransitionTarget> =
  createRuntimeSchema(parseTransitionTarget);
export const transitionStatementTargetSchema: RuntimeSchema<TransitionStatementTarget> =
  createRuntimeSchema(parseTransitionStatementTarget);
export const kernelOperationSchema: RuntimeSchema<KernelOperation> =
  createRuntimeSchema(parseKernelOperation);

type Fields = Readonly<Record<string, unknown>>;

function parseTransitionTarget(value: unknown): RuntimeParseResult<TransitionTarget> {
  if (!isStrictRecord(value) || !hasExactKeys(value, ["kind", "id"])) {
    return runtimeFailure("A transition target must be a strict goal or obligation target.", []);
  }
  if (value.kind !== "goal" && value.kind !== "obligation") {
    return runtimeFailure("A transition target kind must be goal or obligation.", ["kind"]);
  }
  const id = statementIdSchema.safeParse(value.id);
  if (!id.success) return runtimeFailure("A transition target requires a stable ID.", ["id"]);
  return { success: true, data: { kind: value.kind, id: id.data } };
}

function parseTransitionStatementTarget(
  value: unknown,
): RuntimeParseResult<TransitionStatementTarget> {
  if (!isStrictRecord(value) || typeof value.kind !== "string") {
    return runtimeFailure("A statement target must be a strict discriminated object.", []);
  }
  if (value.kind === "conclusion") {
    return hasExactKeys(value, ["kind"])
      ? { success: true, data: { kind: "conclusion" } }
      : runtimeFailure("A conclusion target contains unknown fields.", []);
  }
  if (value.kind !== "hypothesis" || !hasExactKeys(value, ["kind", "id"])) {
    return runtimeFailure("A statement target must identify a conclusion or hypothesis.", []);
  }
  const id = statementIdSchema.safeParse(value.id);
  return id.success
    ? { success: true, data: { kind: "hypothesis", id: id.data } }
    : runtimeFailure("A hypothesis statement target requires a stable ID.", ["id"]);
}

type RewriteKind =
  "rewrite-with-equality" | "rewrite-with-equivalence" | "rewrite-with-implication";

/** Rewrites accept one optional field: an associative lens under `path`. */
const REWRITE_OPERATION_KINDS: ReadonlySet<string> = new Set<KernelOperationKind>([
  "rewrite-with-equality",
  "rewrite-with-equivalence",
  "rewrite-with-implication",
]);

function isRewriteKind(kind: KernelOperationKind): kind is RewriteKind {
  return REWRITE_OPERATION_KINDS.has(kind);
}

/** Typed quantifier binders add optional IDs for the declaration, hypothesis or obligation they create. */
const TYPED_BINDER_FIELDS: Readonly<Partial<Record<KernelOperationKind, readonly string[]>>> = {
  "introduce-universal": ["parameterDeclarationId", "membershipHypothesisId"],
  "instantiate-universal-hypothesis": ["membershipObligationId"],
  "unpack-existential-hypothesis": ["witnessDeclarationId", "membershipHypothesisId"],
};

/**
 * The required fields of each kernel operation kind beyond the base fields. The table has exactly
 * the kernel operation kinds, so it also decides whether a kind is a kernel kind.
 */
const OPERATION_FIELDS: Readonly<Record<KernelOperationKind, readonly string[]>> = {
  "close-by-hypothesis": ["hypothesisId"],
  "close-true": [],
  "close-false-hypothesis": ["hypothesisId"],
  "close-reflexive-equality": [],
  "close-by-contradiction": ["hypothesisId", "negationHypothesisId"],
  "close-by-accepted-inference": ["attestationId"],
  "introduce-implication": ["hypothesisId"],
  "introduce-negation": ["hypothesisId"],
  "split-goal-conjunction": ["childIds"],
  "choose-goal-disjunct": ["disjunctIndex"],
  "expand-hypothesis-conjunction": ["hypothesisId", "expandedHypothesisIds"],
  "split-hypothesis-disjunction": ["hypothesisId", "childIds", "branchHypothesisIds"],
  "split-classical-cases": ["proposition", "childIds", "branchHypothesisIds"],
  "assume-hypothesis": ["proposition", "hypothesisId"],
  "replace-goal": ["proposition"],
  suffices: ["proposition", "obligationId"],
  "drop-hypothesis": ["hypothesisId"],
  "apply-implication-hypothesis": [
    "implicationHypothesisId",
    "antecedentHypothesisId",
    "resultHypothesisId",
  ],
  "introduce-universal": [],
  "instantiate-universal-hypothesis": ["hypothesisId", "term", "resultHypothesisId"],
  "choose-existential-witness": ["witness"],
  "unpack-existential-hypothesis": ["hypothesisId", "resultHypothesisId"],
  "rewrite-with-equality": ["equalityHypothesisId", "statement", "path", "direction"],
  "rewrite-with-equivalence": ["statement", "path", "source", "direction"],
  "rewrite-with-implication": ["statement", "path", "source"],
  "apply-result-backward": ["resultId", "instantiation", "premiseTargetIds"],
  "apply-result-forward": [
    "resultId",
    "instantiation",
    "premiseHypothesisIds",
    "resultHypothesisId",
    "obligationIds",
  ],
  "mark-sorry": ["assumptionId"],
  "close-by-assumption": ["assumptionId", "instantiation"],
};

function parseKernelOperation(value: unknown): RuntimeParseResult<KernelOperation> {
  if (!isStrictRecord(value) || typeof value.kind !== "string") {
    return runtimeFailure("A kernel operation must be a strict discriminated object.", []);
  }
  if ((CONSTRUCTION_OPERATION_KINDS as readonly string[]).includes(value.kind)) {
    return parseConstructionKind(value);
  }
  if (!Object.hasOwn(OPERATION_FIELDS, value.kind)) {
    return runtimeFailure("The kernel operation kind is unknown.", ["kind"]);
  }
  const kind = value.kind as KernelOperationKind;
  if (!hasExactKeys(value, operationKeys(value, kind))) {
    return runtimeFailure("The kernel operation contains missing or unknown fields.", []);
  }

  const base = parseOperationBase(value);
  if (!base.success) return base;
  const invalid = checkCommonFields(value);
  if (invalid !== undefined) return invalid;
  if (isRewriteKind(kind)) return parseRewriteOperation(kind, value, base.data);
  return { success: true, data: OPERATION_BUILDERS[kind](value, base.data) };
}

/** A construction-task operation is parsed by the construction module on top of the base fields. */
function parseConstructionKind(value: Fields): RuntimeParseResult<KernelOperation> {
  const constructionBase = parseOperationBase(value);
  if (!constructionBase.success) return constructionBase;
  const parsed = parseConstructionOperation(value, constructionBase.data);
  return parsed.ok
    ? { success: true, data: parsed.operation }
    : runtimeFailure(parsed.message, parsed.path);
}

/** The exact key set of an operation of this kind, including the optional fields it carries. */
function operationKeys(value: Fields, kind: KernelOperationKind): string[] {
  const hasLens = REWRITE_OPERATION_KINDS.has(kind) && Object.hasOwn(value, "lens");
  // A sorry accepts one optional field: an external sorry reference.
  const hasSorryId = kind === "mark-sorry" && Object.hasOwn(value, "sorryId");
  const typedBinderKeys = (TYPED_BINDER_FIELDS[kind] ?? []).filter((key) =>
    Object.hasOwn(value, key),
  );
  return [
    "kind",
    "expectedStateId",
    "resultStateId",
    "target",
    ...OPERATION_FIELDS[kind],
    ...(hasLens ? ["lens"] : []),
    ...(hasSorryId ? ["sorryId"] : []),
    ...typedBinderKeys,
  ];
}

function parseOperationBase(value: Fields): RuntimeParseResult<OperationBase> {
  const expectedStateId = proofStateIdSchema.safeParse(value.expectedStateId);
  if (!expectedStateId.success) {
    return runtimeFailure("The expected state ID is invalid.", ["expectedStateId"]);
  }
  const resultStateId = proofStateIdSchema.safeParse(value.resultStateId);
  if (!resultStateId.success) {
    return runtimeFailure("The result state ID is invalid.", ["resultStateId"]);
  }
  const target = transitionTargetSchema.safeParse(value.target);
  if (!target.success) {
    return runtimeFailure(target.error.issues[0]?.message ?? "The target is invalid.", ["target"]);
  }
  return {
    success: true,
    data: {
      expectedStateId: expectedStateId.data,
      resultStateId: resultStateId.data,
      target: target.data,
    },
  };
}

/**
 * Validate every field present, in a fixed order across all kinds (the key set has already
 * limited each kind to its own fields). The first invalid field decides the diagnostic.
 */
function checkCommonFields(value: Fields): RuntimeParseResult<never> | undefined {
  return (
    checkIdentifierFields(value) ??
    checkSplitIdLists(value) ??
    checkResultFields(value) ??
    checkClassicalCaseLists(value) ??
    checkExpressionFields(value)
  );
}

function checkIdentifierFields(value: Fields): RuntimeParseResult<never> | undefined {
  for (const field of [
    "hypothesisId",
    "implicationHypothesisId",
    "antecedentHypothesisId",
    "resultHypothesisId",
    "equalityHypothesisId",
    "negationHypothesisId",
    "obligationId",
  ] as const) {
    if (field in value && !statementIdSchema.safeParse(value[field]).success) {
      return runtimeFailure("The statement ID is invalid.", [field]);
    }
  }
  if ("assumptionId" in value && !assumptionIdSchema.safeParse(value.assumptionId).success) {
    return runtimeFailure("The assumption ID is invalid.", ["assumptionId"]);
  }
  const hasSorryId = value.kind === "mark-sorry" && Object.hasOwn(value, "sorryId");
  if (hasSorryId && !stableIdentifierSchema.safeParse(value.sorryId).success) {
    return runtimeFailure("The sorry ID is invalid.", ["sorryId"]);
  }
  if ("attestationId" in value && !attestationIdSchema.safeParse(value.attestationId).success) {
    return runtimeFailure("The attestation ID is invalid.", ["attestationId"]);
  }
  return undefined;
}

/** The ID lists of a split or expansion, each with at least two IDs. */
function checkSplitIdLists(value: Fields): RuntimeParseResult<never> | undefined {
  for (const field of ["childIds", "expandedHypothesisIds", "branchHypothesisIds"] as const) {
    if (field in value && !isStatementIdArray(value[field])) {
      return runtimeFailure("An ID list requires at least two stable, dense IDs.", [field]);
    }
  }
  return undefined;
}

/** The result ID, its instantiation and the ID lists of a result application. */
function checkResultFields(value: Fields): RuntimeParseResult<never> | undefined {
  if ("resultId" in value && !kernelResultIdSchema.safeParse(value.resultId).success) {
    return runtimeFailure("The result ID is invalid.", ["resultId"]);
  }
  if ("instantiation" in value && !isInstantiation(value.instantiation)) {
    return runtimeFailure("An instantiation must map parameter symbols to plain MathJSON terms.", [
      "instantiation",
    ]);
  }
  for (const field of ["premiseTargetIds", "obligationIds"] as const) {
    if (field in value && !isStatementIdArray(value[field], 0)) {
      return runtimeFailure("An ID list must contain stable, dense IDs.", [field]);
    }
  }
  if ("premiseHypothesisIds" in value && !isOptionalStatementIdArray(value.premiseHypothesisIds)) {
    return runtimeFailure("Premise hypothesis entries must be stable IDs or null.", [
      "premiseHypothesisIds",
    ]);
  }
  return undefined;
}

function checkClassicalCaseLists(value: Fields): RuntimeParseResult<never> | undefined {
  if (
    value.kind === "split-classical-cases" &&
    ((value.childIds as readonly unknown[]).length !== 2 ||
      (value.branchHypothesisIds as readonly unknown[]).length !== 2)
  ) {
    return runtimeFailure("A classical case split requires exactly two IDs in each list.", []);
  }
  return undefined;
}

/** The disjunct index and the plain MathJSON expressions of an operation. */
function checkExpressionFields(value: Fields): RuntimeParseResult<never> | undefined {
  if (
    "disjunctIndex" in value &&
    (typeof value.disjunctIndex !== "number" ||
      !Number.isInteger(value.disjunctIndex) ||
      value.disjunctIndex < 0)
  ) {
    return runtimeFailure("A disjunct index must be a nonnegative integer.", ["disjunctIndex"]);
  }
  for (const field of ["term", "witness", "proposition"] as const) {
    if (field in value && !plainMathJsonSchema.safeParse(value[field]).success) {
      return runtimeFailure("An expression must be serializable plain MathJSON.", [field]);
    }
  }
  return undefined;
}

type PlainKind = Exclude<KernelOperationKind, RewriteKind>;
type OperationBuilder<Kind extends PlainKind> = (
  value: Fields,
  common: OperationBase,
) => OperationOfKind<Kind>;

/** Build the detached operation of each kind from its validated fields. */
const OPERATION_BUILDERS: { readonly [Kind in PlainKind]: OperationBuilder<Kind> } = {
  "close-by-hypothesis": (value, common) => ({
    ...common,
    kind: "close-by-hypothesis",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
  }),
  "close-true": (_value, common) => ({ ...common, kind: "close-true" }),
  "close-false-hypothesis": (value, common) => ({
    ...common,
    kind: "close-false-hypothesis",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
  }),
  "close-reflexive-equality": (_value, common) => ({ ...common, kind: "close-reflexive-equality" }),
  "close-by-contradiction": (value, common) => ({
    ...common,
    kind: "close-by-contradiction",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
    negationHypothesisId: statementIdSchema.parse(value.negationHypothesisId),
  }),
  "close-by-accepted-inference": (value, common) => ({
    ...common,
    kind: "close-by-accepted-inference",
    attestationId: attestationIdSchema.parse(value.attestationId),
  }),
  "introduce-implication": (value, common) => ({
    ...common,
    kind: "introduce-implication",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
  }),
  "introduce-negation": (value, common) => ({
    ...common,
    kind: "introduce-negation",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
  }),
  "split-goal-conjunction": (value, common) => ({
    ...common,
    kind: "split-goal-conjunction",
    childIds: copyStatementIds(value.childIds),
  }),
  "choose-goal-disjunct": (value, common) => ({
    ...common,
    kind: "choose-goal-disjunct",
    disjunctIndex: value.disjunctIndex as number,
  }),
  "expand-hypothesis-conjunction": (value, common) => ({
    ...common,
    kind: "expand-hypothesis-conjunction",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
    expandedHypothesisIds: copyStatementIds(value.expandedHypothesisIds),
  }),
  "split-hypothesis-disjunction": (value, common) => ({
    ...common,
    kind: "split-hypothesis-disjunction",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
    childIds: copyStatementIds(value.childIds),
    branchHypothesisIds: copyStatementIds(value.branchHypothesisIds),
  }),
  "split-classical-cases": (value, common) => ({
    ...common,
    kind: "split-classical-cases",
    proposition: copyPlainMathJson(value.proposition),
    childIds: copyStatementIdPair(value.childIds),
    branchHypothesisIds: copyStatementIdPair(value.branchHypothesisIds),
  }),
  "assume-hypothesis": (value, common) => ({
    ...common,
    kind: "assume-hypothesis",
    proposition: copyPlainMathJson(value.proposition),
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
  }),
  "replace-goal": (value, common) => ({
    ...common,
    kind: "replace-goal",
    proposition: copyPlainMathJson(value.proposition),
  }),
  suffices: (value, common) => ({
    ...common,
    kind: "suffices",
    proposition: copyPlainMathJson(value.proposition),
    obligationId: statementIdSchema.parse(value.obligationId),
  }),
  "drop-hypothesis": (value, common) => ({
    ...common,
    kind: "drop-hypothesis",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
  }),
  "apply-implication-hypothesis": (value, common) => ({
    ...common,
    kind: "apply-implication-hypothesis",
    implicationHypothesisId: statementIdSchema.parse(value.implicationHypothesisId),
    antecedentHypothesisId: statementIdSchema.parse(value.antecedentHypothesisId),
    resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
  }),
  "introduce-universal": (value, common) => ({
    ...common,
    kind: "introduce-universal",
    ...optionalDeclarationId(value, "parameterDeclarationId"),
    ...optionalStatementId(value, "membershipHypothesisId"),
  }),
  "instantiate-universal-hypothesis": (value, common) => ({
    ...common,
    kind: "instantiate-universal-hypothesis",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
    term: copyPlainMathJson(value.term),
    resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
    ...optionalStatementId(value, "membershipObligationId"),
  }),
  "choose-existential-witness": (value, common) => ({
    ...common,
    kind: "choose-existential-witness",
    witness: copyPlainMathJson(value.witness),
  }),
  "unpack-existential-hypothesis": (value, common) => ({
    ...common,
    kind: "unpack-existential-hypothesis",
    hypothesisId: statementIdSchema.parse(value.hypothesisId),
    resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
    ...optionalDeclarationId(value, "witnessDeclarationId"),
    ...optionalStatementId(value, "membershipHypothesisId"),
  }),
  "apply-result-backward": (value, common) => ({
    ...common,
    kind: "apply-result-backward",
    resultId: kernelResultIdSchema.parse(value.resultId),
    instantiation: copyInstantiation(value.instantiation),
    premiseTargetIds: copyStatementIds(value.premiseTargetIds),
  }),
  "apply-result-forward": (value, common) => ({
    ...common,
    kind: "apply-result-forward",
    resultId: kernelResultIdSchema.parse(value.resultId),
    instantiation: copyInstantiation(value.instantiation),
    premiseHypothesisIds: copyOptionalStatementIds(value.premiseHypothesisIds),
    resultHypothesisId: statementIdSchema.parse(value.resultHypothesisId),
    obligationIds: copyStatementIds(value.obligationIds),
  }),
  "mark-sorry": (value, common) => ({
    ...common,
    kind: "mark-sorry",
    assumptionId: assumptionIdSchema.parse(value.assumptionId),
    ...(Object.hasOwn(value, "sorryId")
      ? { sorryId: stableIdentifierSchema.parse(value.sorryId) }
      : {}),
  }),
  "close-by-assumption": (value, common) => ({
    ...common,
    kind: "close-by-assumption",
    assumptionId: assumptionIdSchema.parse(value.assumptionId),
    instantiation: copyInstantiation(value.instantiation),
  }),
};

type RewriteFields = Readonly<{
  statement: TransitionStatementTarget | undefined;
  source: RewriteSource | undefined;
  lens: Readonly<{ lens?: RewriteLens }>;
}>;

/** Validate the fields only rewrites have, in order: path, direction, statement, lens, source. */
function readRewriteFields(value: Fields): RuntimeParseResult<RewriteFields> {
  if ("path" in value && !isOperandPath(value.path)) {
    return runtimeFailure("A rewrite path must be a dense list of operand indices.", ["path"]);
  }
  if ("direction" in value && value.direction !== "forward" && value.direction !== "backward") {
    return runtimeFailure("A rewrite direction must be forward or backward.", ["direction"]);
  }
  const statement =
    "statement" in value ? transitionStatementTargetSchema.safeParse(value.statement) : undefined;
  if (statement !== undefined && !statement.success) {
    return runtimeFailure("The rewrite statement target is invalid.", ["statement"]);
  }
  const hasLens = Object.hasOwn(value, "lens");
  if (hasLens && !isRewriteLens(value.lens)) {
    return runtimeFailure(
      "A rewrite lens must contain exactly startOperand and endOperand covering at least two operands.",
      ["lens"],
    );
  }
  const lens: Readonly<{ lens?: RewriteLens }> = hasLens
    ? { lens: copyRewriteLens(value.lens) }
    : {};
  const source =
    "source" in value
      ? parseRewriteSource(value.source, isInstantiation, copyInstantiation)
      : undefined;
  if ("source" in value && source === undefined) {
    return runtimeFailure(
      "A rewrite source must be a hypothesis ID or a result ID with an instantiation.",
      ["source"],
    );
  }
  return { success: true, data: { statement: statement?.data, source, lens } };
}

function parseRewriteOperation(
  kind: RewriteKind,
  value: Fields,
  common: OperationBase,
): RuntimeParseResult<KernelOperation> {
  const fields = readRewriteFields(value);
  if (!fields.success) return fields;
  const { statement, source, lens } = fields.data;
  switch (kind) {
    case "rewrite-with-equality":
      if (statement === undefined) {
        return runtimeFailure("The rewrite statement target is invalid.", ["statement"]);
      }
      return {
        success: true,
        data: {
          ...common,
          kind,
          equalityHypothesisId: statementIdSchema.parse(value.equalityHypothesisId),
          statement,
          path: copyOperandPath(value.path),
          ...lens,
          direction: value.direction as "forward" | "backward",
        },
      };
    case "rewrite-with-equivalence":
    case "rewrite-with-implication": {
      if (statement === undefined || source === undefined) {
        return runtimeFailure("The rewrite statement target or source is invalid.", []);
      }
      const rewrite = {
        ...common,
        statement,
        path: copyOperandPath(value.path),
        ...lens,
        source,
      };
      return kind === "rewrite-with-implication"
        ? { success: true, data: { ...rewrite, kind } }
        : {
            success: true,
            data: {
              ...rewrite,
              kind,
              direction: value.direction as "forward" | "backward",
            },
          };
    }
  }
}
