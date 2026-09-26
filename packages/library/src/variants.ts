/**
 * Deterministic variant generation (design plan §12.3, roadmap N13).
 *
 * `generateVariants` is a pure, opt-in function: it never mutates or registers anything, and the
 * core packs are not expanded automatically. Every transformation below is a (classical) logical
 * equivalence of the whole result, so a variant inherits its source's approval; a future
 * non-equivalent transformation must set `equivalence: false`, which downgrades it to draft.
 *
 * Forward/backward restriction is intentionally not a transformation. Retrieval indexes every
 * pattern of a result regardless of direction and already carries `applicationDirections`, so a
 * copy restricted to one direction would only duplicate existing patterns under a second ID and
 * add ranking noise without changing what can be proved or found.
 *
 * Renderings are derived placeholders (the source strings prefixed with the transformation name);
 * the language package (N03/N04) will replace them with real deterministic renderings.
 */
import { mathJsonEquals, type PlainMathJson } from "@proof/mathjson-model";
import {
  createLibraryResultSchema,
  type ApplicationDirection,
  type LibraryEnvironment,
  type LibraryResult,
  type ResultPattern,
  type VariantFamily,
  type VariantTransformation,
  variantFamilySchema,
} from "./index";

export type VariantGenerationDiagnosticCode =
  "invalid-environment" | "invalid-source" | "invalid-variant";

export type VariantGenerationDiagnostic = Readonly<{
  code: VariantGenerationDiagnosticCode;
  message: string;
  path?: readonly PropertyKey[];
}>;

export type VariantGenerationResult =
  | Readonly<{
      ok: true;
      /**
       * The source tagged with the family ID. Retrieval requires every family member (including
       * the source) to carry the family's ID, so callers index this instead of the original.
       */
      source: LibraryResult;
      variants: readonly LibraryResult[];
      /**
       * Source plus generated members, or undefined when no variant applies. When the source
       * already belonged to a family, the returned family reuses its ID and callers merge members.
       */
      family: VariantFamily | undefined;
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      variants: readonly [];
      family: undefined;
      diagnostics: readonly VariantGenerationDiagnostic[];
    }>;

type Content = Readonly<{ statement: PlainMathJson; premises: readonly PlainMathJson[] }>;

type Transformation = Readonly<{
  name: VariantTransformation;
  label: string;
  /** Whether the variant is logically equivalent to its source (and so inherits approval). */
  equivalence: boolean;
  apply: (content: Content) => Content | undefined;
}>;

const TRANSFORMATIONS: readonly Transformation[] = [
  { name: "contrapositive", label: "Contrapositive", equivalence: true, apply: contrapositive },
  { name: "converse", label: "Converse", equivalence: true, apply: converse },
  {
    name: "symmetric-equality",
    label: "Symmetric equality",
    equivalence: true,
    apply: symmetricEquality,
  },
  { name: "uncurry", label: "Uncurried", equivalence: true, apply: uncurry },
  { name: "curry", label: "Curried", equivalence: true, apply: curry },
  { name: "bundle-premises", label: "Bundled premises", equivalence: true, apply: bundle },
  { name: "unbundle-premises", label: "Unbundled premises", equivalence: true, apply: unbundle },
];

export function generateVariants(
  source: LibraryResult,
  environment: LibraryEnvironment = {},
): VariantGenerationResult {
  let schema: ReturnType<typeof createLibraryResultSchema>;
  try {
    schema = createLibraryResultSchema(environment);
  } catch {
    return failure("invalid-environment", "The library environment is invalid.");
  }
  const parsedSource = schema.safeParse(source);
  if (!parsedSource.success) {
    return failure("invalid-source", "The source must be a valid library result.");
  }
  const result = parsedSource.data;
  const familyId = result.variantFamilyId ?? `variant-family:${result.id}`;
  const sourceContent: Content = {
    statement: result.statement.expression,
    premises: result.premises.map((premise) => premise.expression),
  };

  const seen: Content[] = [sourceContent];
  const variants: LibraryResult[] = [];
  for (const transformation of TRANSFORMATIONS) {
    const content = transformation.apply(sourceContent);
    if (content === undefined || seen.some((existing) => contentEquals(existing, content))) {
      continue;
    }
    seen.push(content);
    const parsed = schema.safeParse(buildVariant(result, familyId, transformation, content));
    if (!parsed.success) {
      return failure(
        "invalid-variant",
        `The ${transformation.name} variant of ${result.id} failed validation.`,
        [transformation.name],
      );
    }
    variants.push(parsed.data);
  }

  if (variants.length === 0) {
    return deepFreeze({
      ok: true,
      source: result,
      variants: [],
      family: undefined,
      diagnostics: [],
    });
  }
  const family = variantFamilySchema.parse({
    id: familyId,
    name: `${result.name} variants`,
    memberIds: [result.id, ...variants.map((variant) => variant.id)],
  });
  const tagged = schema.parse({ ...result, variantFamilyId: familyId });
  return deepFreeze({ ok: true, source: tagged, variants, family, diagnostics: [] });
}

function buildVariant(
  source: LibraryResult,
  familyId: string,
  transformation: Transformation,
  content: Content,
): unknown {
  const id = `${source.id}/${transformation.name}`;
  const sourceReference = { kind: "result" as const, id: source.id };
  const related = source.related.some(
    (reference) => reference.kind === "result" && reference.id === source.id,
  )
    ? source.related
    : [...source.related, sourceReference];
  return {
    kind: "result",
    id,
    name: `${source.name} (${transformation.label.toLowerCase()})`,
    description: `${transformation.label} form of ${source.name}: ${source.description}`,
    renderings: {
      latex: String.raw`\text{${transformation.name}: }` + source.renderings.latex,
      naturalLanguage: `${transformation.label} of: ${source.renderings.naturalLanguage}`,
    },
    classification: source.classification,
    provenance: {
      kind: "derived-variant",
      sourceId: source.id,
      transformation: transformation.name,
    },
    // Only logical equivalences may inherit a reviewer's approval.
    approval: transformation.equivalence ? source.approval : { status: "draft" },
    layer: source.layer,
    related,
    priority: source.priority,
    parameters: source.parameters,
    statement: { expression: content.statement },
    premises: content.premises.map((expression) => ({ expression })),
    sideConditions: source.sideConditions,
    applicationDirections: source.applicationDirections,
    patterns: derivePatterns(id, content, source),
    variantFamilyId: familyId,
  };
}

type PatternSeed = Omit<ResultPattern, "id">;

const HYPOTHESIS = { section: "hypothesis", polarity: "negative", role: "proposition" } as const;
const GOAL = { section: "goal", polarity: "positive", role: "proposition" } as const;
const ANY_PROPOSITION = { section: "any", polarity: "any", role: "proposition" } as const;
const ANY_TERM = { section: "any", polarity: "any", role: "term" } as const;

/**
 * Mirrors the curated packs: rewrites index each side (forward = left, backward = right), and
 * implications index the antecedent as a hypothesis and the consequent as a goal. Bare parameter
 * symbols are dropped because they would match every expression.
 */
function derivePatterns(
  variantId: string,
  content: Content,
  source: LibraryResult,
): readonly ResultPattern[] {
  const { statement, premises } = content;
  const parameterSymbols = new Set(source.parameters.map((parameter) => parameter.symbol));
  const equivalence = binary(statement, "Equivalent");
  const equality = binary(statement, "Equal");
  const implication = binary(statement, "Implies");
  let seeds: PatternSeed[];
  if (equivalence !== undefined) {
    seeds = [
      { expression: equivalence[0], direction: "forward", requirement: ANY_PROPOSITION },
      { expression: equivalence[1], direction: "backward", requirement: ANY_PROPOSITION },
    ];
  } else if (equality !== undefined) {
    seeds = [
      { expression: equality[0], direction: "forward", requirement: ANY_TERM },
      { expression: equality[1], direction: "backward", requirement: ANY_TERM },
    ];
  } else if (implication !== undefined) {
    seeds = [
      { expression: implication[0], direction: "forward", requirement: HYPOTHESIS },
      { expression: implication[1], direction: "backward", requirement: GOAL },
    ];
  } else if (premises[0] !== undefined) {
    seeds = [
      { expression: premises[0], direction: "forward", requirement: HYPOTHESIS },
      { expression: statement, direction: "backward", requirement: GOAL },
    ];
  } else {
    seeds = [
      { expression: statement, direction: "forward", requirement: GOAL },
      { expression: statement, direction: "backward", requirement: GOAL },
    ];
  }
  const allowed = new Set<ApplicationDirection>(source.applicationDirections);
  const kept = seeds.filter(
    (seed) =>
      allowed.has(seed.direction) &&
      !(typeof seed.expression === "string" && parameterSymbols.has(seed.expression)),
  );
  const firstDirection = source.applicationDirections[0] ?? "forward";
  const chosen =
    kept.length > 0
      ? kept
      : [{ expression: statement, direction: firstDirection, requirement: ANY_PROPOSITION }];
  return chosen.map((seed) => ({ id: `pattern:${variantId}/${seed.direction}`, ...seed }));
}

/** `A ⇒ B` becomes `¬B ⇒ ¬A`; bare premises `P₁,…,Pₙ ⊢ C` become `¬C ⇒ ¬(P₁ ∧ … ∧ Pₙ)`. */
function contrapositive({ statement, premises }: Content): Content | undefined {
  const implication = binary(statement, "Implies");
  if (implication !== undefined) {
    const [antecedent, consequent] = implication;
    return { statement: ["Implies", ["Not", consequent], ["Not", antecedent]], premises };
  }
  if (premises.length === 0) return undefined;
  return {
    statement: ["Implies", ["Not", statement], ["Not", conjunction(premises)]],
    premises: [],
  };
}

/** Converse is offered only for equivalences, where it is itself an equivalence. */
function converse(content: Content): Content | undefined {
  return mapConclusion(content, (conclusion) => {
    const sides = binary(conclusion, "Equivalent");
    return sides === undefined ? undefined : ["Equivalent", sides[1], sides[0]];
  });
}

function symmetricEquality(content: Content): Content | undefined {
  return mapConclusion(content, (conclusion) => {
    const sides = binary(conclusion, "Equal");
    return sides === undefined ? undefined : ["Equal", sides[1], sides[0]];
  });
}

/** `A₁ ⇒ (A₂ ⇒ … ⇒ C)` becomes `(A₁ ∧ A₂ ∧ …) ⇒ C`. */
function uncurry({ statement, premises }: Content): Content | undefined {
  const antecedents: PlainMathJson[] = [];
  let conclusion = statement;
  for (let step = binary(conclusion, "Implies"); step !== undefined;) {
    antecedents.push(step[0]);
    conclusion = step[1];
    step = binary(conclusion, "Implies");
  }
  if (antecedents.length < 2) return undefined;
  return { statement: ["Implies", ["And", ...antecedents], conclusion], premises };
}

/** `(A₁ ∧ … ∧ Aₙ) ⇒ C` becomes `A₁ ⇒ (… ⇒ (Aₙ ⇒ C))`. */
function curry({ statement, premises }: Content): Content | undefined {
  const implication = binary(statement, "Implies");
  const parts = conjuncts(implication?.[0]);
  if (implication === undefined || parts === undefined) return undefined;
  const curried = parts.reduceRight<PlainMathJson>(
    (consequent, conjunct) => ["Implies", conjunct, consequent],
    implication[1],
  );
  return { statement: curried, premises };
}

/** Several premises become one conjunctive premise. */
function bundle({ statement, premises }: Content): Content | undefined {
  return premises.length < 2 ? undefined : { statement, premises: [conjunction(premises)] };
}

/** One conjunctive premise becomes one premise per conjunct. */
function unbundle({ statement, premises }: Content): Content | undefined {
  const parts = premises.length === 1 ? conjuncts(premises[0]) : undefined;
  return parts === undefined ? undefined : { statement, premises: parts };
}

/** Applies `map` to the conclusion at the end of the statement's implication spine. */
function mapConclusion(
  { statement, premises }: Content,
  map: (conclusion: PlainMathJson) => PlainMathJson | undefined,
): Content | undefined {
  const rewrite = (expression: PlainMathJson): PlainMathJson | undefined => {
    const implication = binary(expression, "Implies");
    if (implication === undefined) return map(expression);
    const inner = rewrite(implication[1]);
    return inner === undefined ? undefined : ["Implies", implication[0], inner];
  };
  const rewritten = rewrite(statement);
  return rewritten === undefined ? undefined : { statement: rewritten, premises };
}

function conjunction(propositions: readonly PlainMathJson[]): PlainMathJson {
  const [only] = propositions;
  return propositions.length === 1 && only !== undefined ? only : ["And", ...propositions];
}

/** Returns the two operands of `[operator, left, right]`, or undefined for any other shape. */
function binary(
  expression: PlainMathJson,
  operator: string,
): readonly [PlainMathJson, PlainMathJson] | undefined {
  if (!Array.isArray(expression) || expression.length !== 3 || expression[0] !== operator) {
    return undefined;
  }
  return [expression[1] as PlainMathJson, expression[2] as PlainMathJson];
}

/** Returns the operands of an `And` with at least two conjuncts. */
function conjuncts(expression: PlainMathJson | undefined): PlainMathJson[] | undefined {
  if (!Array.isArray(expression) || expression[0] !== "And" || expression.length < 3) {
    return undefined;
  }
  return expression.slice(1) as PlainMathJson[];
}

function contentEquals(left: Content, right: Content): boolean {
  return (
    mathJsonEquals(left.statement, right.statement) &&
    left.premises.length === right.premises.length &&
    left.premises.every((premise, index) =>
      mathJsonEquals(premise, right.premises[index] as PlainMathJson),
    )
  );
}

function failure(
  code: VariantGenerationDiagnosticCode,
  message: string,
  path?: readonly PropertyKey[],
): VariantGenerationResult {
  return deepFreeze({
    ok: false,
    variants: [],
    family: undefined,
    diagnostics: [path === undefined ? { code, message } : { code, message, path }],
  });
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
