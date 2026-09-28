import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  executableProofStateSchema,
  mathJsonEquals,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import {
  alphaEquivalent,
  applyTransition,
  kernelOperationSchema,
  substitutePlaceholder,
} from "./index";

const realSort = { kind: "named", id: "sort:real" } as const;

const declaration = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: realSort,
  role: "universal-parameter" as const,
});

/** Goal: under eps > 0, there is delta with delta > 0 and delta < eps. */
const EXISTENTIAL: PlainMathJson = [
  "Exists",
  "delta",
  ["And", ["Greater", "delta", 0], ["Less", "delta", "eps"]],
];

function initial(
  conclusion: PlainMathJson = EXISTENTIAL,
  symbols: readonly string[] = ["eps", "delta"],
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:0",
    goals: [
      {
        id: "goal:0",
        sequent: {
          context: {
            declarations: symbols.map(declaration),
            hypotheses: [
              { id: "hypothesis:eps", statement: { expression: ["Greater", "eps", 0] } },
            ],
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  });
}

let counter = 0;
function step(
  input: ExecutableProofState,
  operation: Readonly<Record<string, unknown>>,
  /** Defaults to the first goal: construction operations are invoked from some target. */
  target: Readonly<{ kind: "goal" | "obligation"; id: string }> = {
    kind: "goal",
    id: input.goals[0]?.id ?? "goal:0",
  },
) {
  counter += 1;
  return applyTransition(input, {
    expectedStateId: input.id,
    resultStateId: `state:${counter}`,
    target,
    ...operation,
  });
}

function ok(result: ReturnType<typeof applyTransition>): ExecutableProofState {
  if (!result.ok) throw new Error(`Expected success: ${JSON.stringify(result.diagnostics)}`);
  return result.state;
}

const introduce = (extra: Readonly<Record<string, unknown>> = {}) => ({
  kind: "introduce-placeholder",
  taskId: "task:delta",
  symbol: "m",
  displayName: "δ",
  origin: { kind: "existential-goal" },
  dependencies: ["eps"],
  allowedTasks: [],
  ...extra,
});

const auxiliary = (
  taskId: string,
  symbol: string,
  extra: Readonly<Record<string, unknown>> = {},
) => ({
  kind: "introduce-placeholder",
  taskId,
  symbol,
  displayName: symbol,
  origin: auxiliaryOrigin,
  dependencies: ["eps"],
  allowedTasks: [],
  ...extra,
});

const auxiliaryOrigin = {
  kind: "auxiliary-request",
  sort: realSort,
  description: "an auxiliary bound",
} as const;

const requirement = (
  requirementId: string,
  role: "necessary" | "sufficient" | "heuristic",
  proposition: PlainMathJson,
  evidence: unknown,
  taskId = "task:delta",
) => ({
  kind: "add-requirement",
  taskId,
  requirementId,
  role,
  proposition,
  evidence,
  attemptId: "attempt:1",
});

const attested = { kind: "attestation", attestationId: "attestation:1" } as const;
const none = { kind: "none" } as const;

const candidate = (candidateId: string, value: PlainMathJson, taskId = "task:delta") => ({
  kind: "add-candidate",
  taskId,
  candidateId,
  value,
  attemptId: "attempt:2",
});

const resolve = (
  candidateId: string,
  obligationIds: readonly string[] = [],
  taskId = "task:delta",
) => ({
  kind: "resolve-placeholder",
  taskId,
  candidateId,
  obligationIds,
  attemptId: "attempt:3",
});

const m: PlainMathJson = ["m", "eps"];

function introduced(): ExecutableProofState {
  return ok(step(initial(), introduce()));
}

function allHypotheses(state: ExecutableProofState): readonly PlainMathJson[] {
  return [...state.goals, ...state.obligations].flatMap((entry) =>
    entry.sequent.context.hypotheses.map((hypothesis) => hypothesis.statement.expression),
  );
}

describe("introduce-placeholder", () => {
  it("replaces an existential witness by the placeholder applied to its dependencies", () => {
    const result = step(initial(), introduce());
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      evidence: "structural",
      state: {
        goals: [
          {
            sequent: {
              conclusion: { expression: ["And", ["Greater", m, 0], ["Less", m, "eps"]] },
            },
          },
        ],
        constructions: [
          {
            id: "task:delta",
            symbol: "m",
            sort: realSort,
            status: "unresolved",
            origin: {
              kind: "existential-goal",
              target: { kind: "goal", id: "goal:0" },
              statement: { expression: EXISTENTIAL },
            },
            allowedDependencies: { declarations: ["eps"], tasks: [] },
            requirements: [],
            candidates: [],
          },
        ],
      },
    });
    expect(executableProofStateSchema.safeParse(ok(result)).success).toBe(true);
  });

  it("is a strengthening when the choice may not depend on a variable of the sequent", () => {
    expect(step(initial(), introduce({ dependencies: [] }))).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      state: {
        goals: [
          {
            sequent: {
              conclusion: {
                expression: ["And", ["Greater", ["m"], 0], ["Less", ["m"], "eps"]],
              },
            },
          },
        ],
      },
    });
  });

  it("rejects non-existential targets, stale names, and illegal dependencies", () => {
    const cases: readonly [ExecutableProofState, Readonly<Record<string, unknown>>, string][] = [
      [initial(["Greater", "eps", 0]), introduce(), "rule-not-applicable"],
      [initial(), introduce({ symbol: "eps" }), "identifier-collision"],
      [initial(), introduce({ symbol: "Add" }), "identifier-collision"],
      [initial(), introduce({ dependencies: ["zeta"] }), "illegal-dependency"],
      [initial(), introduce({ dependencies: ["eps", "eps"] }), "illegal-dependency"],
      [initial(), introduce({ dependencies: ["delta"] }), "illegal-dependency"],
      [initial(), introduce({ allowedTasks: ["task:missing"] }), "task-not-found"],
    ];
    for (const [input, operation, code] of cases) {
      const result = step(input, operation);
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code }] });
      expect(result.state).toBe(input);
    }
    const once = introduced();
    expect(step(once, auxiliary("task:delta", "n"))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "identifier-collision" }],
    });
  });

  it("lets ordinary kernel rules work on goals with an open placeholder", () => {
    const split = step(introduced(), {
      kind: "split-goal-conjunction",
      childIds: ["goal:positive", "goal:small"],
    });
    expect(split).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: [
          { id: "goal:positive", sequent: { conclusion: { expression: ["Greater", m, 0] } } },
          { id: "goal:small", sequent: { conclusion: { expression: ["Less", m, "eps"] } } },
        ],
      },
    });
    expect(
      step(
        ok(split),
        {
          kind: "assume-hypothesis",
          proposition: ["Less", m, 1],
          hypothesisId: "hypothesis:guess",
        },
        { kind: "goal", id: "goal:small" },
      ),
    ).toMatchObject({ ok: true, transitionClass: "weakening" });
  });

  it("refuses to mark a sorry that mentions an open placeholder", () => {
    expect(step(introduced(), { kind: "mark-sorry", assumptionId: "assumption:1" })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "construction-metavariable-dependency" }],
    });
  });
});

describe("requirements", () => {
  it("records requirements with their role, evidence, and attempt", () => {
    const split = ok(
      step(introduced(), {
        kind: "split-goal-conjunction",
        childIds: ["goal:positive", "goal:small"],
      }),
    );
    const withTarget = ok(
      step(
        split,
        requirement("requirement:positive", "sufficient", ["Greater", m, 0], {
          kind: "target",
          target: { kind: "goal", id: "goal:positive" },
        }),
        { kind: "goal", id: "goal:small" },
      ),
    );
    const result = step(
      withTarget,
      requirement("requirement:heuristic", "heuristic", ["Less", m, 1], none),
      { kind: "goal", id: "goal:small" },
    );
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: split.goals,
        constructions: [
          {
            status: "partially-specified",
            requirements: [
              {
                id: "requirement:positive",
                role: "sufficient",
                evidence: { kind: "target", target: { kind: "goal", id: "goal:positive" } },
                attemptId: "attempt:1",
              },
              { id: "requirement:heuristic", role: "heuristic", evidence: none },
            ],
          },
        ],
      },
    });
  });

  it("enforces the role and evidence rule and the task's scope", () => {
    const input = introduced();
    const cases: readonly [Readonly<Record<string, unknown>>, string][] = [
      [requirement("r", "heuristic", ["Less", m, 1], attested), "invalid-requirement"],
      [requirement("r", "necessary", ["Less", m, 1], none), "invalid-requirement"],
      [requirement("r", "sufficient", ["Less", m, 1], none), "invalid-requirement"],
      [
        requirement("r", "necessary", ["Less", m, 1], {
          kind: "target",
          target: { kind: "goal", id: "goal:0" },
        }),
        "invalid-requirement",
      ],
      [
        requirement("r", "sufficient", ["Less", m, 1], {
          kind: "target",
          target: { kind: "goal", id: "goal:0" },
        }),
        "invalid-requirement",
      ],
      [requirement("r", "necessary", ["Less", "eps", 1], attested), "invalid-requirement"],
      [requirement("r", "necessary", ["Less", m, "zeta"], attested), "invalid-proposition"],
      [requirement("r", "necessary", ["Add", m, 1], attested), "invalid-proposition"],
      [requirement("r", "necessary", ["Less", m, 1], attested, "task:missing"), "task-not-found"],
    ];
    for (const [operation, code] of cases) {
      const result = step(input, operation);
      expect(result, JSON.stringify(operation)).toMatchObject({
        ok: false,
        diagnostics: [{ code }],
      });
      expect(result.state).toBe(input);
    }
    const once = ok(step(input, requirement("r", "necessary", ["Less", m, 1], attested)));
    expect(step(once, requirement("r", "heuristic", ["Less", m, 2], none))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "identifier-collision" }],
    });
  });

  it("never lets a necessary or heuristic requirement close the task or a target", () => {
    const specified = ok(
      step(
        ok(step(introduced(), requirement("n", "necessary", ["Less", m, "eps"], attested))),
        requirement("h", "heuristic", ["Greater", m, 0], none),
      ),
    );
    expect(specified.goals).toEqual(introduced().goals);
    expect(specified.constructions?.[0]?.status).toBe("partially-specified");
    const resolved = ok(
      step(ok(step(specified, candidate("c", ["Divide", "eps", 2]))), resolve("c")),
    );
    // No obligation for the necessary or heuristic requirement; the goal stays open.
    expect(resolved.obligations).toEqual([]);
    expect(resolved.goals).toHaveLength(1);
    expect(allHypotheses(resolved)).toEqual([["Greater", "eps", 0]]);
    // Supplying obligation IDs for them is rejected.
    expect(
      step(ok(step(specified, candidate("c", ["Divide", "eps", 2]))), resolve("c", ["o:1"])),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "arity-mismatch" }] });
  });
});

describe("candidates and dependencies", () => {
  it("rejects values outside the scope, on disallowed declarations, or of the wrong sort", () => {
    const input = introduced();
    const cases: readonly [Readonly<Record<string, unknown>>, string][] = [
      [candidate("c", ["Divide", "zeta", 2]), "illegal-dependency"],
      [candidate("c", ["Divide", "delta", 2]), "illegal-dependency"],
      [candidate("c", ["Add", m, 1]), "cyclic-dependency"],
      [candidate("c", ["Greater", "eps", 0]), "signature-mismatch"],
      [candidate("c", 1, "task:missing"), "task-not-found"],
    ];
    for (const [operation, code] of cases) {
      const result = step(input, operation);
      expect(result, JSON.stringify(operation)).toMatchObject({
        ok: false,
        diagnostics: [{ code }],
      });
      expect(result.state).toBe(input);
    }
    const uniform = ok(step(initial(), introduce({ dependencies: [] })));
    expect(step(uniform, candidate("c", ["Divide", "eps", 2]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "illegal-dependency" }],
    });
    expect(step(uniform, candidate("c", ["Divide", 1, 2]))).toMatchObject({ ok: true });
  });

  it("keeps variables introduced after the placeholder out of the construction", () => {
    const input = initial(
      ["Exists", "delta", ["ForAll", "x", ["LessEqual", "delta", ["Abs", "x"]]]],
      ["eps", "delta", "x"],
    );
    const placed = ok(step(input, introduce()));
    const universal = ok(step(placed, { kind: "introduce-universal" }));
    expect(universal.goals[0]?.sequent.conclusion.expression).toEqual([
      "LessEqual",
      m,
      ["Abs", "x"],
    ]);
    expect(step(universal, candidate("c", ["Abs", "x"]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "illegal-dependency" }],
    });
  });

  it("rejects cyclic task dependencies", () => {
    const withA = introduced();
    // B is requested by A, so A may depend on B; B may not also depend on A.
    expect(
      step(
        withA,
        auxiliary("task:b", "n", {
          origin: { ...auxiliaryOrigin, requestedBy: "task:delta" },
          allowedTasks: ["task:delta"],
        }),
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "cyclic-dependency" }] });

    const withB = ok(
      step(
        withA,
        auxiliary("task:b", "n", { origin: { ...auxiliaryOrigin, requestedBy: "task:delta" } }),
      ),
    );
    expect(withB.constructions?.[0]?.allowedDependencies.tasks).toEqual(["task:b"]);
    // A value of B that uses A reaches back to B.
    expect(step(withB, candidate("c", ["m", "eps"], "task:b"))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "cyclic-dependency" }],
    });
    // A may use B, applied to its own parameters.
    expect(step(withB, candidate("c", ["Divide", ["n", "eps"], 2]))).toMatchObject({ ok: true });
    // A task that was not allowed B may not use it.
    const withC = ok(step(withB, auxiliary("task:c", "k")));
    expect(step(withC, candidate("c", ["n", "eps"], "task:c"))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "illegal-dependency" }],
    });
  });

  it("follows allowed dependencies transitively and substitutes resolved dependencies", () => {
    const withB = ok(
      step(
        introduced(),
        auxiliary("task:b", "n", { origin: { ...auxiliaryOrigin, requestedBy: "task:delta" } }),
      ),
    );
    const withC = ok(
      step(
        withB,
        auxiliary("task:c", "k", { origin: { ...auxiliaryOrigin, requestedBy: "task:b" } }),
      ),
    );
    // A reaches C through B.
    const aCandidate = ok(step(withC, candidate("a", ["Divide", ["k", "eps"], 2])));
    // B's own placeholder in its value is a cycle; C is allowed to B directly.
    expect(step(aCandidate, candidate("b", ["n", "eps"], "task:b"))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "cyclic-dependency" }],
    });
    expect(step(aCandidate, candidate("b", ["k", "eps"], "task:b"))).toMatchObject({ ok: true });
    const cResolved = ok(
      step(
        ok(step(aCandidate, candidate("c", ["Divide", "eps", 3], "task:c"))),
        resolve("c", [], "task:c"),
      ),
    );
    // A's recorded candidate is substituted; the resolved placeholder no longer occurs.
    expect(cResolved.constructions?.[0]?.candidates[0]?.value).toEqual([
      "Divide",
      ["Divide", "eps", 3],
      2,
    ]);
    expect(step(cResolved, candidate("again", ["k", "eps"]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "illegal-dependency" }],
    });
  });
});

describe("resolve-placeholder", () => {
  it("substitutes through dependent statements and turns remaining sufficient requirements into obligations", () => {
    const split = ok(
      step(introduced(), {
        kind: "split-goal-conjunction",
        childIds: ["goal:positive", "goal:small"],
      }),
    );
    let working = ok(
      step(
        split,
        requirement("tracked", "sufficient", ["Greater", m, 0], {
          kind: "target",
          target: { kind: "goal", id: "goal:positive" },
        }),
      ),
    );
    working = ok(
      step(
        working,
        requirement("half", "sufficient", ["LessEqual", m, ["Divide", "eps", 2]], attested),
      ),
    );
    working = ok(step(working, requirement("guess", "heuristic", ["Less", m, 1], none)));
    working = ok(step(working, candidate("half-eps", ["Divide", "eps", 2])));
    const result = step(working, resolve("half-eps", ["obligation:half"]));
    const eps2: PlainMathJson = ["Divide", "eps", 2];
    expect(result).toMatchObject({
      ok: true,
      transitionClass: "strengthening",
      evidence: "structural",
      state: {
        goals: [
          { id: "goal:positive", sequent: { conclusion: { expression: ["Greater", eps2, 0] } } },
          { id: "goal:small", sequent: { conclusion: { expression: ["Less", eps2, "eps"] } } },
        ],
        obligations: [
          {
            id: "obligation:half",
            provenance: {
              kind: "construction-requirement",
              taskId: "task:delta",
              requirementId: "half",
            },
            sequent: {
              context: { hypotheses: [{ statement: { expression: ["Greater", "eps", 0] } }] },
              conclusion: { expression: ["LessEqual", eps2, eps2] },
            },
          },
        ],
        constructions: [
          {
            status: "resolved",
            resolution: {
              candidateId: "half-eps",
              attemptId: "attempt:3",
              obligationIds: ["obligation:half"],
            },
          },
        ],
      },
    });
    const resolved = ok(result);
    // The resolved placeholder is no longer registered for statements.
    expect(
      step(resolved, {
        kind: "assume-hypothesis",
        proposition: ["Less", m, 1],
        hypothesisId: "hypothesis:late",
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-proposition" }] });
    expect(step(resolved, resolve("half-eps", ["obligation:again"]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "task-not-open" }],
    });
  });

  it("rejects missing candidates, stale obligation IDs, and a heuristic-only closing", () => {
    const working = ok(step(introduced(), candidate("c", ["Divide", "eps", 2])));
    expect(step(working, resolve("missing"))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "candidate-not-found" }],
    });
    const sufficient = ok(
      step(working, requirement("s", "sufficient", ["Less", m, "eps"], attested)),
    );
    expect(step(sufficient, resolve("c", ["goal:0"]))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "identifier-collision" }],
    });
    expect(step(sufficient, resolve("c", []))).toMatchObject({
      ok: false,
      diagnostics: [{ code: "arity-mismatch" }],
    });
  });

  it("instantiates the construction at each occurrence's arguments", () => {
    expect(
      substitutePlaceholder(
        [
          "And",
          ["Less", ["m", "a"], ["m", ["Add", "b", 1]]],
          ["ForAll", "x", ["Less", ["m", "x"], 0]],
        ],
        "m",
        ["eps"],
        ["Multiply", "eps", "eps"],
        [],
      ),
    ).toEqual([
      "And",
      ["Less", ["Multiply", "a", "a"], ["Multiply", ["Add", "b", 1], ["Add", "b", 1]]],
      ["ForAll", "x", ["Less", ["Multiply", "x", "x"], 0]],
    ]);
    expect(substitutePlaceholder(["m", 1, 2], "m", ["eps"], "eps", [])).toBeUndefined();
  });
});

describe("abandon-placeholder", () => {
  it("abandons only a placeholder that no longer occurs", () => {
    const input = introduced();
    expect(
      step(input, { kind: "abandon-placeholder", taskId: "task:delta", attemptId: "a" }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "placeholder-in-use" }] });
    const withB = ok(step(input, auxiliary("task:b", "n")));
    const abandoned = step(withB, {
      kind: "abandon-placeholder",
      taskId: "task:b",
      attemptId: "a",
    });
    expect(abandoned).toMatchObject({
      ok: true,
      transitionClass: "equivalence",
      state: {
        goals: input.goals,
        constructions: [
          { status: "unresolved" },
          { status: "abandoned", abandonment: { attemptId: "a" } },
        ],
      },
    });
    expect(
      step(ok(abandoned), requirement("r", "heuristic", ["Less", ["n", "eps"], 1], none, "task:b")),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "task-not-open" }] });
  });

  it("refuses when another open task's records mention the placeholder", () => {
    const withB = ok(
      step(
        introduced(),
        auxiliary("task:b", "n", { origin: { ...auxiliaryOrigin, requestedBy: "task:delta" } }),
      ),
    );
    const used = ok(step(withB, candidate("c", ["n", "eps"])));
    expect(
      step(used, { kind: "abandon-placeholder", taskId: "task:b", attemptId: "a" }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "placeholder-in-use" }] });
  });
});

describe("construction operation parsing and state validation", () => {
  const baseOperation = {
    expectedStateId: "state:0",
    resultStateId: "state:1",
    target: { kind: "goal", id: "goal:0" },
  };

  it("parses construction operations strictly", () => {
    expect(kernelOperationSchema.safeParse({ ...baseOperation, ...introduce() }).success).toBe(
      true,
    );
    const invalid: readonly Readonly<Record<string, unknown>>[] = [
      { ...introduce(), extra: true },
      introduce({ origin: { kind: "existential-goal", sort: realSort } }),
      introduce({ origin: { kind: "auxiliary-request", sort: realSort, description: "" } }),
      introduce({ dependencies: "eps" }),
      requirement("r", "important" as "heuristic", ["Less", m, 1], none),
      requirement("r", "heuristic", ["Less", m, 1], { kind: "none", note: "x" }),
      { ...candidate("c", 1), attemptId: "" },
      resolve("c", ["not an id"]),
      { kind: "abandon-placeholder", taskId: "task:delta" },
    ];
    for (const operation of invalid) {
      expect(
        kernelOperationSchema.safeParse({ ...baseOperation, ...operation }).success,
        JSON.stringify(operation),
      ).toBe(false);
    }
    let invoked = false;
    const evidence = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        invoked = true;
        return "none";
      },
    });
    expect(
      kernelOperationSchema.safeParse({
        ...baseOperation,
        ...requirement("r", "heuristic", ["Less", m, 1], evidence),
      }).success,
    ).toBe(false);
    expect(invoked).toBe(false);
  });

  it("rejects cyclic dependency graphs, dangling placeholders, and forbidden candidates", () => {
    const withB = ok(
      step(
        introduced(),
        auxiliary("task:b", "n", { origin: { ...auxiliaryOrigin, requestedBy: "task:delta" } }),
      ),
    );
    const tasks = withB.constructions ?? [];
    const cyclic = {
      ...withB,
      constructions: tasks.map((task) =>
        task.id === "task:b"
          ? { ...task, allowedDependencies: { ...task.allowedDependencies, tasks: ["task:delta"] } }
          : task,
      ),
    };
    expect(executableProofStateSchema.safeParse(cyclic).success).toBe(false);

    const dangling = {
      ...withB,
      constructions: tasks.map((task) =>
        task.id === "task:b"
          ? { ...task, status: "abandoned", abandonment: { attemptId: "a" } }
          : task,
      ),
      goals: [
        ...withB.goals,
        {
          ...withB.goals[0],
          id: "goal:dangling",
          sequent: {
            ...withB.goals[0]!.sequent,
            conclusion: { expression: ["Less", ["n", "eps"], 1] },
          },
        },
      ],
    };
    expect(executableProofStateSchema.safeParse(dangling).success).toBe(false);

    const forbidden = {
      ...withB,
      constructions: tasks.map((task) =>
        task.id === "task:b"
          ? { ...task, candidates: [{ id: "c", value: m, attemptId: "a" }] }
          : task,
      ),
    };
    expect(executableProofStateSchema.safeParse(forbidden).success).toBe(false);

    const mislabeled = {
      ...withB,
      constructions: tasks.map((task) =>
        task.id === "task:b"
          ? {
              ...task,
              status: "partially-specified",
              requirements: [
                {
                  id: "r",
                  role: "heuristic",
                  statement: { expression: ["Less", ["n", "eps"], 1] },
                  evidence: attested,
                  attemptId: "a",
                },
              ],
            }
          : task,
      ),
    };
    expect(executableProofStateSchema.safeParse(mislabeled).success).toBe(false);
  });
});

describe("construction invariants", () => {
  const roleArbitrary = fc.constantFrom("necessary", "sufficient", "heuristic");

  it("never turns a requirement into a hypothesis and only remaining sufficient ones into obligations", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(roleArbitrary, fc.integer({ min: 2, max: 50 })), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.integer({ min: 2, max: 9 }),
        (entries, divisor) => {
          let working = introduced();
          const statements: PlainMathJson[] = [];
          entries.forEach(([role, bound], index) => {
            const statement: PlainMathJson = ["Less", m, ["Add", "eps", bound]];
            statements.push(statement);
            working = ok(
              step(
                working,
                requirement(`r:${index}`, role, statement, role === "heuristic" ? none : attested),
              ),
            );
            // Recording a requirement never changes goals, obligations, or hypotheses.
            expect(working.goals).toEqual(introduced().goals);
            expect(working.obligations).toEqual([]);
          });
          working = ok(step(working, candidate("c", ["Divide", "eps", divisor])));
          const sufficient = entries.flatMap(([role], index) =>
            role === "sufficient" ? [index] : [],
          );
          const resolved = ok(
            step(
              working,
              resolve(
                "c",
                sufficient.map((index) => `obligation:${index}`),
              ),
            ),
          );
          const value: PlainMathJson = ["Divide", "eps", divisor];
          const substituted = statements.map((statement) =>
            substitutePlaceholder(statement, "m", ["eps"], value, []),
          );
          for (const hypothesis of allHypotheses(resolved)) {
            expect(substituted.some((statement) => alphaEquivalent(statement!, hypothesis))).toBe(
              false,
            );
          }
          expect(resolved.obligations.map((obligation) => obligation.provenance)).toEqual(
            sufficient.map((index) => ({
              kind: "construction-requirement",
              taskId: "task:delta",
              requirementId: `r:${index}`,
            })),
          );
          resolved.obligations.forEach((obligation, position) => {
            const index = sufficient[position] as number;
            expect(
              mathJsonEquals(obligation.sequent.conclusion.expression, substituted[index]!),
            ).toBe(true);
          });
          // The goal is substituted, never closed.
          expect(resolved.goals).toHaveLength(1);
          expect(JSON.stringify(resolved.goals)).not.toContain('"m"');
        },
      ),
      { numRuns: 60 },
    );
  });

  it("classifies introduction as equivalence exactly when every free variable is a dependency", () => {
    fc.assert(
      fc.property(fc.subarray(["eps", "zeta", "eta"]), (dependencies) => {
        const input = initial(
          ["Exists", "delta", ["Less", "delta", ["Add", "eps", "zeta"]]],
          ["eps", "zeta", "eta", "delta"],
        );
        const result = step(input, introduce({ dependencies }));
        const complete = dependencies.includes("eps") && dependencies.includes("zeta");
        expect(result).toMatchObject({
          ok: true,
          transitionClass: complete ? "equivalence" : "strengthening",
        });
      }),
      { numRuns: 30 },
    );
  });
});
