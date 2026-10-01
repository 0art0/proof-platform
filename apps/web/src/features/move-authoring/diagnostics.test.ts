import { describe, expect, it } from "vitest";
import {
  describeAuthoringFailure,
  diagnosticsForExample,
  groupDiagnostics,
  sectionOf,
} from "./diagnostics";

const diagnostic = (code: string, path?: (string | number)[], exampleId?: string) => ({
  code,
  message: `${code} message`,
  ...(path === undefined ? {} : { path }),
  ...(exampleId === undefined ? {} : { exampleId }),
});

describe("template diagnostics", () => {
  it("places each diagnostic in the editor section its path names", () => {
    expect(sectionOf(diagnostic("x", ["name"]))).toBe("details");
    expect(sectionOf(diagnostic("x", ["selectionContract", "slots", 0, "id"]))).toBe("contract");
    expect(sectionOf(diagnostic("x", ["patterns", 0]))).toBe("patterns");
    expect(sectionOf(diagnostic("x", ["parameters", 1, "source"]))).toBe("parameters");
    expect(sectionOf(diagnostic("x", ["requiredArtifacts", 0]))).toBe("artifacts");
    expect(sectionOf(diagnostic("x", ["plan", "steps", 0, "moveId"]))).toBe("plan");
    expect(sectionOf(diagnostic("x", ["transitionClass"]))).toBe("class");
    expect(sectionOf(diagnostic("x", ["examples", 2, "expected"]))).toBe("examples");
    expect(sectionOf(diagnostic("x", undefined, "positive-1"))).toBe("examples");
    expect(sectionOf(diagnostic("x"))).toBe("template");
  });

  it("groups in the editor's order, omitting empty sections", () => {
    const groups = groupDiagnostics([
      diagnostic("a", ["examples"]),
      diagnostic("b", ["transitionClass"]),
      diagnostic("c", ["examples", 0]),
    ]);
    expect(groups.map(({ section, diagnostics }) => [section, diagnostics.length])).toEqual([
      ["class", 1],
      ["examples", 2],
    ]);
  });

  it("finds the diagnostics of one example by ID or by position", () => {
    const all = [
      diagnostic("a", ["examples", 1, "expected"]),
      diagnostic("b", undefined, "positive-1"),
      diagnostic("c", ["examples", 0]),
    ];
    expect(diagnosticsForExample(all, "positive-1", 0).map(({ code }) => code)).toEqual(["b", "c"]);
    expect(diagnosticsForExample(all, "negative-2", 1).map(({ code }) => code)).toEqual(["a"]);
  });
});

describe("refused authoring commands", () => {
  it("explains the review refusal codes readably", () => {
    const view = describeAuthoringFailure("Reject", {
      status: 422,
      code: "review-notes-required",
      message: "A rejection or change request needs notes.",
    });
    expect(view.message).toBe(
      "Reject refused (review-notes-required): A rejection or a change request needs notes explaining it.",
    );
    expect(view.diagnostics).toEqual([]);
  });

  it("keeps the worker's message for an unknown code and carries the diagnostics", () => {
    const view = describeAuthoringFailure("Approve", {
      status: 422,
      code: "something-new",
      message: "The worker said so.",
      validation: [diagnostic("example-failed")],
    });
    expect(view.message).toBe("Approve refused (something-new): The worker said so.");
    expect(view.diagnostics).toHaveLength(1);
  });

  it("advises a retry when the service is unavailable", () => {
    expect(
      describeAuthoringFailure("Save draft", {
        status: 0,
        code: "unavailable",
        message: "The proof service could not be reached.",
      }).message,
    ).toMatch(/Try again once the proof service is available\.$/);
  });
});
