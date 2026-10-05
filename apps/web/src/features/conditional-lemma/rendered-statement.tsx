"use client";

import type { WorkspaceView } from "../proof-workspace";
import { InlineLatex, NaturalLanguageText } from "../proof-workspace/presentation";
import type { RenderedStatementView } from "./api-contract";

/**
 * A statement the worker rendered from stored MathJSON, shown in the selected view. The browser
 * never renders or edits the mathematics itself here.
 */
export function RenderedStatement({
  statement,
  view,
}: Readonly<{ statement: RenderedStatementView; view: WorkspaceView }>) {
  return view === "natural-language" ? (
    <NaturalLanguageText text={statement.naturalLanguage} />
  ) : (
    <InlineLatex latex={statement.latex} />
  );
}
