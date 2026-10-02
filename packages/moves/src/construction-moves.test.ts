import { describe, expect, it } from "vitest";
import { applyTransition } from "@proof/kernel";
import {
  executableProofStateSchema,
  type ExecutableProofState,
  type PlainMathJson,
  type StatementId,
} from "@proof/mathjson-model";
import {
  CONSTRUCTION_MOVES,
  HAND_AUTHORED_MOVES,
  MOVE_OPERATION_KINDS,
  PRIMITIVE_TRANSITION_CLASSES,
  PRIMITIVE_TRANSITION_EVIDENCE,
  commandIdGenerator,
  generateParameterMenus,
  materializeMoveOperation,
  planMove,
  type MoveDefinition,
  type MoveMenuChoices,
  type MoveSelections,
  type ParameterMenu,
  type ParameterMenuItem,
} from "./index";

const real = { kind: "named", id: "sort:real" } as const;
const declaration = (symbol: string, index: number) => ({
  id: `declaration:${index}`,
  symbol,
  sort: real,
  role: "universal-parameter" as const,
});

/** Under eps > 0, there is delta with delta > 0 and delta < eps. */
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

const move = (kind: string): MoveDefinition =>
  CONSTRUCTION_MOVES.find((candidate) => candidate.implementation.operationKind === kind)!;

const selectGoal = (id = "goal:0"): MoveSelections => ({
  target: {
    kind: "exact",
    anchor: { target: { kind: "goal", id: id as StatementId }, statement: { kind: "conclusion" } },
    path: [],
  },
});

let counter = 0;
function commandId(): string {
  counter += 1;
  return `command:construct-${counter}`;
}

const itemWhere = (
  menus: readonly ParameterMenu[],
  parameterId: string,
  predicate: (item: ParameterMenuItem) => boolean,
): ParameterMenuItem => {
  const found = menus.find((menu) => menu.parameterId === parameterId)?.items.find(predicate);
  if (found === undefined) throw new Error(`No matching item in the ${parameterId} menu.`);
  return found;
};

/** Drive one move: choose the named items (by predicate) until it materializes, then apply it. */
function run(
  state: ExecutableProofState,
  kind: string,
  choose: Readonly<Record<string, (item: ParameterMenuItem) => boolean>> = {},
  selections: MoveSelections = selectGoal(),
  options: Readonly<{ attestationIds?: readonly string[] }> = {},
) {
  const id = commandId();
  const choices: Record<string, string> = {};
  const idGenerator = commandIdGenerator(id);
  for (let round = 0; round < 8; round += 1) {
    const result = materializeMoveOperation({
      state,
      move: move(kind),
      selections,
      menuChoices: choices as MoveMenuChoices,
      idGenerator,
      ...(options.attestationIds === undefined ? {} : { attestationIds: options.attestationIds }),
    });
    if (result.ok) {
      const applied = applyTransition(state, result.operation);
      if (!applied.ok) throw new Error(JSON.stringify(applied.diagnostics));
      return { operation: result.operation, applied, menus: result.menus, state: applied.state };
    }
    const pending = result.missingParameters[0];
    if (result.diagnostics[0].code !== "requires-input" || pending === undefined) {
      throw new Error(result.diagnostics[0].message);
    }
    const predicate = choose[pending];
    if (predicate === undefined) throw new Error(`No choice for ${pending}`);
    choices[pending] = itemWhere(result.menus, pending, predicate).id;
  }
  throw new Error("The move kept asking for input.");
}

const anything = () => true;
const expressionHead = (expression: PlainMathJson): unknown =>
  Array.isArray(expression) ? expression[0] : undefined;
const dependsOnEverything = (item: ParameterMenuItem) =>
  item.value.kind === "symbols" && item.value.symbols.length > 0;

function introduced() {
  return run(initial(), "introduce-placeholder", { dependencies: dependsOnEverything });
}

describe("construction moves", () => {
  it("has one hand-authored move per construction operation, apart from the retrieved moves", () => {
    expect(CONSTRUCTION_MOVES.map((entry) => entry.implementation.operationKind)).toEqual([
      "introduce-placeholder",
      "add-requirement",
      "add-candidate",
      "resolve-placeholder",
      "abandon-placeholder",
    ]);
    const ids = new Set(HAND_AUTHORED_MOVES.map(({ id }) => id));
    expect(CONSTRUCTION_MOVES.every(({ id }) => !ids.has(id))).toBe(true);
    for (const entry of CONSTRUCTION_MOVES) {
      expect(entry.parameters.every(({ source }) => source !== "term-input")).toBe(true);
      expect(entry.approval.status).toBe("approved");
    }
  });

  it("declares the class and evidence the kernel reports for each operation", () => {
    expect(MOVE_OPERATION_KINDS).toHaveLength(
      HAND_AUTHORED_MOVES.length + CONSTRUCTION_MOVES.length,
    );
    for (const entry of CONSTRUCTION_MOVES) {
      const kind = entry.implementation.operationKind;
      expect(PRIMITIVE_TRANSITION_CLASSES[kind]).toContain(entry.transitionClass);
      expect(PRIMITIVE_TRANSITION_EVIDENCE[kind]).toEqual(["structural"]);
    }
    expect(PRIMITIVE_TRANSITION_CLASSES["resolve-placeholder"]).toEqual(["strengthening"]);
  });

  describe("introduce-placeholder", () => {
    it("offers dependencies from a menu and generates the task and the placeholder symbol", () => {
      const first = materializeMoveOperation({
        state: initial(),
        move: move("introduce-placeholder"),
        selections: selectGoal(),
        idGenerator: commandIdGenerator("command:first"),
      });
      expect(first).toMatchObject({ ok: false, missingParameters: ["dependencies"] });
      if (first.ok) return;
      const menu = first.menus.find(({ parameterId }) => parameterId === "dependencies")!;
      expect(menu.items.map(({ value }) => value)).toEqual([
        { kind: "symbols", symbols: ["eps"] },
        { kind: "symbols", symbols: [] },
      ]);
      const done = introduced();
      expect(done.operation).toMatchObject({
        kind: "introduce-placeholder",
        displayName: "delta",
        origin: { kind: "existential-goal" },
        dependencies: ["eps"],
        allowedTasks: [],
      });
      expect(done.applied.transitionClass).toBe("equivalence");
      expect(done.state.constructions).toHaveLength(1);
    });

    it("is a strengthening when the choice may not depend on the variables", () => {
      const result = run(initial(), "introduce-placeholder", {
        dependencies: (item) => item.value.kind === "symbols" && item.value.symbols.length === 0,
      });
      expect(result.applied.transitionClass).toBe("strengthening");
    });

    it("rejects a target that is not existential, and rejects unknown menu items", () => {
      const result = materializeMoveOperation({
        state: initial(["Greater", "eps", 0]),
        move: move("introduce-placeholder"),
        selections: selectGoal(),
        idGenerator: commandIdGenerator("command:none"),
      });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "not-applicable" }] });
      const forged = materializeMoveOperation({
        state: initial(),
        move: move("introduce-placeholder"),
        selections: selectGoal(),
        menuChoices: { dependencies: "menu-item:0000000000000000" },
        idGenerator: commandIdGenerator("command:forged"),
      });
      expect(forged).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-choice" }] });
    });

    it("constructs a witness for a typed existential, keeping its membership in the goal", () => {
      const typed = initial(
        ["Exists", ["Element", "delta", "RealNumbers"], EXISTENTIAL[2]!],
        ["eps"],
      );
      const result = run(typed, "introduce-placeholder", { dependencies: dependsOnEverything });
      const conclusion = result.state.goals[0]?.sequent.conclusion
        .expression as unknown as unknown[];
      expect(conclusion[0]).toBe("And");
      const membership = conclusion[1] as unknown[];
      expect(membership[0]).toBe("Element");
      expect((membership[1] as string[])[0]).toMatch(/^placeholder_/);
      expect(membership[2]).toBe("RealNumbers");
    });

    it("generates a fresh symbol per command, as replay needs", () => {
      const symbol = (command: string) => commandIdGenerator(command).symbol("placeholder", 1);
      expect(symbol("command:a")).not.toBe(symbol("command:b"));
      expect(symbol("command:a")).toBe(symbol("command:a"));
      expect(symbol("command:a")).toMatch(/^placeholder_[0-9a-f]{12}$/);
    });
  });

  describe("add-requirement", () => {
    it("offers the goal's own condition as a sufficient requirement tracked by its target", () => {
      const state = introduced().state;
      const result = run(state, "add-requirement", {
        taskId: anything,
        requirement: (item) =>
          item.value.kind === "construction-requirement" &&
          item.value.role === "sufficient" &&
          item.value.evidence.kind === "target",
      });
      expect(result.operation).toMatchObject({
        kind: "add-requirement",
        role: "sufficient",
        evidence: { kind: "target", target: { kind: "goal", id: "goal:0" } },
      });
      expect(result.state.constructions?.[0]).toMatchObject({
        status: "partially-specified",
        requirements: [{ role: "sufficient" }],
      });
      expect(result.applied.transitionClass).toBe("equivalence");
    });

    it("records a heuristic hint that never becomes a hypothesis or an obligation", () => {
      const state = introduced().state;
      const before = JSON.stringify(state.goals.map((goal) => goal.sequent.context.hypotheses));
      const result = run(state, "add-requirement", {
        taskId: anything,
        requirement: (item) =>
          item.value.kind === "construction-requirement" &&
          item.value.role === "heuristic" &&
          item.origin.kind === "subterm-of",
      });
      expect(result.operation).toMatchObject({ role: "heuristic", evidence: { kind: "none" } });
      expect(
        JSON.stringify(result.state.goals.map((goal) => goal.sequent.context.hypotheses)),
      ).toBe(before);
      expect(result.state.obligations).toEqual([]);
    });

    it("offers a necessary or attested sufficient requirement only with a recorded attestation", () => {
      const state = introduced().state;
      const without = generateParameterMenus(state, move("add-requirement"), selectGoal());
      expect(without.ok).toBe(true);
      const menuOf = (attestationIds?: readonly string[]) => {
        const result = generateParameterMenus(
          state,
          move("add-requirement"),
          selectGoal(),
          {},
          {
            ...(attestationIds === undefined ? {} : { attestationIds }),
            menuChoices: {
              taskId: itemWhere(
                (without.ok ? without.menus : []) as readonly ParameterMenu[],
                "taskId",
                anything,
              ).id,
            },
            idGenerator: commandIdGenerator("command:menu"),
          },
        );
        if (!result.ok) throw new Error(result.diagnostics[0].message);
        return result.menus.find(({ parameterId }) => parameterId === "requirement")!.items;
      };
      const kinds = (items: readonly ParameterMenuItem[]) =>
        items.flatMap(({ value }) =>
          value.kind === "construction-requirement" ? [value.evidence.kind] : [],
        );
      expect(kinds(menuOf())).not.toContain("attestation");
      expect(kinds(menuOf(["attestation:1"]))).toContain("attestation");
    });

    it("offers nothing when no statement mentions the placeholder", () => {
      const state = run(initial(), "introduce-placeholder", {
        dependencies: dependsOnEverything,
      }).state;
      const abandoned = {
        ...state,
        goals: state.goals.map((goal) => ({
          ...goal,
          sequent: { ...goal.sequent, conclusion: { expression: "True" as PlainMathJson } },
        })),
      } as ExecutableProofState;
      const result = materializeMoveOperation({
        state: abandoned,
        move: move("add-requirement"),
        selections: selectGoal(),
        menuChoices: {},
        idGenerator: commandIdGenerator("command:empty"),
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("add-candidate", () => {
    it("offers the construction's allowed variables and subterms, not its own placeholder", () => {
      const state = introduced().state;
      const first = materializeMoveOperation({
        state,
        move: move("add-candidate"),
        selections: selectGoal(),
        idGenerator: commandIdGenerator("command:cand"),
      });
      if (first.ok) throw new Error("expected a menu");
      const task = itemWhere(first.menus, "taskId", anything);
      const second = materializeMoveOperation({
        state,
        move: move("add-candidate"),
        selections: selectGoal(),
        menuChoices: { taskId: task.id },
        idGenerator: commandIdGenerator("command:cand"),
      });
      if (second.ok) throw new Error("expected a menu");
      const terms = second.menus
        .find(({ parameterId }) => parameterId === "value")!
        .items.map(({ value }) => (value.kind === "term" ? value.expression : undefined));
      expect(terms).toContainEqual("eps");
      expect(terms).not.toContainEqual(["m_placeholder", "eps"]);
      expect(JSON.stringify(terms)).not.toContain("placeholder_");
    });

    it("records the chosen candidate", () => {
      const state = introduced().state;
      const result = run(state, "add-candidate", {
        taskId: anything,
        value: (item) => item.value.kind === "term" && item.value.expression === "eps",
      });
      expect(result.operation).toMatchObject({ kind: "add-candidate", value: "eps" });
      expect(result.state.constructions?.[0]?.candidates).toHaveLength(1);
      expect(result.applied.transitionClass).toBe("equivalence");
    });

    it("does not offer a candidate twice", () => {
      const withCandidate = run(introduced().state, "add-candidate", {
        taskId: anything,
        value: (item) => item.value.kind === "term" && item.value.expression === "eps",
      }).state;
      expect(() =>
        run(withCandidate, "add-candidate", {
          taskId: anything,
          value: (item) => item.value.kind === "term" && item.value.expression === "eps",
        }),
      ).toThrow(/No matching item/);
    });
  });

  describe("resolve-placeholder", () => {
    const withCandidate = (): ExecutableProofState =>
      run(introduced().state, "add-candidate", {
        taskId: anything,
        value: (item) => item.value.kind === "term" && item.value.expression === "eps",
      }).state;

    it("is offered only for a task that has a candidate", () => {
      const result = materializeMoveOperation({
        state: introduced().state,
        move: move("resolve-placeholder"),
        selections: selectGoal(),
        idGenerator: commandIdGenerator("command:none"),
      });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "not-applicable" }] });
    });

    it("substitutes the candidate and leaves the goal to prove", () => {
      const result = run(withCandidate(), "resolve-placeholder", {
        taskId: anything,
        candidateId: anything,
      });
      expect(result.applied.transitionClass).toBe("strengthening");
      expect(result.state.goals[0]?.sequent.conclusion.expression).toEqual([
        "And",
        ["Greater", "eps", 0],
        ["Less", "eps", "eps"],
      ]);
      expect(result.state.constructions?.[0]).toMatchObject({ status: "resolved" });
    });

    it("turns an attested sufficient requirement into an obligation", () => {
      const withRequirement = run(
        withCandidate(),
        "add-requirement",
        {
          taskId: anything,
          requirement: (item) =>
            item.value.kind === "construction-requirement" &&
            item.value.role === "sufficient" &&
            item.value.evidence.kind === "attestation" &&
            expressionHead(item.value.expression) === "Greater",
        },
        selectGoal(),
        { attestationIds: ["attestation:1"] },
      ).state;
      const resolved = run(withRequirement, "resolve-placeholder", {
        taskId: anything,
        candidateId: anything,
      });
      expect(resolved.state.obligations).toHaveLength(1);
      expect(resolved.state.obligations[0]).toMatchObject({
        provenance: { kind: "construction-requirement" },
        sequent: { conclusion: { expression: ["Greater", "eps", 0] } },
      });
    });
  });

  describe("abandon-placeholder", () => {
    it("is refused while the placeholder is still in the goal", () => {
      const result = materializeMoveOperation({
        state: introduced().state,
        move: move("abandon-placeholder"),
        selections: selectGoal(),
        idGenerator: commandIdGenerator("command:in-use"),
      });
      expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "not-applicable" }] });
    });

    it("abandons a task nothing uses", () => {
      const withAuxiliary = ((): ExecutableProofState => {
        const applied = applyTransition(initial(["Greater", "eps", 0]), {
          kind: "introduce-placeholder",
          expectedStateId: "state:0",
          resultStateId: "state:aux",
          target: { kind: "goal", id: "goal:0" },
          taskId: "task:aux",
          symbol: "aux",
          displayName: "aux",
          origin: { kind: "auxiliary-request", sort: real, description: "a bound" },
          dependencies: ["eps"],
          allowedTasks: [],
        } as never);
        if (!applied.ok) throw new Error("setup failed");
        return applied.state;
      })();
      const result = run(withAuxiliary, "abandon-placeholder", { taskId: anything });
      expect(result.applied.transitionClass).toBe("equivalence");
      expect(result.state.constructions?.[0]).toMatchObject({ status: "abandoned" });
    });
  });

  it("previews a materialized operation through planMove", () => {
    const result = materializeMoveOperation({
      state: initial(),
      move: move("introduce-placeholder"),
      selections: selectGoal(),
      menuChoices: {
        dependencies: itemWhere(
          (
            materializeMoveOperation({
              state: initial(),
              move: move("introduce-placeholder"),
              selections: selectGoal(),
              idGenerator: commandIdGenerator("command:plan"),
            }) as { menus: readonly ParameterMenu[] }
          ).menus,
          "dependencies",
          dependsOnEverything,
        ).id,
      },
      idGenerator: commandIdGenerator("command:plan"),
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(
      planMove(initial(), { moveId: "move:introduce-placeholder", operation: result.operation }),
    ).toMatchObject({
      ok: true,
      preview: { transitionClass: "equivalence", evidence: "structural" },
    });
  });

  describe("placeholders in menus", () => {
    it("offers a placeholder application as a witness for another existential", () => {
      const nested: PlainMathJson = [
        "Exists",
        "x",
        ["Exists", "y", ["And", ["Less", "x", "y"], ["Less", "y", "eps"]]],
      ];
      const state = run(initial(nested, ["eps", "x", "y"]), "introduce-placeholder", {
        dependencies: dependsOnEverything,
      }).state;
      const target = state.goals[0]!.sequent.conclusion.expression;
      expect(JSON.stringify(target)).toContain("placeholder_");
      const menus = generateParameterMenus(
        state,
        HAND_AUTHORED_MOVES.find((entry) => entry.id === "move:choose-existential-witness")!,
        {
          target: selectGoal().target!,
        },
      );
      if (!menus.ok) throw new Error(menus.diagnostics[0].message);
      const witnesses = menus.menus.find(({ parameterId }) => parameterId === "witness")!.items;
      expect(
        witnesses.some(
          ({ value }) =>
            value.kind === "term" &&
            Array.isArray(value.expression) &&
            String(value.expression[0]).startsWith("placeholder_"),
        ),
      ).toBe(true);
    });
  });
});
