/**
 * The elementary benchmark corpus (design plan §21.5, Stage 2 exit; roadmap N16).
 *
 * Each problem is a single-goal proof state over the starter packs together with a scripted
 * solution: a sequence of selections, the displayed suggestion to choose, and, for moves that need
 * input, the menu values to pick. A script never supplies an expression as a payload. Selections
 * name statements by their current MathJSON, the chosen suggestion is looked up among the
 * suggestions actually displayed for those selections, and menu values are translated into the
 * menu item IDs of the menus the worker returns. The corpus therefore measures deterministic
 * coverage: every problem must be solvable through the protocol layer without a model call.
 *
 * The corpus lives beside the packs because each problem is defined by the packs it exercises; it
 * is plain data (no schema calls at module load) so that agents and tests can replay it through
 * any protocol client.
 */
import type { OperatorDeclaration, PlainMathJson, Sort } from "@proof/mathjson-model";
import {
  CLOSURE_OPERATOR_DECLARATIONS,
  DIVISIBILITY_OPERATOR_DECLARATIONS,
  ELEMENT_SET_SORT,
  ELEMENT_SORT,
  INTEGER_SORT,
  REAL_SORT,
  SET_OPERATOR_DECLARATIONS,
  type LibraryPackId,
} from "./packs";

/** A goal or obligation of the current state, found by its conclusion (first match). */
export type CorpusTargetReference = Readonly<{
  kind: "goal" | "obligation";
  conclusion: PlainMathJson;
}>;

/** An exact-occurrence selection in the current state. */
export type CorpusSelection = Readonly<{
  target: CorpusTargetReference;
  /** The target's conclusion, or the hypothesis of its context with this statement. */
  statement: "conclusion" | Readonly<{ hypothesis: PlainMathJson }>;
  path?: readonly number[];
}>;

/** A menu item's value; the client sends the ID of the displayed item with this value. */
export type CorpusMenuValue =
  | Readonly<{ kind: "index"; index: number }>
  | Readonly<{ kind: "term"; expression: PlainMathJson }>
  | Readonly<{ kind: "direction"; direction: "forward" | "backward" }>;

export type CorpusStep = Readonly<{
  note: string;
  selections: readonly CorpusSelection[];
  /** The displayed suggestion to choose. */
  suggestion: Readonly<{ source: "move" | "result"; artifactId: string; patternId?: string }>;
  /** Values for the parameters the worker reports as missing, keyed by parameter ID. */
  menu?: Readonly<Record<string, CorpusMenuValue>>;
}>;

export type CorpusProblem = Readonly<{
  id: string;
  title: string;
  statement: string;
  domain: string;
  packs: readonly LibraryPackId[];
  operators: readonly OperatorDeclaration[];
  declarations: readonly DeclarationSpec[];
  hypotheses: readonly PlainMathJson[];
  goal: PlainMathJson;
  steps: readonly CorpusStep[];
}>;

type DeclarationSpec = readonly [symbol: string, sort: Sort];

const PROPOSITION: Sort = { kind: "proposition" };
const declared =
  (sort: Sort) =>
  (...symbols: string[]): DeclarationSpec[] =>
    symbols.map((symbol) => [symbol, sort] as const);
const propositions = declared(PROPOSITION);
const reals = declared(REAL_SORT);
const sets = declared(ELEMENT_SET_SORT);
const integers = declared(INTEGER_SORT);

/** Select the whole conclusion of the goal whose conclusion is `conclusion`. */
function goal(conclusion: PlainMathJson, path: readonly number[] = []): CorpusSelection {
  return { target: { kind: "goal", conclusion }, statement: "conclusion", path };
}

/** Select (a subterm of) the hypothesis `statement` of the goal whose conclusion is `conclusion`. */
function hypothesis(
  conclusion: PlainMathJson,
  statement: PlainMathJson,
  path: readonly number[] = [],
): CorpusSelection {
  return { target: { kind: "goal", conclusion }, statement: { hypothesis: statement }, path };
}

/** Close the goal `conclusion` by its identical hypothesis. */
function closeByHypothesis(conclusion: PlainMathJson): CorpusStep {
  return {
    note: "Close the goal by the matching hypothesis.",
    selections: [goal(conclusion), hypothesis(conclusion, conclusion)],
    suggestion: { source: "move", artifactId: "move:close-by-hypothesis" },
  };
}

function result(slug: string, direction: "forward" | "backward") {
  return {
    source: "result" as const,
    artifactId: `result:${slug}`,
    patternId: `pattern:${slug}-${direction}`,
  };
}

const term = (expression: PlainMathJson): CorpusMenuValue => ({ kind: "term", expression });
const FORWARD: CorpusMenuValue = { kind: "direction", direction: "forward" };

/** Rewrite the occurrence at `path` of the goal `conclusion` with the equation hypothesis. */
function rewriteGoal(
  conclusion: PlainMathJson,
  equation: PlainMathJson,
  path: readonly number[],
): CorpusStep {
  return {
    note: "Rewrite the occurrence left to right with the derived equation.",
    selections: [hypothesis(conclusion, equation), goal(conclusion, path)],
    suggestion: { source: "move", artifactId: "move:rewrite-with-equality" },
    menu: { direction: FORWARD },
  };
}

const ab: PlainMathJson = ["Multiply", "a", "b"];
const ac: PlainMathJson = ["Multiply", "a", "c"];
const ca: PlainMathJson = ["Multiply", "c", "a"];
const inter: PlainMathJson = ["Element", "x", ["Intersection", "A", "B"]];

export const ELEMENTARY_CORPUS: readonly CorpusProblem[] = [
  {
    id: "corpus:modus-tollens",
    title: "Modus tollens",
    statement: "Assuming p implies q and not q, show not p.",
    domain: "logic",
    packs: ["pack:elementary-logic"],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [
      ["Implies", "p", "q"],
      ["Not", "q"],
    ],
    goal: ["Not", "p"],
    steps: [
      {
        note: "Apply modus tollens forward from the implication; not q is already a hypothesis.",
        selections: [hypothesis(["Not", "p"], ["Implies", "p", "q"])],
        suggestion: result("modus-tollens", "forward"),
      },
      closeByHypothesis(["Not", "p"]),
    ],
  },
  {
    id: "corpus:disjunctive-syllogism",
    title: "Disjunctive syllogism",
    statement: "Assuming p or q and not p, show q.",
    domain: "logic",
    packs: ["pack:elementary-logic"],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [
      ["Or", "p", "q"],
      ["Not", "p"],
    ],
    goal: "q",
    steps: [
      {
        note: "Eliminate the disjunction with the refuted disjunct.",
        selections: [hypothesis("q", ["Or", "p", "q"])],
        suggestion: result("disjunctive-syllogism", "forward"),
      },
      closeByHypothesis("q"),
    ],
  },
  {
    id: "corpus:de-morgan",
    title: "De Morgan for a negated disjunction",
    statement: "Assuming not (p or q), show not p and not q.",
    domain: "logic",
    packs: ["pack:elementary-logic"],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [["Not", ["Or", "p", "q"]]],
    goal: ["And", ["Not", "p"], ["Not", "q"]],
    steps: [
      {
        note: "Rewrite the hypothesis with De Morgan's law.",
        selections: [hypothesis(["And", ["Not", "p"], ["Not", "q"]], ["Not", ["Or", "p", "q"]])],
        suggestion: result("de-morgan-disjunction", "forward"),
      },
      closeByHypothesis(["And", ["Not", "p"], ["Not", "q"]]),
    ],
  },
  {
    id: "corpus:double-negation-commuted",
    title: "Double negation and a commuted disjunction",
    statement: "Assuming not not (p or q), show q or p.",
    domain: "logic",
    packs: ["pack:elementary-logic"],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [["Not", ["Not", ["Or", "p", "q"]]]],
    goal: ["Or", "q", "p"],
    steps: [
      {
        note: "Remove the double negation from the hypothesis.",
        selections: [hypothesis(["Or", "q", "p"], ["Not", ["Not", ["Or", "p", "q"]]])],
        suggestion: result("double-negation", "forward"),
      },
      {
        note: "Commute the disjunction in the goal.",
        selections: [goal(["Or", "q", "p"])],
        suggestion: result("disjunction-commutativity", "forward"),
      },
      closeByHypothesis(["Or", "p", "q"]),
    ],
  },
  {
    id: "corpus:equality-chain",
    title: "Chaining equations",
    statement: "For reals a, b, c with a = b and c = b, show a = c.",
    domain: "equality",
    packs: ["pack:equality"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [
      ["Equal", "a", "b"],
      ["Equal", "c", "b"],
    ],
    goal: ["Equal", "a", "c"],
    steps: [
      {
        note: "Turn c = b around.",
        selections: [hypothesis(["Equal", "a", "c"], ["Equal", "c", "b"])],
        suggestion: result("equality-symmetry", "forward"),
      },
      {
        note: "Chain a = b with b = c; the second premise is found among the hypotheses.",
        selections: [hypothesis(["Equal", "a", "c"], ["Equal", "a", "b"])],
        suggestion: result("equality-transitivity", "forward"),
      },
      closeByHypothesis(["Equal", "a", "c"]),
    ],
  },
  {
    id: "corpus:less-transitivity",
    title: "Transitivity of <",
    statement: "For reals a, b, c with a < b and b < c, show a < c.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [
      ["Less", "a", "b"],
      ["Less", "b", "c"],
    ],
    goal: ["Less", "a", "c"],
    steps: [
      {
        note: "Chain the two inequalities forward.",
        selections: [hypothesis(["Less", "a", "c"], ["Less", "a", "b"])],
        suggestion: result("less-transitivity", "forward"),
      },
      closeByHypothesis(["Less", "a", "c"]),
    ],
  },
  {
    id: "corpus:antisymmetry",
    title: "Antisymmetry of ≤",
    statement: "For reals a, b with a ≤ b and b ≤ a, show a = b.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b"),
    hypotheses: [
      ["LessEqual", "a", "b"],
      ["LessEqual", "b", "a"],
    ],
    goal: ["Equal", "a", "b"],
    steps: [
      {
        note: "Reduce the equation to two inequalities by antisymmetry.",
        selections: [goal(["Equal", "a", "b"])],
        suggestion: result("less-equal-antisymmetry", "backward"),
      },
      closeByHypothesis(["LessEqual", "a", "b"]),
      closeByHypothesis(["LessEqual", "b", "a"]),
    ],
  },
  {
    id: "corpus:shifted-chain",
    title: "A shifted chain of inequalities",
    statement: "For reals a, b, c, d with a ≤ b and b ≤ c, show a + d ≤ c + d.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b", "c", "d"),
    hypotheses: [
      ["LessEqual", "a", "b"],
      ["LessEqual", "b", "c"],
    ],
    goal: ["LessEqual", ["Add", "a", "d"], ["Add", "c", "d"]],
    steps: [
      {
        note: "Chain a ≤ b with b ≤ c.",
        selections: [
          hypothesis(["LessEqual", ["Add", "a", "d"], ["Add", "c", "d"]], ["LessEqual", "a", "b"]),
        ],
        suggestion: result("less-equal-transitivity", "forward"),
      },
      {
        note: "Add d to both sides of a ≤ c, choosing d from the term menu.",
        selections: [
          hypothesis(["LessEqual", ["Add", "a", "d"], ["Add", "c", "d"]], ["LessEqual", "a", "c"]),
        ],
        suggestion: result("less-equal-add-monotonicity", "forward"),
        menu: { "instantiation/z": term("d") },
      },
      closeByHypothesis(["LessEqual", ["Add", "a", "d"], ["Add", "c", "d"]]),
    ],
  },
  {
    id: "corpus:strict-shift",
    title: "Adding to both sides of <",
    statement: "For reals a, b, c with a < b, show a + c < b + c.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [["Less", "a", "b"]],
    goal: ["Less", ["Add", "a", "c"], ["Add", "b", "c"]],
    steps: [
      {
        note: "Reduce to a < b by monotonicity of addition.",
        selections: [goal(["Less", ["Add", "a", "c"], ["Add", "b", "c"]])],
        suggestion: result("less-add-monotonicity", "backward"),
      },
      closeByHypothesis(["Less", "a", "b"]),
    ],
  },
  {
    id: "corpus:distributivity",
    title: "Expanding a product",
    statement: "For reals a, b, c, show a(b + c) = ca + ab.",
    domain: "arithmetic",
    packs: ["pack:arithmetic"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [],
    goal: ["Equal", ["Multiply", "a", ["Add", "b", "c"]], ["Add", ca, ab]],
    steps: [
      {
        note: "Derive the distributive expansion of the left-hand side.",
        selections: [goal(["Equal", ["Multiply", "a", ["Add", "b", "c"]], ["Add", ca, ab]], [0])],
        suggestion: result("left-distributivity", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Multiply", "a", ["Add", "b", "c"]], ["Add", ca, ab]],
        ["Equal", ["Multiply", "a", ["Add", "b", "c"]], ["Add", ab, ac]],
        [0],
      ),
      {
        note: "Derive the commuted sum.",
        selections: [goal(["Equal", ["Add", ab, ac], ["Add", ca, ab]], [0])],
        suggestion: result("add-commutativity", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Add", ab, ac], ["Add", ca, ab]],
        ["Equal", ["Add", ab, ac], ["Add", ac, ab]],
        [0],
      ),
      {
        note: "Derive the commuted product.",
        selections: [goal(["Equal", ["Add", ac, ab], ["Add", ca, ab]], [0, 0])],
        suggestion: result("multiply-commutativity", "forward"),
      },
      rewriteGoal(["Equal", ["Add", ac, ab], ["Add", ca, ab]], ["Equal", ac, ca], [0, 0]),
      {
        note: "Both sides are now identical.",
        selections: [goal(["Equal", ["Add", ca, ab], ["Add", ca, ab]])],
        suggestion: { source: "move", artifactId: "move:close-reflexive-equality" },
      },
    ],
  },
  {
    id: "corpus:identities",
    title: "Additive and multiplicative identities",
    statement: "For a real a, show (a + 0) · 1 = a.",
    domain: "arithmetic",
    packs: ["pack:arithmetic"],
    operators: [],
    declarations: reals("a"),
    hypotheses: [],
    goal: ["Equal", ["Multiply", ["Add", "a", 0], 1], "a"],
    steps: [
      {
        note: "Derive that multiplying by one changes nothing.",
        selections: [goal(["Equal", ["Multiply", ["Add", "a", 0], 1], "a"], [0])],
        suggestion: result("multiply-one", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Multiply", ["Add", "a", 0], 1], "a"],
        ["Equal", ["Multiply", ["Add", "a", 0], 1], ["Add", "a", 0]],
        [0],
      ),
      {
        note: "The remaining goal is an instance of the additive identity.",
        selections: [goal(["Equal", ["Add", "a", 0], "a"])],
        suggestion: result("add-zero", "backward"),
      },
    ],
  },
  {
    id: "corpus:subset-transitivity",
    title: "Transitivity of inclusion",
    statement: "For sets A, B, C with A ⊆ B and B ⊆ C, show A ⊆ C.",
    domain: "sets",
    packs: ["pack:sets"],
    operators: SET_OPERATOR_DECLARATIONS,
    declarations: sets("A", "B", "C"),
    hypotheses: [
      ["SubsetEqual", "A", "B"],
      ["SubsetEqual", "B", "C"],
    ],
    goal: ["SubsetEqual", "A", "C"],
    steps: [
      {
        note: "Chain A ⊆ B with B ⊆ C; the second premise is found among the hypotheses.",
        selections: [hypothesis(["SubsetEqual", "A", "C"], ["SubsetEqual", "A", "B"])],
        suggestion: result("subset-transitivity", "forward"),
      },
      closeByHypothesis(["SubsetEqual", "A", "C"]),
    ],
  },
  {
    id: "corpus:intersection-to-union",
    title: "From an intersection to a union",
    statement: "For an element x and sets A, B with x ∈ A ∩ B, show x ∈ B ∪ A.",
    domain: "sets",
    packs: ["pack:sets"],
    operators: SET_OPERATOR_DECLARATIONS,
    declarations: [["x", ELEMENT_SORT], ...sets("A", "B")],
    hypotheses: [inter],
    goal: ["Element", "x", ["Union", "B", "A"]],
    steps: [
      {
        note: "Unfold membership in the intersection.",
        selections: [hypothesis(["Element", "x", ["Union", "B", "A"]], inter)],
        suggestion: result("intersection-membership", "forward"),
      },
      {
        note: "Split the conjunction into two membership facts.",
        selections: [
          goal(["Element", "x", ["Union", "B", "A"]]),
          hypothesis(
            ["Element", "x", ["Union", "B", "A"]],
            ["And", ["Element", "x", "A"], ["Element", "x", "B"]],
          ),
        ],
        suggestion: { source: "move", artifactId: "move:expand-hypothesis-conjunction" },
      },
      {
        note: "Unfold membership in the union.",
        selections: [goal(["Element", "x", ["Union", "B", "A"]])],
        suggestion: result("union-membership", "forward"),
      },
      {
        note: "Choose the first disjunct from the menu.",
        selections: [goal(["Or", ["Element", "x", "B"], ["Element", "x", "A"]])],
        suggestion: { source: "move", artifactId: "move:choose-goal-disjunct" },
        menu: { disjunctIndex: { kind: "index", index: 0 } },
      },
      closeByHypothesis(["Element", "x", "B"]),
    ],
  },
  {
    id: "corpus:superset-union",
    title: "Membership through a subset and a union",
    statement: "For an element x and sets A, B, C with A ⊆ B and x ∈ A, show x ∈ B ∪ C.",
    domain: "sets",
    packs: ["pack:sets"],
    operators: SET_OPERATOR_DECLARATIONS,
    declarations: [["x", ELEMENT_SORT], ...sets("A", "B", "C")],
    hypotheses: [
      ["SubsetEqual", "A", "B"],
      ["Element", "x", "A"],
    ],
    goal: ["Element", "x", ["Union", "B", "C"]],
    steps: [
      {
        note: "Unfold membership in the union.",
        selections: [goal(["Element", "x", ["Union", "B", "C"]])],
        suggestion: result("union-membership", "forward"),
      },
      {
        note: "Choose the first disjunct from the menu.",
        selections: [goal(["Or", ["Element", "x", "B"], ["Element", "x", "C"]])],
        suggestion: { source: "move", artifactId: "move:choose-goal-disjunct" },
        menu: { disjunctIndex: { kind: "index", index: 0 } },
      },
      {
        note: "Push x ∈ A through A ⊆ B; x ∈ A is found among the hypotheses.",
        selections: [hypothesis(["Element", "x", "B"], ["SubsetEqual", "A", "B"])],
        suggestion: result("subset-membership", "forward"),
      },
      closeByHypothesis(["Element", "x", "B"]),
    ],
  },
];

/** Close the goal `conclusion` by the displayed backward application of a fact. */
function closeByFact(slug: string, conclusion: PlainMathJson, note: string): CorpusStep {
  return { note, selections: [goal(conclusion)], suggestion: result(slug, "backward") };
}

const bc: PlainMathJson = ["Multiply", "b", "c"];
const divides = (left: PlainMathJson, right: PlainMathJson): PlainMathJson => [
  "Divides",
  left,
  right,
];
const subset = (left: PlainMathJson, right: PlainMathJson): PlainMathJson => [
  "SubsetEqual",
  left,
  right,
];
const closure = (argument: PlainMathJson): PlainMathJson => ["Closure", argument];
const RESEARCH_OPERATORS = [...SET_OPERATOR_DECLARATIONS, ...CLOSURE_OPERATOR_DECLARATIONS];

/**
 * The benchmark-corpus extension (design plan §21.5; roadmap N37): logic with the core moves,
 * algebra over the arithmetic identities, number theory over the divisibility pack, sets, order,
 * and a research-notation case whose custom `Closure` operator carries N02 presentation metadata.
 * Like the elementary corpus, every problem is solved through the protocol layer by displayed
 * suggestions and menu choices only.
 */
export const EXTENDED_CORPUS: readonly CorpusProblem[] = [
  {
    id: "corpus:hypothetical-syllogism",
    title: "Chaining implications",
    statement: "Assuming p implies q, q implies r, and p, show r.",
    domain: "logic",
    packs: [],
    operators: [],
    declarations: propositions("p", "q", "r"),
    hypotheses: [["Implies", "p", "q"], ["Implies", "q", "r"], "p"],
    goal: "r",
    steps: [
      {
        note: "Modus ponens forward from p implies q; p is found among the hypotheses.",
        selections: [hypothesis("r", ["Implies", "p", "q"])],
        suggestion: { source: "result", artifactId: "result:modus-ponens" },
      },
      {
        note: "Modus ponens forward from q implies r.",
        selections: [hypothesis("r", ["Implies", "q", "r"])],
        suggestion: { source: "result", artifactId: "result:modus-ponens" },
      },
      closeByHypothesis("r"),
    ],
  },
  {
    id: "corpus:contraposition",
    title: "Contraposition",
    statement: "Assuming p implies q, show that not q implies not p.",
    domain: "logic",
    packs: ["pack:elementary-logic"],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [["Implies", "p", "q"]],
    goal: ["Implies", ["Not", "q"], ["Not", "p"]],
    steps: [
      {
        note: "Assume not q.",
        selections: [goal(["Implies", ["Not", "q"], ["Not", "p"]])],
        suggestion: { source: "move", artifactId: "move:introduce-implication" },
      },
      {
        note: "Modus tollens forward; the assumed not q is found among the hypotheses.",
        selections: [hypothesis(["Not", "p"], ["Implies", "p", "q"])],
        suggestion: result("modus-tollens", "forward"),
      },
      closeByHypothesis(["Not", "p"]),
    ],
  },
  {
    id: "corpus:conjunction-swap",
    title: "Swapping a conjunction",
    statement: "Assuming p and q, show q and p.",
    domain: "logic",
    packs: [],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [["And", "p", "q"]],
    goal: ["And", "q", "p"],
    steps: [
      {
        note: "Split the conjunctive hypothesis.",
        selections: [goal(["And", "q", "p"]), hypothesis(["And", "q", "p"], ["And", "p", "q"])],
        suggestion: { source: "move", artifactId: "move:expand-hypothesis-conjunction" },
      },
      {
        note: "Split the conjunctive goal.",
        selections: [goal(["And", "q", "p"])],
        suggestion: { source: "move", artifactId: "move:split-goal-conjunction" },
      },
      closeByHypothesis("q"),
      closeByHypothesis("p"),
    ],
  },
  {
    id: "corpus:proof-by-cases",
    title: "Proof by cases",
    statement: "Assuming p or q, p implies r, and q implies r, show r.",
    domain: "logic",
    packs: [],
    operators: [],
    declarations: propositions("p", "q", "r"),
    hypotheses: [
      ["Or", "p", "q"],
      ["Implies", "p", "r"],
      ["Implies", "q", "r"],
    ],
    goal: "r",
    steps: [
      {
        note: "Split the disjunctive hypothesis into two cases.",
        selections: [goal("r"), hypothesis("r", ["Or", "p", "q"])],
        suggestion: { source: "move", artifactId: "move:split-hypothesis-disjunction" },
      },
      {
        note: "First case: modus ponens forward from p implies r.",
        selections: [hypothesis("r", ["Implies", "p", "r"])],
        suggestion: { source: "result", artifactId: "result:modus-ponens" },
      },
      closeByHypothesis("r"),
      {
        note: "Second case: modus ponens forward from q implies r.",
        selections: [hypothesis("r", ["Implies", "q", "r"])],
        suggestion: { source: "result", artifactId: "result:modus-ponens" },
      },
      closeByHypothesis("r"),
    ],
  },
  {
    id: "corpus:negated-conjunction",
    title: "Refuting one conjunct",
    statement: "Assuming not (p and q) and p, show not q.",
    domain: "logic",
    packs: ["pack:elementary-logic"],
    operators: [],
    declarations: propositions("p", "q"),
    hypotheses: [["Not", ["And", "p", "q"]], "p"],
    goal: ["Not", "q"],
    steps: [
      {
        note: "Rewrite the hypothesis with De Morgan's law.",
        selections: [hypothesis(["Not", "q"], ["Not", ["And", "p", "q"]])],
        suggestion: result("de-morgan-conjunction", "forward"),
      },
      {
        note: "Split the disjunction into two cases.",
        selections: [
          goal(["Not", "q"]),
          hypothesis(["Not", "q"], ["Or", ["Not", "p"], ["Not", "q"]]),
        ],
        suggestion: { source: "move", artifactId: "move:split-hypothesis-disjunction" },
      },
      {
        note: "First case: p and not p contradict each other.",
        selections: [
          goal(["Not", "q"]),
          hypothesis(["Not", "q"], "p"),
          hypothesis(["Not", "q"], ["Not", "p"]),
        ],
        suggestion: { source: "move", artifactId: "move:close-by-contradiction" },
      },
      closeByHypothesis(["Not", "q"]),
    ],
  },
  {
    id: "corpus:regrouping",
    title: "Regrouping a sum",
    statement: "For reals a, b, c, show (a + b) + c = a + (c + b).",
    domain: "algebra",
    packs: ["pack:arithmetic"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [],
    goal: ["Equal", ["Add", ["Add", "a", "b"], "c"], ["Add", "a", ["Add", "c", "b"]]],
    steps: [
      {
        note: "Derive the associativity instance for the left-hand side.",
        selections: [
          goal(["Equal", ["Add", ["Add", "a", "b"], "c"], ["Add", "a", ["Add", "c", "b"]]], [0]),
        ],
        suggestion: result("add-associativity", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Add", ["Add", "a", "b"], "c"], ["Add", "a", ["Add", "c", "b"]]],
        ["Equal", ["Add", ["Add", "a", "b"], "c"], ["Add", "a", ["Add", "b", "c"]]],
        [0],
      ),
      {
        note: "Derive the commuted inner sum.",
        selections: [
          goal(["Equal", ["Add", "a", ["Add", "b", "c"]], ["Add", "a", ["Add", "c", "b"]]], [0, 1]),
        ],
        suggestion: result("add-commutativity", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Add", "a", ["Add", "b", "c"]], ["Add", "a", ["Add", "c", "b"]]],
        ["Equal", ["Add", "b", "c"], ["Add", "c", "b"]],
        [0, 1],
      ),
      {
        note: "Both sides are now identical.",
        selections: [
          goal(["Equal", ["Add", "a", ["Add", "c", "b"]], ["Add", "a", ["Add", "c", "b"]]]),
        ],
        suggestion: { source: "move", artifactId: "move:close-reflexive-equality" },
      },
    ],
  },
  {
    id: "corpus:annihilation",
    title: "A vanishing product",
    statement: "For reals a, b, show a · 0 + b = b.",
    domain: "algebra",
    packs: ["pack:arithmetic"],
    operators: [],
    declarations: reals("a", "b"),
    hypotheses: [],
    goal: ["Equal", ["Add", ["Multiply", "a", 0], "b"], "b"],
    steps: [
      {
        note: "Derive that the product with zero vanishes.",
        selections: [goal(["Equal", ["Add", ["Multiply", "a", 0], "b"], "b"], [0, 0])],
        suggestion: result("multiply-zero", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Add", ["Multiply", "a", 0], "b"], "b"],
        ["Equal", ["Multiply", "a", 0], 0],
        [0, 0],
      ),
      {
        note: "Derive the commuted sum.",
        selections: [goal(["Equal", ["Add", 0, "b"], "b"], [0])],
        suggestion: result("add-commutativity", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Add", 0, "b"], "b"],
        ["Equal", ["Add", 0, "b"], ["Add", "b", 0]],
        [0],
      ),
      closeByFact("add-zero", ["Equal", ["Add", "b", 0], "b"], "An instance of the identity."),
    ],
  },
  {
    id: "corpus:equal-products",
    title: "Multiplying an equation",
    statement: "For reals a, b, c with a = b, show a · c = b · c.",
    domain: "algebra",
    packs: [],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [["Equal", "a", "b"]],
    goal: ["Equal", ["Multiply", "a", "c"], bc],
    steps: [
      rewriteGoal(["Equal", ["Multiply", "a", "c"], bc], ["Equal", "a", "b"], [0, 0]),
      {
        note: "Both sides are now identical.",
        selections: [goal(["Equal", bc, bc])],
        suggestion: { source: "move", artifactId: "move:close-reflexive-equality" },
      },
    ],
  },
  {
    id: "corpus:vanishing-chain",
    title: "Substituting into a product",
    statement: "For reals a, b, c with a = b and b = 0, show a · c = 0.",
    domain: "algebra",
    packs: ["pack:arithmetic"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [
      ["Equal", "a", "b"],
      ["Equal", "b", 0],
    ],
    goal: ["Equal", ["Multiply", "a", "c"], 0],
    steps: [
      rewriteGoal(["Equal", ["Multiply", "a", "c"], 0], ["Equal", "a", "b"], [0, 0]),
      rewriteGoal(["Equal", bc, 0], ["Equal", "b", 0], [0, 0]),
      {
        note: "Derive the commuted product.",
        selections: [goal(["Equal", ["Multiply", 0, "c"], 0], [0])],
        suggestion: result("multiply-commutativity", "forward"),
      },
      rewriteGoal(
        ["Equal", ["Multiply", 0, "c"], 0],
        ["Equal", ["Multiply", 0, "c"], ["Multiply", "c", 0]],
        [0],
      ),
      closeByFact(
        "multiply-zero",
        ["Equal", ["Multiply", "c", 0], 0],
        "An instance of multiplication by zero.",
      ),
    ],
  },
  {
    id: "corpus:divisibility-chain",
    title: "Transitivity of divisibility",
    statement: "For integers a, b, c with a | b and b | c, show a | c.",
    domain: "number-theory",
    packs: ["pack:divisibility"],
    operators: DIVISIBILITY_OPERATOR_DECLARATIONS,
    declarations: integers("a", "b", "c"),
    hypotheses: [divides("a", "b"), divides("b", "c")],
    goal: divides("a", "c"),
    steps: [
      {
        note: "Chain a | b with b | c; the second premise is found among the hypotheses.",
        selections: [hypothesis(divides("a", "c"), divides("a", "b"))],
        suggestion: result("divides-transitivity", "forward"),
      },
      closeByHypothesis(divides("a", "c")),
    ],
  },
  {
    id: "corpus:divisibility-sum",
    title: "A common divisor divides the sum",
    statement: "For integers a, b, c with a | b and a | c, show a | b + c.",
    domain: "number-theory",
    packs: ["pack:divisibility"],
    operators: DIVISIBILITY_OPERATOR_DECLARATIONS,
    declarations: integers("a", "b", "c"),
    hypotheses: [divides("a", "b"), divides("a", "c")],
    goal: divides("a", ["Add", "b", "c"]),
    steps: [
      {
        note: "Reduce to the two divisibility facts.",
        selections: [goal(divides("a", ["Add", "b", "c"]))],
        suggestion: result("divides-sum", "backward"),
      },
      closeByHypothesis(divides("a", "b")),
      closeByHypothesis(divides("a", "c")),
    ],
  },
  {
    id: "corpus:divisibility-linear",
    title: "A divisor divides a linear expression",
    statement: "For integers a, b, c with a | b, show a | bc + b.",
    domain: "number-theory",
    packs: ["pack:divisibility"],
    operators: DIVISIBILITY_OPERATOR_DECLARATIONS,
    declarations: integers("a", "b", "c"),
    hypotheses: [divides("a", "b")],
    goal: divides("a", ["Add", bc, "b"]),
    steps: [
      {
        note: "Split the sum.",
        selections: [goal(divides("a", ["Add", bc, "b"]))],
        suggestion: result("divides-sum", "backward"),
      },
      {
        note: "Reduce the multiple to its factor.",
        selections: [goal(divides("a", bc))],
        suggestion: result("divides-multiple", "backward"),
      },
      closeByHypothesis(divides("a", "b")),
      closeByHypothesis(divides("a", "b")),
    ],
  },
  {
    id: "corpus:divisibility-self",
    title: "An integer divides a sum of its multiples",
    statement: "For integers a, b, show a | a + ab.",
    domain: "number-theory",
    packs: ["pack:divisibility"],
    operators: DIVISIBILITY_OPERATOR_DECLARATIONS,
    declarations: integers("a", "b"),
    hypotheses: [],
    goal: divides("a", ["Add", "a", ab]),
    steps: [
      {
        note: "Split the sum.",
        selections: [goal(divides("a", ["Add", "a", ab]))],
        suggestion: result("divides-sum", "backward"),
      },
      closeByFact("divides-reflexivity", divides("a", "a"), "a divides itself."),
      {
        note: "Reduce the multiple to its factor.",
        selections: [goal(divides("a", ab))],
        suggestion: result("divides-multiple", "backward"),
      },
      closeByFact("divides-reflexivity", divides("a", "a"), "a divides itself."),
    ],
  },
  {
    id: "corpus:divisibility-chain-multiple",
    title: "A divisor of a divisor divides a multiple",
    statement: "For integers a, b, c, d with a | b and b | c, show a | cd.",
    domain: "number-theory",
    packs: ["pack:divisibility"],
    operators: DIVISIBILITY_OPERATOR_DECLARATIONS,
    declarations: integers("a", "b", "c", "d"),
    hypotheses: [divides("a", "b"), divides("b", "c")],
    goal: divides("a", ["Multiply", "c", "d"]),
    steps: [
      {
        note: "Reduce the multiple to its factor.",
        selections: [goal(divides("a", ["Multiply", "c", "d"]))],
        suggestion: result("divides-multiple", "backward"),
      },
      {
        note: "Chain a | b with b | c.",
        selections: [hypothesis(divides("a", "c"), divides("a", "b"))],
        suggestion: result("divides-transitivity", "forward"),
      },
      closeByHypothesis(divides("a", "c")),
    ],
  },
  {
    id: "corpus:subset-chain-membership",
    title: "Membership along a chain of inclusions",
    statement: "For an element x and sets A, B, C with A ⊆ B, B ⊆ C and x ∈ A, show x ∈ C.",
    domain: "sets",
    packs: ["pack:sets"],
    operators: SET_OPERATOR_DECLARATIONS,
    declarations: [["x", ELEMENT_SORT], ...sets("A", "B", "C")],
    hypotheses: [subset("A", "B"), subset("B", "C"), ["Element", "x", "A"]],
    goal: ["Element", "x", "C"],
    steps: [
      {
        note: "Push x ∈ A through A ⊆ B.",
        selections: [hypothesis(["Element", "x", "C"], subset("A", "B"))],
        suggestion: result("subset-membership", "forward"),
      },
      {
        note: "Push x ∈ B through B ⊆ C.",
        selections: [hypothesis(["Element", "x", "C"], subset("B", "C"))],
        suggestion: result("subset-membership", "forward"),
      },
      closeByHypothesis(["Element", "x", "C"]),
    ],
  },
  {
    id: "corpus:intersection-introduction",
    title: "Membership in an intersection",
    statement: "For an element x and sets A, B with x ∈ A and x ∈ B, show x ∈ A ∩ B.",
    domain: "sets",
    packs: ["pack:sets"],
    operators: SET_OPERATOR_DECLARATIONS,
    declarations: [["x", ELEMENT_SORT], ...sets("A", "B")],
    hypotheses: [
      ["Element", "x", "A"],
      ["Element", "x", "B"],
    ],
    goal: inter,
    steps: [
      {
        note: "Unfold membership in the intersection.",
        selections: [goal(inter)],
        suggestion: result("intersection-membership", "forward"),
      },
      {
        note: "Split the conjunctive goal.",
        selections: [goal(["And", ["Element", "x", "A"], ["Element", "x", "B"]])],
        suggestion: { source: "move", artifactId: "move:split-goal-conjunction" },
      },
      closeByHypothesis(["Element", "x", "A"]),
      closeByHypothesis(["Element", "x", "B"]),
    ],
  },
  {
    id: "corpus:union-introduction",
    title: "Membership in a union",
    statement: "For an element x and sets A, B with x ∈ A, show x ∈ B ∪ A.",
    domain: "sets",
    packs: ["pack:sets"],
    operators: SET_OPERATOR_DECLARATIONS,
    declarations: [["x", ELEMENT_SORT], ...sets("A", "B")],
    hypotheses: [["Element", "x", "A"]],
    goal: ["Element", "x", ["Union", "B", "A"]],
    steps: [
      {
        note: "Unfold membership in the union.",
        selections: [goal(["Element", "x", ["Union", "B", "A"]])],
        suggestion: result("union-membership", "forward"),
      },
      {
        note: "Choose the second disjunct from the menu.",
        selections: [goal(["Or", ["Element", "x", "B"], ["Element", "x", "A"]])],
        suggestion: { source: "move", artifactId: "move:choose-goal-disjunct" },
        menu: { disjunctIndex: { kind: "index", index: 1 } },
      },
      closeByHypothesis(["Element", "x", "A"]),
    ],
  },
  {
    id: "corpus:three-step-chain",
    title: "A chain of three strict inequalities",
    statement: "For reals a, b, c, d with a < b, b < c and c < d, show a < d.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b", "c", "d"),
    hypotheses: [
      ["Less", "a", "b"],
      ["Less", "b", "c"],
      ["Less", "c", "d"],
    ],
    goal: ["Less", "a", "d"],
    steps: [
      {
        note: "Chain a < b with b < c.",
        selections: [hypothesis(["Less", "a", "d"], ["Less", "a", "b"])],
        suggestion: result("less-transitivity", "forward"),
      },
      {
        note: "Chain a < c with c < d.",
        selections: [hypothesis(["Less", "a", "d"], ["Less", "a", "c"])],
        suggestion: result("less-transitivity", "forward"),
      },
      closeByHypothesis(["Less", "a", "d"]),
    ],
  },
  {
    id: "corpus:weak-shift",
    title: "Adding to both sides of ≤",
    statement: "For reals a, b, c with a ≤ b, show a + c ≤ b + c.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [["LessEqual", "a", "b"]],
    goal: ["LessEqual", ["Add", "a", "c"], ["Add", "b", "c"]],
    steps: [
      {
        note: "Reduce to a ≤ b by monotonicity of addition.",
        selections: [goal(["LessEqual", ["Add", "a", "c"], ["Add", "b", "c"]])],
        suggestion: result("less-equal-add-monotonicity", "backward"),
      },
      closeByHypothesis(["LessEqual", "a", "b"]),
    ],
  },
  {
    id: "corpus:cyclic-antisymmetry",
    title: "A cycle of inequalities",
    statement: "For reals a, b, c with a ≤ b, b ≤ c and c ≤ a, show a = b.",
    domain: "order",
    packs: ["pack:order"],
    operators: [],
    declarations: reals("a", "b", "c"),
    hypotheses: [
      ["LessEqual", "a", "b"],
      ["LessEqual", "b", "c"],
      ["LessEqual", "c", "a"],
    ],
    goal: ["Equal", "a", "b"],
    steps: [
      {
        note: "Reduce the equation to two inequalities by antisymmetry.",
        selections: [goal(["Equal", "a", "b"])],
        suggestion: result("less-equal-antisymmetry", "backward"),
      },
      closeByHypothesis(["LessEqual", "a", "b"]),
      {
        note: "Chain b ≤ c with c ≤ a.",
        selections: [hypothesis(["LessEqual", "b", "a"], ["LessEqual", "b", "c"])],
        suggestion: result("less-equal-transitivity", "forward"),
      },
      closeByHypothesis(["LessEqual", "b", "a"]),
    ],
  },
  {
    id: "corpus:closure-superset",
    title: "A set lies in the closure of a superset",
    statement: "For sets A, B with A ⊆ B, show A ⊆ cl(B).",
    domain: "research-notation",
    packs: ["pack:sets", "pack:closure"],
    operators: RESEARCH_OPERATORS,
    declarations: sets("A", "B"),
    hypotheses: [subset("A", "B")],
    goal: subset("A", closure("B")),
    steps: [
      {
        note: "Derive B ⊆ cl(B) from the selected closure term.",
        selections: [goal(subset("A", closure("B")), [1])],
        suggestion: result("closure-extensive", "forward"),
      },
      {
        note: "Chain A ⊆ B with B ⊆ cl(B).",
        selections: [hypothesis(subset("A", closure("B")), subset("A", "B"))],
        suggestion: result("subset-transitivity", "forward"),
      },
      closeByHypothesis(subset("A", closure("B"))),
    ],
  },
  {
    id: "corpus:closure-absorbs",
    title: "Closure absorbs a closed superset",
    statement: "For sets A, B with A ⊆ cl(B), show cl(A) ⊆ cl(B).",
    domain: "research-notation",
    packs: ["pack:closure"],
    operators: RESEARCH_OPERATORS,
    declarations: sets("A", "B"),
    hypotheses: [subset("A", closure("B"))],
    goal: subset(closure("A"), closure("B")),
    steps: [
      {
        note: "Apply monotonicity of closure to the hypothesis.",
        selections: [hypothesis(subset(closure("A"), closure("B")), subset("A", closure("B")))],
        suggestion: result("closure-monotone", "forward"),
      },
      {
        note: "Derive idempotence for the double closure in the new hypothesis.",
        selections: [
          hypothesis(
            subset(closure("A"), closure("B")),
            subset(closure("A"), closure(closure("B"))),
            [1],
          ),
        ],
        suggestion: result("closure-idempotent", "forward"),
      },
      {
        note: "Rewrite cl(B) in the goal right to left as cl(cl(B)).",
        selections: [
          hypothesis(subset(closure("A"), closure("B")), [
            "Equal",
            closure(closure("B")),
            closure("B"),
          ]),
          goal(subset(closure("A"), closure("B")), [1]),
        ],
        suggestion: { source: "move", artifactId: "move:rewrite-with-equality" },
        menu: { direction: { kind: "direction", direction: "backward" } },
      },
      closeByHypothesis(subset(closure("A"), closure(closure("B")))),
    ],
  },
  {
    id: "corpus:closure-double",
    title: "A set lies in its double closure",
    statement: "For a set A, show A ⊆ cl(cl(A)).",
    domain: "research-notation",
    packs: ["pack:closure"],
    operators: RESEARCH_OPERATORS,
    declarations: sets("A"),
    hypotheses: [],
    goal: subset("A", closure(closure("A"))),
    steps: [
      {
        note: "Derive idempotence for the double closure.",
        selections: [goal(subset("A", closure(closure("A"))), [1])],
        suggestion: result("closure-idempotent", "forward"),
      },
      rewriteGoal(
        subset("A", closure(closure("A"))),
        ["Equal", closure(closure("A")), closure("A")],
        [1],
      ),
      closeByFact("closure-extensive", subset("A", closure("A")), "An instance of extensivity."),
    ],
  },
  {
    id: "corpus:typed-universal-reflexive",
    title: "A typed universal statement",
    statement: "Show that every real number x equals itself.",
    domain: "logic",
    packs: [],
    operators: [],
    declarations: [],
    hypotheses: [],
    goal: ["ForAll", ["Element", "x", "RealNumbers"], ["Equal", "x", "x"]],
    steps: [
      {
        note: "Take an arbitrary real x, which adds x in R as a hypothesis.",
        selections: [goal(["ForAll", ["Element", "x", "RealNumbers"], ["Equal", "x", "x"]])],
        suggestion: { source: "move", artifactId: "move:introduce-universal" },
      },
      {
        note: "Close the reflexive equality.",
        selections: [goal(["Equal", "x", "x"])],
        suggestion: { source: "move", artifactId: "move:close-reflexive-equality" },
      },
    ],
  },
  {
    id: "corpus:typed-existential-witness",
    title: "A typed existential statement",
    statement: "For a real number a, show that some real number equals a.",
    domain: "logic",
    packs: [],
    operators: [],
    declarations: reals("a"),
    hypotheses: [["Element", "a", "RealNumbers"]],
    goal: ["Exists", ["Element", "y", "RealNumbers"], ["Equal", "y", "a"]],
    steps: [
      {
        note: "Choose a as the witness; the goal becomes a in R and a = a.",
        selections: [goal(["Exists", ["Element", "y", "RealNumbers"], ["Equal", "y", "a"]])],
        suggestion: { source: "move", artifactId: "move:choose-existential-witness" },
        menu: { witness: term("a") },
      },
      {
        note: "Split the conjunction.",
        selections: [goal(["And", ["Element", "a", "RealNumbers"], ["Equal", "a", "a"]])],
        suggestion: { source: "move", artifactId: "move:split-goal-conjunction" },
      },
      closeByHypothesis(["Element", "a", "RealNumbers"]),
      {
        note: "Close the reflexive equality.",
        selections: [goal(["Equal", "a", "a"])],
        suggestion: { source: "move", artifactId: "move:close-reflexive-equality" },
      },
    ],
  },
];

/** The full benchmark corpus: the N16 elementary corpus followed by the N37 extension. */
export const BENCHMARK_CORPUS: readonly CorpusProblem[] = [
  ...ELEMENTARY_CORPUS,
  ...EXTENDED_CORPUS,
];

/**
 * The root proof state of a problem as plain data: one goal `goal:main` whose context declares
 * the problem's symbols (`declaration:<symbol>`) and hypotheses (`hypothesis:<n>`, 1-based).
 */
export function corpusRootState(problem: CorpusProblem, stateId: string): unknown {
  return {
    id: stateId,
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations: problem.declarations.map(([symbol, sort]) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort,
              role: "universal-parameter",
            })),
            hypotheses: problem.hypotheses.map((expression, index) => ({
              id: `hypothesis:${index + 1}`,
              statement: { expression },
            })),
          },
          conclusion: { expression: problem.goal },
        },
      },
    ],
    obligations: [],
  };
}
