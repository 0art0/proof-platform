import { validateLatex } from "mathlive/ssr";

/**
 * Deterministic repair of the notation a model proposes for a constant (an operator), applied
 * before the deterministic constant rules run. A model often invents a LaTeX command (`\Odd(#1)`),
 * uses a bare `\operatorname` as its parse trigger, or reuses a trigger; each of these used to
 * reject the whole answer although the mathematics was fine. The repair only rewrites notation,
 * never a symbol or a signature, and it is a function of the answer and the supplied context
 * alone, so a replay repairs identically:
 *
 * - every LaTeX command MathLive does not know (`\Name`) becomes `\operatorname{Name}`;
 * - a trigger that is not a usable, unique LaTeX command occurring in the template, or a template
 *   that is still not valid LaTeX, is replaced by the canonical function form
 *   `\operatorname{Symbol}\left(#1, #2\right)` with the trigger `\operatorname{Symbol}`.
 */

/** The notation fields of an operator, as the provider writes them. */
export type WireNotation = Readonly<{
  symbol: string;
  latex: Readonly<{
    template: string;
    precedence: string;
    parse: Readonly<{ trigger: string; notation: "function" | "infix" | "prefix" }> | null;
  }>;
}>;

const COMMAND_TRIGGER = /^\\[A-Za-z]+$/;
const NAMED_FUNCTION_TRIGGER = /^\\(?:operatorname|mathrm)\{[A-Za-z][A-Za-z0-9]*\}$/;
/** Commands that only wrap a name; on their own they would capture every such name. */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
  "\\operatorname",
  "\\mathrm",
  "\\text",
  "\\textrm",
  "\\mathit",
  "\\mathbf",
  "\\mathsf",
  "\\mathcal",
  "\\mathbb",
  "\\mathop",
  "\\mathrel",
  "\\mathbin",
]);

/** The LaTeX of a template with its operand placeholders filled, for validation. */
function filled(template: string): string {
  return template.replace(/(?<!\\)#(\d+)/g, (_match, index: string) => `x_{${index}}`);
}

/** The LaTeX commands MathLive does not know, in order of first occurrence. */
function unknownCommands(latex: string): readonly string[] {
  const unknown: string[] = [];
  for (const error of validateLatex(latex)) {
    if (error.code === "unknown-command" && typeof error.arg === "string") {
      if (!unknown.includes(error.arg)) unknown.push(error.arg);
    }
  }
  return unknown;
}

function isValidLatex(latex: string): boolean {
  return validateLatex(latex).length === 0;
}

/** True when a template renders exactly the operands #1 ... #arity, with no stray characters. */
export function rendersEveryOperand(template: string, arity: number): boolean {
  // Control characters are never meaningful in a template (a model once returned "\u0000").
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(template)) return false;
  const referenced = new Set<number>();
  for (const match of template.matchAll(/(?<!\\)#(\d+)/g)) referenced.add(Number(match[1]));
  if ([...referenced].some((index) => index < 1 || index > arity)) return false;
  return Array.from({ length: arity }, (_, index) => index + 1).every((index) =>
    referenced.has(index),
  );
}

/**
 * True when an operator's LaTeX template renders exactly its operands and MathLive can typeset it.
 * A person's edit to a constant's notation is held to the same standard as a model's.
 */
export function isUsableOperatorTemplate(template: string, arity: number): boolean {
  return rendersEveryOperand(template, arity) && isValidLatex(filled(template));
}

/** The natural-language fields of an operator, as the provider writes them. */
export type WireNaturalLanguage = Readonly<{
  displayName: string;
  result: string;
  naturalLanguage: Readonly<{ template: string; negated: string | null }>;
}>;

/**
 * Repair an operator's natural-language template the same way: a template that does not render
 * every operand becomes "display name (#1, #2)", and a negated template, which only a
 * proposition-valued operator may have, is dropped from any other operator or when it does not
 * render every operand.
 */
export function repairNaturalLanguage<Operator extends WireNaturalLanguage>(
  operator: Operator,
  arity: number,
): Operator {
  const { template, negated } = operator.naturalLanguage;
  const operands = Array.from({ length: arity }, (_, index) => `#${index + 1}`).join(", ");
  const nextTemplate = rendersEveryOperand(template, arity)
    ? template
    : `${operator.displayName} (${operands})`;
  const nextNegated =
    negated !== null && operator.result === "proposition" && rendersEveryOperand(negated, arity)
      ? negated
      : null;
  if (nextTemplate === template && nextNegated === negated) return operator;
  return { ...operator, naturalLanguage: { template: nextTemplate, negated: nextNegated } };
}

/** The canonical function form of an operator: always valid LaTeX, always parseable. */
export function functionFormNotation(symbol: string, arity: number): WireNotation["latex"] {
  const operands = Array.from({ length: arity }, (_, index) => `#${index + 1}`).join(", ");
  return {
    template: `\\operatorname{${symbol}}\\left(${operands}\\right)`,
    precedence: "atom",
    parse: { trigger: `\\operatorname{${symbol}}`, notation: "function" },
  };
}

function triggerIsUsable(
  parse: NonNullable<WireNotation["latex"]["parse"]>,
  template: string,
  arity: number,
): boolean {
  const { trigger, notation } = parse;
  if (WRAPPER_COMMANDS.has(trigger)) return false;
  const shaped =
    COMMAND_TRIGGER.test(trigger) ||
    (notation === "function" && NAMED_FUNCTION_TRIGGER.test(trigger));
  if (!shaped || !template.includes(trigger)) return false;
  if (notation === "infix" && arity !== 2) return false;
  if (notation === "prefix" && arity !== 1) return false;
  return true;
}

/**
 * Repair the notation of each operator in order. `takenTriggers` are the triggers already in use
 * (existing operators); a repaired operator's trigger is added to them, so the operators of one
 * answer never share a trigger either. `arityOf` gives each operator's number of operands.
 */
export function repairOperatorNotations<Operator extends WireNotation & WireNaturalLanguage>(
  operators: readonly Operator[],
  arityOf: (operator: Operator) => number,
  takenTriggers: Iterable<string> = [],
): Operator[] {
  const taken = new Set(takenTriggers);
  return operators.map((operator) => {
    const arity = arityOf(operator);
    const latex = repairLatex(operator, arity, taken);
    const trigger = latex.parse?.trigger;
    if (trigger !== undefined) taken.add(trigger);
    const spoken = repairNaturalLanguage(operator, arity);
    return latex === operator.latex ? spoken : { ...spoken, latex };
  });
}

function repairLatex(
  operator: WireNotation,
  arity: number,
  taken: ReadonlySet<string>,
): WireNotation["latex"] {
  const original = operator.latex;
  let template = original.template;
  let parse = original.parse;
  // Invented commands become named operators: `\Odd` reads as `\operatorname{Odd}`. A trigger that
  // was such a command keeps working as a named-function trigger; an infix or prefix one cannot,
  // and falls through to the canonical form below.
  for (const command of unknownCommands(filled(template))) {
    const name = command.slice(1);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) continue;
    template = template.split(command).join(`\\operatorname{${name}}`);
    if (parse?.trigger === command && parse.notation === "function") {
      parse = { trigger: `\\operatorname{${name}}`, notation: "function" };
    }
  }
  const usable =
    rendersEveryOperand(template, arity) &&
    isValidLatex(filled(template)) &&
    (parse === null || (triggerIsUsable(parse, template, arity) && !taken.has(parse.trigger)));
  if (!usable) return functionFormNotation(operator.symbol, arity);
  if (template === original.template && parse === original.parse) return original;
  return { template, precedence: original.precedence, parse };
}
