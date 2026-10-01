import { describe, expect, it } from "vitest";
import type { AuthoredMoves } from "../move-authoring/api-contract";
import { macroInfoFrom, macroNames } from "./macro-info";

function revision(n: number, status: string, steps: number) {
  return {
    draftArtifactId: `artifact:${n}`,
    revision: n,
    authorId: "actor:human-1",
    status,
    definitionDigest: "d",
    template: { plan: { steps: Array.from({ length: steps }, () => ({})) } },
  };
}

describe("macroInfoFrom", () => {
  it("reads the step count of the latest approved revision and ignores single-step moves", () => {
    const moves = {
      sessionId: "session:t",
      moves: [
        {
          moveId: "authored:macro",
          name: "Macro",
          retrievable: true,
          revisions: [
            revision(1, "approved", 2),
            revision(2, "approved", 3),
            revision(3, "draft", 5),
          ],
        },
        {
          moveId: "authored:single",
          name: "Single",
          retrievable: true,
          revisions: [revision(1, "approved", 1)],
        },
        { moveId: "authored:odd", name: "Odd", retrievable: false, revisions: [] },
      ],
    } as unknown as AuthoredMoves;
    const info = macroInfoFrom(moves);
    expect([...info]).toEqual([["authored:macro", { name: "Macro", stepCount: 3 }]]);
    expect([...macroNames(info)]).toEqual([["authored:macro", "Macro"]]);
  });
});
