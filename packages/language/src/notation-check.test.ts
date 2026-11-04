import { describe, expect, it } from "vitest";
import { operatorDeclarationSchema } from "@proof/mathjson-model";
import { notationRoundTrips } from "./notation-check";

const REAL_FUNCTION = { kind: "named", id: "sort:real-function" } as const;
const INTEGER = { kind: "named", id: "sort:integer" } as const;

function operator(
  symbol: string,
  template: string,
  parse: { trigger: string; notation: "function" | "infix" | "prefix" } | undefined,
  parameters: readonly unknown[],
) {
  return operatorDeclarationSchema.parse({
    id: `operator:${symbol.toLowerCase()}`,
    symbol,
    signature: { parameters, result: { kind: "proposition" } },
    presentation: {
      displayName: symbol.toLowerCase(),
      latex: {
        template,
        precedence: parse?.notation === "infix" ? "relation" : "atom",
        ...(parse === undefined ? {} : { parse }),
      },
    },
  });
}

describe("notationRoundTrips", () => {
  it("accepts notation that typed LaTeX reads back as the operator", () => {
    for (const declaration of [
      operator(
        "Derivative",
        "\\operatorname{Derivative}\\left(#1\\right)",
        { trigger: "\\operatorname{Derivative}", notation: "function" },
        [REAL_FUNCTION],
      ),
      operator("Coprime", "#1 \\perp #2", { trigger: "\\perp", notation: "infix" }, [
        INTEGER,
        INTEGER,
      ]),
      operator("Gcd", "\\gcd\\left(#1, #2\\right)", { trigger: "\\gcd", notation: "function" }, [
        INTEGER,
        INTEGER,
      ]),
    ]) {
      expect(notationRoundTrips(declaration), declaration.symbol).toBe(true);
    }
  });

  it("refuses names the parser already reads as something else", () => {
    // \operatorname{D} is the standard derivative and \operatorname{sin} the sine.
    expect(
      notationRoundTrips(
        operator(
          "Derivative",
          "\\operatorname{D}\\left(#1\\right)",
          { trigger: "\\operatorname{D}", notation: "function" },
          [REAL_FUNCTION],
        ),
      ),
    ).toBe(false);
    expect(
      notationRoundTrips(
        operator(
          "Sine",
          "\\operatorname{sin}\\left(#1\\right)",
          { trigger: "\\operatorname{sin}", notation: "function" },
          [INTEGER],
        ),
      ),
    ).toBe(false);
  });

  it("passes notation that cannot be typed, since nothing is read back", () => {
    expect(
      notationRoundTrips(operator("Wavy", "#1 \\mathrel{\\sim} #2", undefined, [INTEGER, INTEGER])),
    ).toBe(true);
  });

  it("gives the same verdict when asked again", () => {
    const declaration = operator(
      "Sine",
      "\\operatorname{sin}\\left(#1\\right)",
      { trigger: "\\operatorname{sin}", notation: "function" },
      [INTEGER],
    );
    expect(notationRoundTrips(declaration)).toBe(notationRoundTrips(declaration));
  });
});
