import { describe, expect, it } from "vitest";
import {
  explainMacroFailure,
  humanizeMoveId,
  macroDisplayName,
  macroStepLabel,
} from "./macro-labels";

describe("macro labels", () => {
  it("names a macro by its authored name, else by its identifier in words", () => {
    expect(humanizeMoveId("authored:intro-twice")).toBe("Intro twice");
    expect(macroDisplayName("authored:intro-twice")).toBe("Intro twice");
    expect(
      macroDisplayName("authored:intro-twice", new Map([["authored:intro-twice", "Intro 2"]])),
    ).toBe("Intro 2");
  });

  it("labels one step of an application", () => {
    expect(
      macroStepLabel({ moveId: "authored:intro-twice", stepIndex: 2, stepCount: 3 } as never),
    ).toBe("Macro Intro twice, step 2 of 3");
  });

  it("explains a failed step in words and leaves other failures alone", () => {
    expect(
      explainMacroFailure(
        "macro-step-failed",
        "Macro step 2 of 3 (step-2) could not be applied: no match.",
      ),
    ).toBe(
      "This multi-step move stopped at step 2 of 3 (step-2): no match. None of its steps were applied, so the proof is unchanged.",
    );
    expect(explainMacroFailure("macro-step-failed", "odd")).toBe("odd Nothing was changed.");
    expect(explainMacroFailure("preview-rejected", "Macro step 2 of 3 was rejected: x")).toBe(
      "Macro step 2 of 3 was rejected: x",
    );
  });
});
