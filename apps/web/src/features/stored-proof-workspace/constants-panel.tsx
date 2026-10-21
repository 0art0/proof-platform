"use client";

import { createPresentation } from "@proof/language";
import type { OperatorDeclaration, PlainMathJson } from "@proof/protocol";
import { InlineLatex } from "../proof-workspace/presentation";
import type { ConstantsView } from "./use-session-constants";
import styles from "./constants-panel.module.css";

/** A constant applied to placeholder operands, in LaTeX, with its display name. */
export function describeConstant(
  operator: OperatorDeclaration,
): Readonly<{ latex: string; name: string }> {
  const name = operator.presentation?.displayName ?? operator.symbol;
  const operands = operator.signature.parameters.map((_, index) => `x_${index + 1}`);
  try {
    const expression: PlainMathJson = [operator.symbol, ...operands];
    return { latex: createPresentation({ operators: [operator] }).latex(expression), name };
  } catch {
    return { latex: `${operator.symbol}(${operands.join(", ")})`, name };
  }
}

function quoted(names: readonly string[]): string {
  const marked = names.map((name) => `‘${name}’`);
  return marked.length <= 1
    ? (marked[0] ?? "")
    : `${marked.slice(0, -1).join(", ")} and ${marked[marked.length - 1]}`;
}

/**
 * The proof's constants, easy to find and quiet: a collapsed list near the proof state that says
 * which notation is in use, which constants a step added by applying a library result (marked,
 * with a brief highlight when one arrives), and which library constants are still available. It is
 * read-only; constants are added by applying a result, never edited here.
 */
export function ConstantsPanel({ view }: Readonly<{ view: ConstantsView }>) {
  if (view.kind === "loading") {
    return (
      <p className={styles.quiet} data-testid="constants-loading">
        Loading the proof’s constants…
      </p>
    );
  }
  if (view.kind === "unavailable") {
    return (
      <p className={styles.quiet} data-testid="constants-unavailable">
        The list of constants could not be loaded right now. The proof itself is unaffected.
      </p>
    );
  }
  const { constants, added } = view;
  const activated = new Map(constants.activated.map((entry) => [entry.symbol, entry]));
  const justAdded = constants.activated.filter(({ symbol }) => added.includes(symbol));
  return (
    <div className={styles.shell} data-testid="constants-panel">
      <details className={styles.panel}>
        <summary>
          Constants{" "}
          <span className={styles.count}>
            {constants.active.length} in use
            {constants.available.length > 0 ? `, ${constants.available.length} more available` : ""}
          </span>
          {justAdded.length > 0 ? (
            <mark className={styles.newMark} data-testid="constants-new-mark">
              new
            </mark>
          ) : null}
        </summary>
        <p className={styles.hint}>
          Constants are the notation this proof works with, besides built-in mathematics. Applying a
          library result that uses a constant the proof does not have yet adds that constant here.
        </p>
        {constants.active.length === 0 ? (
          <p className={styles.empty}>
            This proof uses no notation of its own yet, only built-in mathematics.
          </p>
        ) : (
          <ul className={styles.list} aria-label="Constants in use">
            {constants.active.map(({ symbol, operator, origin }) => {
              const described = describeConstant(operator);
              const activation = activated.get(symbol);
              const isNew = added.includes(symbol);
              return (
                <li
                  key={symbol}
                  className={styles.item}
                  data-origin={origin}
                  data-new={isNew ? "true" : undefined}
                  data-constant={symbol}
                >
                  <span className={styles.notation}>
                    <InlineLatex latex={described.latex} />
                  </span>{" "}
                  <strong>{described.name}</strong>
                  <span className={styles.origin}>
                    {origin === "setup"
                      ? "from the problem setup"
                      : activation?.resultName != null
                        ? `added when ‘${activation.resultName}’ was applied`
                        : "added when a library result was applied"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <h4 className={styles.subheading}>Available from the library</h4>
        {constants.available.length === 0 ? (
          <p className={styles.empty}>
            No further constants are waiting in the library. A new one appears here when the library
            gains a result that uses it.
          </p>
        ) : (
          <>
            <p className={styles.hint}>
              These are not part of the proof yet. Applying a result that uses one adds it.
            </p>
            <ul className={styles.list} aria-label="Constants available from the library">
              {constants.available.map(({ symbol, operator, results }) => {
                const described = describeConstant(operator);
                return (
                  <li
                    key={symbol}
                    className={`${styles.item} ${styles.available}`}
                    data-constant={symbol}
                  >
                    <span className={styles.notation}>
                      <InlineLatex latex={described.latex} />
                    </span>{" "}
                    <strong>{described.name}</strong>
                    {results.length === 0 ? null : (
                      <span className={styles.origin}>
                        used by {quoted(results.slice(0, 3).map(({ name }) => name))}
                        {results.length > 3 ? ` and ${results.length - 3} more` : ""}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {constants.readOnly ? (
          <p className={styles.hint}>This session is read-only, so its constants cannot change.</p>
        ) : null}
      </details>
      {justAdded.length > 0 ? (
        <p className={styles.added} role="status" data-testid="constants-added">
          {justAdded.length === 1 ? "A constant was" : "Constants were"} added to this proof:{" "}
          {quoted(
            justAdded.map(({ symbol }) => {
              const operator = constants.active.find((entry) => entry.symbol === symbol)?.operator;
              return operator === undefined ? symbol : describeConstant(operator).name;
            }),
          )}
          {justAdded[0]?.resultName != null ? `, by applying ‘${justAdded[0].resultName}’` : ""}.
        </p>
      ) : null}
    </div>
  );
}
