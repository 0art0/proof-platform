import {
  createStatementViewSchema,
  freeSymbolNames,
  operatorDeclarationsSchema,
  plainMathJsonSchema,
  stableIdentifierSchema,
  universalParameterDeclarationSchema,
  type OperatorDeclaration,
  type StatementView,
  type UniversalParameterDeclaration,
} from "@proof/mathjson-model";
import { z } from "zod";

export const libraryArtifactKindSchema = z.enum(["definition", "result", "technique", "move"]);
export type LibraryArtifactKind = z.infer<typeof libraryArtifactKindSchema>;

export const libraryArtifactIdSchema = stableIdentifierSchema.brand("LibraryArtifactId");
export type LibraryArtifactId = z.infer<typeof libraryArtifactIdSchema>;
export const variantFamilyIdSchema = stableIdentifierSchema.brand("VariantFamilyId");
export type VariantFamilyId = z.infer<typeof variantFamilyIdSchema>;

export const libraryLayerSchema = z.enum([
  "global",
  "initial-problem",
  "proof-time-background",
  "derived",
  "move-discovery-draft",
]);
export type LibraryLayer = z.infer<typeof libraryLayerSchema>;

export const applicationDirectionSchema = z.enum(["forward", "backward"]);
export type ApplicationDirection = z.infer<typeof applicationDirectionSchema>;

export const deterministicRenderingsSchema = z
  .object({ latex: z.string().min(1), naturalLanguage: z.string().min(1) })
  .strict();
export type DeterministicRenderings = z.infer<typeof deterministicRenderingsSchema>;

export const backgroundClassificationSchema = z
  .object({
    domains: z.array(z.string().min(1)).min(1),
    level: z.string().min(1),
  })
  .strict()
  .superRefine((classification, context) => {
    addDuplicateStringIssues(classification.domains, "domain", context, ["domains"]);
  });
export type BackgroundClassification = z.infer<typeof backgroundClassificationSchema>;

export const libraryProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("curated"), source: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("imported"), source: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("generated"),
      role: z.string().min(1),
      contextId: stableIdentifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("derived"),
      sessionId: stableIdentifierSchema,
      proofNodeId: stableIdentifierSchema,
    })
    .strict(),
]);
export type LibraryProvenance = z.infer<typeof libraryProvenanceSchema>;

export const libraryApprovalSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }).strict(),
  z.object({ status: z.literal("rejected"), reason: z.string().min(1) }).strict(),
  z
    .object({
      status: z.literal("approved"),
      reviewerId: stableIdentifierSchema,
    })
    .strict(),
]);
export type LibraryApproval = z.infer<typeof libraryApprovalSchema>;

export const libraryArtifactReferenceSchema = z
  .object({ kind: libraryArtifactKindSchema, id: libraryArtifactIdSchema })
  .strict();
export type LibraryArtifactReference = z.infer<typeof libraryArtifactReferenceSchema>;

export const applicationRequirementSchema = z
  .object({
    section: z.enum(["goal", "hypothesis", "obligation", "any"]),
    polarity: z.enum(["positive", "negative", "mixed", "neutral", "any"]),
    role: z.enum(["proposition", "term", "binder", "any"]),
  })
  .strict();
export type ApplicationRequirement = z.infer<typeof applicationRequirementSchema>;

export const resultPatternSchema = z
  .object({
    id: stableIdentifierSchema,
    expression: plainMathJsonSchema,
    direction: applicationDirectionSchema,
    requirement: applicationRequirementSchema,
  })
  .strict();
export type ResultPattern = z.infer<typeof resultPatternSchema>;

const statementShapeSchema = z.object({ expression: plainMathJsonSchema }).strict();

export const resultSideConditionSchema = z
  .object({
    id: stableIdentifierSchema,
    description: z.string().min(1),
    statement: statementShapeSchema.optional(),
  })
  .strict();
export type ResultSideCondition = z.infer<typeof resultSideConditionSchema>;

type LibraryArtifactCommon = Readonly<{
  id: LibraryArtifactId;
  name: string;
  description: string;
  renderings: DeterministicRenderings;
  classification: BackgroundClassification;
  provenance: LibraryProvenance;
  approval: LibraryApproval;
  layer: LibraryLayer;
  related: readonly LibraryArtifactReference[];
  priority: number;
}>;

export type LibraryResult = LibraryArtifactCommon &
  Readonly<{
    kind: "result";
    parameters: readonly UniversalParameterDeclaration[];
    statement: StatementView;
    premises: readonly StatementView[];
    sideConditions: readonly ResultSideCondition[];
    applicationDirections: readonly ApplicationDirection[];
    patterns: readonly ResultPattern[];
    variantFamilyId?: VariantFamilyId | undefined;
  }>;

export type LibraryDefinition = LibraryArtifactCommon &
  Readonly<{
    kind: "definition";
    parameters: readonly UniversalParameterDeclaration[];
    statement: StatementView;
  }>;

export type LibraryTechnique = LibraryArtifactCommon &
  Readonly<{
    kind: "technique";
    steps: readonly string[];
  }>;

export type LibraryArtifact = LibraryDefinition | LibraryResult | LibraryTechnique;

export type LibraryEnvironment = Readonly<{
  operators?: readonly OperatorDeclaration[];
}>;

const commonShape = {
  id: libraryArtifactIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  renderings: deterministicRenderingsSchema,
  classification: backgroundClassificationSchema,
  provenance: libraryProvenanceSchema,
  approval: libraryApprovalSchema,
  layer: libraryLayerSchema,
  related: z.array(libraryArtifactReferenceSchema),
  priority: z.number().int().nonnegative(),
};

const rawResultSchema = z
  .object({
    ...commonShape,
    kind: z.literal("result"),
    parameters: z.array(universalParameterDeclarationSchema),
    statement: statementShapeSchema,
    premises: z.array(statementShapeSchema),
    sideConditions: z.array(resultSideConditionSchema),
    applicationDirections: z.array(applicationDirectionSchema).min(1),
    patterns: z.array(resultPatternSchema).min(1),
    variantFamilyId: variantFamilyIdSchema.optional(),
  })
  .strict();

const rawDefinitionSchema = z
  .object({
    ...commonShape,
    kind: z.literal("definition"),
    parameters: z.array(universalParameterDeclarationSchema),
    statement: statementShapeSchema,
  })
  .strict();

const rawTechniqueSchema = z
  .object({
    ...commonShape,
    kind: z.literal("technique"),
    steps: z.array(z.string().min(1)).min(1),
  })
  .strict();

export function createLibraryResultSchema(
  environment: LibraryEnvironment = {},
): z.ZodType<LibraryResult> {
  const operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
  return guardedSchema(
    rawResultSchema.superRefine((result, context) => {
      addCommonIssues(result, context);
      addDuplicateStringIssues(result.applicationDirections, "application direction", context, [
        "applicationDirections",
      ]);
      addDuplicateFieldIssues(result.patterns, "id", "pattern ID", context, ["patterns"]);
      addDuplicateFieldIssues(result.sideConditions, "id", "side-condition ID", context, [
        "sideConditions",
      ]);
      const allowedDirections = new Set(result.applicationDirections);
      result.patterns.forEach((pattern, index) => {
        if (!allowedDirections.has(pattern.direction)) {
          context.addIssue({
            code: "custom",
            message: "A pattern direction must be listed as a permitted application direction.",
            path: ["patterns", index, "direction"],
          });
        }
      });
      addMathematicalIssues(result, operators, context);
    }),
  );
}

export function createLibraryDefinitionSchema(
  environment: LibraryEnvironment = {},
): z.ZodType<LibraryDefinition> {
  const operators = operatorDeclarationsSchema.parse(environment.operators ?? []);
  return guardedSchema(
    rawDefinitionSchema.superRefine((definition, context) => {
      addCommonIssues(definition, context);
      addStatementIssue(definition.statement, definition.parameters, operators, context, [
        "statement",
      ]);
    }),
  );
}

export const libraryTechniqueSchema: z.ZodType<LibraryTechnique> = guardedSchema(
  rawTechniqueSchema.superRefine(addCommonIssues),
);

export function createLibraryArtifactSchema(
  environment: LibraryEnvironment = {},
): z.ZodType<LibraryArtifact> {
  const resultSchema = createLibraryResultSchema(environment);
  const definitionSchema = createLibraryDefinitionSchema(environment);
  return z.union([definitionSchema, resultSchema, libraryTechniqueSchema]);
}

export const libraryResultSchema = createLibraryResultSchema();
export const libraryDefinitionSchema = createLibraryDefinitionSchema();
export const libraryArtifactSchema = createLibraryArtifactSchema();

export const variantFamilySchema = guardedSchema(
  z
    .object({
      id: variantFamilyIdSchema,
      name: z.string().min(1),
      memberIds: z.array(libraryArtifactIdSchema).min(2),
    })
    .strict()
    .superRefine((family, context) => {
      addDuplicateStringIssues(family.memberIds, "variant member", context, ["memberIds"]);
    }),
);
export type VariantFamily = z.infer<typeof variantFamilySchema>;

function addMathematicalIssues(
  result: z.infer<typeof rawResultSchema>,
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
): void {
  addStatementIssue(result.statement, result.parameters, operators, context, ["statement"]);
  result.premises.forEach((premise, index) =>
    addStatementIssue(premise, result.parameters, operators, context, ["premises", index]),
  );
  result.sideConditions.forEach((condition, index) => {
    if (condition.statement !== undefined) {
      addStatementIssue(condition.statement, result.parameters, operators, context, [
        "sideConditions",
        index,
        "statement",
      ]);
    }
  });

  const parameterSymbols = new Set(result.parameters.map((parameter) => parameter.symbol));
  result.patterns.forEach((pattern, index) => {
    const unknown = freeSymbolNames(pattern.expression, { operators }).find(
      (symbol) => !parameterSymbols.has(symbol),
    );
    if (unknown !== undefined) {
      context.addIssue({
        code: "custom",
        message: `Pattern contains undeclared symbol ${unknown}.`,
        path: ["patterns", index, "expression"],
      });
    }
    if (pattern.requirement.role === "proposition") {
      addStatementIssue({ expression: pattern.expression }, result.parameters, operators, context, [
        "patterns",
        index,
        "expression",
      ]);
    }
  });
}

function addStatementIssue(
  statement: StatementView,
  parameters: readonly UniversalParameterDeclaration[],
  operators: readonly OperatorDeclaration[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const parsed = createStatementViewSchema({ declarations: parameters, operators }).safeParse(
    statement,
  );
  if (!parsed.success) {
    context.addIssue({
      code: "custom",
      message: "Library mathematical content must be a well-typed proposition.",
      path: [...path],
    });
  }
}

function addCommonIssues(
  artifact: Pick<LibraryArtifactCommon, "related">,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  artifact.related.forEach((reference, index) => {
    const key = `${reference.kind}\u0000${reference.id}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: "Related artifact references must be unique.",
        path: ["related", index],
      });
    }
    seen.add(key);
  });
}

function addDuplicateStringIssues(
  values: readonly string[],
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        message: `Each ${label} must be unique.`,
        path: [...path, index],
      });
    }
    seen.add(value);
  });
}

function addDuplicateFieldIssues<
  Entry extends Readonly<Record<Field, string>>,
  Field extends string,
>(
  values: readonly Entry[],
  field: Field,
  label: string,
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value[field])) {
      context.addIssue({
        code: "custom",
        message: `Each ${label} must be unique.`,
        path: [...path, index, field],
      });
    }
    seen.add(value[field]);
  });
}

function guardedSchema<Output>(schema: z.ZodType<Output>): z.ZodType<Output> {
  return z.unknown().transform((value, context) => {
    if (!isJsonData(value)) {
      context.addIssue({ code: "custom", message: "Library records must be plain JSON data." });
      return z.NEVER;
    }
    const parsed = schema.safeParse(structuredClone(value));
    if (parsed.success) return parsed.data;
    parsed.error.issues.forEach((issue) =>
      context.addIssue({ code: "custom", message: issue.message, path: issue.path }),
    );
    return z.NEVER;
  });
}

function isJsonData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (
      keys.length !== value.length + 1 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (key !== "length" && (!Number.isInteger(Number(key)) || Number(key) < 0)),
      )
    ) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonData(descriptor.value, nextAncestors)
      ) {
        return false;
      }
    }
    return true;
  }
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isJsonData(descriptor.value, nextAncestors)
    );
  });
}

const propositionParameter = (suffix: string, symbol: string) => ({
  id: `declaration:core-logic-${suffix}`,
  symbol,
  sort: { kind: "proposition" as const },
  role: "universal-parameter" as const,
});

const curated = {
  classification: { domains: ["logic"], level: "foundational" },
  provenance: { kind: "curated" as const, source: "proof-platform core logic pack" },
  approval: { status: "approved" as const, reviewerId: "reviewer:core-library" },
  layer: "global" as const,
  related: [],
  priority: 100,
  premises: [],
  sideConditions: [],
};

const coreResultInputs = [
  {
    ...curated,
    kind: "result",
    id: "result:modus-ponens",
    name: "Modus ponens",
    description: "An implication and its antecedent establish the consequent.",
    parameters: [propositionParameter("p", "p"), propositionParameter("q", "q")],
    statement: { expression: ["Implies", ["And", ["Implies", "p", "q"], "p"], "q"] },
    renderings: {
      latex: String.raw`((p\Rightarrow q)\land p)\Rightarrow q`,
      naturalLanguage: "If p implies q and p holds, then q holds.",
    },
    applicationDirections: ["forward"],
    patterns: [
      {
        id: "pattern:modus-ponens",
        expression: ["Implies", "p", "q"],
        direction: "forward",
        requirement: { section: "hypothesis", polarity: "negative", role: "proposition" },
      },
    ],
  },
  {
    ...curated,
    kind: "result",
    id: "result:conjunction-commutativity",
    name: "Commutativity of conjunction",
    description: "The order of two conjuncts does not affect their truth.",
    parameters: [propositionParameter("p", "p"), propositionParameter("q", "q")],
    statement: { expression: ["Equivalent", ["And", "p", "q"], ["And", "q", "p"]] },
    renderings: {
      latex: String.raw`p\land q\Leftrightarrow q\land p`,
      naturalLanguage: "p and q is equivalent to q and p.",
    },
    applicationDirections: ["forward", "backward"],
    patterns: [
      {
        id: "pattern:conjunction-commutativity-forward",
        expression: ["And", "p", "q"],
        direction: "forward",
        requirement: { section: "any", polarity: "any", role: "proposition" },
      },
      {
        id: "pattern:conjunction-commutativity-backward",
        expression: ["And", "q", "p"],
        direction: "backward",
        requirement: { section: "any", polarity: "any", role: "proposition" },
      },
    ],
  },
  {
    ...curated,
    kind: "result",
    id: "result:excluded-middle",
    name: "Law of excluded middle",
    description: "Every proposition either holds or does not hold.",
    parameters: [propositionParameter("p", "p")],
    statement: { expression: ["Or", "p", ["Not", "p"]] },
    renderings: {
      latex: String.raw`p\lor\neg p`,
      naturalLanguage: "Either p holds or p does not hold.",
    },
    applicationDirections: ["forward"],
    patterns: [
      {
        id: "pattern:excluded-middle",
        expression: ["Or", "p", ["Not", "p"]],
        direction: "forward",
        requirement: { section: "goal", polarity: "positive", role: "proposition" },
      },
    ],
  },
] as const;

/** A deliberately small, reviewed Stage 2 pack; results remain distinct from executable moves. */
export const CORE_LOGIC_RESULTS: readonly LibraryResult[] = deepFreeze(
  coreResultInputs.map((result) => libraryResultSchema.parse(result)),
);

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
