"use client";

import "mathlive/static.css";
import { InlineLatex } from "../proof-workspace/presentation";
import styles from "./problem-entry.module.css";

/**
 * A formula typeset for reading, with its LaTeX source kept in the page. MathLive is loaded in the
 * browser only; until it has loaded (or if it cannot be) the LaTeX itself is shown, so a formula
 * is never missing. The typeset part is hidden from assistive technology and carries the source as
 * its tooltip, while the source stays in the text for screen readers, copying and tests.
 *
 * Only LaTeX that `@proof/language` produced from validated MathJSON belongs here, never free
 * text such as the problem statement: MathLive's markup is injected as HTML.
 */
export function Formula({ latex }: Readonly<{ latex: string }>) {
  return (
    <span className={styles.formula}>
      <span className={styles.typeset} aria-hidden="true" title={latex}>
        <InlineLatex latex={latex} />
      </span>
      <span className="visually-hidden">{latex}</span>
    </span>
  );
}
