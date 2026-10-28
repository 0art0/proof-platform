// Materializing a chosen displayed suggestion into a move preview request.

import {
  commandIdSchema,
  menuChoicesSchema,
  moveMenuSelectionSchema,
  parameterMenusSchema,
  suggestionAuthorizesMove,
  suggestionIdSchema,
  suggestionSetMatchesNode,
  suggestionSetIdSchema,
  RESULT_APPLICATION_MOVE_IDS,
  type ApplyKernelCommand,
  type DefinitionReference,
  type DisplayedSuggestionSet,
  type MovePreview,
  type MovePreviewId,
  type MoveMenuSelection,
  type ParameterMenuRecord,
  type ProofNode,
  type ProtocolEnvironment,
  type SuggestionSetId,
} from "@proof/protocol";
import {
  commandIdGenerator,
  materializeMoveOperation,
  materializeResultApplication,
  type MaterializationResult,
  type MoveMenuChoices,
  type MoveSelectionInput,
  type MoveSelections,
} from "@proof/moves";
import { runMovePlan } from "@proof/moves/authoring";
import { z } from "zod";
import { extendOperators, missingConstants } from "./session-constants";
import {
  APPROVED_DEFINITIONS,
  definitionHash,
  type DefinitionCatalog,
  type MacroDefinition,
} from "./approved-catalog";
import {
  proofSessionIdSchema,
  type ProofSessionId,
  type ProofStore,
} from "./proof-repository-store";
import {
  type RepositoryFailure,
  repositoryFailure,
  safeParse,
  transactionFailure,
} from "./proof-repository-core";
import {
  loadSession,
  loadNode,
  loadSuggestionSet,
  frozenEnvironment,
  deletedCommandFailure,
  derivedPreviewId,
} from "./proof-repository-records";

/**
 * The chosen move still needs menu choices. Nothing was recorded; the caller shows `menus` and
 * retries with item IDs for `missingParameters`.
 */
export type MoveRequiresInput = Readonly<{
  status: "requires-input";
  suggestionSetId: SuggestionSetId;
  chosenSuggestionId: z.infer<typeof suggestionIdSchema>;
  menus: readonly ParameterMenuRecord[];
  missingParameters: readonly string[];
  diagnostics: readonly [Readonly<{ code: "requires-input"; message: string }>];
}>;

export type MaterializeMoveChoiceResult =
  | Readonly<{ status: "materialized"; request: MaterializedMovePreviewRequest }>
  | MoveRequiresInput
  | RepositoryFailure;

export const moveChoiceSchema = z
  .object({
    commandId: commandIdSchema,
    suggestionSetId: suggestionSetIdSchema,
    chosenSuggestionId: suggestionIdSchema,
    /** Parameter ID → menu item ID; arbitrary expressions are never accepted. */
    menuChoices: menuChoicesSchema.optional(),
  })
  .strict();

export type MaterializedMovePreviewRequest = Readonly<{
  id: MovePreviewId;
  suggestionSetId: SuggestionSetId;
  chosenSuggestionId: z.infer<typeof suggestionIdSchema>;
  moveId: MovePreview["moveId"];
  operation: MovePreview["operation"];
  /** Present when the move displayed a choice menu or the caller chose menu items. */
  menuSelection?: MoveMenuSelection;
  /** Content hashes of the move and library definitions the materialization used. */
  definitions: readonly DefinitionReference[];
  /** Present for a multi-step macro suggestion: every concrete step (`operation` is the first). */
  macro?: Readonly<{
    steps: readonly Readonly<{
      id: string;
      moveId: MovePreview["moveId"];
      operation: MovePreview["operation"];
    }>[];
  }>;
}>;

/**
 * Resolve a persisted displayed choice, with its menu choices, to a trusted primitive request.
 * Generated IDs are derived from the command ID; every other parameter is a menu item regenerated
 * from the historical snapshot, so a stale or fabricated item ID is rejected. A choice that still
 * needs menu input returns the menus instead of a request.
 */
export async function materializeMoveChoice(
  store: ProofStore,
  sessionIdInput: unknown,
  choiceInput: unknown,
  definitions: DefinitionCatalog = APPROVED_DEFINITIONS,
): Promise<MaterializeMoveChoiceResult> {
  const sessionId = safeParse(proofSessionIdSchema, sessionIdInput) as ProofSessionId | undefined;
  const choice = safeParse(moveChoiceSchema, choiceInput);
  if (sessionId === undefined || choice === undefined) {
    return repositoryFailure(
      "rejected",
      "preview-rejected",
      "The session ID or persisted move choice is invalid.",
    );
  }

  try {
    return await store.transaction(async (transaction) => {
      const loadedSession = await loadSession(transaction, sessionId, definitions);
      if (!loadedSession.ok) return loadedSession.failure;
      const { session, environment } = loadedSession;
      const deleted = await deletedCommandFailure(transaction, session.id, choice.commandId);
      if (deleted !== undefined) return deleted;
      const previewId = derivedPreviewId(choice.commandId);
      const existingInput = await transaction.readPreview(session.id, previewId);

      const loadedSuggestionSet = await loadSuggestionSet(
        transaction,
        session,
        choice.suggestionSetId,
      );
      if (!loadedSuggestionSet.ok) return loadedSuggestionSet.failure;
      const suggestionSet = loadedSuggestionSet.suggestionSet;
      const chosen = suggestionSet.suggestions.find(
        (suggestion) => suggestion.id === choice.chosenSuggestionId,
      );
      if (chosen === undefined) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The chosen suggestion was not present in the persisted displayed suggestion set.",
        );
      }
      const loadedParentNode = await loadNode(
        transaction,
        session,
        environment,
        suggestionSet.nodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      if (!loadedParentNode.ok) return loadedParentNode.failure;
      if (
        !suggestionSetMatchesNode(suggestionSet, loadedParentNode.node, environment) ||
        (existingInput === undefined && session.currentNodeId !== loadedParentNode.node.id)
      ) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The displayed move suggestion is stale for the current proof node.",
        );
      }
      const chosenSuggestionId = safeParse(suggestionIdSchema, chosen.id) as
        z.infer<typeof suggestionIdSchema> | undefined;
      if (chosenSuggestionId === undefined) {
        return repositoryFailure(
          "rejected",
          "invalid-suggestion-set-record",
          "The chosen suggestion has an invalid persistent identity.",
        );
      }

      const menuChoices: MoveMenuChoices = choice.menuChoices ?? {};
      // A displayed library result that uses a library constant the session has not activated is
      // materialized in the operators extended with it; activating it waits for the applied step.
      const needed = missingConstants(
        definitions,
        session.operators,
        displayedResultIds(chosen, definitions),
      );
      const materializing =
        needed.length === 0
          ? environment
          : (frozenEnvironment(extendOperators(session.operators, needed), definitions) ??
            environment);
      const materialized = materializeSuggestion(
        loadedParentNode.node,
        suggestionSet,
        chosen,
        materializing,
        choice.commandId,
        menuChoices,
        definitions,
      );
      if (!materialized.ok) {
        if (materialized.requiresInput === undefined) return materialized.failure;
        return {
          status: "requires-input" as const,
          suggestionSetId: suggestionSet.id,
          chosenSuggestionId,
          ...materialized.requiresInput,
        };
      }
      const { moveId, result, references } = materialized;
      const menuSelection = recordedMenuSelection(result.menus, menuChoices);
      if (menuSelection === null) {
        return repositoryFailure(
          "rejected",
          "preview-rejected",
          "The displayed parameter menus failed runtime validation.",
        );
      }
      const request: MaterializedMovePreviewRequest = {
        id: previewId,
        suggestionSetId: suggestionSet.id,
        chosenSuggestionId,
        moveId: moveId as MovePreview["moveId"],
        operation: result.operation,
        ...(menuSelection === undefined ? {} : { menuSelection }),
        definitions: references,
        ...(materialized.macro === undefined ? {} : { macro: materialized.macro }),
      };
      // An existing preview for this command ID is compared by `recordMovePreview`, which
      // regenerates it when only the approved definitions behind it changed.
      return {
        status: "materialized" as const,
        request,
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The move choice could not be materialized.");
  }
}

/**
 * The library results a displayed suggestion applies: the result of a result suggestion, or the
 * results an approved macro's template requires.
 */
function displayedResultIds(
  suggestion: DisplayedSuggestionSet["suggestions"][number],
  definitions: DefinitionCatalog,
): readonly string[] {
  if (suggestion.source !== "move") return [suggestion.artifactId];
  const macro = definitions.macros?.find(({ move }) => move.id === suggestion.artifactId);
  return (macro?.template.requiredArtifacts ?? [])
    .filter(({ kind }) => kind === "result")
    .map(({ id }) => id);
}

type DisplayedSuggestion = DisplayedSuggestionSet["suggestions"][number];

type ResolvedSelection = DisplayedSuggestionSet["selection"] extends infer Selection
  ? Selection extends { kind: "selection-query"; selections: readonly (infer Subject)[] }
    ? Subject extends { selection: infer Item }
      ? Item
      : never
    : Selection
  : never;

type MaterializedSuggestion =
  | Readonly<{
      ok: true;
      moveId: string;
      result: Extract<MaterializationResult, { ok: true }>;
      references: readonly DefinitionReference[];
      /** For a macro suggestion: the concrete steps `runMovePlan` produced. */
      macro?: NonNullable<MaterializedMovePreviewRequest["macro"]>;
    }>
  | Readonly<{
      ok: false;
      requiresInput: Pick<MoveRequiresInput, "menus" | "missingParameters" | "diagnostics">;
    }>
  | Readonly<{ ok: false; requiresInput?: undefined; failure: RepositoryFailure }>;

/**
 * Materialize one displayed suggestion through the moves package. A move suggestion uses its
 * matched selections as move slots; a result suggestion is applied with its retrieval evidence
 * (result, pattern direction, substitutions and the matched occurrence).
 */
function materializeSuggestion(
  node: ProofNode,
  suggestionSet: DisplayedSuggestionSet,
  suggestion: DisplayedSuggestion,
  environment: ProtocolEnvironment,
  commandId: ApplyKernelCommand["commandId"],
  menuChoices: MoveMenuChoices,
  definitions: DefinitionCatalog,
): MaterializedSuggestion {
  const idGenerator = commandIdGenerator(commandId);
  const rejected = (message: string): MaterializedSuggestion => ({
    ok: false,
    failure: repositoryFailure("rejected", "preview-rejected", message),
  });

  let moveId: string | undefined;
  let result: MaterializationResult;
  const references: DefinitionReference[] = [];
  if (suggestion.source === "move") {
    const macro = definitions.macros?.find(({ move }) => move.id === suggestion.artifactId);
    const move =
      definitions.moves.find((definition) => definition.id === suggestion.artifactId) ??
      macro?.move;
    if (move === undefined) {
      return rejected(
        "The displayed move is not available in the approved deterministic move catalog.",
      );
    }
    const selections = displayedMoveSelections(suggestionSet, suggestion);
    if (selections === undefined) {
      return rejected("The displayed move's selection evidence is inconsistent.");
    }
    moveId = move.id;
    if (macro !== undefined) {
      return materializeMacroSuggestion(
        macro,
        node,
        selections,
        menuChoices,
        environment,
        commandId,
      );
    }
    references.push({ kind: "move", id: move.id, hash: definitionHash(move) });
    result = materializeMoveOperation({
      state: node.state,
      move,
      selections,
      menuChoices,
      idGenerator,
      env: environment,
    });
  } else {
    const libraryResult = definitions
      .catalog(environment.operators ?? [])
      .results.find(({ id }) => id === suggestion.artifactId);
    const pattern = libraryResult?.patterns.find(({ id }) => id === suggestion.patternId);
    const match =
      suggestion.selectionMatches.find(({ patternId }) => patternId === suggestion.patternId) ??
      suggestion.selectionMatches[0];
    const selection =
      match === undefined ? undefined : resolvedSelectionById(suggestionSet, match.selectionId);
    if (libraryResult === undefined || pattern === undefined || selection === undefined) {
      return rejected("The displayed result is not available in the approved library catalog.");
    }
    // The matched occurrence is used only when the result is a premise-free equivalence: the
    // suggestion is then a rewrite of that occurrence rather than an application to the target.
    result = materializeResultApplication(
      {
        state: node.state,
        resultId: libraryResult.id,
        direction: pattern.direction,
        target: selection.anchor.target,
        substitutions: suggestion.substitutions,
        occurrence: moveSelectionInput(selection),
        menuChoices,
      },
      environment,
      idGenerator,
    );
    references.push({
      kind: "library-result",
      id: libraryResult.id,
      hash: definitionHash(libraryResult),
    });
    if (result.ok) {
      const kind = result.operation.kind;
      const move = definitions.moves.find(
        (definition) =>
          RESULT_APPLICATION_MOVE_IDS.includes(definition.id) &&
          definition.implementation.operationKind === kind,
      );
      moveId = move?.id;
      if (move !== undefined) {
        references.push({ kind: "move", id: move.id, hash: definitionHash(move) });
      }
    }
  }

  if (!result.ok) {
    const diagnostic = result.diagnostics[0];
    if (diagnostic.code === "requires-input") {
      const menus = safeParse(parameterMenusSchema, result.menus);
      if (menus === undefined) {
        return rejected("The generated parameter menus failed runtime validation.");
      }
      return {
        ok: false,
        requiresInput: {
          menus,
          missingParameters: [...result.missingParameters],
          diagnostics: [{ code: "requires-input", message: diagnostic.message }],
        },
      };
    }
    return rejected(diagnostic.message);
  }
  if (moveId === undefined || !suggestionAuthorizesMove(suggestion, moveId, result.operation)) {
    return rejected("The materialized operation is not authorized by the displayed suggestion.");
  }
  // Definition references are ordered by kind, then ID ("library-result" < "move").
  references.sort((left, right) =>
    left.kind === right.kind
      ? left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0
      : left.kind < right.kind
        ? -1
        : 1,
  );
  return { ok: true, moveId, result, references };
}

/** The move selections a displayed move suggestion matched, by slot; undefined when inconsistent. */
export function displayedMoveSelections(
  suggestionSet: DisplayedSuggestionSet,
  suggestion: DisplayedSuggestion,
): MoveSelections | undefined {
  const selections: Record<string, MoveSelectionInput> = {};
  for (const match of suggestion.selectionMatches) {
    if (match.selectionSlotId === undefined) continue;
    const selection = resolvedSelectionById(suggestionSet, match.selectionId);
    if (selection === undefined || Object.hasOwn(selections, match.selectionSlotId)) {
      return undefined;
    }
    selections[match.selectionSlotId] = moveSelectionInput(selection);
  }
  return selections as MoveSelections;
}

/**
 * Materialize a macro suggestion: its first step from the displayed selections and menu choices,
 * every later step re-matched on the state the previous step left (`runMovePlan`, the same path
 * authoring validation uses). A step that fails to re-match fails the whole materialization and
 * names the step; nothing is applied.
 */
function materializeMacroSuggestion(
  macro: MacroDefinition,
  node: ProofNode,
  selections: MoveSelections,
  menuChoices: MoveMenuChoices,
  environment: ProtocolEnvironment,
  commandId: ApplyKernelCommand["commandId"],
): MaterializedSuggestion {
  const run = runMovePlan(
    macro.template,
    node.state,
    selections,
    menuChoices,
    environment,
    commandId,
  );
  if (!run.ok) {
    const { diagnostic } = run;
    if (diagnostic.code === "requires-input") {
      const menus = safeParse(parameterMenusSchema, diagnostic.menus ?? []);
      if (menus === undefined) {
        return {
          ok: false,
          failure: repositoryFailure(
            "rejected",
            "preview-rejected",
            "The generated parameter menus failed runtime validation.",
          ),
        };
      }
      return {
        ok: false,
        requiresInput: {
          menus,
          missingParameters: [...(diagnostic.missingParameters ?? [])],
          diagnostics: [{ code: "requires-input", message: diagnostic.message }],
        },
      };
    }
    const count = macro.template.plan.steps.length;
    const step = macro.template.plan.steps[diagnostic.stepIndex];
    return {
      ok: false,
      failure: repositoryFailure(
        "rejected",
        diagnostic.stepIndex === 0 ? "preview-rejected" : "macro-step-failed",
        `Macro step ${diagnostic.stepIndex + 1} of ${count}${
          step === undefined ? "" : ` (${step.id})`
        } could not be applied: ${diagnostic.message}`,
      ),
    };
  }
  const first = run.operations[0];
  if (first === undefined) {
    return {
      ok: false,
      failure: repositoryFailure("rejected", "preview-rejected", "The macro produced no steps."),
    };
  }
  return {
    ok: true,
    moveId: macro.move.id,
    result: { ok: true, operation: first, menus: run.menus, diagnostics: [] },
    references: [{ kind: "move", id: macro.move.id, hash: definitionHash(macro.template) }],
    macro: {
      steps: run.steps.map((step) => ({
        id: step.id,
        moveId: step.moveId as MovePreview["moveId"],
        operation: step.operation,
      })),
    },
  };
}

/**
 * The static-history record of the menus a materialization displayed and the item IDs chosen.
 * Moves whose only menus are automatic (generated IDs) and that received no choices record
 * nothing. Returns null when the menus fail the protocol schema.
 */
function recordedMenuSelection(
  menus: Extract<MaterializationResult, { ok: true }>["menus"],
  choices: MoveMenuChoices,
): MoveMenuSelection | undefined | null {
  if (Object.keys(choices).length === 0 && menus.every(({ automatic }) => automatic)) {
    return undefined;
  }
  return safeParse(moveMenuSelectionSchema, { menus, choices }) ?? null;
}

function moveSelectionInput(selection: ResolvedSelection): MoveSelectionInput {
  const anchor = {
    stateId: selection.anchor.stateId,
    target: selection.anchor.target,
    statement: selection.anchor.statement,
  };
  return selection.kind === "exact"
    ? { kind: "exact", anchor, path: [...selection.path] }
    : {
        kind: "associative",
        anchor,
        containerPath: [...selection.containerPath],
        startOperand: selection.startOperand,
        endOperand: selection.endOperand,
      };
}

function resolvedSelectionById(
  suggestionSet: DisplayedSuggestionSet,
  selectionId: string,
): ResolvedSelection | undefined {
  if (suggestionSet.selection.kind !== "selection-query") {
    return selectionId === "selection:primary"
      ? (suggestionSet.selection as ResolvedSelection)
      : undefined;
  }
  return suggestionSet.selection.selections.find(({ id }) => id === selectionId)?.selection as
    ResolvedSelection | undefined;
}
