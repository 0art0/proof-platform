import {
  LATEX_DICTIONARY,
  LatexSyntax,
  type LatexDictionaryEntry,
} from "@cortex-js/compute-engine";
import {
  isPlainMathJson,
  operatorDeclarationsSchema,
  operatorTemplateSegments,
  type OperatorDeclaration,
  type OperatorLatexPrecedence,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { detach, expressionParts, headOf, numericValue, symbolName } from "./expression";

/**
 * Binding strength, tightest first. Quantifiers bind loosest because their body extends to the
 * right; an operand is parenthesized when it binds no tighter than its slot requires.
 */
export const LATEX_PRECEDENCE = Object.freeze({
  atom: 100,
  postfix: 97,
  prefix: 95,
  power: 90,
  fraction: 88,
  negation: 85,
  multiplicative: 80,
  additive: 70,
  relation: 60,
  conjunction: 40,
  disjunction: 30,
  implication: 20,
  equivalence: 10,
  quantifier: 5,
} satisfies Record<OperatorLatexPrecedence | "fraction" | "negation" | "quantifier", number>);

type Rendered = Readonly<{ latex: string; precedence: number }>;

export type LatexParseDiagnostic = Readonly<{
  code: "empty-input" | "parse-error" | "invalid-math-json";
  message: string;
}>;

export type LatexParseResult =
  | Readonly<{ ok: true; expression: PlainMathJson; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly LatexParseDiagnostic[] }>;

export type LatexRendererOptions = Readonly<{
  /** Custom operators; they are validated with `operatorDeclarationsSchema`. */
  operators?: readonly OperatorDeclaration[];
}>;

export type LatexRenderer = Readonly<{
  operators: readonly OperatorDeclaration[];
  /** Total: every plain MathJSON value receives some LaTeX. */
  serialize(expression: PlainMathJson): string;
  /** Standard notation plus the parse triggers of the registered operators. */
  parse(latex: string): LatexParseResult;
}>;

const LOGICAL_INFIX = Object.freeze({
  And: { command: "\\land", precedence: LATEX_PRECEDENCE.conjunction },
  Or: { command: "\\lor", precedence: LATEX_PRECEDENCE.disjunction },
});

export const RELATION_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  Equal: "=",
  NotEqual: "\\neq",
  Less: "<",
  LessEqual: "\\le",
  Greater: ">",
  GreaterEqual: "\\ge",
  Element: "\\in",
  NotElement: "\\notin",
  Subset: "\\subset",
  SubsetEqual: "\\subseteq",
  Superset: "\\supset",
  SupersetEqual: "\\supseteq",
});

/** Compute Engine heads whose serialization delimits its own operands, like `\sin(x)`. */
const SELF_DELIMITED_HEADS = new Set([
  "Sin",
  "Cos",
  "Tan",
  "Ln",
  "Log",
  "Exp",
  "Sqrt",
  "Root",
  "Max",
  "Min",
  "Floor",
  "Ceil",
  "GCD",
  "LCM",
  "Tuple",
  "Set",
  "List",
  "Binomial",
  "Rational",
]);

/** Compute Engine infix precedences used for custom parse triggers. */
const COMPUTE_ENGINE_INFIX_PRECEDENCE: Readonly<Record<OperatorLatexPrecedence, number>> =
  Object.freeze({
    atom: 245,
    postfix: 245,
    prefix: 245,
    power: 720,
    multiplicative: 390,
    additive: 275,
    relation: 245,
    conjunction: 235,
    disjunction: 230,
    implication: 220,
    equivalence: 219,
  });
const COMPUTE_ENGINE_PREFIX_PRECEDENCE = 880;

const STANDARD_HEADS: ReadonlySet<string> = new Set(
  LATEX_DICTIONARY.flatMap((entry) => (typeof entry.name === "string" ? [entry.name] : [])),
);

/** Heads rendered here; a malformed use falls back to explicit application, never to guesses. */
const OWNED_HEADS: ReadonlySet<string> = new Set([
  "Not",
  "And",
  "Or",
  "Implies",
  "Equivalent",
  "ForAll",
  "Exists",
  "Add",
  "Subtract",
  "Multiply",
  "Divide",
  "Power",
  "Negate",
  "Abs",
  ...Object.keys(RELATION_COMMANDS),
]);

const defaultSyntax = new LatexSyntax();
const PLACEHOLDER_PREFIX = "Zplaceholderq";

function wrap(rendered: Rendered, parenthesize: boolean): string {
  return parenthesize ? `\\left(${rendered.latex}\\right)` : rendered.latex;
}

function atom(latex: string): Rendered {
  return { latex, precedence: LATEX_PRECEDENCE.atom };
}

function startsWithMinus(rendered: Rendered): boolean {
  return rendered.latex.startsWith("-");
}

function computeEngineSerialize(expression: PlainMathJson): string | undefined {
  try {
    return defaultSyntax.serialize(expression);
  } catch {
    return undefined;
  }
}

function symbolLatex(symbol: string): string {
  if (symbol === "True") return "\\top";
  if (symbol === "False") return "\\bot";
  return computeEngineSerialize(symbol) ?? `\\mathrm{${symbol}}`;
}

function functionNameLatex(symbol: string): string {
  const latex = symbolLatex(symbol);
  return latex.startsWith("\\mathrm{") ? `\\operatorname{${symbol}}` : latex;
}

export function createLatexRenderer(options: LatexRendererOptions = {}): LatexRenderer {
  const operators = detach(operatorDeclarationsSchema.parse(options.operators ?? []));
  const operatorsBySymbol = new Map(operators.map((operator) => [operator.symbol, operator]));
  let parseSyntax: LatexSyntax | undefined;

  const containsCustomOperator = (expression: PlainMathJson): boolean => {
    const parts = expressionParts(expression);
    if (parts === undefined) return false;
    return operatorsBySymbol.has(parts.operator) || parts.operands.some(containsCustomOperator);
  };

  const render = (expression: PlainMathJson): Rendered => {
    const symbol = symbolName(expression);
    if (symbol !== undefined) return atom(symbolLatex(symbol));

    const parts = expressionParts(expression);
    if (parts === undefined) {
      const latex = computeEngineSerialize(expression) ?? "\\text{?}";
      const value = numericValue(expression);
      return {
        latex,
        precedence:
          value !== undefined && value < 0 ? LATEX_PRECEDENCE.negation : LATEX_PRECEDENCE.atom,
      };
    }
    return renderFunction(parts.operator, parts.operands, expression);
  };

  const operand = (expression: PlainMathJson, needsAbove: number): string => {
    const rendered = render(expression);
    return wrap(rendered, rendered.precedence <= needsAbove);
  };

  const renderFunction = (
    head: string,
    operands: readonly PlainMathJson[],
    expression: PlainMathJson,
  ): Rendered => {
    const first = operands[0];
    const second = operands[1];
    const custom = operatorsBySymbol.get(head);
    if (custom !== undefined) return renderCustom(custom, operands);

    if (head === "Not" && operands.length === 1 && first !== undefined) {
      return {
        latex: `\\lnot ${operand(first, LATEX_PRECEDENCE.prefix - 1)}`,
        precedence: LATEX_PRECEDENCE.prefix,
      };
    }
    if ((head === "And" || head === "Or") && operands.length >= 2) {
      const { command, precedence } = LOGICAL_INFIX[head];
      return {
        latex: operands.map((item) => operand(item, precedence)).join(` ${command} `),
        precedence,
      };
    }
    if (
      (head === "Implies" || head === "Equivalent") &&
      operands.length === 2 &&
      first !== undefined &&
      second !== undefined
    ) {
      const precedence =
        head === "Implies" ? LATEX_PRECEDENCE.implication : LATEX_PRECEDENCE.equivalence;
      const command = head === "Implies" ? "\\implies" : "\\iff";
      // Implication is right-associative; equivalence is always grouped explicitly.
      const rightNeedsAbove = head === "Implies" ? precedence - 1 : precedence;
      const right = render(second);
      const rightLatex = wrap(
        right,
        right.precedence <= rightNeedsAbove || right.precedence === LATEX_PRECEDENCE.quantifier,
      );
      return { latex: `${operand(first, precedence)} ${command} ${rightLatex}`, precedence };
    }
    if (
      (head === "ForAll" || head === "Exists") &&
      operands.length === 2 &&
      first !== undefined &&
      second !== undefined
    ) {
      const quantifier = head === "ForAll" ? "\\forall" : "\\exists";
      const body = render(second);
      // The Compute Engine gives quantifiers a tight scope, so connective bodies are grouped.
      const groupBody =
        body.precedence < LATEX_PRECEDENCE.relation &&
        body.precedence !== LATEX_PRECEDENCE.quantifier;
      return {
        latex: `${quantifier} ${render(first).latex}, ${wrap(body, groupBody)}`,
        precedence: LATEX_PRECEDENCE.quantifier,
      };
    }
    // A lambda with typed parameters: the Compute Engine would print `x\in\R\mapsto x+1`, which
    // reads as membership in a lambda, so the typed parameters are grouped.
    const typedParameters =
      head === "Function" && operands.length >= 2 ? typedLambdaParameters(operands.slice(1)) : [];
    if (typedParameters !== undefined && typedParameters.length > 0 && first !== undefined) {
      const body = render(first);
      return {
        latex: `\\left(${typedParameters.join(", ")}\\right) \\mapsto ${wrap(body, body.precedence <= LATEX_PRECEDENCE.quantifier)}`,
        precedence: LATEX_PRECEDENCE.quantifier,
      };
    }
    // Application of a function-valued term; the Compute Engine would print `\lhd`.
    if (head === "Apply" && first !== undefined) {
      const name = symbolName(first);
      const applied = render(first);
      const headLatex =
        name === undefined
          ? wrap(applied, applied.precedence < LATEX_PRECEDENCE.atom)
          : functionNameLatex(name);
      return atom(
        `${headLatex}(${operands
          .slice(1)
          .map((item) => render(item).latex)
          .join(", ")})`,
      );
    }
    const relation = RELATION_COMMANDS[head];
    if (relation !== undefined && operands.length >= 2) {
      return {
        latex: operands
          .map((item) => operand(item, LATEX_PRECEDENCE.relation))
          .join(` ${relation} `),
        precedence: LATEX_PRECEDENCE.relation,
      };
    }
    const arithmetic = renderArithmetic(head, operands);
    if (arithmetic !== undefined) return arithmetic;

    if (!STANDARD_HEADS.has(head) || OWNED_HEADS.has(head)) {
      return atom(
        `${functionNameLatex(head)}(${operands.map((item) => render(item).latex).join(", ")})`,
      );
    }
    return renderDelegated(head, operands, expression);
  };

  /**
   * LaTeX for lambda parameters when at least one is a typed `["Element", x, S]` declaration;
   * `[]` when none is typed and undefined when a parameter is malformed.
   */
  const typedLambdaParameters = (
    parameters: readonly PlainMathJson[],
  ): readonly string[] | undefined => {
    let typed = false;
    const rendered: string[] = [];
    for (const parameter of parameters) {
      const name = symbolName(parameter);
      if (name !== undefined) {
        rendered.push(symbolLatex(name));
        continue;
      }
      const parts = expressionParts(parameter);
      const [bound, domain] = parts?.operands ?? [];
      const boundName = bound === undefined ? undefined : symbolName(bound);
      if (
        parts?.operator !== "Element" ||
        parts.operands.length !== 2 ||
        boundName === undefined ||
        domain === undefined
      ) {
        return undefined;
      }
      typed = true;
      rendered.push(`${symbolLatex(boundName)} \\in ${operand(domain, LATEX_PRECEDENCE.relation)}`);
    }
    return typed ? rendered : [];
  };

  const renderArithmetic = (
    head: string,
    operands: readonly PlainMathJson[],
  ): Rendered | undefined => {
    const first = operands[0];
    const second = operands[1];
    if (head === "Add" && operands.length >= 2) {
      const latex = operands
        .map((item, index) => {
          const rendered = render(item);
          if (index === 0) {
            return wrap(
              rendered,
              rendered.precedence < LATEX_PRECEDENCE.additive || headOf(item) === "Add",
            );
          }
          const negated = negatedTerm(item);
          if (negated !== undefined) return `-${negated}`;
          return `+${wrap(rendered, rendered.precedence <= LATEX_PRECEDENCE.additive || startsWithMinus(rendered))}`;
        })
        .join("");
      return { latex, precedence: LATEX_PRECEDENCE.additive };
    }
    if (
      head === "Subtract" &&
      first !== undefined &&
      second !== undefined &&
      operands.length === 2
    ) {
      const left = render(first);
      const right = render(second);
      return {
        latex: `${wrap(left, left.precedence < LATEX_PRECEDENCE.additive)}-${wrap(
          right,
          right.precedence <= LATEX_PRECEDENCE.additive || startsWithMinus(right),
        )}`,
        precedence: LATEX_PRECEDENCE.additive,
      };
    }
    if (head === "Multiply" && operands.length >= 2) {
      const factors = operands.map(render);
      const coefficient = numericValue(operands[0] as PlainMathJson);
      if (
        operands.length === 2 &&
        coefficient !== undefined &&
        coefficient >= 0 &&
        symbolName(operands[1] as PlainMathJson) !== undefined
      ) {
        return {
          latex: `${factors[0]?.latex ?? ""}${factors[1]?.latex ?? ""}`,
          precedence: LATEX_PRECEDENCE.multiplicative,
        };
      }
      const latex = factors
        .map((factor, index) =>
          wrap(
            factor,
            factor.precedence <= LATEX_PRECEDENCE.multiplicative ||
              (index > 0 && startsWithMinus(factor)),
          ),
        )
        .join("\\cdot ");
      return { latex, precedence: LATEX_PRECEDENCE.multiplicative };
    }
    if (head === "Divide" && first !== undefined && second !== undefined && operands.length === 2) {
      return {
        latex: `\\frac{${render(first).latex}}{${render(second).latex}}`,
        precedence: LATEX_PRECEDENCE.fraction,
      };
    }
    if (head === "Power" && first !== undefined && second !== undefined && operands.length === 2) {
      const base = render(first);
      return {
        latex: `${wrap(base, base.precedence <= LATEX_PRECEDENCE.power || startsWithMinus(base))}^{${render(second).latex}}`,
        precedence: LATEX_PRECEDENCE.power,
      };
    }
    if (head === "Negate" && first !== undefined && operands.length === 1) {
      const inner = render(first);
      return {
        latex: `-${wrap(inner, inner.precedence <= LATEX_PRECEDENCE.negation || startsWithMinus(inner))}`,
        precedence: LATEX_PRECEDENCE.negation,
      };
    }
    if (head === "Abs" && first !== undefined && operands.length === 1) {
      return atom(`\\left|${render(first).latex}\\right|`);
    }
    return undefined;
  };

  /** The rendering of `t` when `-t` is written as a subtracted term, if `item` is negative. */
  const negatedTerm = (item: PlainMathJson): string | undefined => {
    const parts = expressionParts(item);
    if (parts?.operator === "Negate" && parts.operands.length === 1) {
      const inner = render(parts.operands[0] as PlainMathJson);
      return wrap(inner, inner.precedence <= LATEX_PRECEDENCE.additive || startsWithMinus(inner));
    }
    const value = numericValue(item);
    if (value !== undefined && value < 0) {
      const rendered = render(item).latex;
      return rendered.startsWith("-") ? rendered.slice(1) : undefined;
    }
    return undefined;
  };

  const renderCustom = (
    operator: OperatorDeclaration,
    operands: readonly PlainMathJson[],
  ): Rendered => {
    const latex = operator.presentation?.latex;
    const segments =
      latex === undefined || operands.length !== operator.signature.parameters.length
        ? undefined
        : operatorTemplateSegments(latex.template);
    if (latex === undefined || segments === undefined) {
      return atom(
        `\\operatorname{${operator.symbol}}(${operands.map((item) => render(item).latex).join(", ")})`,
      );
    }
    const precedence = LATEX_PRECEDENCE[latex.precedence];
    const text = segments
      .map((segment) => {
        if (segment.kind === "text") return segment.text;
        const rendered = render(operands[segment.index] as PlainMathJson);
        return latex.precedence === "atom"
          ? rendered.latex
          : wrap(rendered, rendered.precedence <= precedence);
      })
      .join("");
    return { latex: text, precedence };
  };

  /** Standard Compute Engine heads, in raw form; custom-operator operands are spliced in. */
  const renderDelegated = (
    head: string,
    operands: readonly PlainMathJson[],
    expression: PlainMathJson,
  ): Rendered => {
    const precedence = SELF_DELIMITED_HEADS.has(head)
      ? LATEX_PRECEDENCE.atom
      : LATEX_PRECEDENCE.additive;
    const generic = (): Rendered =>
      atom(
        `\\operatorname{${head}}\\left(${operands.map((item) => render(item).latex).join(", ")}\\right)`,
      );
    if (!containsCustomOperator(expression)) {
      const latex = computeEngineSerialize(expression);
      return latex === undefined ? generic() : { latex, precedence };
    }

    const splices: { placeholder: string; latex: string }[] = [];
    const substituted = operands.map((item, index) => {
      if (!containsCustomOperator(item)) return item;
      const name = `${PLACEHOLDER_PREFIX}${index}`;
      const placeholder = computeEngineSerialize(name);
      if (placeholder === undefined) return item;
      const rendered = render(item);
      splices.push({
        placeholder,
        latex: wrap(rendered, rendered.precedence < LATEX_PRECEDENCE.atom),
      });
      return name;
    });
    let latex = computeEngineSerialize([head, ...substituted] as PlainMathJson);
    for (const splice of splices) {
      if (latex === undefined || !latex.includes(splice.placeholder)) return generic();
      latex = latex.split(splice.placeholder).join(splice.latex);
    }
    return latex === undefined ? generic() : { latex, precedence };
  };

  const serialize = (expression: PlainMathJson): string => {
    if (!isPlainMathJson(expression)) return "\\text{?}";
    try {
      return render(expression).latex;
    } catch {
      return computeEngineSerialize(expression) ?? "\\text{?}";
    }
  };

  const parse = (latex: string): LatexParseResult => {
    parseSyntax ??= new LatexSyntax({
      dictionary: [...LATEX_DICTIONARY, ...operators.flatMap(parseEntries)],
    });
    return parseWith(parseSyntax, latex);
  };

  return Object.freeze({ operators, serialize, parse });
}

function parseEntries(operator: OperatorDeclaration): Partial<LatexDictionaryEntry>[] {
  const latex = operator.presentation?.latex;
  const parse = latex?.parse;
  if (latex === undefined || parse === undefined) return [];
  if (parse.notation === "function") {
    const named = /^\\(?:operatorname|mathrm)\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(parse.trigger)?.[1];
    return [
      named === undefined
        ? { kind: "function", name: operator.symbol, latexTrigger: parse.trigger }
        : { kind: "function", name: operator.symbol, symbolTrigger: named },
    ];
  }
  if (parse.notation === "infix") {
    return [
      {
        kind: "infix",
        name: operator.symbol,
        latexTrigger: parse.trigger,
        precedence: COMPUTE_ENGINE_INFIX_PRECEDENCE[latex.precedence],
        associativity: "none",
      },
    ];
  }
  return [
    {
      kind: "prefix",
      name: operator.symbol,
      latexTrigger: parse.trigger,
      precedence: COMPUTE_ENGINE_PREFIX_PRECEDENCE,
    },
  ];
}

function parseWith(syntax: LatexSyntax, latex: string): LatexParseResult {
  if (latex.trim().length === 0) {
    return { ok: false, diagnostics: [{ code: "empty-input", message: "The LaTeX is empty." }] };
  }
  let parsed: PlainMathJson | null;
  try {
    parsed = syntax.parse(latex);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "parse-error",
          message: error instanceof Error ? error.message : "The LaTeX could not be parsed.",
        },
      ],
    };
  }
  if (parsed === null) {
    return { ok: false, diagnostics: [{ code: "empty-input", message: "The LaTeX is empty." }] };
  }
  const errors: string[] = [];
  const expression = normalizeParsed(parsed, errors);
  if (errors.length > 0) {
    return {
      ok: false,
      diagnostics: errors.map((message) => ({ code: "parse-error" as const, message })),
    };
  }
  if (!isPlainMathJson(expression)) {
    return {
      ok: false,
      diagnostics: [{ code: "invalid-math-json", message: "The parse is not plain MathJSON." }],
    };
  }
  return { ok: true, expression: detach(expression), diagnostics: [] };
}

function delimitedArguments(expression: PlainMathJson): readonly PlainMathJson[] | undefined {
  const parts = expressionParts(expression);
  if (parts?.operator !== "Delimiter") return undefined;
  const body = parts.operands[0];
  if (body === undefined) return [];
  const bodyParts = expressionParts(body);
  return bodyParts?.operator === "Sequence" ? bodyParts.operands : [body];
}

/**
 * Remove parse-only structure: grouping delimiters, `Predicate` wrappers, and juxtaposition. A
 * symbol followed by a parenthesized list is read as application; other juxtaposition as a
 * product. Integer `{num}` literals become numbers.
 */
function normalizeParsed(expression: PlainMathJson, errors: string[]): PlainMathJson {
  const parts = expressionParts(expression);
  if (parts === undefined) {
    const value = numericValue(expression);
    return value !== undefined && Number.isSafeInteger(value) && typeof expression !== "number"
      ? value
      : expression;
  }
  const operands = parts.operands;
  const normalized = (items: readonly PlainMathJson[]): PlainMathJson[] =>
    items.map((item) => normalizeParsed(item, errors));

  switch (parts.operator) {
    case "Error":
      errors.push(`The LaTeX could not be parsed: ${JSON.stringify(expression)}`);
      return expression;
    case "Delimiter": {
      const items = delimitedArguments(expression) ?? [];
      const [only] = items;
      if (items.length === 1 && only !== undefined) return normalizeParsed(only, errors);
      return ["Tuple", ...normalized(items)] as PlainMathJson;
    }
    case "Predicate":
      return [
        symbolName(operands[0] as PlainMathJson) ?? "Predicate",
        ...normalized(operands.slice(1)),
      ] as PlainMathJson;
    case "InvisibleOperator": {
      const [head, argument] = operands;
      const name = head === undefined ? undefined : symbolName(head);
      const items = argument === undefined ? undefined : delimitedArguments(argument);
      if (operands.length === 2 && name !== undefined && items !== undefined) {
        return [name, ...normalized(items)] as PlainMathJson;
      }
      return ["Multiply", ...normalized(operands)] as PlainMathJson;
    }
    default:
      return [parts.operator, ...normalized(operands)] as PlainMathJson;
  }
}

/** Parse LaTeX with the standard dictionary plus the operators' parse triggers. */
export function parseLatex(latex: string, options: LatexRendererOptions = {}): LatexParseResult {
  return createLatexRenderer(options).parse(latex);
}
