import { describe, expect, it } from "vitest";
import { validateMoveTemplate } from "@proof/moves/authoring";
import type { AnchoredProofSelection } from "@proof/selections";
import { deriveRecordedPath, pathEdges, pathsWithMoves } from "./recorded-paths";
import { fixtureHistory, nodeById } from "./history-fixture.testing";
import {
  addNegativeExample,
  addPositiveExample,
  assembleTemplate,
  changeFirstPrimitive,
  composedClass,
  draftFromPath,
  draftFromPrimitive,
  draftFromTemplate,
  exampleViews,
  moveIdOf,
  negativeCount,
  parseDraft,
  patternViews,
  planView,
  positiveCount,
  primitiveOptions,
  removeExample,
  removeLastStep,
  removePattern,
  selectedFragment,
  setDeclaredClass,
  setSlotPattern,
  setSlotRequired,
  slotViews,
  suggestIdSuffix,
  toggleArtifact,
  type TemplateDraft,
} from "./template-builder";

const history = fixtureHistory();
const operators = [] as const;
const INTRODUCE = "edge:command:contraposition-1";

function derivedPath(fromNodeId: string, toNodeId: string) {
  const path = pathEdges(history.edges, fromNodeId, toNodeId);
  if (path === undefined) throw new Error("no such path");
  return deriveRecordedPath({
    nodes: history.nodes,
    path,
    suggestionSets: history.suggestionSets,
    operators,
  });
}

function introduceDraft(): TemplateDraft {
  const derived = derivedPath("node:contraposition-root", "node:command:contraposition-1");
  if (!derived.ok) throw new Error(derived.message);
  const built = draftFromPath(derived.path, "Introduce an implication", "Assume the antecedent.");
  if (!built.ok) throw new Error(built.message);
  return { ...built.draft, idSuffix: suggestIdSuffix("Introduce an implication") };
}

const goalSelection = (stateId: string): AnchoredProofSelection => ({
  kind: "exact",
  anchor: {
    stateId,
    target: { kind: "goal", id: "goal:main" },
    statement: { kind: "conclusion" },
  } as AnchoredProofSelection["anchor"],
  path: [],
});

describe("recorded paths", () => {
  it("derives a step from the stored edge, snapshots and suggestion set", () => {
    const derived = derivedPath("node:contraposition-root", "node:command:contraposition-1");
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.path.steps.map(({ moveId }) => moveId)).toEqual(["move:introduce-implication"]);
    expect(derived.path.startNode.id).toBe("node:contraposition-root");
    expect(derived.path.endNode.id).toBe("node:command:contraposition-1");
  });

  it("refuses a library-result step and a step that was not applied from a suggestion", () => {
    const result = derivedPath("node:command:contraposition-1", "node:command:contraposition-2");
    expect(result).toMatchObject({ ok: false, stepIndex: 0 });
    expect(!result.ok && result.message).toMatch(/Step 1 .*applies a library result/);

    const direct = derivedPath("node:contraposition-root", "node:command:cases-on-p");
    expect(direct.ok).toBe(false);
    expect(!direct.ok && direct.message).toMatch(/not applied from a displayed suggestion/);
  });

  it("finds every recorded path that applies the plan's moves", () => {
    const paths = pathsWithMoves(history.edges, ["move:introduce-implication"]);
    expect(paths.map(([only]) => only?.edge.id)).toEqual([
      INTRODUCE,
      "edge:command:replay-first:replay:1",
    ]);
    expect(pathsWithMoves(history.edges, ["move:close-by-hypothesis", "move:mark-sorry"])).toEqual(
      [],
    );
    expect(pathsWithMoves(history.edges, [])).toEqual([]);
  });
});

describe("the template draft", () => {
  it("starts a single-step move from a recorded step as a general move", () => {
    const draft = introduceDraft();
    expect(planView(draft)).toEqual([
      expect.objectContaining({
        index: 0,
        moveId: "move:introduce-implication",
        operationKind: "introduce-implication",
        transitionClass: "equivalence",
        recorded: false,
      }),
    ]);
    // The recorded selections are not preconditions of a single-step move.
    expect(draft.body.plan.steps[0]).not.toHaveProperty("selections");
    expect(patternViews(draft)).toEqual([
      expect.objectContaining({ slotId: "target", text: "Implies(Not(q), Not(p))" }),
    ]);
    expect(slotViews(draft)[0]).toMatchObject({ id: "target", required: true, locked: true });
    expect(draft.body.transitionClass).toBe("equivalence");
    expect(moveIdOf(draft)).toBe("authored:introduce-an-implication");
  });

  it("is well formed once it has a name, an ID and a description", () => {
    const draft = introduceDraft();
    expect(parseDraft(draft).ok).toBe(true);
    const nameless = parseDraft({ ...draft, name: "", idSuffix: "" });
    expect(nameless.ok).toBe(false);
    expect(!nameless.ok && nameless.problems.length).toBeGreaterThan(0);
  });

  it("derives a macro's later steps as recordings", () => {
    const derived = derivedPath("node:contraposition-root", "node:command:contraposition-1");
    if (!derived.ok) throw new Error(derived.message);
    const [step] = derived.path.steps;
    const built = draftFromPath({ ...derived.path, steps: [step!, step!] }, "Twice", "Twice.");
    if (!built.ok) throw new Error(built.message);
    expect(planView(built.draft).map(({ recorded }) => recorded)).toEqual([true, true]);
    expect(built.draft.body.plan.steps[0]).toHaveProperty("selections");
    expect(planView(removeLastStep(built.draft))).toHaveLength(1);
    // A plan keeps at least one step.
    expect(planView(removeLastStep(removeLastStep(built.draft)))).toHaveLength(1);
  });

  it("starts from a primitive with its own contract, parameters and patterns", () => {
    expect(primitiveOptions().map(({ moveId }) => moveId)).not.toContain(
      "move:apply-result-forward",
    );
    const draft = draftFromPrimitive("move:split-goal-conjunction");
    expect(draft?.body.plan.steps).toHaveLength(1);
    expect(draft?.body.examples).toEqual([]);
    expect(draftFromPrimitive("move:not-a-primitive")).toBeUndefined();
    const changed = changeFirstPrimitive(introduceDraft(), "move:split-goal-conjunction");
    expect(planView(changed)[0]?.moveId).toBe("move:split-goal-conjunction");
    expect(patternViews(changed)[0]?.text).toBe("And(p, q)");
    expect(changed.name).toBe("Introduce an implication");
  });

  it("takes a pattern from a selection in a stored snapshot", () => {
    const node = nodeById(history.nodes, "node:command:contraposition-1");
    const fragment = selectedFragment(node, [goalSelection(node.state.id)], operators);
    expect(fragment).toEqual({ ok: true, expression: ["Not", "p"] });
    if (!fragment.ok) return;
    const draft = setSlotPattern(introduceDraft(), "target", fragment.expression);
    expect(patternViews(draft)).toEqual([
      expect.objectContaining({ id: "pattern:target", slotId: "target", text: "Not(p)" }),
    ]);
    expect(selectedFragment(node, [], operators)).toMatchObject({ ok: false });
    expect(
      selectedFragment(
        node,
        [goalSelection(node.state.id), goalSelection(node.state.id)],
        operators,
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps at least one pattern and cannot make a required slot optional", () => {
    const draft = introduceDraft();
    expect(removePattern(draft, "pattern:target").body.patterns).toHaveLength(1);
    const optional = setSlotRequired(draft, "target", false);
    expect(slotViews(optional)[0]).toMatchObject({ required: false, locked: true });
  });

  it("toggles required artifacts", () => {
    const reference = { kind: "result", id: "result:modus-tollens" } as const;
    const added = toggleArtifact(introduceDraft(), reference);
    expect(added.body.requiredArtifacts).toEqual([reference]);
    expect(toggleArtifact(added, reference).body.requiredArtifacts).toEqual([]);
  });

  it("declares a class that may differ from the kernel steps' class", () => {
    const draft = setDeclaredClass(introduceDraft(), "weakening");
    expect(draft.body.transitionClass).toBe("weakening");
    expect(composedClass(draft)).toBe("equivalence");
  });

  it("round-trips through a stored template", () => {
    const draft = introduceDraft();
    expect(draftFromTemplate(assembleTemplate(draft))).toEqual(draft);
  });
});

describe("examples", () => {
  function fullDraft(): TemplateDraft {
    const derived = derivedPath("node:contraposition-root", "node:command:contraposition-1");
    if (!derived.ok) throw new Error(derived.message);
    let draft = introduceDraft();
    for (const description of ["Recorded: first", "Recorded: second"]) {
      const added = addPositiveExample(draft, derived.path, operators, description);
      if (!added.ok) throw new Error(added.message);
      draft = added.draft;
    }
    const node = nodeById(history.nodes, "node:command:contraposition-1");
    const negative = addNegativeExample(
      draft,
      node,
      { target: goalSelection(node.state.id) },
      "A negation is not an implication",
    );
    if (!negative.ok) throw new Error(negative.message);
    return negative.draft;
  }

  it("captures positive examples from a recorded path and negative ones from clicks", () => {
    const draft = fullDraft();
    expect(positiveCount(draft)).toBe(2);
    expect(negativeCount(draft)).toBe(1);
    expect(exampleViews(draft).map(({ id, outcome }) => [id, outcome])).toEqual([
      ["positive-1", "applied"],
      ["positive-2", "applied"],
      ["negative-3", "rejected"],
    ]);
    const [positive] = draft.body.examples;
    expect(positive?.expected).toMatchObject({
      outcome: "applied",
      transitionClass: "equivalence",
    });
    expect(positive?.state).toMatchObject({ id: "state:contraposition-root" });
    const negative = draft.body.examples[2];
    expect(negative?.selections["target"]).toEqual({
      kind: "exact",
      anchor: { target: { kind: "goal", id: "goal:main" }, statement: { kind: "conclusion" } },
      path: [],
    });
  });

  it("passes the kernel's validation when run by the proof service's own validator", () => {
    const result = validateMoveTemplate(assembleTemplate(fullDraft()), { operators: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report).toMatchObject({
      transitionClass: "equivalence",
      stepCount: 1,
      retrievable: true,
    });
    expect(result.report.examples.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "rejected",
    ]);
  });

  it("is refused when the declared class is not the kernel's", () => {
    const wrong = setDeclaredClass(fullDraft(), "strengthening");
    const result = validateMoveTemplate(assembleTemplate(wrong), { operators: [] });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics.map(({ code }) => code)).toContain("class-mismatch");
  });

  it("is refused without enough examples", () => {
    const [first] = fullDraft().body.examples;
    const draft = introduceDraft();
    const result = validateMoveTemplate(
      assembleTemplate({ ...draft, body: { ...draft.body, examples: first ? [first] : [] } }),
      { operators: [] },
    );
    expect(!result.ok && result.diagnostics.map(({ code }) => code)).toContain("missing-example");
  });

  it("does not accept a path with other moves than the plan, nor an empty negative example", () => {
    const derived = derivedPath("node:contraposition-root", "node:command:contraposition-1");
    if (!derived.ok) throw new Error(derived.message);
    const split = draftFromPrimitive("move:split-goal-conjunction")!;
    expect(addPositiveExample(split, derived.path, operators, "x")).toEqual({
      ok: false,
      message: "The path does not apply the same moves as the plan.",
    });
    const node = nodeById(history.nodes, "node:command:contraposition-1");
    expect(addNegativeExample(introduceDraft(), node, {}, "x")).toMatchObject({ ok: false });
  });

  it("pins the expected refusal code when one is given and removes examples", () => {
    const node = nodeById(history.nodes, "node:command:contraposition-1");
    const added = addNegativeExample(
      introduceDraft(),
      node,
      { target: goalSelection(node.state.id) },
      "pinned",
      "not-an-implication",
    );
    if (!added.ok) throw new Error(added.message);
    expect(added.draft.body.examples[0]?.expected).toEqual({
      outcome: "rejected",
      diagnosticCode: "not-an-implication",
    });
    expect(removeExample(added.draft, "negative-1").body.examples).toEqual([]);
  });
});
