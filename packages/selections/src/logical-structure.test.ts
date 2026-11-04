import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  declarationSchema,
  proofStateSchema,
  sortSchema,
  type Declaration,
  type PlainMathJson,
  type ProofState,
} from "@proof/mathjson-model";
import {
  expressionAtPath,
  logicalNodeAtPath,
  logicalProofState,
  logicalProofStateSchema,
  logicalProofStateWithLibraryResultSchema,
  logicalStatement,
  logicalStatementSchema,
  positionAtPath,
  withLibraryResult,
  type AnchoredProofSelection,
  type LogicalStatement,
  type StatementAnchor,
} from "./index";

const proposition = { kind: "proposition" } as const;
const real = sortSchema.parse({ kind: "named", id: "sort:real" });
const universal = (symbol: string, sort: Declaration["sort"] = proposition) =>
  declarationSchema.parse({ id: `decl:${symbol}`, symbol, sort, role: "universal-parameter" });

const P = universal("P");
const Q = universal("Q");
const R = universal("R");
const propositions = { declarations: [P, Q, R] };

const atom = (path: readonly number[], polarity: string, expression: PlainMathJson) => ({
  kind: "atomic",
  path,
  position: { polarity, role: "proposition" },
  expression,
});

/** Rebuilds the MathJSON a node was read from, so a test can show nothing was lost. */
function unproject(node: LogicalStatement): PlainMathJson {
  switch (node.kind) {
    case "atomic":
      return node.expression;
    case "conjunction":
      return ["And", ...node.statements.map(unproject)];
    case "disjunction":
      return ["Or", ...node.statements.map(unproject)];
    case "negation":
      return ["Not", unproject(node.statement)];
    case "implication":
      return ["Implies", unproject(node.antecedent), unproject(node.consequent)];
    case "equivalence":
      return ["Equivalent", unproject(node.left), unproject(node.right)];
    case "universal":
    case "existential":
      return [
        node.kind === "universal" ? "ForAll" : "Exists",
        node.variable.domain === undefined
          ? node.variable.name
          : ["Element", node.variable.name, node.variable.domain],
        unproject(node.statement),
      ];
    case "highlight":
      return unproject(node.statement);
  }
}

function nodes(node: LogicalStatement): readonly LogicalStatement[] {
  switch (node.kind) {
    case "atomic":
      return [node];
    case "conjunction":
    case "disjunction":
      return [node, ...node.statements.flatMap(nodes)];
    case "implication":
      return [node, ...nodes(node.antecedent), ...nodes(node.consequent)];
    case "equivalence":
      return [node, ...nodes(node.left), ...nodes(node.right)];
    default:
      return [node, ...nodes(node.statement)];
  }
}

const statements: fc.Arbitrary<PlainMathJson> = fc.letrec<{ statement: PlainMathJson }>((tie) => ({
  statement: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom<PlainMathJson>("P", "Q", "R", ["Greater", "x", 0], ["Equal", "x", "x"]),
    fc.tuple(tie("statement")).map(([body]): PlainMathJson => ["Not", body]),
    fc
      .tuple(tie("statement"), tie("statement"))
      .map(([left, right]): PlainMathJson => ["Implies", left, right]),
    fc
      .tuple(tie("statement"), tie("statement"))
      .map(([left, right]): PlainMathJson => ["Equivalent", left, right]),
    fc
      .tuple(
        fc.constantFrom("And", "Or"),
        fc.array(tie("statement"), { minLength: 2, maxLength: 3 }),
      )
      .map(([operator, operands]): PlainMathJson => [operator, ...operands]),
    fc
      .tuple(fc.constantFrom("ForAll", "Exists"), tie("statement"))
      .map(([quantifier, body]): PlainMathJson => [quantifier, ["Element", "y", "S"], body]),
  ),
})).statement;

const environment = { declarations: [P, Q, R, universal("x", real), universal("S", real)] };

describe("logicalStatement", () => {
  it("reads each connective with its path and §7.1 polarity", () => {
    expect(
      logicalStatement(["Implies", ["Implies", "P", "Q"], "R"], "positive", propositions),
    ).toEqual({
      kind: "implication",
      path: [],
      position: { polarity: "positive", role: "proposition" },
      antecedent: {
        kind: "implication",
        path: [0],
        position: { polarity: "negative", role: "proposition" },
        antecedent: atom([0, 0], "positive", "P"),
        consequent: atom([0, 1], "negative", "Q"),
      },
      consequent: atom([1], "positive", "R"),
    });
  });

  it("starts hypotheses negative and flips under negation", () => {
    expect(logicalStatement(["Not", "P"], "negative", propositions)).toMatchObject({
      kind: "negation",
      position: { polarity: "negative" },
      statement: atom([0], "positive", "P"),
    });
  });

  it("keeps a relation whole as an atom holding its exact MathJSON", () => {
    const relation = { fn: ["Greater", "x", 0], latex: "x>0" } as PlainMathJson;
    const read = logicalStatement(["And", relation, "P"], "positive", environment);
    expect(read).toMatchObject({ kind: "conjunction" });
    expect(read.kind === "conjunction" && read.statements[0]).toMatchObject({ kind: "atomic" });
    const first = read.kind === "conjunction" ? read.statements[0] : undefined;
    expect(first?.kind === "atomic" && first.expression).toBe(relation);
  });

  it("records a typed binder's domain and marks both sides of an equivalence mixed", () => {
    expect(
      logicalStatement(
        ["ForAll", ["Element", "y", "S"], ["Equivalent", "P", "Q"]],
        "positive",
        environment,
      ),
    ).toMatchObject({
      kind: "universal",
      variable: { name: "y", domain: "S" },
      statement: {
        kind: "equivalence",
        position: { polarity: "positive" },
        left: { position: { polarity: "mixed" } },
        right: { position: { polarity: "mixed" } },
      },
    });
    expect(logicalStatement(["Exists", "y", "P"], "positive", environment)).toMatchObject({
      kind: "existential",
      variable: { name: "y" },
    });
  });

  it("reads a malformed connective as atomic", () => {
    const malformed: PlainMathJson = ["Implies", "P", "Q", "R"];
    expect(logicalStatement(malformed, "positive", propositions)).toMatchObject({
      kind: "atomic",
      expression: malformed,
    });
  });

  it("wraps the logical node that contains a highlighted path", () => {
    const read = logicalStatement(["Implies", ["Greater", "x", 0], "P"], "positive", environment, [
      [0, 0],
    ]);
    expect(read).toMatchObject({
      kind: "implication",
      antecedent: {
        kind: "highlight",
        path: [0],
        position: { polarity: "negative" },
        statement: { kind: "atomic", path: [0] },
      },
    });
  });

  it("satisfies the schema, loses nothing, and agrees with positionAtPath everywhere", () => {
    fc.assert(
      fc.property(statements, fc.constantFrom("positive", "negative"), (expression, base) => {
        const polarity = base as "positive" | "negative";
        const read = logicalStatement(expression, polarity, environment);
        expect(logicalStatementSchema.parse(read)).toEqual(read);
        expect(unproject(read)).toEqual(expression);
        for (const node of nodes(read)) {
          expect(expressionAtPath(expression, node.path)).toBeDefined();
          expect(node.position).toEqual(
            positionAtPath(
              expression,
              node.path,
              { polarity, role: "proposition" },
              environment.declarations,
              [],
            ),
          );
        }
      }),
    );
  });

  it("keeps opposite polarities for a statement read as goal and as hypothesis", () => {
    const flipped = { positive: "negative", negative: "positive", mixed: "mixed" } as const;
    fc.assert(
      fc.property(statements, (expression) => {
        const goal = nodes(logicalStatement(expression, "positive", environment));
        const hypothesis = nodes(logicalStatement(expression, "negative", environment));
        goal.forEach((node, index) => {
          const polarity = node.position.polarity as keyof typeof flipped;
          expect(hypothesis[index]?.position.polarity).toBe(flipped[polarity]);
        });
      }),
    );
  });
});

describe("logicalNodeAtPath", () => {
  const read = logicalStatement(
    ["Implies", ["And", ["Greater", "x", 0], "P"], ["ForAll", "y", "Q"]],
    "positive",
    environment,
  );

  it("finds the proposition governing a term occurrence", () => {
    expect(logicalNodeAtPath(read, [0, 0, 1])).toMatchObject({
      kind: "atomic",
      path: [0, 0],
      position: { polarity: "negative" },
    });
  });

  it("finds the quantifier for its bound variable and the root for the empty path", () => {
    expect(logicalNodeAtPath(read, [1, 0])).toMatchObject({ kind: "universal", path: [1] });
    expect(logicalNodeAtPath(read, [])).toBe(read);
  });

  it("looks through a highlight", () => {
    const highlighted = logicalStatement(["Not", "P"], "positive", propositions, [[0]]);
    expect(logicalNodeAtPath(highlighted, [0])).toMatchObject({ kind: "atomic", path: [0] });
  });
});

describe("logicalProofState", () => {
  const context = {
    declarations: [
      universal("x", real),
      declarationSchema.parse({
        id: "decl:w",
        symbol: "w",
        sort: real,
        role: "local-witness",
      }),
      declarationSchema.parse({
        id: "decl:m",
        symbol: "m",
        sort: real,
        role: "construction-metavariable",
        resolution: { status: "unresolved" },
      }),
      declarationSchema.parse({
        id: "decl:d",
        symbol: "d",
        sort: real,
        role: "construction-metavariable",
        resolution: { status: "resolved", value: 2 },
      }),
    ],
    hypotheses: [{ id: "hyp:x", statement: { expression: ["Greater", "x", 0] } }],
  };
  const sequent = (conclusion: PlainMathJson, hypotheses = context.hypotheses) => ({
    context: { ...context, hypotheses },
    conclusion: { expression: conclusion },
  });
  const state = {
    id: "state:1",
    goals: [
      { id: "goal:a", sequent: sequent(["Greater", "x", 1]) },
      { id: "goal:b", sequent: sequent(["Greater", "x", 2]) },
      { id: "goal:c", sequent: sequent(["Greater", "x", 3], []) },
    ],
    obligations: [
      {
        id: "obligation:a",
        sequent: sequent(["Greater", "x", 4]),
        provenance: { kind: "user" },
      },
    ],
  } as unknown as ProofState;

  it("groups targets by context and keeps obligations apart from goals", () => {
    const logical = logicalProofState(state);
    expect(logicalProofStateSchema.parse(logical)).toEqual(logical);
    expect(logical.contexts).toHaveLength(2);
    expect(logical.contexts[0]).toMatchObject({
      hypotheses: [{ id: "hyp:x", label: "H1", statement: { position: { polarity: "negative" } } }],
      goals: [
        { id: "goal:a", label: "G1", statement: { position: { polarity: "positive" } } },
        { id: "goal:b", label: "G2" },
      ],
      obligations: [{ id: "obligation:a", label: "O1" }],
    });
    expect(logical.contexts[1]).toMatchObject({
      hypotheses: [],
      goals: [{ id: "goal:c", label: "G1" }],
      obligations: [],
    });
  });

  it("classifies variables as free, meta, or let", () => {
    expect(logicalProofState(state).contexts[0]?.variables).toEqual([
      { id: "decl:x", name: "x", sort: real, kind: "free" },
      { id: "decl:w", name: "w", sort: real, kind: "free" },
      { id: "decl:m", name: "m", sort: real, kind: "meta" },
      { id: "decl:d", name: "d", sort: real, kind: "let", value: 2 },
    ]);
  });

  it("reports state-global assumptions apart from hypotheses", () => {
    const assumed = {
      ...state,
      assumptions: [
        {
          id: "assumption:1",
          declarations: [],
          statement: { expression: "True" },
          origin: { kind: "sorry" },
        },
      ],
    } as unknown as ProofState;
    expect(logicalProofState(assumed).assumptions).toEqual([
      {
        id: "assumption:1",
        label: "A1",
        statement: atom([], "negative", "True"),
      },
    ]);
  });

  it("highlights selections in their own statement and ignores other snapshots", () => {
    const anchor = (
      stateId: string,
      targetId: string,
      statement: StatementAnchor["statement"],
    ): StatementAnchor =>
      ({ stateId, target: { kind: "goal", id: targetId }, statement }) as StatementAnchor;
    const selection = (selectionAnchor: StatementAnchor): AnchoredProofSelection => ({
      kind: "exact",
      anchor: selectionAnchor,
      path: [],
    });
    const hypothesis = { kind: "hypothesis", id: "hyp:x" } as StatementAnchor["statement"];
    const logical = logicalProofState(state, {
      highlights: [
        selection(anchor("state:1", "goal:b", { kind: "conclusion" })),
        selection(anchor("state:1", "goal:a", hypothesis)),
        selection(anchor("state:old", "goal:a", { kind: "conclusion" })),
      ],
    });
    const [first] = logical.contexts;
    expect(first?.goals.map((goal) => goal.statement.kind)).toEqual(["atomic", "highlight"]);
    expect(first?.hypotheses[0]?.statement.kind).toBe("highlight");
    expect(logical.contexts[1]?.goals[0]?.statement.kind).toBe("atomic");
  });

  it("marks every operand of an associative selection", () => {
    const conjunction: PlainMathJson = ["And", "P", "Q", "R"];
    const conjunctive = {
      id: "state:2",
      goals: [
        {
          id: "goal:and",
          sequent: {
            context: { declarations: [P, Q, R], hypotheses: [] },
            conclusion: { expression: conjunction },
          },
        },
      ],
      obligations: [],
    } as unknown as ProofState;
    const logical = logicalProofState(proofStateSchema.parse(conjunctive), {
      highlights: [
        {
          kind: "associative",
          anchor: {
            stateId: "state:2",
            target: { kind: "goal", id: "goal:and" },
            statement: { kind: "conclusion" },
          } as StatementAnchor,
          containerPath: [],
          startOperand: 0,
          endOperand: 2,
        },
      ],
    });
    const statement = logical.contexts[0]?.goals[0]?.statement;
    expect(statement?.kind === "conjunction" && statement.statements.map((s) => s.kind)).toEqual([
      "highlight",
      "highlight",
      "atomic",
    ]);
  });
});

describe("withLibraryResult", () => {
  const proofState = { stateId: "state:1", contexts: [], assumptions: [] };

  it("reads a library statement like a hypothesis", () => {
    const bundled = withLibraryResult(
      proofState,
      { id: "result:mono", label: "Monotonicity", expression: ["Implies", "P", "Q"] },
      propositions,
    );
    expect(logicalProofStateWithLibraryResultSchema.parse(bundled)).toEqual(bundled);
    expect(bundled.libraryResult).toMatchObject({
      label: "Monotonicity",
      statement: {
        position: { polarity: "negative" },
        antecedent: { position: { polarity: "positive" } },
      },
    });
  });

  it("leaves the library result absent when there is none", () => {
    expect(withLibraryResult(proofState)).toEqual({ proofState });
  });
});

describe("logical statement schema", () => {
  it("rejects a bare string atom and unknown fields", () => {
    expect(logicalStatementSchema.safeParse("x > 0").success).toBe(false);
    expect(
      logicalStatementSchema.safeParse({ ...atom([], "positive", "P"), typst: "$P$" }).success,
    ).toBe(false);
  });

  it("rejects a non-MathJSON atom and a negative operand index", () => {
    expect(logicalStatementSchema.safeParse(atom([], "positive", undefined as never)).success).toBe(
      false,
    );
    expect(logicalStatementSchema.safeParse(atom([-1], "positive", "P")).success).toBe(false);
  });
});
