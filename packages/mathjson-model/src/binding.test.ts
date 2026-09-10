import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROPOSITION_SORT,
  freeSymbolNames,
  freshSymbolName,
  operatorDeclarationSchema,
  substituteMathJson,
  type PlainMathJson,
} from "./index";

const realSort = { kind: "named", id: "sort:real" } as const;

describe("lexical free-symbol analysis", () => {
  it("distinguishes bound operands, scoped operands, and variable function heads", () => {
    const expression: PlainMathJson = [
      "And",
      ["ForAll", "x", ["Equal", ["f", "x"], "y"]],
      ["P", "z"],
    ];

    expect(freeSymbolNames(expression)).toEqual(["P", "f", "y", "z"]);
  });

  it("honors only the declared scoped operands of custom binders", () => {
    const scoped = operatorDeclarationSchema.parse({
      id: "operator:scoped",
      symbol: "Scoped",
      signature: {
        parameters: [realSort, PROPOSITION_SORT, PROPOSITION_SORT],
        result: PROPOSITION_SORT,
      },
      binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
    });
    const expression: PlainMathJson = ["Scoped", "x", ["Equal", "x", "y"], ["Equal", "x", "z"]];

    expect(freeSymbolNames(expression, { operators: [scoped] })).toEqual(["x", "y", "z"]);
  });
});

describe("fresh symbol names", () => {
  it("uses deterministic suffixes and avoids reserved built-ins", () => {
    expect(freshSymbolName("x", new Set(["x", "x_1"]))).toBe("x_2");
    expect(freshSymbolName("Equal", new Set())).toBe("Equal_1");
    expect(freshSymbolName("available", [])).toBe("available");
  });
});

describe("capture-avoiding substitution", () => {
  it("alpha-renames a binder before inserting a free symbol", () => {
    const expression = ["ForAll", "y", ["Equal", "x", "y"]] as const;
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: "y" }]);

    expect(result).toEqual({
      ok: true,
      expression: ["ForAll", "y_1", ["Equal", "y", "y_1"]],
      alphaRenamings: [{ binderPath: [], from: "y", to: "y_1" }],
      diagnostics: [],
    });
    expect(expression).toEqual(["ForAll", "y", ["Equal", "x", "y"]]);
  });

  it("respects nested shadowing while avoiding capture at both binders", () => {
    const expression: PlainMathJson = [
      "ForAll",
      "y",
      ["And", ["Equal", "x", "y"], ["ForAll", "y", ["Equal", "x", "y"]]],
    ];
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: "y" }]);

    expect(result).toMatchObject({
      ok: true,
      expression: [
        "ForAll",
        "y_1",
        ["And", ["Equal", "y", "y_1"], ["ForAll", "y_2", ["Equal", "y", "y_2"]]],
      ],
      alphaRenamings: [
        { binderPath: [], from: "y", to: "y_1" },
        { binderPath: [1, 1], from: "y", to: "y_2" },
      ],
    });
  });

  it("does not substitute an occurrence shadowed by the current binder", () => {
    const expression = ["ForAll", "x", ["Equal", "x", "z"]] as const;
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: "y" }]);

    expect(result).toEqual({
      ok: true,
      expression,
      alphaRenamings: [],
      diagnostics: [],
    });
    expect(result.expression).toBe(expression);
  });

  it("substitutes outside, but not inside, a custom binder's scope", () => {
    const scoped = operatorDeclarationSchema.parse({
      id: "operator:scoped",
      symbol: "Scoped",
      signature: {
        parameters: [realSort, PROPOSITION_SORT, PROPOSITION_SORT],
        result: PROPOSITION_SORT,
      },
      binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
    });
    const expression: PlainMathJson = ["Scoped", "z", ["Equal", "z", "x"], ["Equal", "z", "x"]];
    const result = substituteMathJson(
      expression,
      [
        { symbol: "z", replacement: "w" },
        { symbol: "x", replacement: 1 },
      ],
      { operators: [scoped] },
    );

    expect(result).toMatchObject({
      ok: true,
      expression: ["Scoped", "z", ["Equal", "z", 1], ["Equal", "w", 1]],
    });
  });

  it("chooses a fresh binder name that avoids every existing symbol", () => {
    const expression: PlainMathJson = [
      "ForAll",
      "y",
      ["And", ["Equal", "x", "y"], ["Equal", "y_1", "y_1"]],
    ];
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: "y" }]);

    expect(result).toMatchObject({
      ok: true,
      expression: ["ForAll", "y_2", ["And", ["Equal", "y", "y_2"], ["Equal", "y_1", "y_1"]]],
    });
  });

  it("also avoids custom operator names that are absent from the expression", () => {
    const reservedFreshName = operatorDeclarationSchema.parse({
      id: "operator:y-1",
      symbol: "y_1",
      signature: { parameters: [realSort], result: realSort },
    });
    const result = substituteMathJson(
      ["ForAll", "y", ["Equal", "x", "y"]],
      [{ symbol: "x", replacement: "y" }],
      { operators: [reservedFreshName] },
    );

    expect(result).toMatchObject({
      ok: true,
      expression: ["ForAll", "y_2", ["Equal", "y", "y_2"]],
    });
  });

  it("performs simultaneous swaps without rewriting the replacements", () => {
    expect(
      substituteMathJson(
        ["Equal", "x", "y"],
        [
          { symbol: "x", replacement: "y" },
          { symbol: "y", replacement: "x" },
        ],
      ),
    ).toMatchObject({ ok: true, expression: ["Equal", "y", "x"] });
  });

  it("renames variable function heads only with symbol replacements", () => {
    const expression = ["f", "x"] as const;
    expect(
      substituteMathJson(expression, [
        { symbol: "f", replacement: "g" },
        { symbol: "x", replacement: "y" },
      ]),
    ).toMatchObject({ ok: true, expression: ["g", "y"] });

    const rejected = substituteMathJson(expression, [
      { symbol: "f", replacement: ["Add", "x", 1] },
    ]);
    expect(rejected).toMatchObject({
      ok: false,
      expression,
      alphaRenamings: [],
      diagnostics: [{ code: "invalid-operator-replacement", path: [], symbol: "f" }],
    });
    expect(rejected.expression).toBe(expression);

    const objectSymbol = substituteMathJson(expression, [
      { symbol: "f", replacement: { sym: "g" } },
    ]);
    expect(objectSymbol).toMatchObject({
      ok: false,
      expression,
      alphaRenamings: [],
      diagnostics: [{ code: "invalid-operator-replacement", path: [], symbol: "f" }],
    });
    expect(objectSymbol.expression).toBe(expression);
  });

  it("rejects binder-introducing function-head replacements", () => {
    const expression = ["f", "x", ["Equal", "x", "y"]] as const;
    const builtin = substituteMathJson(expression, [{ symbol: "f", replacement: "ForAll" }]);
    expect(builtin).toMatchObject({
      ok: false,
      expression,
      diagnostics: [{ code: "invalid-operator-replacement", symbol: "f" }],
    });
    expect(builtin.expression).toBe(expression);

    const scoped = operatorDeclarationSchema.parse({
      id: "operator:scoped-head",
      symbol: "ScopedHead",
      signature: { parameters: [realSort, PROPOSITION_SORT], result: PROPOSITION_SORT },
      binder: { kind: "direct-symbols", boundOperands: [0], scopedOperands: [1] },
    });
    expect(
      substituteMathJson(expression, [{ symbol: "f", replacement: "ScopedHead" }], {
        operators: [scoped],
      }),
    ).toMatchObject({ ok: false, expression });
  });

  it("preserves object-form metadata during alpha-renaming and replacement", () => {
    const expression = {
      fn: [
        "ForAll",
        { sym: "y", comment: "binder" },
        {
          fn: ["Equal", { sym: "x", comment: "target" }, { sym: "y", latex: "y" }],
          comment: "body",
        },
      ],
      documentation: "quantified statement",
    } as const satisfies PlainMathJson;
    const before = JSON.stringify(expression);
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: "y" }]);

    expect(result).toMatchObject({
      ok: true,
      expression: {
        fn: [
          "ForAll",
          { sym: "y_1", comment: "binder" },
          {
            fn: ["Equal", "y", { sym: "y_1", latex: "y" }],
            comment: "body",
          },
        ],
        documentation: "quantified statement",
      },
    });
    expect(JSON.stringify(expression)).toBe(before);
  });

  it("rejects malformed binders atomically", () => {
    const expression = ["ForAll", "True", ["Equal", "x", 1]] as const;
    const result = substituteMathJson(expression, [{ symbol: "x", replacement: 2 }]);

    expect(result).toMatchObject({
      ok: false,
      expression,
      diagnostics: [{ code: "invalid-binder", symbol: "True" }],
    });
    expect(result.expression).toBe(expression);
  });

  it("preflights binder arity even for empty substitutions and replacement payloads", () => {
    const missingBody = ["ForAll", "x"] as const;
    const excessOperand = ["ForAll", "x", ["Equal", "x", "x"], "True"] as const;

    const missingResult = substituteMathJson(missingBody, []);
    expect(missingResult).toMatchObject({
      ok: false,
      expression: missingBody,
      diagnostics: [{ code: "invalid-binder", symbol: "ForAll" }],
    });
    expect(substituteMathJson(excessOperand, [])).toMatchObject({
      ok: false,
      expression: excessOperand,
      diagnostics: [{ code: "invalid-binder", symbol: "ForAll" }],
    });

    const expression = ["Equal", "x", "y"] as const;
    const malformedReplacement = substituteMathJson(expression, [
      { symbol: "x", replacement: ["ForAll", "True", "y"] },
    ]);
    expect(malformedReplacement).toMatchObject({
      ok: false,
      expression,
      alphaRenamings: [],
      diagnostics: [{ code: "invalid-binder", symbol: "True" }],
    });
    expect(malformedReplacement.expression).toBe(expression);
  });

  it("discards earlier alpha-renamings when a later occurrence rejects", () => {
    const expression: PlainMathJson = ["ForAll", "y", ["And", ["Equal", "x", "y"], ["f", "z"]]];
    const result = substituteMathJson(expression, [
      { symbol: "x", replacement: "y" },
      { symbol: "f", replacement: "ForAll" },
    ]);

    expect(result).toMatchObject({
      ok: false,
      expression,
      alphaRenamings: [],
      diagnostics: [{ code: "invalid-operator-replacement", symbol: "f" }],
    });
    expect(result.expression).toBe(expression);
  });

  it("capture-avoids multiple direct-symbol binder operands", () => {
    const bindPair = operatorDeclarationSchema.parse({
      id: "operator:bind-pair",
      symbol: "BindPair",
      signature: {
        parameters: [realSort, realSort, PROPOSITION_SORT],
        result: PROPOSITION_SORT,
      },
      binder: { kind: "direct-symbols", boundOperands: [0, 1], scopedOperands: [2] },
    });
    const result = substituteMathJson(
      ["BindPair", "a", "b", ["Equal", "x", "b"]],
      [{ symbol: "x", replacement: "a" }],
      { operators: [bindPair] },
    );

    expect(result).toMatchObject({
      ok: true,
      expression: ["BindPair", "a_1", "b", ["Equal", "a", "b"]],
      alphaRenamings: [{ binderPath: [], from: "a", to: "a_1" }],
    });
  });

  it("is independent of simultaneous-substitution entry order", () => {
    const expression: PlainMathJson = [
      "ForAll",
      "z",
      ["And", ["Equal", "x", "z"], ["Equal", "y", "z"]],
    ];
    const forward = substituteMathJson(expression, [
      { symbol: "x", replacement: "z" },
      { symbol: "y", replacement: 1 },
    ]);
    const reverse = substituteMathJson(expression, [
      { symbol: "y", replacement: 1 },
      { symbol: "x", replacement: "z" },
    ]);

    expect(forward).toEqual(reverse);
  });

  it("keeps an inserted free symbol free for arbitrary distinct names", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
        (target, binder, replacement) => {
          fc.pre(target !== binder && target !== replacement && binder !== replacement);
          const expression: PlainMathJson = ["ForAll", binder, ["Equal", target, binder]];
          const result = substituteMathJson(expression, [{ symbol: target, replacement }]);
          expect(result.ok).toBe(true);
          if (result.ok) expect(freeSymbolNames(result.expression)).toContain(replacement);
        },
      ),
    );
  });

  it("preserves a colliding replacement as free under arbitrary binders", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
        fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/),
        (target, binder) => {
          fc.pre(target !== binder);
          const expression: PlainMathJson = ["ForAll", binder, ["Equal", target, binder]];
          const result = substituteMathJson(expression, [{ symbol: target, replacement: binder }]);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(freeSymbolNames(result.expression)).toContain(binder);
          expect((result.expression as readonly PlainMathJson[])[1]).not.toBe(binder);
        },
      ),
    );
  });
});
