import { z } from "zod";
import {
  plainMathJsonSchema,
  stableIdentifierSchema,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";
import { symbolName } from "./expression";

export const nounPhraseSchema = z
  .object({
    singular: z.string().min(1),
    plural: z.string().min(1).optional(),
    article: z.enum(["a", "an"]).optional(),
  })
  .strict();
export type NounPhrase = z.infer<typeof nounPhraseSchema>;

/** An exact MathJSON→text entry, compared structurally (`{sym}`/`{fn}` forms are equivalent). */
export const exactEntrySchema = z
  .object({ expression: plainMathJsonSchema, text: z.string().min(1) })
  .strict();
export type ExactEntry = z.infer<typeof exactEntrySchema>;

const PATTERN_PLACEHOLDER = /(?<!\\)#([A-Za-z][A-Za-z0-9]*)/g;

function wildcardNames(pattern: PlainMathJson, names: Set<string> = new Set()): Set<string> {
  if (Array.isArray(pattern)) {
    pattern.forEach((item) => wildcardNames(item as PlainMathJson, names));
    return names;
  }
  const symbol = symbolName(pattern);
  if (symbol !== undefined && symbol.startsWith("_") && symbol.length > 1) {
    names.add(symbol.slice(1));
  }
  return names;
}

/**
 * A pattern entry. Symbols starting with `_` in `pattern` are wildcards (`_n`); a repeated
 * wildcard must match equal subexpressions. `#n` in the template refers to wildcard `_n`.
 */
export const patternEntrySchema = z
  .object({ pattern: plainMathJsonSchema, template: z.string().min(1) })
  .strict()
  .superRefine((entry, context) => {
    const names = wildcardNames(entry.pattern);
    for (const match of entry.template.matchAll(PATTERN_PLACEHOLDER)) {
      const name = match[1] ?? "";
      if (!names.has(name)) {
        context.addIssue({
          code: "custom",
          message: `Placeholder #${name} does not name a wildcard of the pattern.`,
          path: ["template"],
        });
      }
    }
  });
export type PatternEntry = z.infer<typeof patternEntrySchema>;

/**
 * A natural-language dictionary or domain terminology pack. `sortNouns` name the members of a
 * sort by sort ID; `setNouns` name the members of a set symbol, used for `x ∈ S` and typed binders.
 */
export const naturalLanguageDictionarySchema = z
  .object({
    id: stableIdentifierSchema,
    domain: z.string().min(1).optional(),
    exact: z.array(exactEntrySchema).optional(),
    patterns: z.array(patternEntrySchema).optional(),
    sortNouns: z.record(z.string().min(1), nounPhraseSchema).optional(),
    setNouns: z.record(z.string().min(1), nounPhraseSchema).optional(),
  })
  .strict();
export type NaturalLanguageDictionary = z.infer<typeof naturalLanguageDictionarySchema>;

export function patternTemplatePlaceholder(): RegExp {
  return new RegExp(PATTERN_PLACEHOLDER.source, "g");
}

const BUILTIN_SORT_NOUNS: Readonly<Record<string, NounPhrase>> = Object.freeze({
  "sort:natural": { singular: "natural number" },
  "sort:integer": { singular: "integer" },
  "sort:rational": { singular: "rational number" },
  "sort:real": { singular: "real number" },
  "sort:complex": { singular: "complex number" },
  "sort:string": { singular: "string" },
});

const BUILTIN_SET_NOUNS: Readonly<Record<string, NounPhrase>> = Object.freeze({
  NonNegativeIntegers: { singular: "natural number" },
  NaturalNumbers: { singular: "natural number" },
  PositiveIntegers: { singular: "positive integer" },
  Integers: { singular: "integer" },
  RationalNumbers: { singular: "rational number" },
  RealNumbers: { singular: "real number" },
  ComplexNumbers: { singular: "complex number" },
});

/** A small example pack for elementary number theory. */
export const NUMBER_THEORY_PACK: NaturalLanguageDictionary = Object.freeze(
  naturalLanguageDictionarySchema.parse({
    id: "pack:number-theory",
    domain: "number theory",
    setNouns: { Primes: { singular: "prime" } },
    patterns: [
      { pattern: ["Equal", ["Mod", "_n", 2], 0], template: "#n is even" },
      { pattern: ["Equal", ["Mod", "_n", 2], 1], template: "#n is odd" },
      { pattern: ["Equal", ["GCD", "_a", "_b"], 1], template: "#a and #b are coprime" },
    ],
  }),
);

const IRREGULAR_PLURALS: Readonly<Record<string, string>> = Object.freeze({
  matrix: "matrices",
  vertex: "vertices",
  index: "indices",
  radius: "radii",
  child: "children",
});

export function pluralize(singular: string): string {
  const words = singular.split(" ");
  const last = words.pop() ?? "";
  const irregular = IRREGULAR_PLURALS[last];
  const plural =
    irregular ??
    (/[^aeiou]y$/.test(last)
      ? `${last.slice(0, -1)}ies`
      : /(?:s|x|z|ch|sh)$/.test(last)
        ? `${last}es`
        : `${last}s`);
  return [...words, plural].join(" ");
}

export function pluralOf(noun: NounPhrase): string {
  return noun.plural ?? pluralize(noun.singular);
}

export function articleFor(noun: NounPhrase): "a" | "an" {
  if (noun.article !== undefined) return noun.article;
  const word = noun.singular.toLowerCase();
  if (/^(?:uni|use|usu|uti|eu|one)/.test(word)) return "a";
  if (/^(?:hour|honest|honou?r)/.test(word)) return "an";
  return /^[aeiou]/.test(word) ? "an" : "a";
}

export type Terminology = Readonly<{
  sortNoun(sort: Sort): NounPhrase | undefined;
  setNoun(set: PlainMathJson): NounPhrase | undefined;
}>;

/** Earlier dictionaries take precedence over later ones and over the built-in nouns. */
export function createTerminology(dictionaries: readonly NaturalLanguageDictionary[]): Terminology {
  const lookup = (
    field: "sortNouns" | "setNouns",
    key: string,
    builtins: Readonly<Record<string, NounPhrase>>,
  ): NounPhrase | undefined => {
    for (const dictionary of dictionaries) {
      const noun = dictionary[field]?.[key];
      if (noun !== undefined) return noun;
    }
    return Object.hasOwn(builtins, key) ? builtins[key] : undefined;
  };

  const sortNoun = (sort: Sort): NounPhrase | undefined => {
    if (sort.kind === "proposition") return { singular: "proposition" };
    if (sort.kind === "function") {
      return sort.signature.result.kind === "proposition"
        ? { singular: "predicate" }
        : { singular: "function" };
    }
    const known = lookup("sortNouns", sort.id, BUILTIN_SORT_NOUNS);
    if (known !== undefined) return known;
    if (sort.id === "sort:set") {
      const member = sort.arguments?.[0];
      const memberNoun = member === undefined ? undefined : sortNoun(member);
      return memberNoun === undefined
        ? { singular: "set" }
        : { singular: `set of ${pluralOf(memberNoun)}`, plural: `sets of ${pluralOf(memberNoun)}` };
    }
    const derived = sort.id
      .replace(/^sort:/, "")
      .replace(/[-_.:/]+/g, " ")
      .trim();
    return derived.length === 0 ? undefined : { singular: derived };
  };

  const setNoun = (set: PlainMathJson): NounPhrase | undefined => {
    const symbol = symbolName(set);
    return symbol === undefined ? undefined : lookup("setNouns", symbol, BUILTIN_SET_NOUNS);
  };

  return Object.freeze({ sortNoun, setNoun });
}
