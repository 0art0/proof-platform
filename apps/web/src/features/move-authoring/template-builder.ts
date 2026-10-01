/**
 * The pure view model of the move-template editor (design plan §13.1, roadmap N35). A draft is
 * assembled only from stored data and clicks: patterns are the fragments of selected occurrences,
 * the contract and parameters are the first primitive's own, the plan is a sequence of primitive
 * kernel operations (picked, or recorded in the stored history), and examples are stored
 * snapshots with the selections captured in them. No mathematics is typed and none is computed
 * here; the proof service validates the finished template by running its examples.
 */
import {
  HAND_AUTHORED_MOVES,
  PRIMITIVE_TRANSITION_CLASSES,
  type MoveDefinition,
} from "@proof/moves";
import {
  authoredExampleSchema,
  authoredMoveTemplateSchema,
  macroFromSemanticSteps,
  plannedTransitionClass,
  primitiveForStep,
  recordedMacroExample,
  AUTHORED_MOVE_ID_PREFIX,
  type AuthoredExample,
  type AuthoredMoveTemplate,
  type AuthoredPlanStep,
} from "@proof/moves/authoring";
import { compactMathText, type OperatorDeclaration, type ProofNode } from "@proof/protocol";
import { resolveProofSelection, type AnchoredProofSelection } from "@proof/selections";
import type { PlainMathJson } from "@proof/mathjson-model";
import type { DerivedPath } from "./recorded-paths";

export type TransitionClassName = AuthoredMoveTemplate["transitionClass"];
type ArtifactReference = AuthoredMoveTemplate["requiredArtifacts"][number];
export type TemplateBody = Omit<AuthoredMoveTemplate, "id" | "name" | "description">;

/** What the editor holds: the text fields the author types, and the structured body. */
export type TemplateDraft = Readonly<{
  /** The part of the move ID after `authored:`. */
  idSuffix: string;
  name: string;
  description: string;
  body: TemplateBody;
}>;

export const CLASS_LABELS: Readonly<Record<TransitionClassName, string>> = Object.freeze({
  equivalence: "Equivalence",
  strengthening: "Strengthening",
  weakening: "Weakening",
});

// ---------------------------------------------------------------------------------------------
// Identity and assembly
// ---------------------------------------------------------------------------------------------

/** A stable-identifier suffix for a move name: lowercase words joined by hyphens. */
export function suggestIdSuffix(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function moveIdOf(draft: TemplateDraft): string {
  return `${AUTHORED_MOVE_ID_PREFIX}${draft.idSuffix}`;
}

/** The template the draft stands for; it need not be valid yet. */
export function assembleTemplate(draft: TemplateDraft): Record<string, unknown> {
  return {
    id: moveIdOf(draft),
    name: draft.name,
    description: draft.description,
    ...draft.body,
  };
}

export type ParsedDraft =
  | Readonly<{ ok: true; template: AuthoredMoveTemplate }>
  | Readonly<{ ok: false; problems: readonly string[] }>;

/** A local well-formedness check; the proof service still validates the examples. */
export function parseDraft(draft: TemplateDraft): ParsedDraft {
  const parsed = authoredMoveTemplateSchema.safeParse(assembleTemplate(draft));
  if (parsed.success) return { ok: true, template: parsed.data };
  const problems = [
    ...new Set(
      parsed.error.issues.map((issue) => {
        const where = issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
        return `${where}${issue.message}`;
      }),
    ),
  ];
  return { ok: false, problems: problems.slice(0, 8) };
}

/** A draft from a stored template (a saved revision being revised); undefined when it is not one. */
export function draftFromTemplate(
  template: Readonly<Record<string, unknown>>,
): TemplateDraft | undefined {
  const parsed = authoredMoveTemplateSchema.safeParse(template);
  if (!parsed.success) return undefined;
  const { id, name, description, ...body } = parsed.data;
  return {
    idSuffix: id.startsWith(AUTHORED_MOVE_ID_PREFIX)
      ? id.slice(AUTHORED_MOVE_ID_PREFIX.length)
      : id,
    name,
    description,
    body: structuredClone(body) as TemplateBody,
  };
}

// ---------------------------------------------------------------------------------------------
// Starting points: a primitive, or a recorded path
// ---------------------------------------------------------------------------------------------

export type PrimitiveOption = Readonly<{
  moveId: string;
  name: string;
  operationKind: string;
  transitionClass: TransitionClassName;
}>;

/** The primitive kernel operations a plan step can be: every hand-authored primitive move. */
export function primitiveOptions(): readonly PrimitiveOption[] {
  return HAND_AUTHORED_MOVES.filter(
    ({ implementation }) =>
      implementation.operationKind !== "apply-result-forward" &&
      implementation.operationKind !== "apply-result-backward",
  ).map((move) => ({
    moveId: move.id,
    name: move.name,
    operationKind: move.implementation.operationKind,
    transitionClass: move.transitionClass,
  }));
}

function primitiveById(moveId: string): MoveDefinition | undefined {
  return HAND_AUTHORED_MOVES.find(({ id }) => id === moveId);
}

function primitiveBody(
  primitive: MoveDefinition,
  rest: readonly AuthoredPlanStep[],
  examples: readonly AuthoredExample[],
): TemplateBody {
  const steps: AuthoredPlanStep[] = [
    { id: "step-1", moveId: primitive.id, operationKind: primitive.implementation.operationKind },
    ...rest,
  ];
  const plan = { kind: "deterministic-plan" as const, steps };
  return {
    selectionContract: structuredClone({
      slots: [...primitive.selectionContract.slots],
      allowAdditional: false as const,
    }),
    patterns: structuredClone([...primitive.patterns]),
    contextRequirements: [...primitive.contextRequirements],
    sideConditions: [...primitive.sideConditions],
    parameters: structuredClone([...primitive.parameters]),
    requiredArtifacts: [],
    plan,
    transitionClass: plannedTransitionClass(plan) ?? primitive.transitionClass,
    examples: [...examples],
  };
}

/** A one-step draft over a primitive: its contract, parameters and patterns, no examples yet. */
export function draftFromPrimitive(moveId: string): TemplateDraft | undefined {
  const primitive = primitiveById(moveId);
  if (primitive === undefined) return undefined;
  return {
    idSuffix: "",
    name: "",
    description: "",
    body: primitiveBody(primitive, [], []),
  };
}

export type DraftFromPath =
  Readonly<{ ok: true; draft: TemplateDraft }> | Readonly<{ ok: false; message: string }>;

/**
 * A draft from a recorded path. A single step becomes a general move: its recorded selections
 * are only the patterns, so other places match; a macro keeps its recorded selections and menu
 * choices, which later steps replay.
 */
export function draftFromPath(path: DerivedPath, name = "", description = ""): DraftFromPath {
  const built = macroFromSemanticSteps(path.steps, {
    id: "authored:draft",
    name: name || "Draft move",
    description: description || "Draft move",
  });
  if (!built.ok) return { ok: false, message: built.diagnostics[0].message };
  const base = draftFromTemplate(built.template);
  if (base === undefined)
    return { ok: false, message: "The recorded steps do not make a template." };
  const { body } = base;
  const [only] = body.plan.steps;
  const plan =
    path.steps.length === 1 && only !== undefined
      ? {
          ...body.plan,
          steps: [{ id: only.id, moveId: only.moveId, operationKind: only.operationKind }],
        }
      : body.plan;
  return { ok: true, draft: { idSuffix: "", name, description, body: { ...body, plan } } };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export type PlanStepView = Readonly<{
  id: string;
  index: number;
  moveName: string;
  moveId: string;
  operationKind: string;
  transitionClass: TransitionClassName;
  /** Whether the step is replayed from a recording (every step after the first). */
  recorded: boolean;
}>;

export function planView(draft: TemplateDraft): readonly PlanStepView[] {
  return draft.body.plan.steps.map((step, index) => {
    const primitive = primitiveForStep(step);
    return {
      id: step.id,
      index,
      moveName: primitive?.name ?? step.moveId,
      moveId: step.moveId,
      operationKind: step.operationKind,
      transitionClass: PRIMITIVE_TRANSITION_CLASSES[step.operationKind],
      recorded: step.operation !== undefined,
    };
  });
}

/** The class its kernel steps compose to: the weakest guarantee among them. */
export function composedClass(draft: TemplateDraft): TransitionClassName {
  return plannedTransitionClass(draft.body.plan) ?? draft.body.transitionClass;
}

export function moveIdsOfPlan(plan: TemplateBody["plan"]): readonly string[] {
  return plan.steps.map(({ moveId }) => moveId);
}

/** Pick another primitive for the first step: its contract, parameters and patterns replace. */
export function changeFirstPrimitive(draft: TemplateDraft, moveId: string): TemplateDraft {
  const primitive = primitiveById(moveId);
  if (primitive === undefined) return draft;
  const rest = draft.body.plan.steps.slice(1);
  const body = primitiveBody(primitive, rest, draft.body.examples);
  return { ...draft, body: { ...body, requiredArtifacts: draft.body.requiredArtifacts } };
}

/** Drop the last step of a macro; a plan keeps at least one step. */
export function removeLastStep(draft: TemplateDraft): TemplateDraft {
  const steps = draft.body.plan.steps;
  if (steps.length <= 1) return draft;
  const plan = { ...draft.body.plan, steps: steps.slice(0, -1) };
  return { ...draft, body: { ...draft.body, plan, transitionClass: composedClassOf(plan) } };
}

function composedClassOf(plan: TemplateBody["plan"]): TransitionClassName {
  return plannedTransitionClass(plan) ?? "equivalence";
}

export function setDeclaredClass(draft: TemplateDraft, value: TransitionClassName): TemplateDraft {
  return { ...draft, body: { ...draft.body, transitionClass: value } };
}

// ---------------------------------------------------------------------------------------------
// Selection contract, patterns, artifacts
// ---------------------------------------------------------------------------------------------

export type SlotView = Readonly<{
  id: string;
  role: string;
  semanticRole: string;
  required: boolean;
  /** The first primitive requires the slot, so the contract cannot make it optional. */
  locked: boolean;
}>;

export function slotViews(draft: TemplateDraft): readonly SlotView[] {
  const first = draft.body.plan.steps[0];
  const primitive = first === undefined ? undefined : primitiveForStep(first);
  return draft.body.selectionContract.slots.map((slot) => ({
    id: slot.id,
    role: slot.role,
    semanticRole: slot.semanticRole,
    required: slot.required,
    locked: primitive?.selectionContract.slots.find(({ id }) => id === slot.id)?.required === true,
  }));
}

export function setSlotRequired(draft: TemplateDraft, slotId: string, required: boolean) {
  const slots = draft.body.selectionContract.slots.map((slot) =>
    slot.id === slotId ? { ...slot, required } : slot,
  );
  return {
    ...draft,
    body: { ...draft.body, selectionContract: { ...draft.body.selectionContract, slots } },
  };
}

export type PatternView = Readonly<{ id: string; slotId: string; text: string }>;

export function patternViews(draft: TemplateDraft): readonly PatternView[] {
  return draft.body.patterns.map((pattern) => ({
    id: pattern.id,
    slotId: pattern.selectionSlotId,
    text: compactMathText(pattern.expression),
  }));
}

export type SelectedFragment =
  Readonly<{ ok: true; expression: PlainMathJson }> | Readonly<{ ok: false; message: string }>;

/** The fragment a single selection names in a stored snapshot, read from the snapshot. */
export function selectedFragment(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
  operators: readonly OperatorDeclaration[],
): SelectedFragment {
  if (selections.length !== 1) {
    return { ok: false, message: "Select exactly one occurrence in the snapshot." };
  }
  const resolved = resolveProofSelection(node.state, selections[0], { operators });
  if (!resolved.ok) return { ok: false, message: resolved.diagnostics[0].message };
  return { ok: true, expression: resolved.selection.fragment };
}

/** Set the pattern of a slot to a selected fragment: replaces the slot's patterns. */
export function setSlotPattern(
  draft: TemplateDraft,
  slotId: string,
  expression: PlainMathJson,
): TemplateDraft {
  const others = draft.body.patterns.filter(({ selectionSlotId }) => selectionSlotId !== slotId);
  const patterns = [...others, { id: `pattern:${slotId}`, selectionSlotId: slotId, expression }];
  return { ...draft, body: { ...draft.body, patterns } };
}

/** Remove a pattern; a template keeps at least one. */
export function removePattern(draft: TemplateDraft, patternId: string): TemplateDraft {
  if (draft.body.patterns.length <= 1) return draft;
  return {
    ...draft,
    body: { ...draft.body, patterns: draft.body.patterns.filter(({ id }) => id !== patternId) },
  };
}

export function toggleArtifact(
  draft: TemplateDraft,
  reference: Readonly<{ kind: "definition" | "result"; id: string }>,
): TemplateDraft {
  const present = draft.body.requiredArtifacts.some(
    ({ kind, id }) => kind === reference.kind && id === reference.id,
  );
  const requiredArtifacts = present
    ? draft.body.requiredArtifacts.filter(
        ({ kind, id }) => !(kind === reference.kind && id === reference.id),
      )
    : [
        ...draft.body.requiredArtifacts,
        { kind: reference.kind, id: reference.id as ArtifactReference["id"] },
      ];
  return { ...draft, body: { ...draft.body, requiredArtifacts } };
}

// ---------------------------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------------------------

export type ExampleView = Readonly<{
  id: string;
  description: string;
  outcome: "applied" | "rejected";
  /** A readable summary of what the example expects. */
  expectation: string;
  selectionCount: number;
}>;

export function exampleViews(draft: TemplateDraft): readonly ExampleView[] {
  return draft.body.examples.map((example) => ({
    id: example.id,
    description: example.description,
    outcome: example.expected.outcome,
    expectation:
      example.expected.outcome === "applied"
        ? `${CLASS_LABELS[example.expected.transitionClass]}; ${example.expected.goals.length} goal${
            example.expected.goals.length === 1 ? "" : "s"
          } and ${example.expected.obligations.length} obligation${
            example.expected.obligations.length === 1 ? "" : "s"
          } afterwards`
        : "Rejected by the kernel",
    selectionCount: Object.keys(example.selections).length,
  }));
}

export function positiveCount(draft: TemplateDraft): number {
  return draft.body.examples.filter(({ expected }) => expected.outcome === "applied").length;
}

export function negativeCount(draft: TemplateDraft): number {
  return draft.body.examples.filter(({ expected }) => expected.outcome === "rejected").length;
}

function nextExampleId(draft: TemplateDraft, prefix: string): string {
  const used = new Set(draft.body.examples.map(({ id }) => id));
  for (let index = draft.body.examples.length + 1; ; index += 1) {
    const id = `${prefix}-${index}`;
    if (!used.has(id)) return id;
  }
}

export type AddedExample =
  Readonly<{ ok: true; draft: TemplateDraft }> | Readonly<{ ok: false; message: string }>;

/**
 * A positive example from a recorded path with the draft's plan: the path's start snapshot, the
 * first step's recorded selections and menu choices, and the end snapshot's conclusions.
 */
export function addPositiveExample(
  draft: TemplateDraft,
  path: DerivedPath,
  operators: readonly OperatorDeclaration[],
  description: string,
): AddedExample {
  const planned = moveIdsOfPlan(draft.body.plan);
  if (
    path.steps.length !== planned.length ||
    path.steps.some((step, index) => step.moveId !== planned[index])
  ) {
    return { ok: false, message: "The path does not apply the same moves as the plan." };
  }
  const example = recordedMacroExample({
    id: nextExampleId(draft, "positive"),
    description,
    state: path.startNode.state,
    finalState: path.endNode.state,
    steps: path.steps,
    transitionClass: draft.body.transitionClass,
    operators,
  });
  if (example === undefined) {
    return {
      ok: false,
      message: "The recorded menu choices could not be matched in the stored snapshot.",
    };
  }
  return withExample(draft, example);
}

/** Selections in a snapshot, by the contract slot each is for. */
export type SlotSelections = Readonly<Record<string, AnchoredProofSelection>>;

/**
 * A negative example: a stored snapshot and the selections made in it, which the kernel must
 * refuse. Optionally pins the diagnostic code the refusal must carry.
 */
export function addNegativeExample(
  draft: TemplateDraft,
  node: ProofNode,
  selections: SlotSelections,
  description: string,
  diagnosticCode?: string,
): AddedExample {
  if (Object.keys(selections).length === 0) {
    return { ok: false, message: "Assign at least one selection to a slot first." };
  }
  const mapped: Record<string, unknown> = {};
  for (const [slotId, selection] of Object.entries(selections)) {
    const anchor = { target: selection.anchor.target, statement: selection.anchor.statement };
    mapped[slotId] =
      selection.kind === "exact"
        ? { kind: "exact", anchor, path: [...selection.path] }
        : {
            kind: "associative",
            anchor,
            containerPath: [...selection.containerPath],
            startOperand: selection.startOperand,
            endOperand: selection.endOperand,
          };
  }
  const parsed = authoredExampleSchema.safeParse({
    id: nextExampleId(draft, "negative"),
    description,
    state: structuredClone(node.state) as unknown as Record<string, unknown>,
    selections: mapped,
    expected: {
      outcome: "rejected",
      ...(diagnosticCode === undefined || diagnosticCode === "" ? {} : { diagnosticCode }),
    },
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "The example is invalid." };
  }
  return withExample(draft, parsed.data);
}

function withExample(draft: TemplateDraft, example: AuthoredExample): AddedExample {
  return {
    ok: true,
    draft: { ...draft, body: { ...draft.body, examples: [...draft.body.examples, example] } },
  };
}

export function removeExample(draft: TemplateDraft, exampleId: string): TemplateDraft {
  return {
    ...draft,
    body: {
      ...draft.body,
      examples: draft.body.examples.filter(({ id }) => id !== exampleId),
    },
  };
}
