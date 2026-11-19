/**
 * Starter domain packs (design plan §12, §21.5; roadmap N16).
 *
 * Each pack is a small set of hand-authored, reviewed results for one elementary domain, together
 * with the deterministic variants (N13) that improve matching, and the operator declarations the
 * pack's statements need. Every result passes the library result schema in the pack's operator
 * environment and the global-layer admission gate; a pack that fails either is a programming
 * error and throws when the packs are first built.
 *
 * Operators. Order and arithmetic use the reserved built-ins (`Less`, `LessEqual`, `Add`,
 * `Multiply`); the set pack declares `Union` and `Intersection`, the divisibility pack `Divides`,
 * and the closure pack `Closure` (research-style notation) as registered global operators.
 * A session can use a pack only when it declares every one of the pack's operators identically
 * (see `libraryPacksForOperators`), so a pack never adds notation to a session behind its back.
 *
 * Sorts. Equality, order and arithmetic are stated over `sort:real`; the set pack uses sets of the
 * generic element sort `sort:element`, and divisibility is stated over `sort:integer`. The type system is monomorphic, so a session over another
 * number sort does not match these results.
 *
 * Variants. Only transformations that add a genuinely different application are requested per
 * result (for example the bundled form of a transitivity law, whose premise matches a conjunctive
 * hypothesis). A variant that would be alpha-equivalent to its source, such as the symmetric
 * orientation of a commutativity law, is not requested.
 *
 * Equality patterns. An equality result is applied either forward (the instantiated equation
 * becomes a hypothesis, which `rewrite-with-equality` can then use) or backward (it closes a goal
 * that is exactly an instance of the equation). Its patterns are therefore the left-hand term
 * (forward) and the whole equation as a goal (backward). `generateVariants` derives a right-hand
 * term pattern for the backward direction, which no result-application move can apply, so the
 * patterns of equality variants are re-derived here in the applicable form and re-validated.
 *
 * The packs are built lazily: this module is re-exported by `./index`, whose schemas are not yet
 * initialized while this module's top level runs.
 */
import {
  canonicalJsonEquals,
  operatorDeclarationsSchema,
  operatorIdSchema,
  sortSchema,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";
import { admitLibraryArtifact, libraryOperatorRegistrationSchema } from "./additions";
import type { LibraryOperatorRegistration } from "./additions";
import {
  createLibraryResultSchema,
  variantFamilySchema,
  type ApplicationDirection,
  type ApplicationRequirement,
  type LibraryResult,
  type ResultPattern,
  type VariantFamily,
  type VariantTransformation,
} from "./index";
import { generateVariants } from "./variants";

export const LIBRARY_PACK_IDS = [
  "pack:elementary-logic",
  "pack:equality",
  "pack:order",
  "pack:arithmetic",
  "pack:sets",
  "pack:divisibility",
  "pack:closure",
  "pack:modular-arithmetic",
] as const;
export type LibraryPackId = (typeof LIBRARY_PACK_IDS)[number];

export type LibraryPack = Readonly<{
  id: LibraryPackId;
  name: string;
  description: string;
  domain: string;
  /** Global operator-registry entries for the notation this pack introduces. */
  operatorRegistrations: readonly LibraryOperatorRegistration[];
  /** The declarations of `operatorRegistrations`; a session must declare each identically. */
  operators: readonly OperatorDeclaration[];
  /** Hand-authored results (tagged with their family when they have variants) and variants. */
  results: readonly LibraryResult[];
  variantFamilies: readonly VariantFamily[];
}>;

export const REAL_SORT: Sort = deepFreeze(sortSchema.parse({ kind: "named", id: "sort:real" }));
export const ELEMENT_SORT: Sort = deepFreeze(
  sortSchema.parse({ kind: "named", id: "sort:element" }),
);
export const ELEMENT_SET_SORT: Sort = deepFreeze(
  sortSchema.parse({ kind: "named", id: "sort:set", arguments: [ELEMENT_SORT] }),
);
export const INTEGER_SORT: Sort = deepFreeze(
  sortSchema.parse({ kind: "named", id: "sort:integer" }),
);
const PROPOSITION_SORT: Sort = { kind: "proposition" };

const OPERATOR_REVIEWER = "reviewer:core-library";
const OPERATOR_REGISTERED_AT = "2026-09-26T00:00:00.000Z";

/** The set pack's operators: binary union and intersection of sets of elements. */
export const SET_OPERATOR_DECLARATIONS: readonly OperatorDeclaration[] = [
  {
    id: operatorIdSchema.parse("operator:set-union"),
    symbol: "Union",
    signature: { parameters: [ELEMENT_SET_SORT, ELEMENT_SET_SORT], result: ELEMENT_SET_SORT },
    presentation: {
      displayName: "union",
      latex: { template: String.raw`#1\cup #2`, precedence: "additive" },
      naturalLanguage: [{ template: "the union of #1 and #2" }],
      domains: ["sets"],
    },
  },
  {
    id: operatorIdSchema.parse("operator:set-intersection"),
    symbol: "Intersection",
    signature: { parameters: [ELEMENT_SET_SORT, ELEMENT_SET_SORT], result: ELEMENT_SET_SORT },
    presentation: {
      displayName: "intersection",
      latex: { template: String.raw`#1\cap #2`, precedence: "multiplicative" },
      naturalLanguage: [{ template: "the intersection of #1 and #2" }],
      domains: ["sets"],
    },
  },
];

/** The divisibility pack's operator: the relation "m divides n" between integers. */
export const DIVISIBILITY_OPERATOR_DECLARATIONS: readonly OperatorDeclaration[] = [
  {
    id: operatorIdSchema.parse("operator:divides"),
    symbol: "Divides",
    signature: { parameters: [INTEGER_SORT, INTEGER_SORT], result: PROPOSITION_SORT },
    presentation: {
      displayName: "divides",
      latex: {
        template: String.raw`#1\mid #2`,
        precedence: "relation",
        parse: { trigger: String.raw`\mid`, notation: "infix" },
      },
      naturalLanguage: [
        { template: "#1 divides #2", proposition: true, negated: "#1 does not divide #2" },
      ],
      domains: ["number-theory"],
    },
  },
];

/** Congruence means that the modulus divides the difference, including at modulus zero. */
export const MODULAR_OPERATOR_DECLARATIONS: readonly OperatorDeclaration[] = [
  {
    id: operatorIdSchema.parse("operator:congruent"),
    symbol: "Congruent",
    signature: {
      parameters: [INTEGER_SORT, INTEGER_SORT, INTEGER_SORT],
      result: PROPOSITION_SORT,
    },
    presentation: {
      displayName: "congruent modulo",
      latex: { template: String.raw`#1\equiv #2\pmod{#3}`, precedence: "relation" },
      naturalLanguage: [
        {
          template: "#1 is congruent to #2 modulo #3",
          proposition: true,
          negated: "#1 is not congruent to #2 modulo #3",
        },
      ],
      domains: ["number-theory"],
    },
  },
];

/**
 * The closure pack's operator: a Kuratowski-style closure of a set of elements, the corpus's
 * research-notation case (design plan §21.5). It is presented as `\operatorname{cl}(A)` and read
 * "the closure of A"; its LaTeX parse trigger lets typed input produce the operator.
 */
export const CLOSURE_OPERATOR_DECLARATIONS: readonly OperatorDeclaration[] = [
  {
    id: operatorIdSchema.parse("operator:set-closure"),
    symbol: "Closure",
    signature: { parameters: [ELEMENT_SET_SORT], result: ELEMENT_SET_SORT },
    presentation: {
      displayName: "closure",
      latex: {
        template: String.raw`\operatorname{cl}\left(#1\right)`,
        precedence: "atom",
        parse: { trigger: String.raw`\operatorname{cl}`, notation: "function" },
      },
      naturalLanguage: [{ template: "the closure of #1" }],
      domains: ["topology"],
      notations: ["kuratowski-closure"],
    },
  },
];

const HYPOTHESIS: ApplicationRequirement = {
  section: "hypothesis",
  polarity: "negative",
  role: "proposition",
};
const GOAL: ApplicationRequirement = { section: "goal", polarity: "positive", role: "proposition" };
const ANY_PROPOSITION: ApplicationRequirement = {
  section: "any",
  polarity: "any",
  role: "proposition",
};
const ANY_TERM: ApplicationRequirement = { section: "any", polarity: "any", role: "term" };

type PatternSpec = Readonly<{
  suffix: string;
  expression: PlainMathJson;
  direction: ApplicationDirection;
  requirement: ApplicationRequirement;
}>;

type ResultSpec = Readonly<{
  /** The result ID without the `result:` prefix. */
  slug: string;
  name: string;
  description: string;
  parameters: readonly (readonly [symbol: string, sort: Sort])[];
  premises?: readonly PlainMathJson[];
  statement: PlainMathJson;
  latex: string;
  naturalLanguage: string;
  directions: readonly ApplicationDirection[];
  patterns: readonly PatternSpec[];
  variants?: readonly VariantTransformation[];
  congruenceSymbols?: readonly string[];
  priority?: number;
}>;

type PackSpec = Readonly<{
  id: LibraryPackId;
  name: string;
  description: string;
  domain: string;
  operators: readonly OperatorDeclaration[];
  results: readonly ResultSpec[];
}>;

/** An equivalence `left ⇔ right` is a rewrite source in both directions. */
function equivalencePatterns(left: PlainMathJson, right?: PlainMathJson): readonly PatternSpec[] {
  return [
    { suffix: "forward", expression: left, direction: "forward", requirement: ANY_PROPOSITION },
    ...(right === undefined
      ? []
      : [
          {
            suffix: "backward",
            expression: right,
            direction: "backward" as const,
            requirement: ANY_PROPOSITION,
          },
        ]),
  ];
}

/** A rule `premises ⊢ conclusion`: forward from its first premise, backward from its conclusion. */
function rulePatterns(firstPremise: PlainMathJson, conclusion: PlainMathJson): PatternSpec[] {
  return [
    { suffix: "forward", expression: firstPremise, direction: "forward", requirement: HYPOTHESIS },
    { suffix: "backward", expression: conclusion, direction: "backward", requirement: GOAL },
  ];
}

/** An equation: derive it forward from its left-hand term, or close a goal that is an instance. */
function equationPatterns(
  statement: PlainMathJson,
  parameterSymbols: ReadonlySet<string>,
): PatternSpec[] {
  const left = Array.isArray(statement) ? (statement[1] as PlainMathJson) : undefined;
  return [
    ...(left === undefined || (typeof left === "string" && parameterSymbols.has(left))
      ? []
      : [
          {
            suffix: "forward",
            expression: left,
            direction: "forward" as const,
            requirement: ANY_TERM,
          },
        ]),
    { suffix: "backward", expression: statement, direction: "backward", requirement: GOAL },
  ];
}

const p = (symbol: string) => [symbol, PROPOSITION_SORT] as const;
const real = (symbol: string) => [symbol, REAL_SORT] as const;
const set = (symbol: string) => [symbol, ELEMENT_SET_SORT] as const;
const element = (symbol: string) => [symbol, ELEMENT_SORT] as const;
const integer = (symbol: string) => [symbol, INTEGER_SORT] as const;

type CongruenceSpec = Omit<ResultSpec, "congruenceSymbols" | "directions" | "patterns"> &
  Readonly<{
    head: string;
    premises: readonly [PlainMathJson, ...PlainMathJson[]];
  }>;

function congruenceRule({ head, statement, ...rule }: CongruenceSpec): ResultSpec {
  const implication = Array.isArray(statement) && statement[0] === "Implies";
  const patterns = rulePatterns(
    rule.premises[0],
    implication ? (statement[2] as PlainMathJson) : statement,
  );
  return {
    ...rule,
    statement,
    congruenceSymbols: [head],
    // Generic order premises would list many unrelated predicate transports in isolation.
    priority: 40,
    directions: ["forward", "backward"],
    patterns: implication ? patterns.filter(({ direction }) => direction === "backward") : patterns,
  };
}

const notCongruence = congruenceRule({
  slug: "not-equivalence-congruence",
  name: "Negation preserves equivalence",
  description: "Negating equivalent propositions gives equivalent negations.",
  head: "Not",
  parameters: [p("p"), p("q")],
  premises: [["Equivalent", "p", "q"]],
  statement: ["Equivalent", ["Not", "p"], ["Not", "q"]],
  latex: String.raw`p\iff q\vdash (\neg p)\iff(\neg q)`,
  naturalLanguage: "If p and q are equivalent, their negations are equivalent.",
});

const addEqualityCongruence = congruenceRule({
  slug: "add-equality-congruence",
  name: "Addition preserves equality",
  description: "Adding a fixed number preserves equality.",
  head: "Add",
  parameters: [real("x"), real("y"), real("z")],
  premises: [["Equal", "x", "y"]],
  statement: ["Equal", ["Add", "x", "z"], ["Add", "y", "z"]],
  latex: String.raw`x=y\vdash x+z=y+z`,
  naturalLanguage: "If x equals y, then x + z equals y + z.",
});

const LOGIC_PACK: PackSpec = {
  id: "pack:elementary-logic",
  name: "Elementary logic",
  description: "Propositional equivalences and elimination rules beyond the core logic pack.",
  domain: "logic",
  operators: [],
  results: [
    {
      slug: "double-negation",
      name: "Double negation",
      description: "A doubly negated proposition is equivalent to the proposition.",
      parameters: [p("p")],
      statement: ["Equivalent", ["Not", ["Not", "p"]], "p"],
      latex: String.raw`\neg\neg p\Leftrightarrow p`,
      naturalLanguage: "Not not p is equivalent to p.",
      directions: ["forward", "backward"],
      // The right-hand side is a bare parameter, which would match every proposition.
      patterns: equivalencePatterns(["Not", ["Not", "p"]]),
    },
    {
      slug: "disjunction-commutativity",
      name: "Commutativity of disjunction",
      description: "The order of two disjuncts does not affect their truth.",
      parameters: [p("p"), p("q")],
      statement: ["Equivalent", ["Or", "p", "q"], ["Or", "q", "p"]],
      latex: String.raw`p\lor q\Leftrightarrow q\lor p`,
      naturalLanguage: "p or q is equivalent to q or p.",
      // Both directions: a rewrite inside a goal is a backward application. One pattern suffices
      // because the law is its own converse.
      directions: ["forward", "backward"],
      patterns: equivalencePatterns(["Or", "p", "q"]),
    },
    {
      slug: "de-morgan-conjunction",
      name: "De Morgan's law for conjunction",
      description: "The negation of a conjunction is the disjunction of the negations.",
      parameters: [p("p"), p("q")],
      statement: ["Equivalent", ["Not", ["And", "p", "q"]], ["Or", ["Not", "p"], ["Not", "q"]]],
      latex: String.raw`\neg(p\land q)\Leftrightarrow\neg p\lor\neg q`,
      naturalLanguage: "Not (p and q) is equivalent to not p or not q.",
      directions: ["forward", "backward"],
      patterns: equivalencePatterns(["Not", ["And", "p", "q"]], ["Or", ["Not", "p"], ["Not", "q"]]),
    },
    {
      slug: "de-morgan-disjunction",
      name: "De Morgan's law for disjunction",
      description: "The negation of a disjunction is the conjunction of the negations.",
      parameters: [p("p"), p("q")],
      statement: ["Equivalent", ["Not", ["Or", "p", "q"]], ["And", ["Not", "p"], ["Not", "q"]]],
      latex: String.raw`\neg(p\lor q)\Leftrightarrow\neg p\land\neg q`,
      naturalLanguage: "Not (p or q) is equivalent to not p and not q.",
      directions: ["forward", "backward"],
      patterns: equivalencePatterns(["Not", ["Or", "p", "q"]], ["And", ["Not", "p"], ["Not", "q"]]),
    },
    {
      slug: "modus-tollens",
      name: "Modus tollens",
      description: "An implication and the negation of its consequent refute its antecedent.",
      parameters: [p("p"), p("q")],
      premises: [
        ["Implies", "p", "q"],
        ["Not", "q"],
      ],
      statement: ["Not", "p"],
      latex: String.raw`p\Rightarrow q,\ \neg q\vdash\neg p`,
      naturalLanguage: "If p implies q and q does not hold, then p does not hold.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["Implies", "p", "q"], ["Not", "p"]),
      variants: ["bundle-premises"],
    },
    {
      slug: "disjunctive-syllogism",
      name: "Disjunctive syllogism",
      description: "A disjunction and the negation of one disjunct establish the other.",
      parameters: [p("p"), p("q")],
      premises: [
        ["Or", "p", "q"],
        ["Not", "p"],
      ],
      statement: "q",
      latex: String.raw`p\lor q,\ \neg p\vdash q`,
      naturalLanguage: "If p or q holds and p does not hold, then q holds.",
      // Backward application would match every goal: the conclusion is a bare parameter.
      directions: ["forward"],
      patterns: [
        {
          suffix: "forward",
          expression: ["Or", "p", "q"],
          direction: "forward",
          requirement: HYPOTHESIS,
        },
      ],
    },
    notCongruence,
  ],
};

const EQUALITY_PACK: PackSpec = {
  id: "pack:equality",
  name: "Equality",
  description: "Symmetry and transitivity of equality between real numbers.",
  domain: "equality",
  operators: [],
  results: [
    {
      slug: "equality-symmetry",
      name: "Symmetry of equality",
      description: "An equation may be read in either direction.",
      parameters: [real("x"), real("y")],
      premises: [["Equal", "x", "y"]],
      statement: ["Equal", "y", "x"],
      latex: String.raw`x=y\vdash y=x`,
      naturalLanguage: "If x equals y, then y equals x.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["Equal", "x", "y"], ["Equal", "y", "x"]),
    },
    {
      slug: "equality-transitivity",
      name: "Transitivity of equality",
      description: "Two equations sharing a middle term combine into one.",
      parameters: [real("x"), real("y"), real("z")],
      premises: [
        ["Equal", "x", "y"],
        ["Equal", "y", "z"],
      ],
      statement: ["Equal", "x", "z"],
      latex: String.raw`x=y,\ y=z\vdash x=z`,
      naturalLanguage: "If x equals y and y equals z, then x equals z.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["Equal", "x", "y"], ["Equal", "x", "z"]),
      variants: ["bundle-premises"],
    },
    addEqualityCongruence,
  ],
};

function transitivity(
  slug: string,
  name: string,
  relation: "Less" | "LessEqual",
  symbol: string,
  phrase: string,
): ResultSpec {
  return {
    slug,
    name,
    description: `The relation "${phrase}" is transitive.`,
    parameters: [real("x"), real("y"), real("z")],
    premises: [
      [relation, "x", "y"],
      [relation, "y", "z"],
    ],
    statement: [relation, "x", "z"],
    latex: `x${symbol} y,\\ y${symbol} z\\vdash x${symbol} z`,
    naturalLanguage: `If x is ${phrase} y and y is ${phrase} z, then x is ${phrase} z.`,
    directions: ["forward", "backward"],
    patterns: rulePatterns([relation, "x", "y"], [relation, "x", "z"]),
    variants: ["contrapositive", "bundle-premises"],
  };
}

const ORDER_RELATIONS = [
  { head: "Less", slug: "less", latex: "<", phrase: "less than", ascending: true },
  {
    head: "LessEqual",
    slug: "less-equal",
    latex: String.raw`\le`,
    phrase: "at most",
    ascending: true,
  },
  { head: "Greater", slug: "greater", latex: ">", phrase: "greater than", ascending: false },
  {
    head: "GreaterEqual",
    slug: "greater-equal",
    latex: String.raw`\ge`,
    phrase: "at least",
    ascending: false,
  },
] as const;

type OrderRelation = (typeof ORDER_RELATIONS)[number];
type OperandPosition = "left" | "right";

const OPERAND_POSITIONS: readonly OperandPosition[] = ["left", "right"];

function orderOperations(relation: OrderRelation, position: OperandPosition): ResultSpec[] {
  const { head, slug, latex, phrase } = relation;
  const other = position === "right";
  const args = (variable: string) => (other ? ["z", variable] : [variable, "z"]);
  const addition: PlainMathJson = [head, ["Add", ...args("x")], ["Add", ...args("y")]];
  const product: PlainMathJson = [head, ["Multiply", ...args("x")], ["Multiply", ...args("y")]];
  const sum = (variable: string) => (other ? `z+${variable}` : `${variable}+z`);
  const multiple = (variable: string) => (other ? `z ${variable}` : `${variable} z`);
  const parameters = [real("x"), real("y"), real("z")];
  const premise: PlainMathJson = [head, "x", "y"];
  const addRule = congruenceRule({
    slug: `${slug}-add-monotonicity${other ? "-right" : ""}`,
    name:
      !other && relation.ascending
        ? `Monotonicity of addition for ${head === "Less" ? "<" : "≤"}`
        : `Monotonicity of addition for ${phrase} (${position} operand)`,
    description: `Adding the same number to both sides preserves "${phrase}".`,
    head: "Add",
    parameters,
    premises: [premise],
    statement: addition,
    latex: `x${latex} y\\vdash ${sum("x")}${latex} ${sum("y")}`,
    naturalLanguage: `If x is ${phrase} y, then ${sum("x")} is ${phrase} ${sum("y")}.`,
  });
  const reverseProduct: PlainMathJson = [
    head,
    ["Multiply", ...args("y")],
    ["Multiply", ...args("x")],
  ];
  return [
    !other && relation.ascending
      ? { ...addRule, priority: 100, variants: ["contrapositive"] }
      : addRule,
    congruenceRule({
      slug: `${slug}-multiply-positive-${position}`,
      name: `Monotonicity of multiplication by a positive number for ${phrase} (${position} operand)`,
      description: `Multiplying both sides by a positive number preserves "${phrase}".`,
      head: "Multiply",
      parameters,
      premises: [premise, ["Greater", "z", 0]],
      statement: product,
      latex: `x${latex} y,\\ z>0\\vdash ${multiple("x")}${latex} ${multiple("y")}`,
      naturalLanguage: `If x is ${phrase} y and z is positive, then ${multiple("x")} is ${phrase} ${multiple("y")}.`,
    }),
    congruenceRule({
      slug: `${slug}-multiply-negative-${position}`,
      name: `Antitonicity of multiplication by a negative number for ${phrase} (${position} operand)`,
      description: `Multiplying both sides by a negative number reverses "${phrase}".`,
      head: "Multiply",
      parameters,
      premises: [premise, ["Less", "z", 0]],
      statement: reverseProduct,
      latex: `x${latex} y,\\ z<0\\vdash ${multiple("y")}${latex} ${multiple("x")}`,
      naturalLanguage: `If x is ${phrase} y and z is negative, then ${multiple("y")} is ${phrase} ${multiple("x")}.`,
    }),
  ];
}

function compareEndpoints(
  relation: OrderRelation,
  comparison: OrderRelation,
  position: OperandPosition,
): ResultSpec {
  const left = position === "left";
  const oldValue: PlainMathJson = left ? [comparison.head, "x", "z"] : [comparison.head, "z", "x"];
  const newValue: PlainMathJson = left ? [comparison.head, "y", "z"] : [comparison.head, "z", "y"];
  const reverse = (relation.ascending === comparison.ascending) === left;
  const statement: PlainMathJson = [
    "Implies",
    ...(reverse ? [newValue, oldValue] : [oldValue, newValue]),
  ];
  const comparisonText = (variable: string) =>
    left ? `${variable}${comparison.latex} z` : `z${comparison.latex} ${variable}`;
  const comparisonWords = (variable: string) =>
    left ? `${variable} is ${comparison.phrase} z` : `z is ${comparison.phrase} ${variable}`;
  const [from, to] = reverse ? ["y", "x"] : ["x", "y"];
  return congruenceRule({
    slug: `${relation.slug}-transport-${comparison.slug}-${position}`,
    name: `Transport ${phraseFor(comparison)} along ${phraseFor(relation)} (${position} operand)`,
    description: `Changing the ${position} operand of a comparison along the order yields an implication.`,
    head: comparison.head,
    parameters: [real("x"), real("y"), real("z")],
    premises: [[relation.head, "x", "y"]],
    statement,
    latex: `x${relation.latex} y\\vdash (${comparisonText(from)})\\implies(${comparisonText(to)})`,
    naturalLanguage: `If x is ${relation.phrase} y, then ${comparisonWords(from)} implies ${comparisonWords(to)}.`,
  });
}

const phraseFor = (relation: OrderRelation) => `“${relation.phrase}”`;

function negateOrder(relation: OrderRelation): ResultSpec {
  const { head, slug, latex, phrase } = relation;
  return congruenceRule({
    slug: `${slug}-negation-antitonicity`,
    name: `Negation reverses ${phraseFor(relation)}`,
    description: "Multiplying by −1 reverses the order.",
    head: "Negate",
    parameters: [real("x"), real("y")],
    premises: [[head, "x", "y"]],
    statement: [head, ["Negate", "y"], ["Negate", "x"]],
    latex: `x${latex} y\\vdash -y${latex} -x`,
    naturalLanguage: `If x is ${phrase} y, then −y is ${phrase} −x.`,
  });
}

const ORDER_PACK: PackSpec = {
  id: "pack:order",
  name: "Order",
  description: "Transitivity, antisymmetry, and congruence rules for the real order.",
  domain: "order",
  operators: [],
  results: [
    transitivity("less-transitivity", "Transitivity of <", "Less", "<", "less than"),
    transitivity(
      "less-equal-transitivity",
      "Transitivity of ≤",
      "LessEqual",
      String.raw`\le`,
      "at most",
    ),
    {
      slug: "less-equal-antisymmetry",
      name: "Antisymmetry of ≤",
      description: "Two numbers each at most the other are equal.",
      parameters: [real("x"), real("y")],
      premises: [
        ["LessEqual", "x", "y"],
        ["LessEqual", "y", "x"],
      ],
      statement: ["Equal", "x", "y"],
      latex: String.raw`x\le y,\ y\le x\vdash x=y`,
      naturalLanguage: "If x is at most y and y is at most x, then x equals y.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["LessEqual", "x", "y"], ["Equal", "x", "y"]),
      variants: ["bundle-premises"],
    },
    ...ORDER_RELATIONS.flatMap((relation) => [
      ...OPERAND_POSITIONS.flatMap((position) => orderOperations(relation, position)),
      negateOrder(relation),
      ...ORDER_RELATIONS.flatMap((comparison) =>
        OPERAND_POSITIONS.map((position) => compareEndpoints(relation, comparison, position)),
      ),
    ]),
  ],
};

function identity(
  slug: string,
  name: string,
  description: string,
  parameters: readonly (readonly [string, Sort])[],
  statement: PlainMathJson,
  latex: string,
  naturalLanguage: string,
  variants: readonly VariantTransformation[] = [],
): ResultSpec {
  return {
    slug,
    name,
    description,
    parameters,
    statement,
    latex,
    naturalLanguage,
    directions: ["forward", "backward"],
    patterns: equationPatterns(statement, new Set(parameters.map(([symbol]) => symbol))),
    variants,
  };
}

const ARITHMETIC_PACK: PackSpec = {
  id: "pack:arithmetic",
  name: "Basic arithmetic identities",
  description: "Commutativity, associativity, identities, and distributivity for real numbers.",
  domain: "arithmetic",
  operators: [],
  results: [
    identity(
      "add-commutativity",
      "Commutativity of addition",
      "The order of two summands does not change the sum.",
      [real("x"), real("y")],
      ["Equal", ["Add", "x", "y"], ["Add", "y", "x"]],
      "x+y=y+x",
      "x + y equals y + x.",
    ),
    identity(
      "add-associativity",
      "Associativity of addition",
      "Grouping of three summands does not change the sum.",
      [real("x"), real("y"), real("z")],
      ["Equal", ["Add", ["Add", "x", "y"], "z"], ["Add", "x", ["Add", "y", "z"]]],
      "(x+y)+z=x+(y+z)",
      "(x + y) + z equals x + (y + z).",
      ["symmetric-equality"],
    ),
    identity(
      "add-zero",
      "Additive identity",
      "Adding zero leaves a number unchanged.",
      [real("x")],
      ["Equal", ["Add", "x", 0], "x"],
      "x+0=x",
      "x + 0 equals x.",
      ["symmetric-equality"],
    ),
    identity(
      "multiply-commutativity",
      "Commutativity of multiplication",
      "The order of two factors does not change the product.",
      [real("x"), real("y")],
      ["Equal", ["Multiply", "x", "y"], ["Multiply", "y", "x"]],
      String.raw`x\cdot y=y\cdot x`,
      "x times y equals y times x.",
    ),
    identity(
      "multiply-associativity",
      "Associativity of multiplication",
      "Grouping of three factors does not change the product.",
      [real("x"), real("y"), real("z")],
      [
        "Equal",
        ["Multiply", ["Multiply", "x", "y"], "z"],
        ["Multiply", "x", ["Multiply", "y", "z"]],
      ],
      String.raw`(x\cdot y)\cdot z=x\cdot(y\cdot z)`,
      "(x times y) times z equals x times (y times z).",
      ["symmetric-equality"],
    ),
    identity(
      "multiply-one",
      "Multiplicative identity",
      "Multiplying by one leaves a number unchanged.",
      [real("x")],
      ["Equal", ["Multiply", "x", 1], "x"],
      String.raw`x\cdot 1=x`,
      "x times 1 equals x.",
      ["symmetric-equality"],
    ),
    identity(
      "multiply-zero",
      "Multiplication by zero",
      "Multiplying by zero gives zero.",
      [real("x")],
      ["Equal", ["Multiply", "x", 0], 0],
      String.raw`x\cdot 0=0`,
      "x times 0 equals 0.",
    ),
    identity(
      "left-distributivity",
      "Distributivity of multiplication over addition",
      "Multiplication distributes over a sum from the left.",
      [real("x"), real("y"), real("z")],
      [
        "Equal",
        ["Multiply", "x", ["Add", "y", "z"]],
        ["Add", ["Multiply", "x", "y"], ["Multiply", "x", "z"]],
      ],
      String.raw`x\cdot(y+z)=x\cdot y+x\cdot z`,
      "x times (y + z) equals x times y plus x times z.",
      ["symmetric-equality"],
    ),
  ],
};

const SET_PACK: PackSpec = {
  id: "pack:sets",
  name: "Sets",
  description: "Subset transitivity and membership in unions and intersections.",
  domain: "sets",
  operators: SET_OPERATOR_DECLARATIONS,
  results: [
    {
      slug: "subset-transitivity",
      name: "Transitivity of inclusion",
      description: "Inclusion of sets is transitive.",
      parameters: [set("A"), set("B"), set("C")],
      premises: [
        ["SubsetEqual", "A", "B"],
        ["SubsetEqual", "B", "C"],
      ],
      statement: ["SubsetEqual", "A", "C"],
      latex: String.raw`A\subseteq B,\ B\subseteq C\vdash A\subseteq C`,
      naturalLanguage: "If A is a subset of B and B is a subset of C, then A is a subset of C.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["SubsetEqual", "A", "B"], ["SubsetEqual", "A", "C"]),
      variants: ["bundle-premises"],
    },
    {
      slug: "subset-membership",
      name: "Membership in a superset",
      description: "An element of a set belongs to every superset of it.",
      parameters: [set("A"), set("B"), element("x")],
      premises: [
        ["SubsetEqual", "A", "B"],
        ["Element", "x", "A"],
      ],
      statement: ["Element", "x", "B"],
      latex: String.raw`A\subseteq B,\ x\in A\vdash x\in B`,
      naturalLanguage: "If A is a subset of B and x is an element of A, then x is an element of B.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["SubsetEqual", "A", "B"], ["Element", "x", "B"]),
    },
    {
      slug: "union-membership",
      name: "Membership in a union",
      description: "An element belongs to a union exactly when it belongs to one of the sets.",
      parameters: [element("x"), set("A"), set("B")],
      statement: [
        "Equivalent",
        ["Element", "x", ["Union", "A", "B"]],
        ["Or", ["Element", "x", "A"], ["Element", "x", "B"]],
      ],
      latex: String.raw`x\in A\cup B\Leftrightarrow x\in A\lor x\in B`,
      naturalLanguage: "x is an element of A union B exactly when x is in A or x is in B.",
      directions: ["forward", "backward"],
      patterns: equivalencePatterns(
        ["Element", "x", ["Union", "A", "B"]],
        ["Or", ["Element", "x", "A"], ["Element", "x", "B"]],
      ),
    },
    {
      slug: "intersection-membership",
      name: "Membership in an intersection",
      description: "An element belongs to an intersection exactly when it belongs to both sets.",
      parameters: [element("x"), set("A"), set("B")],
      statement: [
        "Equivalent",
        ["Element", "x", ["Intersection", "A", "B"]],
        ["And", ["Element", "x", "A"], ["Element", "x", "B"]],
      ],
      latex: String.raw`x\in A\cap B\Leftrightarrow x\in A\land x\in B`,
      naturalLanguage: "x is an element of A intersect B exactly when x is in A and x is in B.",
      directions: ["forward", "backward"],
      patterns: equivalencePatterns(
        ["Element", "x", ["Intersection", "A", "B"]],
        ["And", ["Element", "x", "A"], ["Element", "x", "B"]],
      ),
    },
  ],
};

const DIVISIBILITY_PACK: PackSpec = {
  id: "pack:divisibility",
  name: "Divisibility",
  description: "Reflexivity and transitivity of divisibility; divisors of sums and multiples.",
  domain: "number-theory",
  operators: DIVISIBILITY_OPERATOR_DECLARATIONS,
  results: [
    {
      slug: "divides-reflexivity",
      name: "Reflexivity of divisibility",
      description: "Every integer divides itself.",
      parameters: [integer("a")],
      statement: ["Divides", "a", "a"],
      latex: String.raw`a\mid a`,
      naturalLanguage: "a divides a.",
      // A fact without premises only closes a goal that is an instance of it.
      directions: ["backward"],
      patterns: [
        {
          suffix: "backward",
          expression: ["Divides", "a", "a"],
          direction: "backward",
          requirement: GOAL,
        },
      ],
    },
    {
      slug: "divides-transitivity",
      name: "Transitivity of divisibility",
      description: "Divisibility is transitive.",
      parameters: [integer("a"), integer("b"), integer("c")],
      premises: [
        ["Divides", "a", "b"],
        ["Divides", "b", "c"],
      ],
      statement: ["Divides", "a", "c"],
      latex: String.raw`a\mid b,\ b\mid c\vdash a\mid c`,
      naturalLanguage: "If a divides b and b divides c, then a divides c.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["Divides", "a", "b"], ["Divides", "a", "c"]),
      variants: ["bundle-premises"],
    },
    {
      slug: "divides-sum",
      name: "Divisibility of a sum",
      description: "A common divisor of two integers divides their sum.",
      parameters: [integer("a"), integer("b"), integer("c")],
      premises: [
        ["Divides", "a", "b"],
        ["Divides", "a", "c"],
      ],
      statement: ["Divides", "a", ["Add", "b", "c"]],
      latex: String.raw`a\mid b,\ a\mid c\vdash a\mid b+c`,
      naturalLanguage: "If a divides b and a divides c, then a divides b + c.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["Divides", "a", "b"], ["Divides", "a", ["Add", "b", "c"]]),
    },
    {
      slug: "divides-multiple",
      name: "Divisibility of a multiple",
      description: "A divisor of an integer divides every multiple of it.",
      parameters: [integer("a"), integer("b"), integer("c")],
      premises: [["Divides", "a", "b"]],
      statement: ["Divides", "a", ["Multiply", "b", "c"]],
      latex: String.raw`a\mid b\vdash a\mid b\cdot c`,
      naturalLanguage: "If a divides b, then a divides b times c.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(["Divides", "a", "b"], ["Divides", "a", ["Multiply", "b", "c"]]),
    },
  ],
};

const CLOSURE_PACK: PackSpec = {
  id: "pack:closure",
  name: "Closure operators",
  description: "Extensivity, monotonicity, and idempotence of a closure operator on sets.",
  domain: "topology",
  operators: CLOSURE_OPERATOR_DECLARATIONS,
  results: [
    {
      slug: "closure-extensive",
      name: "Extensivity of closure",
      description: "Every set is contained in its closure.",
      parameters: [set("A")],
      statement: ["SubsetEqual", "A", ["Closure", "A"]],
      latex: String.raw`A\subseteq\operatorname{cl}\left(A\right)`,
      naturalLanguage: "A is a subset of the closure of A.",
      directions: ["forward", "backward"],
      patterns: [
        // Forward from a selected closure term: the inclusion becomes a hypothesis.
        {
          suffix: "forward",
          expression: ["Closure", "A"],
          direction: "forward",
          requirement: ANY_TERM,
        },
        {
          suffix: "backward",
          expression: ["SubsetEqual", "A", ["Closure", "A"]],
          direction: "backward",
          requirement: GOAL,
        },
      ],
    },
    {
      slug: "closure-monotone",
      name: "Monotonicity of closure",
      description: "Closure preserves inclusion.",
      parameters: [set("A"), set("B")],
      premises: [["SubsetEqual", "A", "B"]],
      statement: ["SubsetEqual", ["Closure", "A"], ["Closure", "B"]],
      latex: String.raw`A\subseteq B\vdash\operatorname{cl}\left(A\right)\subseteq\operatorname{cl}\left(B\right)`,
      naturalLanguage:
        "If A is a subset of B, then the closure of A is a subset of the closure of B.",
      directions: ["forward", "backward"],
      patterns: rulePatterns(
        ["SubsetEqual", "A", "B"],
        ["SubsetEqual", ["Closure", "A"], ["Closure", "B"]],
      ),
    },
    identity(
      "closure-idempotent",
      "Idempotence of closure",
      "Taking the closure twice gives the closure.",
      [set("A")],
      ["Equal", ["Closure", ["Closure", "A"]], ["Closure", "A"]],
      String.raw`\operatorname{cl}\left(\operatorname{cl}\left(A\right)\right)=\operatorname{cl}\left(A\right)`,
      "The closure of the closure of A equals the closure of A.",
    ),
  ],
};

const congruent = (left: PlainMathJson, right: PlainMathJson): PlainMathJson => [
  "Congruent",
  left,
  right,
  "m",
];

function modularArithmeticCongruence(
  head: "Add" | "Multiply",
  position: OperandPosition,
): ResultSpec {
  const lhs = position === "left";
  const addition = head === "Add";
  const operation = addition ? "addition" : "multiplication";
  const operands = (value: string): PlainMathJson =>
    lhs ? [head, value, "z"] : [head, "z", value];
  const term = (value: string) =>
    lhs ? `${value}${addition ? "+" : " "}z` : `z${addition ? "+" : " "}${value}`;
  return congruenceRule({
    slug: `congruent-${head.toLowerCase()}-${position}`,
    name: `Modular congruence of ${operation} (${position} operand)`,
    description: `Integer ${operation} preserves congruence modulo a fixed modulus.`,
    head,
    parameters: [integer("x"), integer("y"), integer("z"), integer("m")],
    premises: [congruent("x", "y")],
    statement: congruent(operands("x"), operands("y")),
    latex: `x\\equiv y\\pmod{m}\\vdash ${term("x")}\\equiv ${term("y")}\\pmod{m}`,
    naturalLanguage: `If x and y are congruent modulo m, so are ${term("x")} and ${term("y")}.`,
  });
}

function modularPredicateCongruence(position: OperandPosition): ResultSpec {
  const left = position === "left";
  const comparison = (value: PlainMathJson) =>
    left ? congruent(value, "z") : congruent("z", value);
  const displayed = (value: string) =>
    left ? `${value}\\equiv z\\pmod{m}` : `z\\equiv ${value}\\pmod{m}`;
  return congruenceRule({
    slug: `congruent-predicate-${position}`,
    name: `Modular congruence preserves the congruence predicate (${position} operand)`,
    description:
      "Either compared integer can be replaced by a congruent integer at the same modulus.",
    head: "Congruent",
    parameters: [integer("x"), integer("y"), integer("z"), integer("m")],
    premises: [congruent("x", "y")],
    statement: ["Equivalent", comparison("x"), comparison("y")],
    latex: `x\\equiv y\\pmod{m}\\vdash (${displayed("x")})\\iff(${displayed("y")})`,
    naturalLanguage:
      "If x and y are congruent modulo m, replacing x by y in a congruence modulo m preserves its truth.",
  });
}

const MODULAR_PACK: PackSpec = {
  id: "pack:modular-arithmetic",
  name: "Modular arithmetic",
  description: "Congruence of integers modulo a fixed modulus.",
  domain: "number-theory",
  operators: MODULAR_OPERATOR_DECLARATIONS,
  results: OPERAND_POSITIONS.flatMap((position) => [
    modularArithmeticCongruence("Add", position),
    modularArithmeticCongruence("Multiply", position),
    modularPredicateCongruence(position),
  ]),
};

const PACK_SPECS: readonly PackSpec[] = [
  LOGIC_PACK,
  EQUALITY_PACK,
  ORDER_PACK,
  ARITHMETIC_PACK,
  SET_PACK,
  DIVISIBILITY_PACK,
  CLOSURE_PACK,
  MODULAR_PACK,
];

let builtPacks: readonly LibraryPack[] | undefined;

/** The reviewed starter packs, validated and admitted on first use; frozen. */
export function starterLibraryPacks(): readonly LibraryPack[] {
  builtPacks ??= deepFreeze(PACK_SPECS.map(buildPack));
  return builtPacks;
}

/** One starter pack by ID. */
export function starterLibraryPack(id: LibraryPackId): LibraryPack {
  const pack = starterLibraryPacks().find((candidate) => candidate.id === id);
  if (pack === undefined) throw new Error(`Unknown library pack ${id}.`);
  return pack;
}

/**
 * The packs usable in an operator environment: those whose every operator the environment
 * declares identically. Packs without operators are always usable.
 */
export function libraryPacksForOperators(
  operators: readonly OperatorDeclaration[],
  packs: readonly LibraryPack[] = starterLibraryPacks(),
): readonly LibraryPack[] {
  const declared = new Map(operators.map((operator) => [operator.symbol, operator]));
  return packs.filter((pack) =>
    pack.operators.every((operator) => {
      const existing = declared.get(operator.symbol);
      return existing !== undefined && canonicalJsonEquals(existing, operator);
    }),
  );
}

function buildPack(spec: PackSpec): LibraryPack {
  const operators = operatorDeclarationsSchema.parse(structuredClone(spec.operators));
  const operatorRegistrations = operators.map((operator) =>
    libraryOperatorRegistrationSchema.parse({
      operator,
      reviewerId: OPERATOR_REVIEWER,
      registeredAt: OPERATOR_REGISTERED_AT,
    }),
  );
  const schema = createLibraryResultSchema({ operators });
  const results: LibraryResult[] = [];
  const variantFamilies: VariantFamily[] = [];
  for (const resultSpec of spec.results) {
    const source = admit(schema.parse(resultInput(spec, resultSpec)), operators);
    const requested = new Set(resultSpec.variants ?? []);
    if (requested.size === 0) {
      results.push(source);
      continue;
    }
    const generated = generateVariants(source, { operators });
    if (!generated.ok) {
      throw new Error(`Variants of ${source.id} failed: ${generated.diagnostics[0]?.message}`);
    }
    const variants = generated.variants
      .filter(
        (variant) =>
          variant.provenance.kind === "derived-variant" &&
          requested.has(variant.provenance.transformation),
      )
      .map((variant) => admit(schema.parse(withApplicablePatterns(variant)), operators));
    if (variants.length !== requested.size) {
      throw new Error(`Not every requested variant of ${source.id} could be generated.`);
    }
    const familyId = generated.source.variantFamilyId;
    if (familyId === undefined) throw new Error(`${source.id} has no variant family.`);
    variantFamilies.push(
      variantFamilySchema.parse({
        id: familyId,
        name: `${source.name} variants`,
        memberIds: [source.id, ...variants.map((variant) => variant.id)],
      }),
    );
    results.push(generated.source, ...variants);
  }
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    domain: spec.domain,
    operatorRegistrations,
    operators,
    results,
    variantFamilies,
  };
}

function resultInput(pack: PackSpec, spec: ResultSpec): unknown {
  const id = `result:${spec.slug}`;
  const patterns: ResultPattern[] = spec.patterns.map((pattern) => ({
    id: `pattern:${spec.slug}-${pattern.suffix}`,
    expression: pattern.expression,
    direction: pattern.direction,
    requirement: pattern.requirement,
  }));
  return {
    kind: "result",
    id,
    name: spec.name,
    description: spec.description,
    renderings: { latex: spec.latex, naturalLanguage: spec.naturalLanguage },
    classification: { domains: [pack.domain], level: "foundational" },
    provenance: {
      kind: "curated",
      source: `proof-platform starter ${pack.name.toLowerCase()} pack`,
    },
    approval: { status: "approved", reviewerId: OPERATOR_REVIEWER },
    layer: "global",
    related: [],
    priority: spec.priority ?? 100,
    parameters: spec.parameters.map(([symbol, sort]) => ({
      id: `declaration:${pack.id.slice("pack:".length)}-${spec.slug}-${symbol}`,
      symbol,
      sort,
      role: "universal-parameter",
    })),
    statement: { expression: spec.statement },
    premises: (spec.premises ?? []).map((expression) => ({ expression })),
    sideConditions: [],
    ...(spec.congruenceSymbols === undefined ? {} : { congruenceSymbols: spec.congruenceSymbols }),
    applicationDirections: spec.directions,
    patterns,
  };
}

/** Equality variants get the applicable equation patterns; see the module comment. */
function withApplicablePatterns(variant: LibraryResult): LibraryResult {
  const statement = variant.statement.expression;
  if (!Array.isArray(statement) || statement[0] !== "Equal" || variant.premises.length > 0) {
    return variant;
  }
  const symbols = new Set(variant.parameters.map((parameter) => parameter.symbol));
  const allowed = new Set(variant.applicationDirections);
  return {
    ...variant,
    patterns: equationPatterns(statement, symbols)
      .filter((pattern) => allowed.has(pattern.direction))
      .map((pattern) => ({
        id: `pattern:${variant.id}/${pattern.suffix}`,
        expression: pattern.expression,
        direction: pattern.direction,
        requirement: pattern.requirement,
      })),
  };
}

/** Run the deterministic global-layer admission gate; a starter pack must pass it. */
function admit(result: LibraryResult, operators: readonly OperatorDeclaration[]): LibraryResult {
  const admission = admitLibraryArtifact({
    artifact: result,
    layer: "global",
    environment: { operators },
  });
  if (!admission.ok || admission.artifact.kind !== "result") {
    throw new Error(
      `${result.id} was not admitted: ${admission.diagnostics[0]?.message ?? "not a result"}`,
    );
  }
  return admission.artifact;
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
