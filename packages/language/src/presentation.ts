import type { OperatorDeclaration, PlainMathJson } from "@proof/mathjson-model";
import { createLatexRenderer, type LatexParseResult } from "./latex";
import {
  createNaturalLanguageRenderer,
  type NaturalLanguageContext,
  type NaturalLanguageRendererOptions,
} from "./natural-language";
import type { ExactEntry, NaturalLanguageDictionary } from "./terminology";

/** Deterministic projections of one authoritative MathJSON statement. Neither is a source. */
export type RenderedMathematics = Readonly<{
  /** The exact MathJSON object that was rendered. */
  expression: PlainMathJson;
  latex: string;
  naturalLanguage: string;
}>;

export type PresentationOptions = Readonly<{
  operators?: readonly OperatorDeclaration[];
  dictionaries?: readonly NaturalLanguageDictionary[];
  overrides?: readonly ExactEntry[];
  relationStyle?: NaturalLanguageRendererOptions["relationStyle"];
}>;

export type Presentation = Readonly<{
  latex(expression: PlainMathJson): string;
  naturalLanguage(statement: PlainMathJson, context?: NaturalLanguageContext): string;
  render(statement: PlainMathJson, context?: NaturalLanguageContext): RenderedMathematics;
  parseLatex(latex: string): LatexParseResult;
}>;

/** The central presentation registry: one operator environment for LaTeX and prose. */
export function createPresentation(options: PresentationOptions = {}): Presentation {
  const latex = createLatexRenderer({ operators: options.operators ?? [] });
  const naturalLanguage = createNaturalLanguageRenderer({
    latex,
    dictionaries: options.dictionaries ?? [],
    overrides: options.overrides ?? [],
    relationStyle: options.relationStyle ?? "words",
  });
  return Object.freeze({
    latex: latex.serialize,
    naturalLanguage: naturalLanguage.statement,
    render: (statement: PlainMathJson, context: NaturalLanguageContext = {}) =>
      Object.freeze({
        expression: statement,
        latex: latex.serialize(statement),
        naturalLanguage: naturalLanguage.statement(statement, context),
      }),
    parseLatex: latex.parse,
  });
}
