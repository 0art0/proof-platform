import { describe, expect, it } from "vitest";
import {
  applyKernelCommandSchema,
  menuChoicesSchema,
  moveMenuSelectionSchema,
  moveRequiresInputResponseSchema,
  suggestionAuthorizesMove,
} from "./index";

const ITEM_P = "menu-item:0123456789abcdef";
const ITEM_Q = "menu-item:fedcba9876543210";

const disjunctMenu = {
  parameterId: "disjunctIndex",
  label: "Disjunct",
  automatic: false,
  items: [
    {
      id: ITEM_P,
      label: { kind: "math", expression: "p" },
      value: { kind: "index", index: 0 },
      origin: { kind: "subterm-of", statement: { kind: "conclusion" }, path: [0] },
    },
    {
      id: ITEM_Q,
      label: { kind: "math", expression: "q" },
      value: { kind: "index", index: 1 },
      origin: { kind: "subterm-of", statement: { kind: "conclusion" }, path: [1] },
    },
  ],
};

describe("menu-choice payloads", () => {
  it("accepts menu item IDs only, never expressions or free text", () => {
    expect(menuChoicesSchema.safeParse({ disjunctIndex: ITEM_P }).success).toBe(true);
    expect(menuChoicesSchema.safeParse({ "instantiation/p": ITEM_Q }).success).toBe(true);
    for (const value of [["Or", "p", "q"], "p", 1, "menu-item:XYZ", { kind: "term" }]) {
      expect(menuChoicesSchema.safeParse({ term: value }).success).toBe(false);
    }
  });

  it("requires every recorded choice to name an item of its recorded menu", () => {
    expect(
      moveMenuSelectionSchema.safeParse({
        menus: [disjunctMenu],
        choices: { disjunctIndex: ITEM_Q },
      }).success,
    ).toBe(true);
    expect(
      moveMenuSelectionSchema.safeParse({
        menus: [disjunctMenu],
        choices: { disjunctIndex: "menu-item:0000000000000000" },
      }).success,
    ).toBe(false);
    expect(
      moveMenuSelectionSchema.safeParse({ menus: [disjunctMenu], choices: { witness: ITEM_P } })
        .success,
    ).toBe(false);
    expect(
      moveMenuSelectionSchema.safeParse({
        menus: [{ ...disjunctMenu, extra: true }],
        choices: {},
      }).success,
    ).toBe(false);
  });

  it("describes requires-input responses strictly, with a menu for every missing parameter", () => {
    const response = {
      status: "requires-input",
      suggestionSetId: "suggestion-set:one",
      chosenSuggestionId: "suggestion:one",
      menus: [disjunctMenu],
      missingParameters: ["disjunctIndex"],
      diagnostics: [{ code: "requires-input", message: "Choose a disjunct." }],
    };
    expect(moveRequiresInputResponseSchema.safeParse(response).success).toBe(true);
    expect(
      moveRequiresInputResponseSchema.safeParse({ ...response, missingParameters: ["witness"] })
        .success,
    ).toBe(false);
    expect(moveRequiresInputResponseSchema.safeParse({ ...response, operation: {} }).success).toBe(
      false,
    );
  });

  it("records menu selections only on suggestion-backed commands", () => {
    const command = {
      commandId: "command:one",
      kind: "apply-kernel-operation",
      actor: { id: "actor:human", kind: "human" },
      parentNodeId: "node:root",
      resultNodeId: "node:child",
      edgeId: "edge:one",
      eventId: "event:one",
      operation: {
        kind: "choose-goal-disjunct",
        expectedStateId: "state:root",
        resultStateId: "state:child",
        target: { kind: "goal", id: "goal:main" },
        disjunctIndex: 1,
      },
      menuSelection: { menus: [disjunctMenu], choices: { disjunctIndex: ITEM_Q } },
    };
    expect(applyKernelCommandSchema.safeParse(command).success).toBe(false);
    expect(
      applyKernelCommandSchema.safeParse({
        ...command,
        moveId: "move:choose-goal-disjunct",
        suggestionSetId: "suggestion-set:one",
        chosenSuggestionId: "suggestion:one",
      }).success,
    ).toBe(true);
  });
});

describe("suggestionAuthorizesMove", () => {
  const rewrite = {
    kind: "rewrite-with-equivalence",
    expectedStateId: "state:root",
    resultStateId: "state:child",
    target: { kind: "goal", id: "goal:main" },
    statement: { kind: "conclusion" },
    path: [0],
    source: { kind: "result", resultId: "result:commutativity", instantiation: {} },
    direction: "forward",
  } as never;

  it("binds a move suggestion to its move and a result suggestion to its result", () => {
    expect(
      suggestionAuthorizesMove(
        { source: "move", artifactId: "move:rewrite-with-equivalence" },
        "move:rewrite-with-equivalence",
        rewrite,
      ),
    ).toBe(true);
    expect(
      suggestionAuthorizesMove(
        { source: "result", artifactId: "result:commutativity" },
        "move:rewrite-with-equivalence",
        rewrite,
      ),
    ).toBe(true);
    expect(
      suggestionAuthorizesMove(
        { source: "result", artifactId: "result:other" },
        "move:rewrite-with-equivalence",
        rewrite,
      ),
    ).toBe(false);
    expect(
      suggestionAuthorizesMove(
        { source: "result", artifactId: "result:commutativity" },
        "move:rewrite-with-implication",
        rewrite,
      ),
    ).toBe(false);
    expect(
      suggestionAuthorizesMove(
        { source: "result", artifactId: "result:commutativity" },
        undefined,
        rewrite,
      ),
    ).toBe(false);
  });
});
