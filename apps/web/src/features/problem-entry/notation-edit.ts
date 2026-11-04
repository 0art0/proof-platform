import type { OperatorDeclaration, PlainMathJson } from "@proof/protocol";

/**
 * Deterministic helpers for a person's edits to a proposed constant's notation. Only presentation
 * changes: the symbol and signature stay as proposed, so the library built from the proposal keeps
 * its meaning and simply renders with the new notation. The worker checks the same rules again
 * when the background is approved (`apps/worker/src/background-amendment.ts`).
 */

type LatexParse = NonNullable<NonNullable<OperatorDeclaration["presentation"]>["latex"]>["parse"];

const NAMED = /\\(?:operatorname|mathrm)\{([A-Za-z][A-Za-z0-9]*)\}/;
const WRAPPERS: ReadonlySet<string> = new Set([
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
  "\\left",
  "\\right",
]);

/** The operand indices a template renders, in order of first appearance. */
function placeholders(template: string): readonly number[] {
  const seen: number[] = [];
  for (const match of template.matchAll(/(?<!\\)#(\d+)/g)) {
    const index = Number(match[1]);
    if (!seen.includes(index)) seen.push(index);
  }
  return seen;
}

/**
 * Why a template cannot be used, or undefined. `unknownCommands` reports LaTeX commands the
 * typesetter does not know (MathLive's `validateLatex`, when it has loaded).
 */
export function templateIssue(
  template: string,
  arity: number,
  unknownCommands?: (latex: string) => readonly string[],
): string | undefined {
  if (template.trim().length === 0) return "Enter the LaTeX.";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f$]/.test(template)) return "Write LaTeX without $ signs.";
  const used = placeholders(template);
  const missing = Array.from({ length: arity }, (_, index) => index + 1).filter(
    (index) => !used.includes(index),
  );
  if (missing.length > 0) return `Show ${missing.map((index) => `#${index}`).join(" and ")}.`;
  const extra = used.filter((index) => index < 1 || index > arity);
  if (extra.length > 0) return `There is no #${extra[0]}: this takes ${arity}.`;
  let depth = 0;
  for (const character of template.replace(/\\[{}]/g, "")) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0) return "A } has no matching {.";
  }
  if (depth !== 0) return "A { is not closed.";
  const [unknown] = unknownCommands?.(filledTemplate(template, arity)) ?? [];
  if (unknown !== undefined) {
    return `${unknown} is not standard LaTeX; try \\operatorname{${unknown.slice(1)}}.`;
  }
  return undefined;
}

/** A template with sample operands, for previews and for the typesetter's check. */
export function filledTemplate(template: string, arity: number): string {
  const names = ["a", "b", "c", "d", "e", "f"];
  return template.replace(/(?<!\\)#(\d+)/g, (_match, index: string) => {
    const position = Number(index) - 1;
    return position < arity ? (names[position] ?? `x_{${index}}`) : `x_{${index}}`;
  });
}

/**
 * How typed LaTeX is read back into the operator after an edit: the previous trigger while the
 * template still shows it, else a named operator (`\operatorname{Name}`), else the one command
 * between two operands (infix) or before one (prefix), else a leading function command.
 * Undefined when the notation cannot be typed; it still displays.
 */
export function deriveParse(
  template: string,
  arity: number,
  previous: LatexParse | undefined,
): LatexParse | undefined {
  if (previous !== undefined && template.includes(previous.trigger)) return previous;
  const named = NAMED.exec(template);
  if (named !== null) return { trigger: named[0], notation: "function" };
  const command = (pattern: RegExp) => {
    const found = pattern.exec(template)?.[1];
    return found !== undefined && !WRAPPERS.has(found) ? found : undefined;
  };
  if (arity === 2) {
    const infix = command(/^\s*#1\s*(\\[A-Za-z]+)\s*#2\s*$/);
    if (infix !== undefined) return { trigger: infix, notation: "infix" };
  }
  if (arity === 1) {
    const prefix = command(/^\s*(\\[A-Za-z]+)\s*#1\s*$/);
    if (prefix !== undefined) return { trigger: prefix, notation: "prefix" };
  }
  const leading = command(/^\s*(\\[A-Za-z]+)\s*(?:\\left)?\s*\(/);
  if (leading !== undefined) return { trigger: leading, notation: "function" };
  return undefined;
}

/** The person's edits to one constant. */
export type ConstantEdit = Readonly<{ displayName: string; template: string }>;

/** The constant as edited: same ID, symbol and signature; new name and notation. */
export function editedOperator(
  original: OperatorDeclaration,
  edit: ConstantEdit,
): OperatorDeclaration {
  const arity = original.signature.parameters.length;
  const latex = original.presentation?.latex;
  const template = edit.template.trim();
  const sameNotation = latex !== undefined && template === latex.template;
  const parse = sameNotation ? latex.parse : deriveParse(template, arity, latex?.parse);
  const displayName = edit.displayName.trim();
  return {
    ...original,
    presentation: {
      ...original.presentation,
      displayName:
        displayName.length > 0
          ? displayName
          : (original.presentation?.displayName ?? original.symbol),
      latex: {
        template,
        precedence: sameNotation ? latex.precedence : (latex?.precedence ?? "atom"),
        ...(parse === undefined ? {} : { parse }),
      },
    },
  };
}

/** Every operator name a formula applies. */
export function appliedSymbols(expression: PlainMathJson): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (node: PlainMathJson) => {
    if (!Array.isArray(node)) return;
    const [head, ...operands] = node;
    if (typeof head === "string") found.add(head);
    else if (head !== undefined) visit(head);
    operands.forEach(visit);
  };
  visit(expression);
  return found;
}
