import { describe, expect, it } from "vitest";
import { starterLibraryPacks } from "@proof/library";
import { operatorDeclarationSchema, type OperatorDeclaration } from "@proof/protocol";
import { resolveAgainstRegistry } from "./approved-background";
import { unapprovedConstantDiagnostics, validateProblemDraft } from "./problem-setup";
import { setDraft } from "./problem-setup.testing";

function operator(overrides: Record<string, unknown> = {}): OperatorDeclaration {
  return operatorDeclarationSchema.parse({
    id: "operator:coprime",
    symbol: "Coprime",
    signature: {
      parameters: [
        { kind: "named", id: "sort:integer" },
        { kind: "named", id: "sort:integer" },
      ],
      result: { kind: "proposition" },
    },
    presentation: {
      displayName: "coprime",
      latex: {
        template: String.raw`#1\perp #2`,
        precedence: "relation",
        parse: { trigger: String.raw`\perp`, notation: "infix" },
      },
      naturalLanguage: [{ template: "#1 and #2 are coprime" }],
    },
    ...overrides,
  });
}

const divisibility = starterLibraryPacks()
  .flatMap((pack) => pack.operators)
  .find(({ symbol }) => symbol === "Divides") as OperatorDeclaration;

function integerDraft(overrides: Record<string, unknown> = {}) {
  return setDraft({
    packs: [],
    declarations: [
      { symbol: "m", sort: "integer" },
      { symbol: "n", sort: "integer" },
    ],
    hypotheses: [],
    goals: [{ format: "latex", latex: String.raw`m \perp n` }],
    ...overrides,
  });
}

describe("resolveAgainstRegistry", () => {
  it("passes an unrelated constant through unchanged", () => {
    const constant = operator();
    expect(resolveAgainstRegistry([constant])).toEqual({ constants: [constant], conflicts: [] });
  });

  it("replaces a constant that repeats a registry symbol and signature by the registry's own", () => {
    const reference = operator({
      id: "operator:my-divides",
      symbol: "Divides",
      presentation: undefined,
      signature: divisibility.signature,
    });
    const resolution = resolveAgainstRegistry([reference]);
    expect(resolution.conflicts).toEqual([]);
    expect(resolution.constants).toEqual([divisibility]);
  });

  it("reports a registry symbol with another signature, and reused IDs and triggers", () => {
    const wrongSignature = operator({
      id: "operator:my-divides",
      symbol: "Divides",
      signature: {
        parameters: [
          { kind: "named", id: "sort:natural" },
          { kind: "named", id: "sort:natural" },
        ],
        result: { kind: "proposition" },
      },
    });
    const reusesId = operator({ id: divisibility.id });
    const reusesTrigger = operator({
      id: "operator:fancy",
      symbol: "Fancy",
      presentation: {
        displayName: "fancy",
        latex: {
          template: String.raw`#1\mid #2`,
          precedence: "relation",
          parse: { trigger: String.raw`\mid`, notation: "infix" },
        },
      },
    });
    const { conflicts } = resolveAgainstRegistry([wrongSignature, reusesId, reusesTrigger]);
    expect(conflicts).toHaveLength(3);
    expect(conflicts[0]).toContain("Divides is already an operator of the pack pack:divisibility");
    expect(conflicts[1]).toContain(`The ID ${divisibility.id}`);
    expect(conflicts[2]).toContain("The LaTeX trigger \\mid");
  });
});

describe("validateProblemDraft with approved constants", () => {
  it("parses the constants' notation and adds them to the session's operators after the packs'", () => {
    const withoutConstants = validateProblemDraft(integerDraft());
    expect(withoutConstants.ok).toBe(false);

    const validated = validateProblemDraft(integerDraft({ packs: ["pack:sets"] }), undefined, {
      constants: [operator()],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.operators.map(({ symbol }) => symbol)).toEqual([
      "Union",
      "Intersection",
      "Coprime",
    ]);
    expect(validated.value.review.operators).toEqual(validated.value.operators);
    const [goal] = validated.value.rootNode.state.goals;
    expect(goal?.sequent.conclusion.expression).toEqual(["Coprime", "m", "n"]);
  });

  it("keys the review digest to the constants", () => {
    const first = validateProblemDraft(integerDraft(), undefined, { constants: [operator()] });
    const second = validateProblemDraft(integerDraft(), undefined, {
      constants: [
        operator(),
        operator({
          id: "operator:other",
          symbol: "Other",
          presentation: undefined,
        }),
      ],
    });
    if (!first.ok || !second.ok) throw new Error("Expected both drafts to be valid.");
    expect(first.value.review.digest).not.toBe(second.value.review.digest);
  });

  it("accepts a constant identical to a selected pack's operator, and flags a different one", () => {
    const same = validateProblemDraft(
      integerDraft({
        packs: ["pack:divisibility"],
        goals: [{ format: "latex", latex: String.raw`m \mid n` }],
      }),
      undefined,
      { constants: [divisibility] },
    );
    expect(same.ok).toBe(true);
    if (same.ok) {
      expect(same.value.operators.filter(({ symbol }) => symbol === "Divides")).toHaveLength(1);
    }

    const different = validateProblemDraft(
      integerDraft({
        packs: ["pack:divisibility"],
        goals: [{ format: "latex", latex: String.raw`m \mid n` }],
      }),
      undefined,
      { constants: [operator({ id: "operator:other-divides", symbol: "Divides" })] },
    );
    expect(different).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "pack-operator-conflict",
          path: ["approvedBackground"],
          message: expect.stringContaining("the pack pack:divisibility"),
        },
      ],
    });
  });

  it("flags a constant that reuses another operator's ID or trigger, and a variable named like one", () => {
    const clash = validateProblemDraft(
      integerDraft({
        packs: ["pack:divisibility"],
        goals: [{ format: "mathjson", expression: ["Equal", "m", "n"] }],
      }),
      undefined,
      { constants: [operator({ id: divisibility.id })] },
    );
    expect(clash).toMatchObject({
      ok: false,
      diagnostics: [{ code: "pack-operator-conflict", path: ["approvedBackground"] }],
    });

    const shadowed = validateProblemDraft(
      integerDraft({
        declarations: [{ symbol: "Coprime", sort: "integer" }],
        goals: [{ format: "mathjson", expression: ["Equal", "Coprime", "Coprime"] }],
      }),
      undefined,
      { constants: [operator()] },
    );
    expect(shadowed).toMatchObject({
      ok: false,
      diagnostics: [
        {
          code: "operator-symbol",
          message: "Coprime is an operator of the approved background constants.",
        },
      ],
    });
  });
});

describe("unapprovedConstantDiagnostics", () => {
  const constants = [operator()];

  function diagnosticsFor(draft: ReturnType<typeof integerDraft>, withConstants = constants) {
    return unapprovedConstantDiagnostics(draft, undefined, { constants: withConstants });
  }

  it("reports nothing for built-ins, selected-pack operators, approved constants and declarations", () => {
    expect(diagnosticsFor(integerDraft())).toEqual([]);
    expect(
      diagnosticsFor(
        integerDraft({
          packs: ["pack:sets"],
          declarations: [
            { symbol: "A", sort: "set-of-elements" },
            { symbol: "B", sort: "set-of-elements" },
            { symbol: "f", sort: "real-function" },
          ],
          hypotheses: [
            { format: "mathjson", expression: ["Element", ["f", "x"], ["Union", "A", "B"]] },
          ],
          goals: [{ format: "latex", latex: String.raw`A \cup B = B \cup A` }],
        }),
      ),
    ).toEqual([]);
  });

  it("reports an applied operator outside the set, once per statement and symbol", () => {
    const diagnostics = diagnosticsFor(
      integerDraft({
        hypotheses: [
          { format: "mathjson", expression: ["And", ["Gcd", "m", "n"], ["Gcd", "n", "m"]] },
        ],
        goals: [
          { format: "mathjson", expression: ["Coprime", "m", ["Lcm", "m", "n"]] },
          { format: "mathjson", expression: ["Coprime", "m", "n"] },
        ],
      }),
    );
    expect(diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "unapproved-constant", path: ["hypotheses", 0, "expression"] },
      { code: "unapproved-constant", path: ["goals", 0, "expression"] },
    ]);
    expect(diagnostics[0]?.message).toContain("Hypothesis 1 applies the operator Gcd");
    expect(diagnostics[0]?.message).toContain("Coprime");
    expect(diagnostics[1]?.message).toContain("Goal 1 applies the operator Lcm");
  });

  it("does not treat bound function variables or bare unknown symbols as constants", () => {
    expect(
      diagnosticsFor(
        integerDraft({
          goals: [
            {
              format: "mathjson",
              expression: ["ForAll", "g", ["Equal", ["g", "m"], ["g", "n"]]],
            },
            { format: "mathjson", expression: ["Equal", "undeclared", "m"] },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("names the pack of a registry operator whose pack is not selected", () => {
    const [diagnostic] = diagnosticsFor(
      integerDraft({ goals: [{ format: "mathjson", expression: ["Divides", "m", "n"] }] }),
    );
    expect(diagnostic?.message).toContain("pack:divisibility, which is not selected");
    expect(
      diagnosticsFor(
        integerDraft({
          packs: ["pack:divisibility"],
          goals: [{ format: "mathjson", expression: ["Divides", "m", "n"] }],
        }),
      ),
    ).toEqual([]);
  });

  it("leaves a LaTeX statement that does not parse to the usual diagnostics", () => {
    expect(
      diagnosticsFor(integerDraft({ goals: [{ format: "latex", latex: String.raw`m \perp` }] })),
    ).toEqual([]);
    expect(
      validateProblemDraft(
        integerDraft({ goals: [{ format: "latex", latex: String.raw`m \perp` }] }),
        undefined,
        { constants },
      ),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: "latex-parse-failed" }],
    });
  });

  it("reads LaTeX with only the approved notation", () => {
    // Without the constant, \perp has no meaning, so the statement is not read as Coprime.
    const diagnostics = diagnosticsFor(integerDraft(), []);
    expect(diagnostics.every(({ code }) => code === "unapproved-constant")).toBe(true);
  });
});
