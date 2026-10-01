"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { compactMathText, type OperatorDeclaration, type ProofNode } from "@proof/protocol";
import type { AnchoredProofSelection } from "@proof/selections";
import { ProofWorkspace } from "../proof-workspace";
import {
  addNegativeExample,
  selectedFragment,
  setSlotPattern,
  slotViews,
  type SlotSelections,
  type TemplateDraft,
} from "./template-builder";
import { Help, Hint, WhyDisabled } from "./help";
import styles from "./move-authoring.module.css";

export type SnapshotPanelProps = Readonly<{
  nodes: readonly ProofNode[];
  operators: readonly OperatorDeclaration[];
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  disabled?: boolean | undefined;
}>;

/**
 * A stored snapshot to click in. What is selected here becomes a pattern of a contract slot, or
 * is assigned to slots to form a negative example (selections the kernel must refuse). The
 * snapshot is the stored one; the selection is read from it, never typed.
 */
export function SnapshotPanel({
  nodes,
  operators,
  draft,
  onChange,
  disabled = false,
}: SnapshotPanelProps) {
  const nodeSelectId = useId();
  const slotSelectId = useId();
  const descriptionId = useId();
  const codeId = useId();
  const [nodeId, setNodeId] = useState<string | undefined>(undefined);
  const [selections, setSelections] = useState<readonly AnchoredProofSelection[]>([]);
  const [slotId, setSlotId] = useState<string | undefined>(undefined);
  const [assigned, setAssigned] = useState<SlotSelections>({});
  const [description, setDescription] = useState("");
  const [code, setCode] = useState("");
  const [notice, setNotice] = useState<Readonly<{ kind: "ok" | "error"; text: string }>>();

  const node = nodes.find(({ id }) => id === nodeId) ?? nodes[nodes.length - 1];
  const slots = slotViews(draft);
  const slot = slots.find(({ id }) => id === slotId)?.id ?? slots[0]?.id;
  const fragment = useMemo(
    () => (node === undefined ? undefined : selectedFragment(node, selections, operators)),
    [node, operators, selections],
  );
  const handleSelection = useCallback(
    (next: readonly AnchoredProofSelection[]) => setSelections(next),
    [],
  );

  if (node === undefined) return null;

  const chooseNode = (id: string) => {
    setNodeId(id);
    setAssigned({});
    setNotice(undefined);
  };

  const usePattern = () => {
    if (slot === undefined || fragment === undefined || !fragment.ok) return;
    onChange(setSlotPattern(draft, slot, fragment.expression));
    setNotice({
      kind: "ok",
      text: `The pattern for ${slot} is now ${compactMathText(fragment.expression)}.`,
    });
  };

  const assign = () => {
    const [selection] = selections;
    if (slot === undefined || selection === undefined || selections.length !== 1) return;
    setAssigned({ ...assigned, [slot]: selection });
    setNotice(undefined);
  };

  const addNegative = () => {
    const added = addNegativeExample(
      draft,
      node,
      assigned,
      description.trim() === "" ? `Rejected in ${node.id}` : description.trim(),
      code.trim() === "" ? undefined : code.trim(),
    );
    if (!added.ok) {
      setNotice({ kind: "error", text: added.message });
      return;
    }
    onChange(added.draft);
    setAssigned({});
    setDescription("");
    setCode("");
    setNotice({ kind: "ok", text: "Added a negative example." });
  };

  const assignedSlots = Object.keys(assigned);
  const patternReason = disabled
    ? "Editing is unavailable right now."
    : fragment === undefined
      ? undefined
      : fragment.ok
        ? undefined
        : fragment.message;
  const assignReason = disabled
    ? "Editing is unavailable right now."
    : selections.length === 1
      ? undefined
      : "Select exactly one occurrence in the proof state first.";
  const negativeReason = disabled
    ? "Editing is unavailable right now."
    : assignedSlots.length === 0
      ? "Assign a selection to a slot first (the button above)."
      : undefined;
  return (
    <section className={styles.panel} aria-label="Stored snapshot">
      <h2>Pick an occurrence in a stored proof state</h2>
      <Hint>
        Choose a proof state from this session, then select part of a goal or hypothesis exactly as
        you do in the workspace. You never type mathematics: what you select is read from the stored
        state.
      </Hint>
      <Help summary="What can I do with a selection?">
        <p>
          <strong>Use it as a pattern:</strong> the move will then apply to selections of the same
          shape. Example: select the goal “p and q” and use it for the target; the pattern becomes
          And(p, q).
        </p>
        <p>
          <strong>Use it for a negative example:</strong> select something the move must refuse,
          assign it to the matching selection above, and add it. Example: select an atom “p” as the
          target of a split-conjunction move.
        </p>
      </Help>
      <div className={styles.inline}>
        <label htmlFor={nodeSelectId}>Snapshot</label>
        <select
          id={nodeSelectId}
          value={node.id}
          onChange={(event) => chooseNode(event.target.value)}
        >
          {nodes.map(({ id }) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </div>
      <div className={styles.snapshot}>
        <ProofWorkspace
          node={node}
          operators={operators}
          view="formal"
          onSelectionChange={handleSelection}
        />
      </div>
      <p className={styles.muted} data-testid="snapshot-selection">
        {fragment === undefined || !fragment.ok
          ? (fragment?.message ?? "")
          : `Selected: ${compactMathText(fragment.expression)}`}
      </p>
      <div className={styles.inline}>
        <label htmlFor={slotSelectId}>Slot</label>
        <select
          id={slotSelectId}
          value={slot ?? ""}
          onChange={(event) => setSlotId(event.target.value)}
        >
          {slots.map(({ id }) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={styles.button}
          disabled={patternReason !== undefined}
          onClick={usePattern}
        >
          Use the selection as this slot&apos;s pattern
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={assignReason !== undefined}
          onClick={assign}
        >
          Assign the selection to this slot
        </button>
        <WhyDisabled reason={patternReason ?? assignReason} />
      </div>
      {assignedSlots.length === 0 ? null : (
        <ul aria-label="Assigned selections" className={styles.list}>
          {assignedSlots.map((assignedSlot) => (
            <li key={assignedSlot} className={styles.item}>
              <span className={styles.code}>
                {assignedSlot}: {describeSelection(assigned[assignedSlot]!)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>A selection the move must refuse</h3>
      <Hint>
        Assign selections to slots, then add them as a negative example. Checking later confirms the
        kernel really refuses them.
      </Hint>
      <div className={styles.fieldGrid}>
        <label htmlFor={descriptionId}>Note for this example</label>
        <input
          id={descriptionId}
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <label htmlFor={codeId}>Expected reason (optional)</label>
        <input
          id={codeId}
          type="text"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </div>
      <div className={styles.inline}>
        <button
          type="button"
          className={styles.button}
          disabled={negativeReason !== undefined}
          onClick={addNegative}
        >
          Add as a negative example (the kernel must refuse it)
        </button>
        <WhyDisabled reason={negativeReason} />
      </div>
      {notice === undefined ? null : (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={notice.kind === "error" ? styles.error : styles.notice}
        >
          {notice.text}
        </p>
      )}
    </section>
  );
}

function describeSelection(selection: AnchoredProofSelection): string {
  const where =
    selection.anchor.statement.kind === "conclusion"
      ? `${selection.anchor.target.id} conclusion`
      : `${selection.anchor.target.id} hypothesis ${selection.anchor.statement.id}`;
  return selection.kind === "exact"
    ? `${where} at [${selection.path.join(", ")}]`
    : `${where} operands ${selection.startOperand}–${selection.endOperand} of [${selection.containerPath.join(", ")}]`;
}
