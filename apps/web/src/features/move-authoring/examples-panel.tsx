"use client";

import { useMemo, useState } from "react";
import type { DisplayedSuggestionSet, OperatorDeclaration, ProofNode } from "@proof/protocol";
import type { HistoryEdge } from "../stored-proof-workspace/toolbar-actions";
import type { TemplateDiagnosticView } from "./api-contract";
import { diagnosticAdvice, diagnosticsForExample, diagnosticTitle } from "./diagnostics";
import { deriveRecordedPath, pathsWithMoves } from "./recorded-paths";
import {
  addPositiveExample,
  exampleViews,
  moveIdsOfPlan,
  negativeCount,
  positiveCount,
  removeExample,
  type TemplateDraft,
} from "./template-builder";
import { Help, Hint, WhyDisabled } from "./help";
import styles from "./move-authoring.module.css";

export type ExamplesPanelProps = Readonly<{
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
  operators: readonly OperatorDeclaration[];
  suggestionSets: ReadonlyMap<string, DisplayedSuggestionSet>;
  /** The diagnostics of the latest validation, shown on the example they concern. */
  diagnostics: readonly TemplateDiagnosticView[];
  disabled?: boolean | undefined;
}>;

/**
 * The template's examples. A positive example is a recorded path that applies the plan's moves:
 * its start snapshot, selections and menu choices come from the stored step, and the snapshot it
 * reached is the expected outcome. Negative examples are captured in the snapshot panel.
 */
export function ExamplesPanel({
  draft,
  onChange,
  nodes,
  edges,
  operators,
  suggestionSets,
  diagnostics,
  disabled = false,
}: ExamplesPanelProps) {
  const [notice, setNotice] = useState<string>();
  const views = exampleViews(draft);
  const plan = draft.body.plan;
  const planMoves = useMemo(() => moveIdsOfPlan(plan), [plan]);
  const candidates = useMemo(() => {
    const names = new Set(draft.body.examples.map(({ description }) => description));
    return pathsWithMoves(edges, planMoves).flatMap((path) => {
      const description = describePath(path);
      if (names.has(description)) return [];
      return [
        {
          key: path.map(({ edge }) => edge.id).join(">"),
          description,
          derived: deriveRecordedPath({ nodes, path, suggestionSets, operators }),
        },
      ];
    });
  }, [draft.body.examples, edges, nodes, operators, planMoves, suggestionSets]);

  return (
    <section className={styles.panel} aria-label="Examples">
      <h2>3. Show it working and failing (examples)</h2>
      <Hint>
        Examples are how the kernel proves your move does what you say. Add two that should work and
        one that shouldn&apos;t.
      </Hint>
      <Help summary="Where do examples come from?">
        <p>
          <strong>Should work:</strong> a step you recorded earlier that the move would repeat. Its
          proof state, selections and choices are read from the stored step, and the state it
          reached is what is expected.
        </p>
        <p>
          <strong>Shouldn&apos;t work:</strong> a selection the move must refuse, picked in a stored
          proof state in the panel above.
        </p>
      </Help>
      <p className={styles.muted} data-testid="example-counts">
        {positiveCount(draft)} should work, {negativeCount(draft)} should fail. A move needs at
        least two that should work and one that should fail.
      </p>
      {views.length === 0 ? (
        <p className={styles.empty}>
          No examples yet: add two that should work and one that shouldn&apos;t.
        </p>
      ) : (
        <ul className={styles.list}>
          {views.map((example, index) => {
            const problems = diagnosticsForExample(diagnostics, example.id, index);
            return (
              <li
                key={example.id}
                className={styles.item}
                data-outcome={example.outcome}
                data-example-id={example.id}
              >
                <span className={styles.itemBody}>
                  <span>
                    <strong>{example.id}</strong> — {example.description}
                  </span>
                  <span className={styles.muted}>
                    {example.expectation}; {example.selectionCount} selection
                    {example.selectionCount === 1 ? "" : "s"}
                  </span>
                  {problems.map((problem, problemIndex) => (
                    <span
                      key={`${problem.code}:${problemIndex}`}
                      className={styles.error}
                      role="alert"
                    >
                      {diagnosticTitle(problem.code)}: {problem.message}
                      {diagnosticAdvice(problem.code) === undefined
                        ? null
                        : ` What to do: ${diagnosticAdvice(problem.code)}`}
                    </span>
                  ))}
                </span>
                <button
                  type="button"
                  className={styles.button}
                  disabled={disabled}
                  onClick={() => onChange(removeExample(draft, example.id))}
                  aria-label={`Remove example ${example.id}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h3>Examples that should work: recorded steps</h3>
      {candidates.length === 0 ? (
        <p className={styles.empty}>
          Every recorded step that matches this move is already an example. To add another that
          should work, apply the move once more in the workspace (on a different goal), then come
          back.
        </p>
      ) : (
        <ul className={styles.list} aria-label="Recorded paths for this plan">
          {candidates.map((candidate) => (
            <li key={candidate.key} className={styles.item}>
              <span className={styles.itemBody}>
                <span>{candidate.description}</span>
                <WhyDisabled
                  reason={
                    disabled
                      ? "Editing is unavailable right now."
                      : candidate.derived.ok
                        ? undefined
                        : `Cannot be used: ${candidate.derived.message}`
                  }
                />
              </span>
              <button
                type="button"
                className={styles.button}
                disabled={disabled || !candidate.derived.ok}
                onClick={() => {
                  if (!candidate.derived.ok) return;
                  const added = addPositiveExample(
                    draft,
                    candidate.derived.path,
                    operators,
                    candidate.description,
                  );
                  if (added.ok) {
                    onChange(added.draft);
                    setNotice(undefined);
                  } else {
                    setNotice(added.message);
                  }
                }}
              >
                Add as a positive example
              </button>
            </li>
          ))}
        </ul>
      )}
      {notice === undefined ? null : (
        <p role="alert" className={styles.error}>
          {notice}
        </p>
      )}
    </section>
  );
}

function describePath(path: readonly HistoryEdge[]): string {
  const first = path[0];
  const last = path[path.length - 1];
  if (first === undefined || last === undefined) return "";
  return `Recorded: ${path.map(({ name }) => name).join(" → ")} (${first.edge.parentNodeId} → ${last.edge.childNodeId})`;
}
