"use client";

import { useEffect, useMemo, useState } from "react";
import { createPresentation, type Presentation } from "@proof/language";
import type { OperatorDeclaration } from "@proof/protocol";

/**
 * Read-only projections use the central `@proof/language` presentation registry.
 *
 * Interactive MathLive fields deliberately keep `renderMathJson` (see `mathlive-selection.ts`):
 * range gestures are mapped back to MathJSON by asking MathLive to *parse* the displayed LaTeX,
 * and MathLive's parser knows neither the registry's custom-operator templates nor their parse
 * triggers. Templates may also place operands out of path order, which breaks the ordered leaf
 * annotation. Both would silently turn exact selections into snapped fallbacks.
 */
export type WorkspaceView = "formal" | "natural-language";

export function usePresentation(operators: readonly OperatorDeclaration[]): Presentation {
  return useMemo(() => createPresentation({ operators }), [operators]);
}

type MarkupRenderer = (latex: string) => string;
let markupRenderer: Promise<MarkupRenderer | undefined> | undefined;

function loadMarkupRenderer(): Promise<MarkupRenderer | undefined> {
  markupRenderer ??= import("mathlive")
    .then((module) =>
      typeof module.convertLatexToMarkup === "function"
        ? (latex: string) => module.convertLatexToMarkup(latex)
        : undefined,
    )
    .catch(() => undefined);
  return markupRenderer;
}

/** Static typeset LaTeX; the source text is shown until MathLive's renderer has loaded. */
export function InlineLatex({ latex }: Readonly<{ latex: string }>) {
  const [markup, setMarkup] = useState<string>();
  useEffect(() => {
    let active = true;
    void loadMarkupRenderer().then((render) => {
      if (!active || render === undefined) return;
      try {
        setMarkup(render(latex));
      } catch {
        setMarkup(undefined);
      }
    });
    return () => {
      active = false;
    };
  }, [latex]);

  // MathLive markup is generated from serializer output of validated MathJSON, never from
  // free user text, so it is safe to inject.
  return markup === undefined ? (
    <code data-latex={latex}>{latex}</code>
  ) : (
    <span data-latex={latex} dangerouslySetInnerHTML={{ __html: markup }} />
  );
}

/** Split natural language on `$…$` so inline mathematics is typeset and prose stays text. */
export function splitNaturalLanguage(
  text: string,
): readonly Readonly<{ kind: "text" | "math"; value: string }>[] {
  const parts: { kind: "text" | "math"; value: string }[] = [];
  const pieces = text.split("$");
  // An unmatched `$` leaves an odd count of delimiters; the trailing piece is then prose.
  const balanced = pieces.length % 2 === 1;
  pieces.forEach((value, index) => {
    const math = index % 2 === 1 && (balanced || index < pieces.length - 1);
    if (value.length > 0) parts.push({ kind: math ? "math" : "text", value });
  });
  return parts;
}

export function NaturalLanguageText({ text }: Readonly<{ text: string }>) {
  return (
    <>
      {splitNaturalLanguage(text).map((part, index) =>
        part.kind === "math" ? (
          <InlineLatex key={index} latex={part.value} />
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </>
  );
}
