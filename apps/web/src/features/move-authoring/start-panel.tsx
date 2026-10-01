"use client";

import { useId, useMemo, useState } from "react";
import type { DisplayedSuggestionSet, OperatorDeclaration, ProofNode } from "@proof/protocol";
import { ancestorsOf, type HistoryEdge } from "../stored-proof-workspace/toolbar-actions";
import { deriveRecordedPath, pathEdges } from "./recorded-paths";
import {
  CLASS_LABELS,
  draftFromPath,
  draftFromPrimitive,
  primitiveOptions,
  type TemplateDraft,
} from "./template-builder";
import { Help, Hint, WhyDisabled } from "./help";
import styles from "./move-authoring.module.css";

export type StartPanelProps = Readonly<{
  nodes: readonly ProofNode[];
  edges: readonly HistoryEdge[];
  operators: readonly OperatorDeclaration[];
  suggestionSets: ReadonlyMap<string, DisplayedSuggestionSet>;
  /** Why no draft can be started (a read-only session), if so. */
  disabledReason?: string | undefined;
  onStart: (draft: TemplateDraft, source: string) => void;
}>;

/**
 * Where a draft starts: a path recorded in the stored history (a one-step path becomes a single
 * move, a longer one a macro), or one primitive kernel operation. The steps are read from the
 * stored edges and the suggestion sets they were applied from; nothing is recomputed.
 */
export function StartPanel({
  nodes,
  edges,
  operators,
  suggestionSets,
  disabledReason,
  onStart,
}: StartPanelProps) {
  const endId = useId();
  const startId = useId();
  const primitiveId = useId();
  const incoming = useMemo(
    () => new Map(edges.map((record) => [record.edge.childNodeId as string, record])),
    [edges],
  );
  const endOptions = useMemo(
    () => nodes.map(({ id }) => id as string).filter((id) => incoming.has(id)),
    [incoming, nodes],
  );
  const [toNodeId, setToNodeId] = useState<string | undefined>(undefined);
  const [fromNodeId, setFromNodeId] = useState<string | undefined>(undefined);
  const [primitive, setPrimitive] = useState<string>(() => primitiveOptions()[0]?.moveId ?? "");
  const primitives = useMemo(() => primitiveOptions(), []);

  const end = toNodeId ?? endOptions[0];
  const startOptions = end === undefined ? [] : ancestorsOf(edges, end);
  const start =
    fromNodeId !== undefined && startOptions.includes(fromNodeId)
      ? fromNodeId
      : incoming.get(end ?? "")?.edge.parentNodeId;
  const path = end === undefined || start === undefined ? undefined : pathEdges(edges, start, end);
  const derived = useMemo(
    () =>
      path === undefined || path.length === 0
        ? undefined
        : deriveRecordedPath({ nodes, path, suggestionSets, operators }),
    [nodes, operators, path, suggestionSets],
  );

  const nodeLabel = (id: string) => {
    const record = incoming.get(id);
    if (record === undefined) return "The very start";
    // Several steps can share a name; the position tells them apart without showing an ID.
    const same = nodes.filter(({ id: other }) => incoming.get(other)?.name === record.name);
    return same.length > 1
      ? `After “${record.name}” (#${same.findIndex((node) => node.id === id) + 1})`
      : `After “${record.name}”`;
  };

  const startFromPath = () => {
    if (derived === undefined || !derived.ok) return;
    const built = draftFromPath(derived.path);
    if (!built.ok) return;
    const names = derived.path.edges.map(({ name }) => `“${name}”`).join(", ");
    onStart(built.draft, `the recorded path ${names}`);
  };

  const startFromPrimitive = () => {
    const draft = draftFromPrimitive(primitive);
    if (draft !== undefined) {
      onStart(
        draft,
        `the primitive ${primitives.find(({ moveId }) => moveId === primitive)?.name}`,
      );
    }
  };

  return (
    <section className={styles.panel} aria-label="Start a move">
      <h2>1. Start from something you already did</h2>
      <Hint>
        The easiest way to make a move is to repeat a step you already took in this session. Pick
        that step (or a run of steps) and the move is built from it.
      </Hint>
      <p className={styles.example}>
        Example: you split a conjunction goal in the workspace. Choose that step here to make a
        “split goal” move that works on any conjunction.
      </p>
      <Help summary="How are moves built, and what can they do?">
        <p>
          A move only repeats operations the kernel already trusts; it never adds mathematics of its
          own. Each time it is used, the kernel checks the result again.
        </p>
        <p>
          One step becomes a suggestion in the workspace once it is approved. A run of several steps
          becomes a macro: it is stored and approved the same way, and is then offered as one
          suggestion that applies every step in a row (Preview shows what each step does).
        </p>
      </Help>
      <h3>From a recorded path</h3>
      {endOptions.length === 0 ? (
        <p className={styles.empty}>
          No steps are recorded yet: apply a move in the workspace, then come back, or start from an
          operation below.
        </p>
      ) : (
        <div className={styles.fieldGrid}>
          <label htmlFor={endId}>Path ending at</label>
          <select
            id={endId}
            value={end ?? ""}
            onChange={(event) => setToNodeId(event.target.value)}
          >
            {endOptions.map((id) => (
              <option key={id} value={id}>
                {nodeLabel(id)}
              </option>
            ))}
          </select>
          <label htmlFor={startId}>Starting after</label>
          <select
            id={startId}
            value={start ?? ""}
            onChange={(event) => setFromNodeId(event.target.value)}
          >
            {startOptions.map((id) => (
              <option key={id} value={id}>
                {nodeLabel(id)}
              </option>
            ))}
          </select>
        </div>
      )}
      {derived === undefined ? null : derived.ok ? (
        <>
          <ol aria-label="Recorded steps" className={styles.list}>
            {derived.path.edges.map(({ edge, name }, index) => (
              <li key={edge.id} className={styles.item}>
                <span>
                  {index + 1}. <strong>{name}</strong>
                </span>
                <span className={styles.badge}>{CLASS_LABELS[edge.transitionClass]}</span>
              </li>
            ))}
          </ol>
          <div className={styles.inline}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={disabledReason !== undefined}
              onClick={startFromPath}
            >
              {derived.path.steps.length === 1
                ? "Start a single-step move from this step"
                : `Start a ${derived.path.steps.length}-step macro from this path`}
            </button>
            <WhyDisabled reason={disabledReason} />
          </div>
        </>
      ) : (
        <div role="note" data-testid="path-unusable">
          <p className={styles.error}>{derived.message}</p>
          <Hint>
            Choose steps you applied by picking a suggestion in the workspace: those record what you
            selected. Steps made by other means, and steps that use a library result, cannot be
            turned into a move.
          </Hint>
        </div>
      )}
      <h3>From one basic operation</h3>
      <Hint>
        Prefer this when you have not done the step yet. A kernel operation is one of the basic
        proof steps the platform already trusts, such as splitting a conjunction; your move starts
        as that step (the “primitive”) and you add your own pattern and examples. You still add
        examples from steps you record later.
      </Hint>
      <div className={styles.inline}>
        <label htmlFor={primitiveId}>Kernel operation</label>
        <select
          id={primitiveId}
          value={primitive}
          onChange={(event) => setPrimitive(event.target.value)}
        >
          {primitives.map((option) => (
            <option key={option.moveId} value={option.moveId}>
              {option.name} ({CLASS_LABELS[option.transitionClass]})
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.button}
          disabled={disabledReason !== undefined}
          onClick={startFromPrimitive}
        >
          Start from this primitive
        </button>
        <WhyDisabled reason={disabledReason} />
      </div>
    </section>
  );
}
