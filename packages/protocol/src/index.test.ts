import { describe, expect, it } from "vitest";
import { CORE_LOGIC_RESULTS } from "@proof/library";
import {
  PROPOSITION_SORT,
  executableProofStateSchema,
  type ExecutableProofState,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { HAND_AUTHORED_MOVES } from "@proof/moves";
import { createRetrievalIndex, type RetrievalIndex } from "@proof/retrieval";
import {
  actorSchema,
  applyKernelCommandSchema,
  createPreparedProofCommandSchema,
  displayedSuggestionSetSchema,
  movePreviewSchema,
  prepareDisplayedSuggestionSet,
  prepareMovePreview,
  prepareProofCommand,
  proofNodeSchema,
  type Actor,
  type ApplyKernelCommand,
  type ProofNode,
} from "./index";

const declarations = ["p", "q"].map((symbol, index) => ({
  id: `declaration:${index}`,
  symbol,
  sort: PROPOSITION_SORT,
  role: "universal-parameter" as const,
}));

function sequent(conclusion: PlainMathJson) {
  return {
    context: { declarations, hypotheses: [] },
    conclusion: { expression: conclusion },
  };
}

function state(
  goal: PlainMathJson = "True",
  obligation: PlainMathJson | undefined = undefined,
): ExecutableProofState {
  return executableProofStateSchema.parse({
    id: "state:before",
    goals: [{ id: "goal:main", sequent: sequent(goal) }],
    obligations:
      obligation === undefined ? [] : [{ id: "obligation:main", sequent: sequent(obligation) }],
  });
}

function node(proofState: ExecutableProofState = state()): ProofNode {
  return proofNodeSchema.parse({ id: "node:before", state: proofState });
}

function replaceFirstConclusion(current: ProofNode, expression: PlainMathJson) {
  const first = current.state.goals[0]!;
  return {
    ...current,
    state: {
      ...current.state,
      goals: [
        {
          ...first,
          sequent: { ...first.sequent, conclusion: { expression } },
        },
        ...current.state.goals.slice(1),
      ],
    },
  };
}

const human = actorSchema.parse({ id: "actor:human", kind: "human" });
const agent = actorSchema.parse({ id: "actor:agent", kind: "agent" });

function exactSelection(proofState: ExecutableProofState = state()) {
  return {
    kind: "exact",
    anchor: {
      stateId: proofState.id,
      target: { kind: "goal", id: "goal:main" },
      statement: { kind: "conclusion" },
    },
    path: [],
  };
}

function retrievalIndex(): RetrievalIndex {
  const created = createRetrievalIndex({
    results: CORE_LOGIC_RESULTS,
    moves: HAND_AUTHORED_MOVES,
    variantFamilies: [],
  });
  if (!created.ok) throw new Error(created.diagnostics[0].message);
  return created.index;
}

function command(
  actor: Actor = human,
  operation: Record<string, unknown> = {
    kind: "close-true",
    expectedStateId: "state:before",
    resultStateId: "state:after",
    target: { kind: "goal", id: "goal:main" },
  },
  overrides: Record<string, unknown> = {},
): ApplyKernelCommand {
  return applyKernelCommandSchema.parse({
    commandId: "command:one",
    kind: "apply-kernel-operation",
    actor,
    parentNodeId: "node:before",
    resultNodeId: "node:after",
    edgeId: "edge:one",
    eventId: "event:one",
    operation,
    ...overrides,
  });
}

describe("proof command preparation", () => {
  it("records the exact deterministic suggestion list as frozen snapshot evidence", () => {
    const baseIndex = retrievalIndex();
    let queryCount = 0;
    const countingIndex: RetrievalIndex = {
      resultCount: baseIndex.resultCount,
      moveCount: baseIndex.moveCount,
      patternCount: baseIndex.patternCount,
      query(...args) {
        queryCount += 1;
        return baseIndex.query(...args);
      },
    };
    const result = prepareDisplayedSuggestionSet(countingIndex, node(), {
      id: "suggestion-set:one",
      selection: exactSelection(),
      options: { limit: 100 },
    });

    expect(result).toMatchObject({
      ok: true,
      suggestionSet: {
        id: "suggestion-set:one",
        nodeId: "node:before",
        stateId: "state:before",
        selection: { fragment: "True" },
      },
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(
      result.suggestionSet.suggestions.some(({ artifactId }) => artifactId === "move:close-true"),
    ).toBe(true);
    expect(
      result.suggestionSet.suggestions.every(
        ({ rank, reasons }) => rank.length > 0 && reasons.length > 0,
      ),
    ).toBe(true);
    expect(Object.isFrozen(result.suggestionSet)).toBe(true);
    expect(Object.isFrozen(result.suggestionSet.suggestions)).toBe(true);

    const recorded = structuredClone(result.suggestionSet);
    expect(displayedSuggestionSetSchema.safeParse(recorded).success).toBe(true);
    expect(queryCount).toBe(1);
    expect(recorded).toEqual(result.suggestionSet);
  });

  it("records and re-resolves an associative selection lens as static suggestion evidence", () => {
    const proofState = state(["And", "p", "q", "p"]);
    const result = prepareDisplayedSuggestionSet(retrievalIndex(), node(proofState), {
      id: "suggestion-set:virtual",
      selection: {
        kind: "associative",
        anchor: {
          stateId: "state:before",
          target: { kind: "goal", id: "goal:main" },
          statement: { kind: "conclusion" },
        },
        containerPath: [],
        startOperand: 1,
        endOperand: 3,
        displayRange: [5, 12],
      },
      options: { limit: 100 },
    });

    expect(result).toMatchObject({
      ok: true,
      suggestionSet: {
        selection: {
          kind: "associative",
          operator: "And",
          container: ["And", "p", "q", "p"],
          coveredOperandPaths: [[1], [2]],
          fragment: ["And", "q", "p"],
          displayRange: [5, 12],
        },
      },
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    const forgedLens = {
      ...result.suggestionSet,
      selection: {
        ...result.suggestionSet.selection,
        coveredOperandPaths: [[0], [2]],
      },
    };
    expect(displayedSuggestionSetSchema.safeParse(forgedLens).success).toBe(false);
  });

  it("records multiselection slot assignments and rejects forged occurrence mappings", () => {
    const proofState = executableProofStateSchema.parse({
      id: "state:before",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations,
              hypotheses: [{ id: "hypothesis:p", statement: { expression: "p" } }],
            },
            conclusion: { expression: "p" },
          },
        },
      ],
      obligations: [],
    });
    const result = prepareDisplayedSuggestionSet(retrievalIndex(), node(proofState), {
      id: "suggestion-set:multiple",
      selection: {
        kind: "selection-query",
        selections: [
          { id: "selection:target", selection: exactSelection(proofState) },
          {
            id: "selection:fact",
            selection: {
              kind: "exact",
              anchor: {
                stateId: proofState.id,
                target: { kind: "goal", id: "goal:main" },
                statement: { kind: "hypothesis", id: "hypothesis:p" },
              },
              path: [],
            },
          },
        ],
      },
      options: { limit: 100 },
    });

    expect(result).toMatchObject({
      ok: true,
      suggestionSet: {
        selection: {
          kind: "selection-query",
          selections: [
            { id: "selection:target", selection: { fragment: "p" } },
            { id: "selection:fact", selection: { fragment: "p" } },
          ],
        },
      },
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    const close = result.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-by-hypothesis",
    );
    if (close === undefined) throw new Error("Expected a close-by-hypothesis suggestion.");
    expect(close.selectionMatches).toEqual([
      { selectionId: "selection:fact", selectionSlotId: "fact" },
      {
        selectionId: "selection:target",
        selectionSlotId: "target",
        patternId: "move-pattern:close-by-hypothesis",
      },
    ]);
    const forged = {
      ...result.suggestionSet,
      suggestions: result.suggestionSet.suggestions.map((suggestion) =>
        suggestion.id === close.id
          ? {
              ...suggestion,
              selectionMatches: suggestion.selectionMatches.map((match, index) =>
                index === 0 ? { ...match, selectionId: "selection:missing" } : match,
              ),
            }
          : suggestion,
      ),
    };
    expect(displayedSuggestionSetSchema.safeParse(forged).success).toBe(false);
  });

  it("stores query-only abstraction separately and re-resolves its concrete snapshot", () => {
    const proofState = state(["And", "p", "q"]);
    const wildcard = {
      id: "wildcard:any-proposition",
      symbol: "_proposition",
      role: "retrieval-wildcard",
      sort: PROPOSITION_SORT,
    } as const;
    const result = prepareDisplayedSuggestionSet(retrievalIndex(), node(proofState), {
      id: "suggestion-set:abstracted",
      selection: {
        kind: "selection-query",
        selections: [
          {
            id: "selection:abstracted",
            selection: exactSelection(proofState),
            abstraction: wildcard,
          },
        ],
      },
      options: { limit: 100 },
    });

    expect(result).toMatchObject({
      ok: true,
      suggestionSet: {
        selection: {
          kind: "selection-query",
          selections: [
            {
              selection: { fragment: ["And", "p", "q"] },
              abstraction: wildcard,
            },
          ],
        },
      },
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);
    expect(
      result.suggestionSet.suggestions.every(
        ({ exactRepresentationMatch, applicability }) =>
          !exactRepresentationMatch && applicability === "requires-input",
      ),
    ).toBe(true);

    const selected = result.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:split-goal-conjunction",
    );
    if (selected === undefined) throw new Error("Expected an abstracted split suggestion.");
    const forgedApplicability = {
      ...result.suggestionSet,
      suggestions: result.suggestionSet.suggestions.map((suggestion) =>
        suggestion.id === selected.id
          ? {
              ...suggestion,
              exactRepresentationMatch: true,
              unresolvedSelectionSlots: [],
              unresolvedParameters: [],
              applicability: "applicable",
              abstractionFit: "not-used",
            }
          : suggestion,
      ),
    };
    expect(displayedSuggestionSetSchema.safeParse(forgedApplicability).success).toBe(false);

    if (result.suggestionSet.selection.kind !== "selection-query") {
      throw new Error("Expected a resolved selection query.");
    }
    const forgedSelection = {
      ...result.suggestionSet,
      selection: {
        ...result.suggestionSet.selection,
        selections: result.suggestionSet.selection.selections.map((subject, index) =>
          index === 0
            ? {
                ...subject,
                selection: { ...subject.selection, fragment: ["Or", "p", "q"] },
              }
            : subject,
        ),
      },
    };
    expect(displayedSuggestionSetSchema.safeParse(forgedSelection).success).toBe(true);
    expect(
      prepareMovePreview(node(proofState), forgedSelection, {
        id: "preview:forged-query",
        suggestionSetId: forgedSelection.id,
        chosenSuggestionId: selected.id,
        moveId: "move:split-goal-conjunction",
        operation: {
          kind: "split-goal-conjunction",
          expectedStateId: "state:before",
          resultStateId: "state:after",
          target: { kind: "goal", id: "goal:main" },
          childIds: ["goal:left", "goal:right"],
        },
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "preview-rejected" }] });
  });

  it("links a chosen displayed move through the command, edge, and event", () => {
    const suggestions = prepareDisplayedSuggestionSet(retrievalIndex(), node(), {
      id: "suggestion-set:one",
      selection: exactSelection(),
      options: { limit: 100 },
    });
    if (!suggestions.ok) throw new Error(suggestions.diagnostics[0].message);
    const chosen = suggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-true",
    );
    if (chosen === undefined) throw new Error("Expected close-true to be displayed.");
    const selectedCommand = command(human, undefined, {
      moveId: "move:close-true",
      suggestionSetId: suggestions.suggestionSet.id,
      chosenSuggestionId: chosen.id,
    });

    const result = prepareProofCommand(node(), selectedCommand, {
      trustedActor: human,
      suggestionSet: suggestions.suggestionSet,
    });
    expect(result).toMatchObject({
      ok: true,
      prepared: {
        edge: {
          suggestionSetId: "suggestion-set:one",
          chosenSuggestionId: chosen.id,
        },
        event: {
          suggestionSetId: "suggestion-set:one",
          chosenSuggestionId: chosen.id,
        },
      },
    });
    if (!result.ok) throw new Error(result.diagnostics[0].message);

    const retry = prepareProofCommand(result.prepared.node, selectedCommand, {
      trustedActor: human,
      previous: result,
      suggestionSet: suggestions.suggestionSet,
    });
    expect(retry).toBe(result);
  });

  it("records and revalidates a concrete move preview before command execution", () => {
    const current = node();
    const suggestions = prepareDisplayedSuggestionSet(retrievalIndex(), current, {
      id: "suggestion-set:one",
      selection: exactSelection(),
      options: { limit: 100 },
    });
    if (!suggestions.ok) throw new Error(suggestions.diagnostics[0].message);
    const chosen = suggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-true",
    );
    if (chosen === undefined) throw new Error("Expected close-true to be displayed.");
    const preview = prepareMovePreview(current, suggestions.suggestionSet, {
      id: "preview:one",
      suggestionSetId: suggestions.suggestionSet.id,
      chosenSuggestionId: chosen.id,
      moveId: "move:close-true",
      operation: command().operation,
    });

    expect(preview).toMatchObject({
      ok: true,
      preview: {
        id: "preview:one",
        nodeId: "node:before",
        stateId: "state:before",
        transitionClass: "equivalence",
        afterState: { id: "state:after", goals: [] },
        delta: { goals: { added: [], removed: ["goal:main"], updated: [] } },
      },
    });
    if (!preview.ok) throw new Error(preview.diagnostics[0].message);
    expect(Object.isFrozen(preview.preview)).toBe(true);
    const previewedCommand = command(human, undefined, {
      moveId: "move:close-true",
      suggestionSetId: suggestions.suggestionSet.id,
      chosenSuggestionId: chosen.id,
      previewId: preview.preview.id,
    });
    const applied = prepareProofCommand(current, previewedCommand, {
      trustedActor: human,
      suggestionSet: suggestions.suggestionSet,
      preview: preview.preview,
    });
    expect(applied).toMatchObject({
      ok: true,
      prepared: {
        edge: { previewId: "preview:one" },
        event: { previewId: "preview:one" },
      },
    });
    if (!applied.ok) throw new Error(applied.diagnostics[0].message);
    expect(
      prepareProofCommand(applied.prepared.node, previewedCommand, {
        trustedActor: human,
        suggestionSet: suggestions.suggestionSet,
        preview: preview.preview,
        previous: applied,
      }),
    ).toBe(applied);

    const forged = { ...preview.preview, transitionClass: "weakening" as const };
    expect(movePreviewSchema.safeParse(forged).success).toBe(true);
    expect(
      prepareProofCommand(current, previewedCommand, {
        trustedActor: human,
        suggestionSet: suggestions.suggestionSet,
        preview: forged,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "preview-rejected" }] });
  });

  it("rejects missing, mismatched, and stale suggestion evidence", () => {
    const suggestions = prepareDisplayedSuggestionSet(retrievalIndex(), node(), {
      id: "suggestion-set:one",
      selection: exactSelection(),
      options: { limit: 100 },
    });
    if (!suggestions.ok) throw new Error(suggestions.diagnostics[0].message);
    const chosen = suggestions.suggestionSet.suggestions.find(
      ({ artifactId }) => artifactId === "move:close-true",
    );
    if (chosen === undefined) throw new Error("Expected close-true to be displayed.");
    const selectedCommand = command(human, undefined, {
      moveId: "move:close-true",
      suggestionSetId: suggestions.suggestionSet.id,
      chosenSuggestionId: chosen.id,
    });

    expect(prepareProofCommand(node(), selectedCommand, { trustedActor: human })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "suggestion-evidence-invalid" }],
    });
    expect(
      prepareProofCommand(
        node(),
        { ...selectedCommand, chosenSuggestionId: "suggestion:not-displayed" },
        { trustedActor: human, suggestionSet: suggestions.suggestionSet },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "suggestion-evidence-invalid" }],
    });
    expect(
      prepareProofCommand(node(), selectedCommand, {
        trustedActor: human,
        suggestionSet: { ...suggestions.suggestionSet, nodeId: "node:stale" },
      }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "suggestion-evidence-invalid" }],
    });
  });

  it("rejects malformed static rank order and hostile suggestion inputs without throwing", () => {
    const suggestions = prepareDisplayedSuggestionSet(retrievalIndex(), node(), {
      id: "suggestion-set:one",
      selection: exactSelection(),
      options: { limit: 100 },
    });
    if (!suggestions.ok) throw new Error(suggestions.diagnostics[0].message);
    const first = suggestions.suggestionSet.suggestions[0];
    if (first === undefined) throw new Error("Expected at least one displayed suggestion.");
    const misordered = {
      ...suggestions.suggestionSet,
      suggestions: [
        { ...first, id: "suggestion:lower-rank", rank: [0] },
        { ...first, id: "suggestion:higher-rank", rank: [1] },
      ],
    };
    expect(displayedSuggestionSetSchema.safeParse(misordered).success).toBe(false);

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile suggestion request");
        },
      },
    );
    expect(() => prepareDisplayedSuggestionSet(retrievalIndex(), node(), hostile)).not.toThrow();
    expect(prepareDisplayedSuggestionSet(retrievalIndex(), node(), hostile)).toMatchObject({
      ok: false,
    });
  });

  it.each([human, agent])("gives human and agent actors the same command path", (actor) => {
    const result = prepareProofCommand(node(), command(actor), { trustedActor: actor });

    expect(result).toMatchObject({
      ok: true,
      prepared: {
        node: { id: "node:after", state: { id: "state:after", goals: [] } },
        edge: {
          id: "edge:one",
          parentNodeId: "node:before",
          childNodeId: "node:after",
          transitionClass: "equivalence",
        },
        event: {
          actor,
          beforeState: { id: "state:before", goals: [{ id: "goal:main" }] },
          afterState: { id: "state:after", goals: [] },
        },
      },
      receipt: {
        commandId: "command:one",
        nodeId: "node:after",
        resultStateId: "state:after",
      },
    });
  });

  it("rejects forged actor provenance before applying a command", () => {
    const result = prepareProofCommand(node(), command(agent), { trustedActor: human });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "actor-mismatch" }] });
    expect(result).not.toHaveProperty("prepared");
    expect(result).not.toHaveProperty("receipt");
  });

  it("rejects stale parent nodes and stale kernel state IDs without records", () => {
    const wrongParent = prepareProofCommand(
      node(),
      command(human, undefined, { parentNodeId: "node:stale" }),
      { trustedActor: human },
    );
    expect(wrongParent).toMatchObject({
      ok: false,
      diagnostics: [{ code: "stale-parent" }],
    });

    const staleState = prepareProofCommand(
      node(),
      command(human, {
        kind: "close-true",
        expectedStateId: "state:stale",
        resultStateId: "state:after",
        target: { kind: "goal", id: "goal:main" },
      }),
      { trustedActor: human },
    );
    expect(staleState).toMatchObject({
      ok: false,
      diagnostics: [{ code: "kernel-rejected", message: expect.stringContaining("stale-state") }],
    });
    expect(staleState).not.toHaveProperty("prepared");
  });

  it("records the kernel-derived strengthening class and an updated goal", () => {
    const current = node(state(["Or", "p", "q"]));
    const result = prepareProofCommand(
      current,
      command(human, {
        kind: "choose-goal-disjunct",
        expectedStateId: "state:before",
        resultStateId: "state:after",
        target: { kind: "goal", id: "goal:main" },
        disjunctIndex: 1,
      }),
      { trustedActor: human },
    );
    expect(result).toMatchObject({
      ok: true,
      prepared: {
        node: { state: { goals: [{ sequent: { conclusion: { expression: "q" } } }] } },
        edge: { transitionClass: "strengthening" },
        event: {
          transitionClass: "strengthening",
          delta: {
            goals: { added: [], removed: [], updated: ["goal:main"] },
            obligations: { added: [], removed: [], updated: [] },
          },
        },
      },
      receipt: { transitionClass: "strengthening" },
    });
  });

  it("validates and records selected move provenance on the same command path", () => {
    const current = node(state(["Or", "p", "q"]));
    const moveCommand = command(
      human,
      {
        kind: "choose-goal-disjunct",
        expectedStateId: "state:before",
        resultStateId: "state:after",
        target: { kind: "goal", id: "goal:main" },
        disjunctIndex: 0,
      },
      { moveId: "move:choose-goal-disjunct" },
    );
    const result = prepareProofCommand(current, moveCommand, { trustedActor: human });

    expect(result).toMatchObject({
      ok: true,
      prepared: {
        command: { moveId: "move:choose-goal-disjunct" },
        edge: { moveId: "move:choose-goal-disjunct", transitionClass: "strengthening" },
        event: { moveId: "move:choose-goal-disjunct", transitionClass: "strengthening" },
      },
    });
    if (!result.ok) throw new Error("Expected move command preparation to succeed.");
    const malformed = {
      ...result.prepared,
      event: { ...result.prepared.event, moveId: "move:close-true" },
    };
    expect(createPreparedProofCommandSchema().safeParse(malformed).success).toBe(false);
  });

  it("rejects move provenance whose definition does not match the supplied primitive", () => {
    const result = prepareProofCommand(
      node(),
      command(human, undefined, { moveId: "move:introduce-negation" }),
      { trustedActor: human },
    );
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "move-rejected" }] });
  });

  it("re-verifies stored move provenance instead of trusting structurally linked evidence", () => {
    const valid = prepareProofCommand(
      node(),
      command(human, undefined, { moveId: "move:close-true" }),
      { trustedActor: human },
    );
    if (!valid.ok) throw new Error("Expected move preparation to succeed.");
    const forged = {
      ...valid,
      prepared: {
        ...valid.prepared,
        command: { ...valid.prepared.command, moveId: "move:introduce-negation" },
        edge: { ...valid.prepared.edge, moveId: "move:introduce-negation" },
        event: { ...valid.prepared.event, moveId: "move:introduce-negation" },
      },
    };
    expect(createPreparedProofCommandSchema().safeParse(forged.prepared).success).toBe(true);
    expect(
      prepareProofCommand(forged.prepared.node, forged.prepared.command, {
        trustedActor: human,
        previous: forged,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-prepared-record" }] });
  });

  it("computes removals independently for goals and obligations", () => {
    const current = node(state("True", "True"));
    const goalResult = prepareProofCommand(current, command(), { trustedActor: human });
    expect(goalResult).toMatchObject({
      ok: true,
      prepared: {
        event: {
          delta: {
            goals: { added: [], removed: ["goal:main"], updated: [] },
            obligations: { added: [], removed: [], updated: [] },
          },
        },
      },
    });

    const obligationResult = prepareProofCommand(
      current,
      command(human, {
        kind: "close-true",
        expectedStateId: "state:before",
        resultStateId: "state:after",
        target: { kind: "obligation", id: "obligation:main" },
      }),
      { trustedActor: human },
    );
    expect(obligationResult).toMatchObject({
      ok: true,
      prepared: {
        event: {
          delta: {
            goals: { added: [], removed: [], updated: [] },
            obligations: { added: [], removed: ["obligation:main"], updated: [] },
          },
        },
      },
    });
  });

  it("keeps exact static metadata evidence and deeply detaches and freezes records", () => {
    const truth: PlainMathJson = { sym: "True", comment: "original source" };
    const current = node(state(truth));
    const result = prepareProofCommand(current, command(), { trustedActor: human });
    if (!result.ok) throw new Error("Expected command preparation to succeed.");

    expect(result.prepared.event.beforeState.goals[0]?.sequent.conclusion.expression).toEqual(
      truth,
    );
    expect(result.prepared.event.beforeState).not.toBe(current.state);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.prepared)).toBe(true);
    expect(Object.isFrozen(result.prepared.event.beforeState.goals[0]?.sequent.conclusion)).toBe(
      true,
    );
    truth.comment = "mutated caller value";
    expect(result.prepared.event.beforeState.goals[0]?.sequent.conclusion.expression).toEqual({
      sym: "True",
      comment: "original source",
    });
  });

  it("returns an identical recorded success before stale checks on retry", () => {
    const first = prepareProofCommand(node(), command(), { trustedActor: human });
    if (!first.ok) throw new Error("Expected initial preparation to succeed.");

    const retry = prepareProofCommand(first.prepared.node, command(), {
      trustedActor: human,
      previous: first,
    });
    expect(retry).toBe(first);
  });

  it("rejects a changed validated command that reuses a command ID", () => {
    const first = prepareProofCommand(node(), command(), { trustedActor: human });
    if (!first.ok) throw new Error("Expected initial preparation to succeed.");
    const changed = command(human, undefined, { edgeId: "edge:different" });

    expect(
      prepareProofCommand(first.prepared.node, changed, {
        trustedActor: human,
        previous: first,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "command-id-conflict" }] });
  });

  it("rejects malformed prior cross-links instead of replaying them", () => {
    const first = prepareProofCommand(node(), command(), { trustedActor: human });
    if (!first.ok) throw new Error("Expected initial preparation to succeed.");
    const malformed = structuredClone(first);
    malformed.prepared.edge.childNodeId =
      "node:wrong" as typeof malformed.prepared.edge.childNodeId;

    expect(createPreparedProofCommandSchema().safeParse(malformed.prepared).success).toBe(false);
    expect(
      prepareProofCommand(first.prepared.node, command(), {
        trustedActor: human,
        previous: malformed,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-prepared-record" }] });
  });

  it("re-verifies imported retry evidence with the kernel", () => {
    const first = prepareProofCommand(node(), command(), { trustedActor: human });
    if (!first.ok) throw new Error("Expected initial preparation to succeed.");

    const falseParent = replaceFirstConclusion(first.prepared.parent, "False");
    const forgedState = {
      ...first,
      prepared: {
        ...first.prepared,
        parent: falseParent,
        event: { ...first.prepared.event, beforeState: falseParent.state },
      },
    };
    expect(createPreparedProofCommandSchema().safeParse(forgedState.prepared).success).toBe(true);
    expect(
      prepareProofCommand(forgedState.prepared.parent, command(), {
        trustedActor: human,
        previous: forgedState,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-prepared-record" }] });

    const forgedClass = {
      ...first,
      prepared: {
        ...first.prepared,
        edge: { ...first.prepared.edge, transitionClass: "weakening" as const },
        event: { ...first.prepared.event, transitionClass: "weakening" as const },
      },
      receipt: { ...first.receipt, transitionClass: "weakening" as const },
    };
    expect(
      prepareProofCommand(first.prepared.node, command(), {
        trustedActor: human,
        previous: forgedClass,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-prepared-record" }] });
  });

  it("rejects current nodes that contradict recorded evidence with the same identity", () => {
    const first = prepareProofCommand(node(), command(), { trustedActor: human });
    if (!first.ok) throw new Error("Expected initial preparation to succeed.");
    const contradictory = replaceFirstConclusion(first.prepared.parent, "False");

    expect(
      prepareProofCommand(contradictory, command(), {
        trustedActor: human,
        previous: first,
      }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-current-node" }] });
  });

  it("turns unknown and hostile kernel operations into command validation failures", () => {
    const unknownKind = { ...command(), operation: { kind: "invent-proof" } };
    expect(prepareProofCommand(node(), unknownKind, { trustedActor: human })).toMatchObject({
      ok: false,
      diagnostics: [{ code: "invalid-command" }],
    });

    const hostileOperation = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("do not inspect me unsafely");
        },
      },
    );
    expect(
      prepareProofCommand(
        node(),
        { ...command(), operation: hostileOperation },
        {
          trustedActor: human,
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-command" }] });

    const validOperation = command().operation;
    let prototypeReads = 0;
    const delayed = new Proxy(validOperation, {
      getPrototypeOf(target) {
        prototypeReads += 1;
        if (prototypeReads > 2) throw new Error("late operation proxy");
        return Reflect.getPrototypeOf(target);
      },
    });
    let delayedResult: ReturnType<typeof prepareProofCommand> | undefined;
    expect(() => {
      delayedResult = prepareProofCommand(
        node(),
        { ...command(), operation: delayed },
        { trustedActor: human },
      );
    }).not.toThrow();
    expect(delayedResult).toMatchObject({ ok: true });
  });

  it("rejects invalid current nodes and strict command extensions", () => {
    expect(
      prepareProofCommand({ ...node(), extra: true }, command(), { trustedActor: human }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-current-node" }] });
    expect(
      prepareProofCommand(
        node(),
        { ...command(), privilege: "bypass-kernel" },
        {
          trustedActor: human,
        },
      ),
    ).toMatchObject({ ok: false, diagnostics: [{ code: "invalid-command" }] });
  });
});
