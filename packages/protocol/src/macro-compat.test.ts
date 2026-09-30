import { describe, expect, it } from "vitest";
import { macroFromSemanticSteps, type RecordedStep } from "@proof/moves/authoring";
import type { SemanticStep } from "./semantic-replay";

/**
 * `@proof/moves` cannot import `SemanticStep`, so it declares the structural `RecordedStep`. This
 * compile-time check keeps the two in step: a recorded N21 plan must be accepted as a macro source.
 */
describe("macro sources", () => {
  it("accepts N21 semantic steps as recorded steps", () => {
    const accepts = (steps: readonly SemanticStep[]) => {
      const recorded: readonly RecordedStep[] = steps;
      return macroFromSemanticSteps(recorded, {
        id: "authored:compat",
        name: "Compat",
        description: "Compat",
      });
    };
    expect(accepts([]).ok).toBe(false);
  });
});
