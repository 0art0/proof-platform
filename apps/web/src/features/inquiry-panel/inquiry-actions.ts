/**
 * The inquiry actions (refinement §10; roadmap N34): whether each fits the current selection and
 * displayed suggestion, and the N25 command envelope each sends. Every action is one envelope
 * through the single command path as the human web actor, based on the current node. No action
 * sends free-typed mathematics: targets, hypotheses and occurrences are named by stored identity,
 * and a construction placeholder is introduced from the selected existential goal alone (the
 * construction actions on a task live in `construction-actions.ts`).
 *
 * Reasons stay honest. Only "Try this method" and "Investigate this hypothesis" are methods with
 * stated semantics, so only they create method-encoded records (on the worker). The other
 * record-creating actions are explicit user actions and record no reason at all: they claim no
 * more than "the participant chose to explore, or to attempt, this".
 */
import {
  protocolCommandEnvelopeSchema,
  type InteractionSelection,
  type OperatorDeclaration,
  type MenuChoices,
  type ProofNode,
  type ProtocolCommandEnvelope,
} from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import {
  selectedTarget,
  toolbarCommandId,
  WEB_ACTOR,
  type Availability,
  type ToolbarTarget,
} from "../stored-proof-workspace/toolbar-actions";
import type { MoveState } from "../stored-proof-workspace/suggestion-card";
import type { SuggestionState } from "../stored-proof-workspace/suggestion-panel";
import { constructPlan, type ConstructPlan } from "./construction-actions";
import type { InquirySummary } from "./inquiry-summary";

export { WEB_ACTOR };
export type { Availability, ToolbarTarget };

function unavailable<Value>(reason: string): Availability<Value> {
  return { ok: false, reason };
}

function envelope(
  commandId: string,
  nodeId: string,
  command: Readonly<Record<string, unknown>>,
): ProtocolCommandEnvelope {
  return protocolCommandEnvelopeSchema.parse({
    commandId,
    actor: WEB_ACTOR,
    basis: { nodeId },
    command,
  });
}

/** A fresh command ID for one inquiry action. */
export function inquiryCommandId(action: string): string {
  return toolbarCommandId(action);
}

// ---------------------------------------------------------------------------------------------
// Investigate this hypothesis
// ---------------------------------------------------------------------------------------------

export type HypothesisPlan = Readonly<{ target: ToolbarTarget; hypothesisId: string }>;

/** The one hypothesis every selection lies in. */
export function investigateAvailability(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
): Availability<HypothesisPlan> {
  const target = selectedTarget(node, selections);
  if (!target.ok) {
    return unavailable(
      selections.length === 0 ? "Select an occurrence in a hypothesis first." : target.reason,
    );
  }
  const statements = selections.map(({ anchor }) => anchor.statement);
  const first = statements[0]!;
  if (first.kind !== "hypothesis") {
    return unavailable("Select within a hypothesis, not a conclusion.");
  }
  if (
    statements.some((statement) => statement.kind !== "hypothesis" || statement.id !== first.id)
  ) {
    return unavailable("The selections lie in different statements; select within one hypothesis.");
  }
  const entry = (target.value.kind === "goal" ? node.state.goals : node.state.obligations).find(
    ({ id }) => id === target.value.id,
  );
  if (!entry?.sequent.context.hypotheses.some(({ id }) => id === first.id)) {
    return unavailable("The selected hypothesis is not in the target's context.");
  }
  return { ok: true, value: { target: target.value, hypothesisId: first.id } };
}

export function investigateEnvelope(
  input: Readonly<{ commandId: string; nodeId: string; plan: HypothesisPlan }>,
): ProtocolCommandEnvelope {
  return envelope(input.commandId, input.nodeId, {
    kind: "investigate-hypothesis",
    nodeId: input.nodeId,
    target: { ...input.plan.target },
    hypothesis: input.plan.hypothesisId,
  });
}

// ---------------------------------------------------------------------------------------------
// Try this method
// ---------------------------------------------------------------------------------------------

export type TryMethodPlan = Readonly<{
  /** The command ID the preview was recorded under; applying reuses it. */
  commandId: string;
  suggestionSetId: string;
  suggestionId: string;
  name: string;
  menuChoices: MenuChoices;
}>;

/** "Try this method" applies the previewed library-result suggestion as "Try this theorem". */
export function tryMethodAvailability(
  suggestions: SuggestionState,
  move: MoveState,
): Availability<TryMethodPlan> {
  const hint = "Preview a library-result suggestion first; “Try this method” applies it.";
  if (suggestions.kind !== "ready" && suggestions.kind !== "empty") return unavailable(hint);
  if (move.kind !== "previewed") return unavailable(hint);
  const suggestion = suggestions.suggestionSet.suggestions.find(
    ({ id }) => id === move.suggestionId,
  );
  if (suggestion === undefined) {
    return unavailable("The previewed suggestion is not in the displayed suggestion set.");
  }
  if (suggestion.source !== "result") {
    return unavailable(
      `“${suggestion.name}” is an approved move, not a library result; only a result can be tried as a theorem.`,
    );
  }
  return {
    ok: true,
    value: {
      commandId: move.commandId,
      suggestionSetId: suggestions.suggestionSet.id,
      suggestionId: suggestion.id,
      name: suggestion.name,
      menuChoices: move.choices,
    },
  };
}

export function tryMethodEnvelope(
  input: Readonly<{ nodeId: string; plan: TryMethodPlan }>,
): ProtocolCommandEnvelope {
  const { plan } = input;
  return envelope(plan.commandId, input.nodeId, {
    kind: "apply",
    suggestion: plan.suggestionId,
    suggestionSetId: plan.suggestionSetId,
    ...(Object.keys(plan.menuChoices).length === 0 ? {} : { menuChoices: { ...plan.menuChoices } }),
    inquiryMethod: "try-result",
  });
}

// ---------------------------------------------------------------------------------------------
// Construct an object
// ---------------------------------------------------------------------------------------------

export { constructEnvelope, existentialBinder, type ConstructPlan } from "./construction-actions";

/**
 * A placeholder can be introduced for the existential goal or obligation that is selected. The
 * move, not this action, reads the goal: it handles bare and typed binders alike and says why it
 * cannot apply.
 */
export function constructAvailability(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
  operators: readonly OperatorDeclaration[],
): Availability<ConstructPlan> {
  const target = selectedTarget(node, selections);
  if (!target.ok) return target;
  return constructPlan(node, operators, target.value);
}

// ---------------------------------------------------------------------------------------------
// Find sufficient conditions
// ---------------------------------------------------------------------------------------------

export type ExploreReference =
  | Readonly<{ kind: "target"; nodeId: string; target: ToolbarTarget }>
  | Readonly<{
      kind: "statement";
      nodeId: string;
      target: ToolbarTarget;
      statement: InteractionSelection["anchor"]["statement"];
    }>
  | Readonly<{
      kind: "occurrence";
      nodeId: string;
      target: ToolbarTarget;
      statement: InteractionSelection["anchor"]["statement"];
      path: readonly number[];
    }>;

export type FindConditionsPlan = Readonly<{
  target: ToolbarTarget;
  reference: ExploreReference;
}>;

/** The selected object, by identity: one exact occurrence, else the target the selection is in. */
export function findConditionsAvailability(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
): Availability<FindConditionsPlan> {
  const target = selectedTarget(node, selections);
  if (!target.ok) return target;
  const [only] = selections;
  if (selections.length === 1 && only?.kind === "exact") {
    const { statement } = only.anchor;
    const reference: ExploreReference =
      only.path.length === 0
        ? { kind: "statement", nodeId: node.id, target: target.value, statement }
        : {
            kind: "occurrence",
            nodeId: node.id,
            target: target.value,
            statement,
            path: [...only.path],
          };
    return { ok: true, value: { target: target.value, reference } };
  }
  return {
    ok: true,
    value: {
      target: target.value,
      reference: { kind: "target", nodeId: node.id, target: target.value },
    },
  };
}

/**
 * An Explore question about the relationship between the selected object and conditions that
 * would suffice for it, with an elective objective on the selected target. It records no reason
 * and no sufficiency: finding conditions is a question, and "would suffice" needs evidence.
 */
export function findConditionsEnvelope(
  input: Readonly<{ commandId: string; nodeId: string; plan: FindConditionsPlan }>,
): ProtocolCommandEnvelope {
  const questionId = `${input.commandId}:question`;
  return envelope(input.commandId, input.nodeId, {
    kind: "record-inquiry",
    nodeId: input.nodeId,
    records: [
      {
        id: questionId,
        kind: "question",
        question: { form: "explore", objects: [input.plan.reference], aspect: "relationship" },
      },
      {
        id: `${input.commandId}:objective`,
        kind: "objective",
        questionId,
        necessity: "elective",
        focus: { nodeId: input.nodeId, target: { ...input.plan.target } },
      },
    ],
  });
}

// ---------------------------------------------------------------------------------------------
// Use this
// ---------------------------------------------------------------------------------------------

export type UseThisPlan = Readonly<{
  objectiveId: string;
  selections: readonly InteractionSelection[];
}>;

function interactionSelection(selection: AnchoredProofSelection): InteractionSelection {
  const anchor = {
    stateId: selection.anchor.stateId,
    target: { kind: selection.anchor.target.kind, id: selection.anchor.target.id },
    statement:
      selection.anchor.statement.kind === "conclusion"
        ? ({ kind: "conclusion" } as const)
        : ({ kind: "hypothesis", id: selection.anchor.statement.id } as const),
  };
  return selection.kind === "exact"
    ? ({ kind: "exact", anchor, path: [...selection.path] } as InteractionSelection)
    : ({
        kind: "associative",
        anchor,
        containerPath: [...selection.containerPath],
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
        ...(selection.displayRange === undefined
          ? {}
          : { displayRange: [...selection.displayRange] as [number, number] }),
      } as InteractionSelection);
}

/**
 * "Use this" records an attempt on the active objective, by a manual method, with the selected
 * objects. The N22 schema has no "used for" relation between mathematics and an objective, so an
 * attempt with selections is the faithful record: it says what was tried on what, and nothing
 * about whether it suffices.
 */
export function useThisAvailability(
  node: ProofNode,
  selections: readonly AnchoredProofSelection[],
  summary: InquirySummary | undefined,
): Availability<UseThisPlan> {
  if (summary === undefined) return unavailable("The inquiry records are not loaded yet.");
  if (summary.activeObjective === undefined) {
    return unavailable(
      "There is no active objective. Investigate a hypothesis or find sufficient conditions first.",
    );
  }
  const target = selectedTarget(node, selections);
  if (!target.ok) return target;
  return {
    ok: true,
    value: {
      objectiveId: summary.activeObjective.record.id,
      selections: selections.map(interactionSelection),
    },
  };
}

export function useThisEnvelope(
  input: Readonly<{ commandId: string; nodeId: string; plan: UseThisPlan }>,
): ProtocolCommandEnvelope {
  return envelope(input.commandId, input.nodeId, {
    kind: "record-inquiry",
    nodeId: input.nodeId,
    records: [
      {
        id: `${input.commandId}:attempt`,
        kind: "attempt",
        objectiveId: input.plan.objectiveId,
        method: { kind: "manual" },
        selections: input.plan.selections.map((selection) => structuredClone(selection)),
      },
    ],
  });
}
