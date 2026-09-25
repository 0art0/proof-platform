import { z } from "zod";
import {
  isPlainMathJson,
  operatorTemplateSegments,
  type OperatorDeclaration,
  type OperatorNaturalLanguageTemplate,
  type PlainMathJson,
  type Sort,
} from "@proof/mathjson-model";
import { expressionParts, matchPattern, structurallyEqual, symbolName } from "./expression";
import { createLatexRenderer, type LatexRenderer } from "./latex";
import {
  articleFor,
  createTerminology,
  exactEntrySchema,
  naturalLanguageDictionarySchema,
  patternTemplatePlaceholder,
  pluralOf,
  type ExactEntry,
  type NaturalLanguageDictionary,
  type NounPhrase,
} from "./terminology";

export type NaturalLanguageContext = Readonly<{
  /** Declarations in scope; they supply sort nouns for quantified variables. */
  declarations?: readonly Readonly<{ symbol: string; sort: Sort }>[];
  /** Problem-local overrides; they take precedence over every other rule. */
  overrides?: readonly ExactEntry[];
}>;

export type NaturalLanguageRendererOptions = Readonly<{
  /** Ignored when `latex` is supplied; the LaTeX renderer's operators are used instead. */
  operators?: readonly OperatorDeclaration[];
  latex?: LatexRenderer;
  /** Earlier dictionaries take precedence over later ones. */
  dictionaries?: readonly NaturalLanguageDictionary[];
  overrides?: readonly ExactEntry[];
  /** `words`: "$x$ is less than $y$"; `symbols`: "$x < y$". */
  relationStyle?: "words" | "symbols";
}>;

export type NaturalLanguageRenderer = Readonly<{
  /** Render a proposition as a clause. Total: unknown constructs become inline LaTeX. */
  statement(expression: PlainMathJson, context?: NaturalLanguageContext): string;
  /** Render a term as a noun phrase or inline LaTeX. */
  term(expression: PlainMathJson, context?: NaturalLanguageContext): string;
}>;

/**
 * `open` clauses can absorb following text ("A and B", "if A, then B"), so they are grouped
 * when they are not the last component of their parent. `comma` marks clause-level commas.
 */
type Clause = Readonly<{ text: string; open: boolean; comma: boolean; kind: ClauseKind }>;
type ClauseKind =
  "atom" | "coordination" | "negation" | "conditional" | "biconditional" | "quantified";

type TemplateSlot = Readonly<{ expression: PlainMathJson; proposition: boolean }>;
type TemplatePart =
  Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "slot"; slot: TemplateSlot }>;

type Binder = Readonly<{ variable: string; noun: NounPhrase | undefined; suffix: string }>;

const RELATION_WORDS: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  Equal: ["is equal to", "is not equal to"],
  NotEqual: ["is not equal to", "is equal to"],
  Less: ["is less than", "is not less than"],
  LessEqual: ["is less than or equal to", "is not less than or equal to"],
  Greater: ["is greater than", "is not greater than"],
  GreaterEqual: ["is greater than or equal to", "is not greater than or equal to"],
  Element: ["is an element of", "is not an element of"],
  NotElement: ["is not an element of", "is an element of"],
  Subset: ["is a proper subset of", "is not a proper subset of"],
  SubsetEqual: ["is a subset of", "is not a subset of"],
  Superset: ["is a proper superset of", "is not a proper superset of"],
  SupersetEqual: ["is a superset of", "is not a superset of"],
});

const NEGATED_RELATION_LATEX: Readonly<Record<string, string>> = Object.freeze({
  Equal: "\\neq",
  NotEqual: "=",
  Less: "\\not<",
  LessEqual: "\\not\\le",
  Greater: "\\not>",
  GreaterEqual: "\\not\\ge",
  Element: "\\notin",
  NotElement: "\\in",
  Subset: "\\not\\subset",
  SubsetEqual: "\\not\\subseteq",
  Superset: "\\not\\supset",
  SupersetEqual: "\\not\\supseteq",
});

const STATEMENT_HEADS = new Set([
  "Not",
  "And",
  "Or",
  "Implies",
  "Equivalent",
  "ForAll",
  "Exists",
  ...Object.keys(RELATION_WORDS),
]);

function atomClause(text: string): Clause {
  return { text, open: false, comma: false, kind: "atom" };
}

function joinList(items: readonly string[], conjunction: string): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0] ?? ""} ${conjunction} ${items[1] ?? ""}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items[items.length - 1] ?? ""}`;
}

function grouped(clause: Clause): string {
  return clause.open ? `(${clause.text})` : clause.text;
}

const exactEntriesSchema = z.array(exactEntrySchema);

export function createNaturalLanguageRenderer(
  options: NaturalLanguageRendererOptions = {},
): NaturalLanguageRenderer {
  const latex = options.latex ?? createLatexRenderer({ operators: options.operators ?? [] });
  const operators = new Map(latex.operators.map((operator) => [operator.symbol, operator]));
  const dictionaries = z.array(naturalLanguageDictionarySchema).parse(options.dictionaries ?? []);
  const globalOverrides = exactEntriesSchema.parse(options.overrides ?? []);
  const terminology = createTerminology(dictionaries);
  const relationStyle = options.relationStyle ?? "words";

  const createSession = (context: NaturalLanguageContext) => {
    const overrides = [...exactEntriesSchema.parse(context.overrides ?? []), ...globalOverrides];
    const sorts = new Map((context.declarations ?? []).map((item) => [item.symbol, item.sort]));
    const inlineMath = (expression: PlainMathJson): string => `$${latex.serialize(expression)}$`;

    /** override > exact > pattern; operator and constructor rules follow in the callers. */
    const dictionaryText = (expression: PlainMathJson): string | undefined => {
      for (const entry of overrides) {
        if (structurallyEqual(entry.expression, expression)) return entry.text;
      }
      for (const dictionary of dictionaries) {
        for (const entry of dictionary.exact ?? []) {
          if (structurallyEqual(entry.expression, expression)) return entry.text;
        }
      }
      for (const dictionary of dictionaries) {
        for (const entry of dictionary.patterns ?? []) {
          const bindings = matchPattern(entry.pattern, expression);
          if (bindings !== undefined) return renderPatternTemplate(entry.template, bindings);
        }
      }
      return undefined;
    };

    const renderPatternTemplate = (
      template: string,
      bindings: ReadonlyMap<string, PlainMathJson>,
    ): string => {
      const parts: TemplatePart[] = [];
      let last = 0;
      for (const match of template.matchAll(patternTemplatePlaceholder())) {
        const bound = bindings.get(match[1] ?? "");
        if (bound === undefined) continue;
        parts.push({ kind: "text", text: template.slice(last, match.index) });
        parts.push({
          kind: "slot",
          slot: { expression: bound, proposition: isStatementLike(bound) },
        });
        last = match.index + match[0].length;
      }
      parts.push({ kind: "text", text: template.slice(last) });
      return renderTemplate(parts);
    };

    const renderOperatorTemplate = (
      operator: OperatorDeclaration,
      template: string,
      operands: readonly PlainMathJson[],
    ): string | undefined => {
      const segments = operatorTemplateSegments(template);
      if (segments === undefined || operands.length !== operator.signature.parameters.length) {
        return undefined;
      }
      return renderTemplate(
        segments.map((segment) =>
          segment.kind === "text"
            ? segment
            : {
                kind: "slot",
                slot: {
                  expression: operands[segment.index] as PlainMathJson,
                  proposition: operator.signature.parameters[segment.index]?.kind === "proposition",
                },
              },
        ),
      );
    };

    /** Placeholders inside `$...$` receive raw LaTeX; elsewhere natural language. */
    const renderTemplate = (parts: readonly TemplatePart[]): string => {
      let mathMode = false;
      return parts
        .map((part) => {
          if (part.kind === "text") {
            mathMode = part.text.split(/(?<!\\)\$/).length % 2 === 0 ? !mathMode : mathMode;
            return part.text;
          }
          if (mathMode) return latex.serialize(part.slot.expression);
          return part.slot.proposition
            ? grouped(statement(part.slot.expression, false))
            : term(part.slot.expression);
        })
        .join("");
    };

    const operatorTemplate = (
      expression: PlainMathJson,
    ):
      | Readonly<{
          operator: OperatorDeclaration;
          template: OperatorNaturalLanguageTemplate;
          operands: readonly PlainMathJson[];
        }>
      | undefined => {
      const parts = expressionParts(expression);
      const operator = parts === undefined ? undefined : operators.get(parts.operator);
      const template = operator?.presentation?.naturalLanguage?.[0];
      return parts === undefined || operator === undefined || template === undefined
        ? undefined
        : { operator, template, operands: parts.operands };
    };

    const isStatementLike = (expression: PlainMathJson): boolean => {
      const symbol = symbolName(expression);
      if (symbol !== undefined) {
        return symbol === "True" || symbol === "False" || sorts.get(symbol)?.kind === "proposition";
      }
      const parts = expressionParts(expression);
      if (parts === undefined) return false;
      if (STATEMENT_HEADS.has(parts.operator)) return true;
      const operatorResult = operators.get(parts.operator)?.signature.result;
      const declared = sorts.get(parts.operator);
      const result =
        operatorResult ?? (declared?.kind === "function" ? declared.signature.result : undefined);
      return result?.kind === "proposition";
    };

    const term = (expression: PlainMathJson): string => {
      const text = dictionaryText(expression);
      if (text !== undefined) return text;
      const custom = operatorTemplate(expression);
      if (custom !== undefined && custom.operator.signature.result.kind !== "proposition") {
        const rendered = renderOperatorTemplate(
          custom.operator,
          custom.template.template,
          custom.operands,
        );
        if (rendered !== undefined) return rendered;
      }
      return inlineMath(expression);
    };

    const relation = (expression: PlainMathJson, negated: boolean): string | undefined => {
      const parts = expressionParts(expression);
      if (parts === undefined) return undefined;
      const words = RELATION_WORDS[parts.operator];
      if (words === undefined) return undefined;
      const [left, right] = parts.operands;
      if (parts.operands.length !== 2 || left === undefined || right === undefined) {
        return negated || parts.operands.length < 2 ? undefined : inlineMath(expression);
      }
      if (relationStyle === "symbols") {
        if (!negated) return inlineMath(expression);
        const command = NEGATED_RELATION_LATEX[parts.operator] ?? "";
        return `$${latex.serialize(left)} ${command} ${latex.serialize(right)}$`;
      }
      const setNoun =
        parts.operator === "Element" || parts.operator === "NotElement"
          ? terminology.setNoun(right)
          : undefined;
      if (setNoun !== undefined) {
        const positive = (parts.operator === "Element") !== negated;
        return `${term(left)} is ${positive ? "" : "not "}${articleFor(setNoun)} ${setNoun.singular}`;
      }
      return `${term(left)} ${words[negated ? 1 : 0]} ${term(right)}`;
    };

    const binder = (expression: PlainMathJson): Binder => {
      const symbol = symbolName(expression);
      if (symbol !== undefined) {
        const sort = sorts.get(symbol);
        return {
          variable: inlineMath(expression),
          noun: sort === undefined ? undefined : terminology.sortNoun(sort),
          suffix: "",
        };
      }
      const parts = expressionParts(expression);
      const [variable, set] = parts?.operands ?? [];
      if (parts?.operator === "Element" && variable !== undefined && set !== undefined) {
        const noun = terminology.setNoun(set);
        return noun === undefined
          ? {
              variable: inlineMath(variable),
              noun: { singular: "element" },
              suffix: ` of ${term(set)}`,
            }
          : { variable: inlineMath(variable), noun, suffix: "" };
      }
      return { variable: inlineMath(expression), noun: undefined, suffix: "" };
    };

    const quantifierChain = (
      quantifier: "ForAll" | "Exists",
      expression: PlainMathJson,
    ): Readonly<{ groups: readonly (readonly Binder[])[]; body: PlainMathJson; count: number }> => {
      const binders: Binder[] = [];
      let current = expression;
      for (;;) {
        const parts = expressionParts(current);
        const [bound, body] = parts?.operands ?? [];
        if (
          parts?.operator !== quantifier ||
          parts.operands.length !== 2 ||
          bound === undefined ||
          body === undefined ||
          (current !== expression && dictionaryText(current) !== undefined)
        ) {
          break;
        }
        binders.push(binder(bound));
        current = body;
      }
      const groups: Binder[][] = [];
      const keyOf = (item: Binder) => `${item.noun?.singular ?? ""}\u0000${item.suffix}`;
      for (const item of binders) {
        const group = groups[groups.length - 1];
        const previous = group?.[0];
        if (group !== undefined && previous !== undefined && keyOf(previous) === keyOf(item)) {
          group.push(item);
        } else {
          groups.push([item]);
        }
      }
      return { groups, body: current, count: binders.length };
    };

    const variables = (group: readonly Binder[]): string =>
      joinList(
        group.map((item) => item.variable),
        "and",
      );

    const universal = (expression: PlainMathJson): Clause => {
      const chain = quantifierChain("ForAll", expression);
      const phrases = chain.groups.map((group) => {
        const noun = group[0]?.noun;
        const suffix = group[0]?.suffix ?? "";
        if (group.length === 1) {
          return `every ${noun === undefined ? "" : `${noun.singular} `}${variables(group)}${suffix}`;
        }
        return `all ${noun === undefined ? "" : `${pluralOf(noun)} `}${variables(group)}${suffix}`;
      });
      const body = statement(chain.body, false);
      return {
        text: `for ${joinList(phrases, "and")}, ${body.text}`,
        open: true,
        comma: true,
        kind: "quantified",
      };
    };

    const existentialPhrases = (
      groups: readonly (readonly Binder[])[],
      negated: boolean,
    ): string[] =>
      groups.map((group) => {
        const noun = group[0]?.noun;
        const suffix = group[0]?.suffix ?? "";
        if (noun === undefined) return `${variables(group)}${suffix}`;
        if (group.length > 1) return `${pluralOf(noun)} ${variables(group)}${suffix}`;
        const article = negated ? "" : `${articleFor(noun)} `;
        return `${article}${noun.singular} ${variables(group)}${suffix}`;
      });

    const existential = (expression: PlainMathJson, negated: boolean): Clause => {
      const chain = quantifierChain("Exists", expression);
      const phrases = joinList(existentialPhrases(chain.groups, negated), "and");
      const lead = negated
        ? chain.count === 1
          ? "there is no"
          : "there are no"
        : chain.count === 1
          ? "there exists"
          : "there exist";
      const body = statement(chain.body, false);
      return {
        text: `${lead} ${phrases} such that ${body.text}`,
        open: true,
        comma: body.comma,
        kind: "quantified",
      };
    };

    const coordination = (
      head: "And" | "Or",
      operands: readonly PlainMathJson[],
      marked: boolean,
    ): Clause => {
      const children = operands.map((operand) => {
        const operator = expressionParts(operand)?.operator;
        return statement(operand, operator === "And" || operator === "Or");
      });
      const last = children[children.length - 1];
      const texts = children.map((child, index) =>
        index < children.length - 1 ? grouped(child) : child.text,
      );
      const joined = joinList(texts, head === "And" ? "and" : "or");
      const comma = children.length > 2 || children.some((child) => child.comma);
      if (!marked) return { text: joined, open: true, comma, kind: "coordination" };
      if (children.length === 2) {
        return {
          text: `${head === "And" ? "both" : "either"} ${joined}`,
          open: last?.open ?? false,
          comma,
          kind: "coordination",
        };
      }
      return { text: `(${joined})`, open: false, comma, kind: "coordination" };
    };

    const negation = (inner: PlainMathJson): Clause => {
      if (dictionaryText(inner) === undefined) {
        const negatedRelation = relation(inner, true);
        if (negatedRelation !== undefined) return atomClause(negatedRelation);
        const custom = operatorTemplate(inner);
        if (custom?.template.negated !== undefined) {
          const rendered = renderOperatorTemplate(
            custom.operator,
            custom.template.negated,
            custom.operands,
          );
          if (rendered !== undefined) return atomClause(rendered);
        }
        if (expressionParts(inner)?.operator === "Exists") return existential(inner, true);
      }
      const operator = expressionParts(inner)?.operator;
      const body = statement(inner, operator === "And" || operator === "Or");
      return {
        text: `it is not the case that ${body.text}`,
        open: true,
        comma: body.comma,
        kind: "negation",
      };
    };

    const statement = (expression: PlainMathJson, marked: boolean): Clause => {
      const text = dictionaryText(expression);
      if (text !== undefined) return atomClause(text);

      const custom = operatorTemplate(expression);
      if (custom !== undefined && custom.operator.signature.result.kind === "proposition") {
        const rendered = renderOperatorTemplate(
          custom.operator,
          custom.template.template,
          custom.operands,
        );
        if (rendered !== undefined) return atomClause(rendered);
      }

      const parts = expressionParts(expression);
      const operands = parts?.operands ?? [];
      const [first, second] = operands;
      switch (parts?.operator) {
        case "Not":
          if (operands.length === 1 && first !== undefined) return negation(first);
          break;
        case "And":
        case "Or":
          if (operands.length >= 2) return coordination(parts.operator, operands, marked);
          break;
        case "Implies":
          if (operands.length === 2 && first !== undefined && second !== undefined) {
            const antecedent = statement(first, false);
            const consequent = statement(second, false);
            const groupAntecedent = antecedent.comma || antecedent.kind === "biconditional";
            return {
              text: `if ${groupAntecedent ? `(${antecedent.text})` : antecedent.text}, then ${consequent.text}`,
              open: true,
              comma: true,
              kind: "conditional",
            };
          }
          break;
        case "Equivalent":
          if (operands.length === 2 && first !== undefined && second !== undefined) {
            const left = statement(first, true);
            const right = statement(second, true);
            return {
              text: `${grouped(left)} if and only if ${right.text}`,
              open: true,
              comma: left.comma || right.comma,
              kind: "biconditional",
            };
          }
          break;
        case "ForAll":
          if (operands.length === 2) return universal(expression);
          break;
        case "Exists":
          if (operands.length === 2) return existential(expression, false);
          break;
        default: {
          const rendered = relation(expression, false);
          if (rendered !== undefined) return atomClause(rendered);
        }
      }
      return atomClause(inlineMath(expression));
    };

    return { statement, term };
  };

  const total =
    (render: (session: ReturnType<typeof createSession>, expression: PlainMathJson) => string) =>
    (expression: PlainMathJson, context: NaturalLanguageContext = {}): string => {
      if (!isPlainMathJson(expression)) return "$\\text{?}$";
      try {
        return render(createSession(context), expression);
      } catch {
        return `$${latex.serialize(expression)}$`;
      }
    };

  return Object.freeze({
    statement: total((session, expression) => session.statement(expression, false).text),
    term: total((session, expression) => session.term(expression)),
  });
}
