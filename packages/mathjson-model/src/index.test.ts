import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  canonicalJsonEquals,
  deepFreeze,
  isPlainMathJson,
  jsonValueEquals,
  mathJsonEquals,
  parsePlainMathJson,
  renderMathJson,
  type PlainMathJson,
} from "./index";

describe("plain MathJSON", () => {
  it("accepts array and object expression forms but rejects non-expression JSON", () => {
    expect(isPlainMathJson(["Equal", ["Add", "x", 1], 2])).toBe(true);
    expect(isPlainMathJson({ fn: ["Power", { sym: "x" }, { num: "2" }] })).toBe(true);
    expect(isPlainMathJson({ dict: { domain: "real", enabled: true } })).toBe(true);
    expect(isPlainMathJson([])).toBe(false);
    expect(isPlainMathJson([1, 2])).toBe(false);
    expect(isPlainMathJson(null)).toBe(false);
    expect(isPlainMathJson(Number.NaN)).toBe(false);
  });

  it("rejects ambiguous, cyclic, sparse, and accessor-backed runtime values", () => {
    expect(isPlainMathJson({ sym: "x", fn: ["Add", "x", 1] })).toBe(false);
    expect(isPlainMathJson({ sym: "x", unexpected: true })).toBe(false);
    expect(isPlainMathJson({ num: "not-a-number" })).toBe(false);
    expect(isPlainMathJson({ num: "1(3)" })).toBe(false);
    expect(isPlainMathJson({ num: "1.(3)" })).toBe(true);

    const cyclic: { fn: unknown[] } = { fn: ["Identity"] };
    cyclic.fn.push(cyclic);
    expect(isPlainMathJson(cyclic)).toBe(false);

    const sparse: unknown[] = new Array(4);
    sparse[0] = "Add";
    sparse[1] = "x";
    sparse[3] = 1;
    expect(isPlainMathJson(sparse)).toBe(false);

    const accessor = Object.defineProperty({}, "sym", {
      enumerable: true,
      get: () => "x",
    });
    expect(isPlainMathJson(accessor)).toBe(false);

    const sparseOffsets: unknown[] = new Array(2);
    expect(isPlainMathJson({ sym: "x", sourceOffsets: sparseOffsets })).toBe(false);

    let dictionaryGetterRead = false;
    const dictionary = Object.defineProperty({}, "entry", {
      enumerable: true,
      get: () => {
        dictionaryGetterRead = true;
        return 1;
      },
    });
    expect(isPlainMathJson({ dict: dictionary })).toBe(false);
    expect(dictionaryGetterRead).toBe(false);
  });

  it("preserves supported object metadata without canonicalizing it", () => {
    const expression = {
      fn: ["Equal", { fn: ["Add", "x", 1], latex: "x+1" }, { fn: ["Add", 1, "x"] }],
      comment: "keep operand order",
      sourceOffsets: [4, 12],
    } as const;

    expect(isPlainMathJson(expression)).toBe(true);
    const parsed = parsePlainMathJson(JSON.stringify(expression));
    expect(parsed).toEqual(expression);
  });

  it("parses only valid expression roots", () => {
    expect(parsePlainMathJson('["Add", "x", 1]')).toEqual(["Add", "x", 1]);
    expect(parsePlainMathJson("true")).toBeUndefined();
    expect(parsePlainMathJson("not json")).toBeUndefined();
  });

  it("compares nested array and object forms structurally", () => {
    const expression: PlainMathJson = { fn: ["Add", { sym: "x" }, 1], comment: "raw" };
    expect(mathJsonEquals(expression, { comment: "raw", fn: ["Add", { sym: "x" }, 1] })).toBe(true);
    expect(mathJsonEquals(expression, ["Add", "x", 1])).toBe(false);
  });
});

describe("plain data helpers", () => {
  it("compares plain JSON data regardless of key order", () => {
    expect(jsonValueEquals({ kind: "exact", path: [0, 1] }, { path: [0, 1], kind: "exact" })).toBe(
      true,
    );
    expect(jsonValueEquals({ a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 2 }] } })).toBe(true);
    expect(jsonValueEquals([0, 1], [1, 0])).toBe(false);
    expect(jsonValueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonValueEquals({ a: undefined }, {})).toBe(false);
    expect(jsonValueEquals([], {})).toBe(false);
    expect(jsonValueEquals(null, {})).toBe(false);
  });

  it("writes canonical JSON with sorted keys and a JSON.stringify undefined policy (golden)", () => {
    // Persisted digests and IDs hash these bytes; see also the artifact and menu-item goldens.
    expect(
      canonicalJson({
        z: [3, -1.5, 1e21, 0.1, -0, 2e-7, 123456789012345680000],
        a: {
          é: 'ünïcødé ∀x. x≥0   "quoted" \\ \n\t\u0001',
          "10": true,
          "2": false,
          "": null,
          B: "upper",
          b: "lower",
        },
        m: [["Add", 1, { sym: "x" }], { fn: ["Sin", "Pi"] }, [], {}],
        emoji: "😀 \ud800",
      }),
    ).toBe(
      '{"a":{"":null,"10":true,"2":false,"B":"upper","b":"lower",' +
        '"é":"ünïcødé ∀x. x≥0   \\"quoted\\" \\\\ \\n\\t\\u0001"},' +
        '"emoji":"😀 \\ud800",' +
        '"m":[["Add",1,{"sym":"x"}],{"fn":["Sin","Pi"]},[],{}],' +
        '"z":[3,-1.5,1e+21,0.1,0,2e-7,123456789012345680000]}',
    );
    expect(canonicalJson({ b: 1, a: undefined, c: [undefined, { d: undefined }] })).toBe(
      '{"b":1,"c":[null,{}]}',
    );
    const sparse: unknown[] = [1];
    sparse[2] = 2;
    expect(canonicalJson(sparse)).toBe(JSON.stringify(sparse));
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(Number.NaN)).toBe("null");
    expect(canonicalJsonEquals({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(canonicalJsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(canonicalJsonEquals([1, 2], [2, 1])).toBe(false);
  });

  it("is invariant under key permutation and agrees with jsonValueEquals (property)", () => {
    const permuted = (value: unknown, seed: number): unknown => {
      if (Array.isArray(value)) return value.map((item, index) => permuted(item, seed + index));
      if (typeof value !== "object" || value === null) return value;
      const entries = Object.entries(value).map(
        ([key, child], index) => [key, permuted(child, seed + index)] as const,
      );
      const rotation = entries.length === 0 ? 0 : seed % entries.length;
      const reordered = [...entries.slice(rotation), ...entries.slice(0, rotation)];
      return Object.fromEntries(seed % 2 === 0 ? reordered : reordered.reverse());
    };
    const json = fc.jsonValue({ maxDepth: 4 });
    fc.assert(
      fc.property(json, fc.nat(), (value, seed) => {
        const other = permuted(value, seed);
        expect(canonicalJson(other)).toBe(canonicalJson(value));
        expect(jsonValueEquals(other, value)).toBe(true);
        expect(JSON.parse(canonicalJson(value))).toEqual(value);
      }),
    );
    // Equal canonical text exactly when the values are structurally equal. The small domain makes
    // equal (but differently ordered) pairs common.
    const small = fc.letrec((tie) => ({
      leaf: fc.constantFrom<unknown>(0, 1, "a", "b", true, null),
      node: fc.oneof(
        { depthSize: "small" },
        tie("leaf"),
        fc.array(tie("node"), { maxLength: 2 }),
        fc.dictionary(fc.constantFrom("a", "b", "c"), tie("node"), { maxKeys: 3 }),
      ),
    })).node;
    const value = fc.oneof(json, small);
    fc.assert(
      fc.property(value, value, fc.nat(), (left, right, seed) => {
        expect(canonicalJson(left) === canonicalJson(permuted(right, seed))).toBe(
          jsonValueEquals(left, right),
        );
      }),
      { numRuns: 500 },
    );
  });

  it("freezes nested data in place, including cycles, and returns the same value", () => {
    const value: { inner: { list: number[] }; self?: unknown } = { inner: { list: [1, 2] } };
    value.self = value;
    expect(deepFreeze(value)).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.inner)).toBe(true);
    expect(Object.isFrozen(value.inner.list)).toBe(true);
    expect(deepFreeze(3)).toBe(3);
    expect(deepFreeze(null)).toBeNull();
  });
});

describe("Compute Engine boundary", () => {
  it("renders a noncanonical expression without replacing the source", () => {
    const expression = [
      "Equal",
      ["Add", ["Power", "x", 2], ["Multiply", 3, "y"], "z", "y"],
      12,
    ] as const satisfies PlainMathJson;
    const before = JSON.stringify(expression);

    const result = renderMathJson(expression);

    expect(result).toEqual({ ok: true, latex: "x^2+3y+z+y=12", diagnostics: [] });
    expect(JSON.stringify(expression)).toBe(before);
  });
});
