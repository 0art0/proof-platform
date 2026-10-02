/**
 * The construction actions (refinement §5; roadmap N42): Construct an object, Add requirement,
 * Add candidate, Use this candidate and Abandon. Each is one hand-authored construction move
 * (`CONSTRUCTION_MOVES`) driven from the stored snapshot: its menus are generated from the
 * snapshot and its operation is materialized from a menu choice, so no mathematics is typed. The
 * operation travels in one N25 `kernel-operation` envelope as the human web actor, and the worker
 * validates it again with the kernel.
 *
 * The mathematics of a requirement or a candidate is sent raw, so the envelope declares the
 * `validated-operation` payload source: the worker accepts it only when the expression already
 * occurs in the snapshot, which a menu item always does.
 */
import {
  CONSTRUCTION_MOVES,
  commandIdGenerator,
  generateParameterMenus,
  materializeMoveOperation,
  type MoveSelections,
  type ParameterMenuItem,
} from "@proof/moves";
import type { ConstructionTask } from "@proof/mathjson-model";
import {
  protocolCommandEnvelopeSchema,
  type OperatorDeclaration,
  type ProofNode,
  type ProtocolCommandEnvelope,
} from "@proof/protocol";
import {
  toolbarCommandId,
  WEB_ACTOR,
  type Availability,
} from "../stored-proof-workspace/toolbar-actions";

export type ConstructionActionKind =
  "add-requirement" | "add-candidate" | "resolve-placeholder" | "abandon-placeholder";

/** The menu parameter a construction action chooses from, besides the construction itself. */
const CHOICE_PARAMETER: Readonly<Record<ConstructionActionKind, string | undefined>> = {
  "add-requirement": "requirement",
  "add-candidate": "value",
  "resolve-placeholder": "candidateId",
  "abandon-placeholder": undefined,
};

/** The actions that send a raw expression, which the worker checks against the snapshot. */
const SENDS_MATHEMATICS: ReadonlySet<string> = new Set(["add-requirement", "add-candidate"]);

export type ConstructionTarget = Readonly<{ kind: "goal" | "obligation"; id: string }>;

function moveFor(kind: string) {
  return CONSTRUCTION_MOVES.find((move) => move.implementation.operationKind === kind);
}

/** Whether a statement mentions `symbol`, as a placeholder head or as an operand. */
function mentions(expression: unknown, symbol: string): boolean {
  if (expression === symbol) return true;
  if (Array.isArray(expression)) return expression.some((part) => mentions(part, symbol));
  if (typeof expression === "object" && expression !== null) {
    const record = expression as Record<string, unknown>;
    return record.sym === symbol || (Array.isArray(record.fn) && mentions(record.fn, symbol));
  }
  return false;
}

/**
 * The target a construction action is invoked from: one whose goal still mentions the
 * placeholder, else the target the construction came from, else any open target.
 */
export function constructionTarget(
  node: ProofNode,
  task: ConstructionTask,
): ConstructionTarget | undefined {
  const targets: ConstructionTarget[] = [
    ...node.state.goals.map(({ id }) => ({ kind: "goal" as const, id })),
    ...node.state.obligations.map(({ id }) => ({ kind: "obligation" as const, id })),
  ];
  const entries = [...node.state.goals, ...node.state.obligations];
  const using = entries.findIndex((entry) =>
    mentions(entry.sequent.conclusion.expression, task.symbol),
  );
  if (using >= 0) return targets[using];
  if (task.origin.kind === "existential-goal") {
    const { target } = task.origin;
    const origin = targets.find(({ kind, id }) => kind === target.kind && id === target.id);
    if (origin !== undefined) return origin;
  }
  return targets[0];
}

function selectionsFor(node: ProofNode, target: ConstructionTarget): MoveSelections {
  return {
    target: {
      kind: "exact",
      anchor: {
        stateId: node.state.id,
        target: target as MoveSelections[string]["anchor"]["target"],
        statement: { kind: "conclusion" },
      },
      path: [],
    },
  };
}

function environment(operators: readonly OperatorDeclaration[]) {
  return { operators };
}

type MenuResult =
  | Readonly<{
      ok: true;
      items: readonly ParameterMenuItem[];
      taskChoice: Readonly<Record<string, string>>;
    }>
  | Readonly<{ ok: false; reason: string }>;

/**
 * The items a construction action can choose from for `task`. An action with no choice (abandon)
 * has no items; it is available exactly when the task is in the move's own task menu.
 */
export function constructionOptions(
  node: ProofNode,
  operators: readonly OperatorDeclaration[],
  kind: ConstructionActionKind,
  task: ConstructionTask,
): MenuResult {
  const move = moveFor(kind);
  const target = constructionTarget(node, task);
  if (move === undefined || target === undefined) {
    return { ok: false, reason: "There is no open goal or obligation to act from." };
  }
  const selections = selectionsFor(node, target);
  const idGenerator = commandIdGenerator("command:web-construction-menu");
  const first = generateParameterMenus(node.state, move, selections, environment(operators), {
    idGenerator,
  });
  if (!first.ok) return { ok: false, reason: first.diagnostics[0].message };
  const taskItem = first.menus
    .find(({ parameterId }) => parameterId === "taskId")
    ?.items.find(({ value }) => value.kind === "construction-task" && value.taskId === task.id);
  if (taskItem === undefined) return { ok: false, reason: noTaskReason(kind, task) };
  const taskChoice = { taskId: taskItem.id };
  const parameter = CHOICE_PARAMETER[kind];
  if (parameter === undefined) return { ok: true, items: [], taskChoice };
  const second = generateParameterMenus(node.state, move, selections, environment(operators), {
    idGenerator,
    menuChoices: taskChoice,
  });
  if (!second.ok) return { ok: false, reason: second.diagnostics[0].message };
  const items = second.menus.find((menu) => menu.parameterId === parameter)?.items ?? [];
  return items.length === 0
    ? { ok: false, reason: noItemsReason(kind, task) }
    : { ok: true, items, taskChoice };
}

function noTaskReason(kind: ConstructionActionKind, task: ConstructionTask): string {
  switch (kind) {
    case "resolve-placeholder":
      return task.candidates.length === 0
        ? `Add a candidate for ${task.displayName} first.`
        : `No candidate of ${task.displayName} can be used yet.`;
    case "abandon-placeholder":
      return `${task.displayName} still occurs in the proof state, so it cannot be abandoned. Backtrack to before it was introduced to undo it.`;
    default:
      return `${task.displayName} is not an open construction.`;
  }
}

function noItemsReason(kind: ConstructionActionKind, task: ConstructionTask): string {
  switch (kind) {
    case "add-requirement":
      return `No statement of the proof state says something new about ${task.displayName}.`;
    case "add-candidate":
      return `Every term ${task.displayName} may use is already a candidate.`;
    default:
      return `Nothing is available for ${task.displayName}.`;
  }
}

/** Plain words for what a requirement item would record. */
export function requirementRoleText(item: ParameterMenuItem): string {
  const { value } = item;
  if (value.kind !== "construction-requirement") return "";
  switch (value.role) {
    case "sufficient":
      return value.evidence.kind === "target"
        ? "Sufficient: the proof already needs this (it is a goal or obligation)."
        : "Sufficient: an attested argument says this would be enough.";
    case "necessary":
      return "Necessary: an attested argument says any valid choice must satisfy this.";
    case "heuristic":
      return "Hint only: worth investigating; it establishes nothing and is not an assumption.";
  }
}

export type ConstructionActionInput = Readonly<{
  node: ProofNode;
  operators: readonly OperatorDeclaration[];
  kind: ConstructionActionKind;
  task: ConstructionTask;
  /** The chosen menu item's ID, for an action that chooses. */
  itemId?: string;
  commandId?: string;
}>;

/** The one `kernel-operation` envelope of a construction action. */
export function constructionActionEnvelope(
  input: ConstructionActionInput,
): Availability<ProtocolCommandEnvelope> {
  const { node, operators, kind, task } = input;
  const options = constructionOptions(node, operators, kind, task);
  if (!options.ok) return options;
  const parameter = CHOICE_PARAMETER[kind];
  if (parameter !== undefined && !options.items.some(({ id }) => id === input.itemId)) {
    return { ok: false, reason: "Choose one of the offered items first." };
  }
  const move = moveFor(kind);
  const target = constructionTarget(node, task);
  if (move === undefined || target === undefined) {
    return { ok: false, reason: "There is no open goal or obligation to act from." };
  }
  const commandId = input.commandId ?? toolbarCommandId(kind);
  const materialized = materializeMoveOperation({
    state: node.state,
    move,
    selections: selectionsFor(node, target),
    menuChoices: {
      ...options.taskChoice,
      ...(parameter === undefined || input.itemId === undefined
        ? {}
        : { [parameter]: input.itemId }),
    },
    idGenerator: commandIdGenerator(commandId),
    env: environment(operators),
  });
  if (!materialized.ok) return { ok: false, reason: materialized.diagnostics[0].message };
  return {
    ok: true,
    value: protocolCommandEnvelopeSchema.parse({
      commandId,
      actor: WEB_ACTOR,
      basis: { nodeId: node.id },
      command: {
        kind: "kernel-operation",
        operation: { ...materialized.operation },
        ...(SENDS_MATHEMATICS.has(kind) ? { payloadSource: "validated-operation" } : {}),
      },
    }),
  };
}

export type ConstructPlan = Readonly<{
  target: ConstructionTarget;
  /** The variable the placeholder replaces, shown to the user. */
  boundSymbol: string;
}>;

/** The binder an existential conclusion binds, bare or typed (`["Element", x, S]`). */
export function existentialBinder(expression: unknown): string | undefined {
  if (!Array.isArray(expression) || expression.length !== 3 || expression[0] !== "Exists") {
    return undefined;
  }
  const binder: unknown = expression[1];
  if (typeof binder === "string") return binder;
  return Array.isArray(binder) &&
    binder.length === 3 &&
    binder[0] === "Element" &&
    typeof binder[1] === "string"
    ? binder[1]
    : undefined;
}

/**
 * "Construct an object" on the selected existential goal or obligation, over every variable the
 * goal mentions (the choice that keeps the goal equivalent). The move's own menu offers the
 * narrower choices; this action takes the first.
 */
export function constructPlan(
  node: ProofNode,
  operators: readonly OperatorDeclaration[],
  target: ConstructionTarget,
): Availability<ConstructPlan> {
  const entry = (target.kind === "goal" ? node.state.goals : node.state.obligations).find(
    ({ id }) => id === target.id,
  );
  if (entry === undefined)
    return { ok: false, reason: "The selected target is not open in this snapshot." };
  const bound = existentialBinder(entry.sequent.conclusion.expression);
  if (bound === undefined) {
    return {
      ok: false,
      reason: "The selected target does not conclude with an existential statement.",
    };
  }
  const move = moveFor("introduce-placeholder");
  if (move === undefined) return { ok: false, reason: "The construction move is unavailable." };
  const probe = materializeMoveOperation({
    state: node.state,
    move,
    selections: selectionsFor(node, target),
    menuChoices: {},
    idGenerator: commandIdGenerator("command:web-construct-probe"),
    env: environment(operators),
  });
  if (probe.ok) return { ok: true, value: { target, boundSymbol: bound } };
  const diagnostic = probe.diagnostics[0];
  if (diagnostic.code === "requires-input") {
    return { ok: true, value: { target, boundSymbol: bound } };
  }
  return {
    ok: false,
    reason:
      diagnostic.code === "not-applicable"
        ? `The variable ${bound} has no declared sort in this target's context.`
        : diagnostic.message,
  };
}

export function constructEnvelope(
  input: Readonly<{
    node: ProofNode;
    operators: readonly OperatorDeclaration[];
    plan: ConstructPlan;
    commandId?: string;
  }>,
): Availability<ProtocolCommandEnvelope> {
  const { node, operators, plan } = input;
  const move = moveFor("introduce-placeholder");
  if (move === undefined) return { ok: false, reason: "The construction move is unavailable." };
  const selections = selectionsFor(node, plan.target);
  const menus = generateParameterMenus(node.state, move, selections, environment(operators), {});
  if (!menus.ok) return { ok: false, reason: menus.diagnostics[0].message };
  const everything = menus.menus.find(({ parameterId }) => parameterId === "dependencies")
    ?.items[0];
  if (everything === undefined) return { ok: false, reason: "No dependencies are offered." };
  const commandId = input.commandId ?? toolbarCommandId("construct");
  const materialized = materializeMoveOperation({
    state: node.state,
    move,
    selections,
    menuChoices: { dependencies: everything.id },
    idGenerator: commandIdGenerator(commandId),
    env: environment(operators),
  });
  if (!materialized.ok) return { ok: false, reason: materialized.diagnostics[0].message };
  return {
    ok: true,
    value: protocolCommandEnvelopeSchema.parse({
      commandId,
      actor: WEB_ACTOR,
      basis: { nodeId: node.id },
      command: { kind: "kernel-operation", operation: { ...materialized.operation } },
    }),
  };
}
