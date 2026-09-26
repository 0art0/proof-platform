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
  ELEMENT_SET_SORT,
  ELEMENT_SORT,
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

/** Select the whole conclusion of the goal whose conclusion is `conclusion`. */
function goal(conclusion: PlainMathJson, path: readonly number[] = []): CorpusSelection {
  return { target: { kind: "goal", conclusion }, statement: "conclusion", path };
}

/** Select the hypothesis `hypothesis` of the goal whose conclusion is `conclusion`. */
function hypothesis(conclusion: PlainMathJson, statement: PlainMathJson): CorpusSelection {
  return { target: { kind: "goal", conclusion }, statement: { hypothesis: statement }, path: [] };
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
