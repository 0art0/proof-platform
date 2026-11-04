import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { backgroundProposalSchema, type BackgroundProposal } from "@proof/llm";
import { problemSetupSort } from "@proof/protocol";
import { amendBackgroundProposal } from "./background-amendment";

const PROFILE = {
  level: "first-year undergraduate",
  summary: "Elementary number theory.",
  assumptions: ["Divisibility of integers"],
};

function constant(index: number) {
  return {
    operator: {
      id: `operator:c${index}`,
      symbol: `C${index}`,
      signature: {
        parameters: [problemSetupSort("integer"), problemSetupSort("integer")],
        result: { kind: "proposition" },
      },
      presentation: {
        displayName: `relation ${index}`,
        latex: {
          template: String.raw`\operatorname{C${index}}\left(#1, #2\right)`,
          precedence: "atom",
          parse: { trigger: String.raw`\operatorname{C${index}}`, notation: "function" },
        },
        naturalLanguage: [{ template: `#1 is related${index} to #2` }],
      },
    },
    rationale: `Constant ${index}.`,
  };
}

function proposal(size: number): BackgroundProposal {
  return backgroundProposalSchema.parse({
    kind: "background-proposal",
    background: PROFILE,
    constants: Array.from({ length: size }, (_, index) => constant(index)),
  });
}

/** A presentation-only edit: new display name and notation, same ID, symbol and signature. */
function restyled(operator: BackgroundProposal["constants"][number]["operator"], name: string) {
  return {
    ...operator,
    presentation: {
      displayName: name,
      latex: {
        template: String.raw`\operatorname{${name}}\left(#1, #2\right)`,
        precedence: "atom" as const,
        parse: { trigger: String.raw`\operatorname{${name}}`, notation: "function" as const },
      },
      naturalLanguage: [{ template: `#1 ${name} #2` }],
    },
  };
}

describe("background amendments", () => {
  it("accepts any removal and any presentation-only edit, keeping the proposal's order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }).chain((size) =>
          fc.tuple(
            fc.constant(size),
            fc.subarray(Array.from({ length: size }, (_, index) => index)),
            fc.uniqueArray(fc.stringMatching(/^[a-z]{2,8}$/), { minLength: size, maxLength: size }),
          ),
        ),
        ([size, kept, names]) => {
          const original = proposal(size);
          // The kept constants are sent in reverse: order is the proposal's, not the request's.
          const edits = [...kept]
            .reverse()
            .map((index) => restyled(original.constants[index]!.operator, `x${names[index]}`));
          const amended = amendBackgroundProposal(original, {
            background: { ...PROFILE, level: "secondary school" },
            constants: edits,
          });
          expect(amended.ok).toBe(true);
          if (!amended.ok) return;
          expect(amended.amended.background.level).toBe("secondary school");
          expect(amended.amended.constants.map(({ operator }) => operator.symbol)).toEqual(
            kept.map((index) => `C${index}`),
          );
          expect(amended.amended.constants.map(({ rationale }) => rationale)).toEqual(
            kept.map((index) => `Constant ${index}.`),
          );
        },
      ),
      { numRuns: 80 },
    );
  });

  it("refuses a renamed symbol, an added constant and a repeated edit", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5 }), fc.nat(), (size, pick) => {
        const original = proposal(size);
        const target = original.constants[pick % size]!.operator;
        const renamed = amendBackgroundProposal(original, {
          background: PROFILE,
          constants: [{ ...target, symbol: `${target.symbol}Renamed` }],
        });
        expect(renamed).toMatchObject({ ok: false });
        const added = amendBackgroundProposal(original, {
          background: PROFILE,
          constants: [restyled({ ...target, id: "operator:added" as typeof target.id }, "added")],
        });
        expect(added).toMatchObject({ ok: false });
        const twice = amendBackgroundProposal(original, {
          background: PROFILE,
          constants: [target, target],
        });
        expect(twice).toMatchObject({ ok: false });
      }),
      { numRuns: 40 },
    );
  });

  it("refuses two kept constants that share a trigger after the edit", () => {
    const original = proposal(2);
    const [first, second] = original.constants.map(({ operator }) => operator);
    const amended = amendBackgroundProposal(original, {
      background: PROFILE,
      constants: [restyled(first!, "same"), restyled(second!, "same")],
    });
    expect(amended).toMatchObject({ ok: false });
  });
});
