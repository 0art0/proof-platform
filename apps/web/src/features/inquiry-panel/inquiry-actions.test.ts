import { describe, expect, it } from "vitest";
import type { ProofNode } from "@proof/protocol";
import { statementIdSchema } from "@proof/mathjson-model";
import type { DisplayedSuggestionSet } from "@proof/protocol";
import type { SuggestionState } from "../stored-proof-workspace/suggestion-panel";
import type { MoveState } from "../stored-proof-workspace/suggestion-card";
import {
  constructAvailability,
  constructEnvelope,
  existentialBinder,
  findConditionsAvailability,
  findConditionsEnvelope,
  investigateAvailability,
  investigateEnvelope,
  tryMethodAvailability,
  tryMethodEnvelope,
  useThisAvailability,
  useThisEnvelope,
} from "./inquiry-actions";
import { summarizeInquiry } from "./inquiry-summary";
import { MAIN_TARGET, makeNode, recordSeries, selection } from "./inquiry-fixtures.testing";

const node = makeNode();
const conclusion = { kind: "conclusion" } as const;
const hypothesis = (id: string) =>
  ({ kind: "hypothesis", id: statementIdSchema.parse(id) }) as const;

describe("Investigate this hypothesis", () => {
  it("needs a selection inside one hypothesis and names why otherwise", () => {
    expect(investigateAvailability(node, [])).toEqual({
      ok: false,
      reason: "Select an occurrence in a hypothesis first.",
    });
    expect(investigateAvailability(node, [selection(node, conclusion, [])])).toEqual({
      ok: false,
      reason: "Select within a hypothesis, not a conclusion.",
    });
    const two = investigateAvailability(node, [
      selection(node, hypothesis("hypothesis:eps"), [1]),
      selection(node, hypothesis("hypothesis:small"), [1]),
    ]);
    expect(two).toMatchObject({ ok: false });
    expect((two as { reason: string }).reason).toMatch(/different statements/);
    const stale = { ...selection(node, hypothesis("hypothesis:eps"), []) };
    expect(
      investigateAvailability(node, [
        { ...stale, anchor: { ...stale.anchor, stateId: "state:old" as never } },
      ]),
    ).toMatchObject({ ok: false });
  });

  it("sends the investigate-hypothesis envelope for the selected hypothesis by identity", () => {
    const available = investigateAvailability(node, [
      selection(node, hypothesis("hypothesis:eps"), [1]),
    ]);
    if (!available.ok) throw new Error(available.reason);
    const envelope = investigateEnvelope({
      commandId: "command:web-investigate-1",
      nodeId: node.id,
      plan: available.value,
    });
    expect(envelope).toEqual({
      commandId: "command:web-investigate-1",
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:root" },
      command: {
        kind: "investigate-hypothesis",
        nodeId: "node:root",
        target: { kind: "goal", id: "goal:main" },
        hypothesis: "hypothesis:eps",
      },
    });
  });
});

describe("Construct an object", () => {
  it("is offered for an existential goal with the dependencies its sequent mentions", () => {
    const available = constructAvailability(node, [selection(node, conclusion, [])]);
    expect(available).toEqual({
      ok: true,
      value: { target: MAIN_TARGET, boundSymbol: "delta", dependencies: ["eps"] },
    });
  });

  it("names why it is unavailable", () => {
    expect(constructAvailability(node, [])).toMatchObject({ ok: false });
    expect(constructAvailability(node, [selection(node, conclusion, [], "goal:premise")])).toEqual({
      ok: false,
      reason: "The selected target does not conclude with an existential statement.",
    });
    // A target whose binder has no declared sort in its context.
    const [main, ...others] = node.state.goals;
    const undeclared = {
      ...node,
      state: {
        ...node.state,
        goals: [
          {
            ...main!,
            sequent: {
              ...main!.sequent,
              context: {
                ...main!.sequent.context,
                declarations: main!.sequent.context.declarations.filter(
                  ({ symbol }) => symbol !== "delta",
                ),
              },
            },
          },
          ...others,
        ],
      },
    } as ProofNode;
    expect(constructAvailability(undeclared, [selection(undeclared, conclusion, [])])).toEqual({
      ok: false,
      reason: "The variable delta has no declared sort in this target's context.",
    });
  });

  it("recognizes only a built-in existential over a symbol", () => {
    expect(existentialBinder(["Exists", "x", ["P", "x"]])).toBe("x");
    expect(existentialBinder(["ForAll", "x", ["P", "x"]])).toBeUndefined();
    expect(existentialBinder(["Exists", ["Element", "x", "S"], ["P", "x"]])).toBeUndefined();
    expect(existentialBinder("p")).toBeUndefined();
  });

  it("sends introduce-placeholder built from the target alone, with no mathematics", () => {
    const available = constructAvailability(node, [selection(node, conclusion, [])]);
    if (!available.ok) throw new Error(available.reason);
    const envelope = constructEnvelope({
      nodeId: node.id,
      plan: available.value,
      nonce: "0123abcd-4567",
    });
    expect(envelope.basis).toEqual({ nodeId: "node:root" });
    expect(envelope.actor).toEqual({ id: "actor:web", kind: "human" });
    expect(envelope.command).toEqual({
      kind: "kernel-operation",
      operation: {
        kind: "introduce-placeholder",
        target: { kind: "goal", id: "goal:main" },
        taskId: "construction-task:web-0123abcd-4567",
        symbol: "m_delta_0123abcd",
        displayName: "delta",
        origin: { kind: "existential-goal" },
        dependencies: ["eps"],
        allowedTasks: [],
      },
    });
    // No field the payload-source rule would inspect.
    const operation = (envelope.command as { operation: Record<string, unknown> }).operation;
    for (const field of ["proposition", "term", "witness", "value", "instantiation", "source"]) {
      expect(operation).not.toHaveProperty(field);
    }
    expect(envelope).not.toHaveProperty("command.payloadSource");
  });
});

describe("Find sufficient conditions", () => {
  it("references one exact selection by identity, else the whole target", () => {
    const whole = findConditionsAvailability(node, [selection(node, conclusion, [])]);
    expect(whole).toMatchObject({
      ok: true,
      value: { reference: { kind: "statement", nodeId: "node:root", statement: conclusion } },
    });
    const occurrence = findConditionsAvailability(node, [selection(node, conclusion, [1, 0])]);
    expect(occurrence).toMatchObject({
      ok: true,
      value: { reference: { kind: "occurrence", path: [1, 0] } },
    });
    const several = findConditionsAvailability(node, [
      selection(node, conclusion, [1]),
      selection(node, hypothesis("hypothesis:eps"), [1]),
    ]);
    expect(several).toMatchObject({
      ok: true,
      value: { reference: { kind: "target", target: MAIN_TARGET } },
    });
    expect(findConditionsAvailability(node, [])).toMatchObject({ ok: false });
  });

  it("records an Explore question and an elective objective, with no reason or sufficiency", () => {
    const available = findConditionsAvailability(node, [selection(node, conclusion, [1])]);
    if (!available.ok) throw new Error(available.reason);
    const envelope = findConditionsEnvelope({
      commandId: "command:web-find-1",
      nodeId: node.id,
      plan: available.value,
    });
    expect(envelope.command).toEqual({
      kind: "record-inquiry",
      nodeId: "node:root",
      records: [
        {
          id: "command:web-find-1:question",
          kind: "question",
          question: {
            form: "explore",
            objects: [
              {
                kind: "occurrence",
                nodeId: "node:root",
                target: MAIN_TARGET,
                statement: conclusion,
                path: [1],
              },
            ],
            aspect: "relationship",
          },
        },
        {
          id: "command:web-find-1:objective",
          kind: "objective",
          questionId: "command:web-find-1:question",
          necessity: "elective",
          focus: { nodeId: "node:root", target: MAIN_TARGET },
        },
      ],
    });
    const json = JSON.stringify(envelope);
    for (const claim of ["provenance", "method-encoded", "wouldSufficeFor", "reason"]) {
      expect(json).not.toContain(claim);
    }
  });
});

describe("Use this", () => {
  const record = recordSeries();
  const withObjective = summarizeInquiry({
    records: [
      record({
        id: "question:main",
        kind: "question",
        question: {
          form: "establish",
          proposition: { kind: "target", nodeId: "node:root", target: MAIN_TARGET },
        },
      }),
      record({
        id: "objective:main",
        kind: "objective",
        questionId: "question:main",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
    ],
    state: node.state,
  });
  const selected = [selection(node, hypothesis("hypothesis:eps"), [1])];

  it("needs loaded records, an active objective and a selection", () => {
    expect(useThisAvailability(node, selected, undefined)).toEqual({
      ok: false,
      reason: "The inquiry records are not loaded yet.",
    });
    const none = summarizeInquiry({ records: [], state: node.state });
    const missing = useThisAvailability(node, selected, none);
    expect(missing).toMatchObject({ ok: false });
    expect((missing as { reason: string }).reason).toMatch(/no active objective/i);
    expect(useThisAvailability(node, [], withObjective)).toMatchObject({ ok: false });
  });

  it("records a manual attempt on the active objective with the selections as anchored", () => {
    const available = useThisAvailability(node, selected, withObjective);
    if (!available.ok) throw new Error(available.reason);
    const envelope = useThisEnvelope({
      commandId: "command:web-use-this-1",
      nodeId: node.id,
      plan: available.value,
    });
    expect(envelope.command).toEqual({
      kind: "record-inquiry",
      nodeId: "node:root",
      records: [
        {
          id: "command:web-use-this-1:attempt",
          kind: "attempt",
          objectiveId: "objective:main",
          method: { kind: "manual" },
          selections: [
            {
              kind: "exact",
              anchor: {
                stateId: "state:root",
                target: MAIN_TARGET,
                statement: { kind: "hypothesis", id: "hypothesis:eps" },
              },
              path: [1],
            },
          ],
        },
      ],
    });
    // The action attributes no reason and claims no sufficiency.
    expect(JSON.stringify(envelope)).not.toMatch(/provenance|wouldSufficeFor/);
  });
});

describe("Try this method", () => {
  const set = (source: "result" | "move") =>
    ({
      id: "suggestion-set:1",
      suggestions: [{ id: "suggestion:1", source, name: "Continuity of sums", artifactId: "x" }],
    }) as unknown as DisplayedSuggestionSet;
  const ready = (source: "result" | "move"): SuggestionState => ({
    kind: "ready",
    suggestionSet: set(source),
    transitionClasses: [],
  });
  const previewed = (choices: Record<string, string> = {}): MoveState =>
    ({
      kind: "previewed",
      suggestionId: "suggestion:1",
      commandId: "command:preview-1",
      preview: {},
      choices,
    }) as unknown as MoveState;

  it("applies only a previewed library result", () => {
    expect(tryMethodAvailability({ kind: "idle" }, { kind: "idle" })).toMatchObject({ ok: false });
    expect(tryMethodAvailability(ready("result"), { kind: "idle" })).toMatchObject({ ok: false });
    const move = tryMethodAvailability(ready("move"), previewed());
    expect(move).toMatchObject({ ok: false });
    expect((move as { reason: string }).reason).toMatch(/approved move, not a library result/);
    expect(
      tryMethodAvailability(ready("result"), {
        ...(previewed() as object),
        suggestionId: "suggestion:9",
      } as unknown as MoveState),
    ).toMatchObject({ ok: false });
    expect(tryMethodAvailability(ready("result"), previewed())).toMatchObject({
      ok: true,
      value: { commandId: "command:preview-1", suggestionId: "suggestion:1" },
    });
  });

  it("sends apply with the try-result method under the preview's command ID", () => {
    const plain = tryMethodAvailability(ready("result"), previewed());
    if (!plain.ok) throw new Error(plain.reason);
    expect(tryMethodEnvelope({ nodeId: "node:root", plan: plain.value })).toEqual({
      commandId: "command:preview-1",
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:root" },
      command: {
        kind: "apply",
        suggestion: "suggestion:1",
        suggestionSetId: "suggestion-set:1",
        inquiryMethod: "try-result",
      },
    });
    const chosen = tryMethodAvailability(
      ready("result"),
      previewed({ "parameter:a": "menu-item:0123456789abcdef" }),
    );
    if (!chosen.ok) throw new Error(chosen.reason);
    expect(
      (
        tryMethodEnvelope({ nodeId: "node:root", plan: chosen.value }).command as {
          menuChoices: unknown;
        }
      ).menuChoices,
    ).toEqual({ "parameter:a": "menu-item:0123456789abcdef" });
  });
});
