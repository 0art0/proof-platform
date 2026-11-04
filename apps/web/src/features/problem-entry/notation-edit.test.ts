import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { operatorDeclarationSchema, type OperatorDeclaration } from "@proof/protocol";
import {
  appliedSymbols,
  deriveParse,
  editedOperator,
  filledTemplate,
  templateIssue,
} from "./notation-edit";

const INTEGER = { kind: "named", id: "sort:integer" } as const;
const COPRIME = operatorDeclarationSchema.parse({
  id: "operator:coprime",
  symbol: "Coprime",
  signature: { parameters: [INTEGER, INTEGER], result: { kind: "proposition" } },
  presentation: {
    displayName: "coprime",
    latex: {
      template: "#1 \\perp #2",
      precedence: "relation",
      parse: { trigger: "\\perp", notation: "infix" },
    },
    naturalLanguage: [{ template: "#1 and #2 are coprime" }],
  },
});

describe("templateIssue", () => {
  it("accepts LaTeX that shows exactly the operands", () => {
    expect(templateIssue("#1 \\perp #2", 2)).toBeUndefined();
    expect(templateIssue("\\operatorname{cop}\\left(#1, #2\\right)", 2)).toBeUndefined();
    expect(templateIssue("\\{#1\\}", 1)).toBeUndefined();
  });

  it("says what is wrong otherwise", () => {
    expect(templateIssue("  ", 2)).toBe("Enter the LaTeX.");
    expect(templateIssue("$#1 \\perp #2$", 2)).toBe("Write LaTeX without $ signs.");
    expect(templateIssue("#1 \\perp", 2)).toBe("Show #2.");
    expect(templateIssue("\\perp", 2)).toBe("Show #1 and #2.");
    expect(templateIssue("#1 \\perp #3", 2)).toBe("Show #2.");
    expect(templateIssue("#1 \\perp #2 #3", 2)).toBe("There is no #3: this takes 2.");
    expect(templateIssue("{#1 \\perp #2", 2)).toBe("A { is not closed.");
    expect(templateIssue("#1 \\perp #2}", 2)).toBe("A } has no matching {.");
    expect(
      templateIssue("\\Cop{#1}{#2}", 2, (latex) => (latex.includes("\\Cop") ? ["\\Cop"] : [])),
    ).toBe("\\Cop is not standard LaTeX; try \\operatorname{Cop}.");
  });
});

describe("deriveParse", () => {
  const infix = { trigger: "\\perp", notation: "infix" } as const;
  it("keeps the previous trigger while the template still shows it", () => {
    expect(deriveParse("#1\\,\\perp\\,#2", 2, infix)).toBe(infix);
  });
  it("reads named operators, infix and prefix commands, and leading functions", () => {
    expect(deriveParse("\\operatorname{cop}(#1, #2)", 2, infix)).toEqual({
      trigger: "\\operatorname{cop}",
      notation: "function",
    });
    expect(deriveParse("#1 \\mid #2", 2, infix)).toEqual({ trigger: "\\mid", notation: "infix" });
    expect(deriveParse("\\neg #1", 1, undefined)).toEqual({ trigger: "\\neg", notation: "prefix" });
    expect(deriveParse("\\gcd\\left(#1, #2\\right)", 2, undefined)).toEqual({
      trigger: "\\gcd",
      notation: "function",
    });
  });
  it("never takes a wrapper command, and gives up on notation that cannot be typed", () => {
    expect(deriveParse("#1 \\mathrel{\\sim} #2", 2, infix)).toBeUndefined();
    expect(deriveParse("\\left(#1, #2\\right)", 2, undefined)).toBeUndefined();
  });
});

describe("editedOperator", () => {
  it("changes the name and notation only", () => {
    const edited = editedOperator(COPRIME, {
      displayName: " coprime to ",
      template: "\\operatorname{cop}\\left(#1, #2\\right)",
    });
    expect(edited).toMatchObject({
      id: COPRIME.id,
      symbol: "Coprime",
      signature: COPRIME.signature,
      presentation: {
        displayName: "coprime to",
        latex: {
          template: "\\operatorname{cop}\\left(#1, #2\\right)",
          precedence: "relation",
          parse: { trigger: "\\operatorname{cop}", notation: "function" },
        },
        naturalLanguage: COPRIME.presentation?.naturalLanguage,
      },
    });
    expect(operatorDeclarationSchema.safeParse(edited).success).toBe(true);
  });

  it("returns the proposal's notation unchanged when the template is unchanged", () => {
    const edited = editedOperator(COPRIME, { displayName: "coprime", template: "#1 \\perp #2" });
    expect(edited).toEqual(COPRIME);
  });

  it("never changes the ID, symbol or signature, whatever is typed (property)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (displayName, template) => {
        const edited: OperatorDeclaration = editedOperator(COPRIME, { displayName, template });
        expect(edited.id).toBe(COPRIME.id);
        expect(edited.symbol).toBe(COPRIME.symbol);
        expect(edited.signature).toEqual(COPRIME.signature);
        expect(edited.presentation?.displayName.length).toBeGreaterThan(0);
        // An accepted template always gives a declaration the worker can read.
        if (templateIssue(template, 2) === undefined) {
          const parse = edited.presentation?.latex?.parse;
          if (parse !== undefined)
            expect(edited.presentation?.latex?.template).toContain(parse.trigger);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("filledTemplate and appliedSymbols", () => {
  it("fills operands with sample names", () => {
    expect(filledTemplate("#1 \\perp #2", 2)).toBe("a \\perp b");
    expect(filledTemplate("\\# #1", 1)).toBe("\\# a");
  });
  it("lists the operators a formula applies, at any depth", () => {
    expect([
      ...appliedSymbols(["Implies", ["Coprime", "a", "b"], ["Not", ["Divides", 2, "a"]]]),
    ]).toEqual(["Implies", "Coprime", "Not", "Divides"]);
    expect(appliedSymbols("a").size).toBe(0);
  });
});
