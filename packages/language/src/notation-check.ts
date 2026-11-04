import {
  jsonValueEquals,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { createLatexRenderer } from "./latex";

/** Operand names that are plain variables to the parser (unlike `e`, `i` or `d`). */
const SAMPLE_OPERANDS = ["x", "y", "z", "u", "v", "w", "s", "t"];

/**
 * Whether typed LaTeX in an operator's notation reads back as that operator: the operator applied
 * to sample variables is written with its template and parsed with its parse trigger, and must
 * give the same application. An operator without a parse trigger cannot be typed, so it passes
 * trivially. A trigger can be well formed and still fail: `\operatorname{D}` is read as the
 * standard derivative `D`, so `Derivative` written that way would be typed as something else.
 */
export function notationRoundTrips(operator: OperatorDeclaration): boolean {
  if (operator.presentation?.latex?.parse === undefined) return true;
  const arity = operator.signature.parameters.length;
  if (arity > SAMPLE_OPERANDS.length) return true;
  // Building a parser is not free (and the parser logs about names it already knows), while a
  // page asks again on every render: the verdict depends on the declaration alone, so it is kept.
  const key = JSON.stringify([operator.symbol, arity, operator.presentation.latex]);
  const known = verdicts.get(key);
  if (known !== undefined) return known;
  const application: PlainMathJson = [operator.symbol, ...SAMPLE_OPERANDS.slice(0, arity)];
  let verdict: boolean;
  try {
    const renderer = createLatexRenderer({ operators: [operator] });
    const parsed = renderer.parse(renderer.serialize(application));
    verdict = parsed.ok && jsonValueEquals(parsed.expression, application);
  } catch {
    verdict = false;
  }
  if (verdicts.size >= MAX_VERDICTS) verdicts.delete(verdicts.keys().next().value ?? "");
  verdicts.set(key, verdict);
  return verdict;
}

const MAX_VERDICTS = 256;
const verdicts = new Map<string, boolean>();
