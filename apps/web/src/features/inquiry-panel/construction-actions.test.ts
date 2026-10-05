import { describe, expect, it } from "vitest";
import type { ConstructionTask } from "@proof/mathjson-model";
import {
  constructionActionEnvelope,
  constructionOptions,
  constructionTarget,
  requirementRoleText,
  type ConstructionActionKind,
} from "./construction-actions";
import { makeConstructedNode, makeNode } from "./inquiry-fixtures.testing";

const operators = [] as const;

function taskOf(node: ReturnType<typeof makeConstructedNode>): ConstructionTask {
  return node.state.constructions![0] as ConstructionTask;
}

function itemsFor(
  node: ReturnType<typeof makeConstructedNode>,
  kind: ConstructionActionKind,
): NonNullable<Extract<ReturnType<typeof constructionOptions>, { ok: true }>["items"]> {
  const options = constructionOptions(node, operators, kind, taskOf(node));
  if (!options.ok) throw new Error(options.reason);
  return options.items;
}

describe("constructionTarget", () => {
  it("acts from the goal that still mentions the placeholder", () => {
    const node = makeConstructedNode();
    expect(constructionTarget(node, taskOf(node))).toEqual({ kind: "goal", id: "goal:main" });
  });

  it("falls back to the first open target when nothing mentions it", () => {
    const node = makeNode();
    const task = {
      ...taskOf(makeConstructedNode()),
      origin: { kind: "auxiliary-request", description: "x" },
    } as unknown as ConstructionTask;
    expect(constructionTarget(node, task)).toEqual({ kind: "goal", id: "goal:main" });
  });
});

describe("add requirement", () => {
  it("offers a sufficient requirement tracked by its target and heuristic hints, in plain words", () => {
    const items = itemsFor(makeConstructedNode(), "add-requirement");
    const roles = items.map(({ value }) =>
      value.kind === "construction-requirement" ? `${value.role}/${value.evidence.kind}` : "",
    );
    expect(roles).toContain("sufficient/target");
    expect(roles).toContain("heuristic/none");
    expect(roles.every((role) => !role.startsWith("necessary"))).toBe(true);
    const sufficient = items.find(
      ({ value }) => value.kind === "construction-requirement" && value.role === "sufficient",
    )!;
    expect(requirementRoleText(sufficient)).toMatch(/proof already needs this/);
    const heuristic = items.find(
      ({ value }) => value.kind === "construction-requirement" && value.role === "heuristic",
    )!;
    expect(requirementRoleText(heuristic)).toMatch(/establishes nothing and is not an assumption/);
  });

  it("sends the requirement chosen from the menu, declaring where its mathematics came from", () => {
    const node = makeConstructedNode();
    const item = itemsFor(node, "add-requirement").find(
      ({ value }) => value.kind === "construction-requirement" && value.role === "sufficient",
    )!;
    const built = constructionActionEnvelope({
      node,
      operators,
      kind: "add-requirement",
      task: taskOf(node),
      itemId: item.id,
      commandId: "command:web-add-requirement-1",
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.value).toMatchObject({
      commandId: "command:web-add-requirement-1",
      actor: { id: "actor:web", kind: "human" },
      basis: { nodeId: "node:constructed" },
      command: {
        kind: "kernel-operation",
        payloadSource: "validated-operation",
        operation: {
          kind: "add-requirement",
          taskId: "construction-task:delta",
          role: "sufficient",
          evidence: { kind: "target", target: { kind: "goal", id: "goal:main" } },
          proposition: ["Less", ["m_delta", "eps"], "eps"],
        },
      },
    });
  });

  it("rejects an item that is not in the menu", () => {
    const node = makeConstructedNode();
    expect(
      constructionActionEnvelope({
        node,
        operators,
        kind: "add-requirement",
        task: taskOf(node),
        itemId: "menu-item:0000000000000000",
      }),
    ).toEqual({ ok: false, reason: "Choose one of the offered items first." });
  });
});

describe("add candidate", () => {
  it("offers the variables the construction may depend on", () => {
    const terms = itemsFor(makeConstructedNode(), "add-candidate").map(({ value }) =>
      value.kind === "term" ? value.expression : undefined,
    );
    expect(terms).toContain("eps");
    expect(JSON.stringify(terms)).not.toContain("m_delta");
  });

  it("sends the chosen term", () => {
    const node = makeConstructedNode();
    const item = itemsFor(node, "add-candidate").find(
      ({ value }) => value.kind === "term" && value.expression === "eps",
    )!;
    const built = constructionActionEnvelope({
      node,
      operators,
      kind: "add-candidate",
      task: taskOf(node),
      itemId: item.id,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.command).toMatchObject({
      kind: "kernel-operation",
      payloadSource: "validated-operation",
      operation: { kind: "add-candidate", value: "eps", taskId: "construction-task:delta" },
    });
  });
});

describe("use this candidate", () => {
  it("says a candidate is needed first", () => {
    const node = makeConstructedNode();
    expect(constructionOptions(node, operators, "resolve-placeholder", taskOf(node))).toEqual({
      ok: false,
      reason: "Add a candidate for delta first.",
    });
  });

  it("resolves with a stored candidate without sending any mathematics", () => {
    const node = makeConstructedNode({
      candidates: [{ id: "candidate:eps", value: "eps", attemptId: "attempt:1" }],
    });
    const item = itemsFor(node, "resolve-placeholder")[0]!;
    const built = constructionActionEnvelope({
      node,
      operators,
      kind: "resolve-placeholder",
      task: taskOf(node),
      itemId: item.id,
    });
    if (!built.ok) throw new Error(built.reason);
    const { command } = built.value as { command: Record<string, unknown> };
    expect(command).not.toHaveProperty("payloadSource");
    expect(command.operation).toMatchObject({
      kind: "resolve-placeholder",
      candidateId: "candidate:eps",
      obligationIds: [],
    });
  });
});

describe("abandon", () => {
  it("explains that a placeholder still in the goal cannot be abandoned", () => {
    const node = makeConstructedNode();
    const options = constructionOptions(node, operators, "abandon-placeholder", taskOf(node));
    expect(options).toMatchObject({
      ok: false,
      reason: expect.stringContaining("still occurs in the proof state"),
    });
  });

  it("sends the abandonment of an unused construction", () => {
    const base = makeConstructedNode();
    const unused = {
      ...base,
      state: {
        ...base.state,
        goals: makeNode().state.goals.map((goal) =>
          goal.id === "goal:main"
            ? {
                ...goal,
                sequent: { ...goal.sequent, conclusion: { expression: ["Greater", "eps", 0] } },
              }
            : goal,
        ),
      },
    } as typeof base;
    const built = constructionActionEnvelope({
      node: unused,
      operators,
      kind: "abandon-placeholder",
      task: taskOf(unused),
    });
    if (!built.ok) throw new Error(built.reason);
    expect(built.value.command).toMatchObject({
      kind: "kernel-operation",
      operation: { kind: "abandon-placeholder", taskId: "construction-task:delta" },
    });
  });
});
