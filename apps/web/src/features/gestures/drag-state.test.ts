import { describe, expect, it } from "vitest";
import {
  IDLE_DRAG_STATE,
  dragReducer,
  type DragAction,
  type DragSource,
  type DragState,
} from "./drag-state";

const result: DragSource = { kind: "result", artifactId: "result:excluded-middle", label: "EM" };
const target = {
  kind: "exact",
  anchor: {
    stateId: "state:a",
    target: { kind: "goal", id: "goal:a" },
    statement: { kind: "conclusion" },
  },
  path: [],
} as never;

function run(actions: readonly DragAction[], from: DragState = IDLE_DRAG_STATE): DragState {
  return actions.reduce(dragReducer, from);
}

describe("drag state machine", () => {
  it("walks idle → carrying → resolving → idle with the settled outcome", () => {
    const carrying = run([{ type: "pick-up", source: result, input: "pointer" }]);
    expect(carrying).toEqual({ phase: "carrying", source: result, input: "pointer", over: false });
    const resolving = run([{ type: "drop", target }], carrying);
    expect(resolving).toEqual({ phase: "resolving", source: result, target });
    const settled = run(
      [{ type: "settle", outcome: { kind: "previewing", message: "ok" } }],
      resolving,
    );
    expect(settled).toEqual({ phase: "idle", outcome: { kind: "previewing", message: "ok" } });
  });

  it("only hovers, drops and cancels while carrying", () => {
    expect(run([{ type: "hover", over: true }])).toBe(IDLE_DRAG_STATE);
    expect(run([{ type: "drop", target }])).toBe(IDLE_DRAG_STATE);
    expect(run([{ type: "cancel" }])).toBe(IDLE_DRAG_STATE);
    const carrying = run([{ type: "pick-up", source: result, input: "keyboard" }]);
    expect(run([{ type: "hover", over: true }], carrying)).toMatchObject({ over: true });
    expect(run([{ type: "cancel" }], carrying)).toEqual({
      phase: "idle",
      outcome: { kind: "cancelled", message: "Drag cancelled." },
    });
  });

  it("ignores a second drop, a late cancel and a pick-up while resolving", () => {
    const resolving = run([
      { type: "pick-up", source: result, input: "pointer" },
      { type: "drop", target },
    ]);
    expect(run([{ type: "drop", target }], resolving)).toBe(resolving);
    expect(run([{ type: "cancel" }], resolving)).toBe(resolving);
    expect(run([{ type: "pick-up", source: result, input: "keyboard" }], resolving)).toBe(
      resolving,
    );
  });

  it("settles only a resolution, and a reset forgets everything", () => {
    const outcome = { kind: "no-move", message: "No move applies here" } as const;
    expect(run([{ type: "settle", outcome }])).toBe(IDLE_DRAG_STATE);
    const resolving = run([
      { type: "pick-up", source: result, input: "pointer" },
      { type: "drop", target },
    ]);
    expect(run([{ type: "reset" }], resolving)).toBe(IDLE_DRAG_STATE);
    const settled = run([{ type: "settle", outcome }], resolving);
    expect(run([{ type: "reset" }], settled)).toBe(IDLE_DRAG_STATE);
  });

  it("replaces the carried source when another is picked up", () => {
    const other: DragSource = { kind: "result", artifactId: "result:other", label: "Other" };
    const state = run([
      { type: "pick-up", source: result, input: "pointer" },
      { type: "pick-up", source: other, input: "keyboard" },
    ]);
    expect(state).toMatchObject({ phase: "carrying", source: other, input: "keyboard" });
  });
});
