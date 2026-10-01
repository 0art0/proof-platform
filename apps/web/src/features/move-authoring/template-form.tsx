"use client";

import { useId } from "react";
import type { LibraryEntry } from "../library-drawer/api-contract";
import type { TemplateDiagnosticView } from "./api-contract";
import { Help, Hint, InlineDiagnostics, WhyDisabled } from "./help";
import {
  CLASS_LABELS,
  changeFirstPrimitive,
  composedClass,
  moveIdOf,
  parseDraft,
  patternViews,
  planView,
  primitiveOptions,
  removeLastStep,
  removePattern,
  setDeclaredClass,
  setSlotRequired,
  slotViews,
  suggestIdSuffix,
  toggleArtifact,
  type TemplateDraft,
  type TransitionClassName,
} from "./template-builder";
import styles from "./move-authoring.module.css";

export type TemplateFormProps = Readonly<{
  draft: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  /** Library definitions and results a move may require. */
  artifacts: readonly LibraryEntry[];
  /** The diagnostics of the latest validation, shown next to the fields they concern. */
  diagnostics?: readonly TemplateDiagnosticView[] | undefined;
  /** The text fields cannot be edited while a save is in flight or in a read-only session. */
  disabled?: boolean | undefined;
}>;

const CLASS_NAMES: readonly TransitionClassName[] = ["equivalence", "strengthening", "weakening"];

/** What each kind of step means, in a sentence. */
export const CLASS_EXPLANATIONS: Readonly<Record<TransitionClassName, string>> = Object.freeze({
  equivalence: "The new goals are true exactly when the old goal was: nothing is gained or lost.",
  strengthening:
    "The new goals are stronger than the old one: proving them is enough, but they may be harder.",
  weakening:
    "The new goals are weaker than the old one: they may be easier, but proving them might not be enough.",
});

/**
 * The visual template editor's structured sections, in plain words: what the move does, what you
 * select, what a selection must look like, the choices it asks for, the library items it relies
 * on, and the kind of step it is. Examples are edited in their own panel because they are captured
 * from stored snapshots.
 */
export function TemplateForm({
  draft,
  onChange,
  artifacts,
  diagnostics = [],
  disabled = false,
}: TemplateFormProps) {
  const nameId = useId();
  const idId = useId();
  const descriptionId = useId();
  const classId = useId();
  const firstId = useId();
  const parsed = parseDraft(draft);
  const plan = planView(draft);
  const composed = composedClass(draft);
  const primitives = primitiveOptions();
  const firstStep = plan[0];
  const choosable = artifacts.filter(
    ({ artifact }) => artifact.kind === "definition" || artifact.kind === "result",
  );
  const declared = draft.body.transitionClass;

  return (
    <section className={styles.panel} aria-label="Move template">
      <h2>2. Name and describe your move</h2>
      <Hint>
        This is what other people see in the suggestion list. Say what the move does and when to use
        it.
      </Hint>
      <div className={styles.fieldGrid}>
        <label htmlFor={nameId}>Name</label>
        <input
          id={nameId}
          type="text"
          value={draft.name}
          placeholder="e.g. Split a conjunction goal"
          disabled={disabled}
          onChange={(event) => {
            const name = event.target.value;
            // The ID follows the name until the author sets it by hand.
            const followsName = draft.idSuffix === suggestIdSuffix(draft.name);
            onChange({
              ...draft,
              name,
              ...(followsName ? { idSuffix: suggestIdSuffix(name) } : {}),
            });
          }}
        />
        <label htmlFor={idId}>Move ID</label>
        <span className={styles.inline}>
          <span className={styles.code}>authored:</span>
          <input
            id={idId}
            type="text"
            value={draft.idSuffix}
            placeholder="split-a-conjunction-goal"
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, idSuffix: event.target.value })}
          />
        </span>
        <label htmlFor={descriptionId}>Description</label>
        <textarea
          id={descriptionId}
          value={draft.description}
          placeholder="e.g. Turn a goal “A and B” into two goals, one for A and one for B."
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, description: event.target.value })}
        />
      </div>
      <p className={styles.muted} data-testid="move-id">
        This move will be {moveIdOf(draft)}. The ID follows the name until you edit it.
      </p>
      <InlineDiagnostics diagnostics={diagnostics} section="details" />
      {parsed.ok ? null : (
        <div role="note" aria-label="Template problems">
          <p className={styles.error}>Not complete yet. To save, fix:</p>
          <ul className={styles.diagnostics}>
            {parsed.problems.map((problem) => (
              <li key={problem} className={styles.diagnostic}>
                {problem}
              </li>
            ))}
          </ul>
        </div>
      )}
      <InlineDiagnostics diagnostics={diagnostics} section="template" />

      <section aria-label="Kind of step">
        <h3>Kind of step (declared class)</h3>
        <Hint>
          Say what the move does to the proof. The kernel works out the real answer from the steps;
          the two must agree.
        </Hint>
        <div className={styles.inline}>
          <label htmlFor={classId}>This move is</label>
          <select
            id={classId}
            value={declared}
            disabled={disabled}
            onChange={(event) =>
              onChange(setDeclaredClass(draft, event.target.value as TransitionClassName))
            }
          >
            {CLASS_NAMES.map((name) => (
              <option key={name} value={name}>
                {CLASS_LABELS[name]}
              </option>
            ))}
          </select>
          <span className={styles.muted} data-testid="composed-class">
            Its kernel steps compose to {CLASS_LABELS[composed]}.
          </span>
        </div>
        <p className={styles.hint} data-testid="class-explanation">
          {CLASS_LABELS[declared]}: {CLASS_EXPLANATIONS[declared]}
        </p>
        {declared === composed ? null : (
          <p className={styles.error} role="note">
            The kernel will report {CLASS_LABELS[composed]} for these steps, so checking will refuse
            this class. Choose {CLASS_LABELS[composed]}.
          </p>
        )}
        <Help summary="What do the three kinds mean?">
          <ul>
            {CLASS_NAMES.map((name) => (
              <li key={name}>
                <strong>{CLASS_LABELS[name]}.</strong> {CLASS_EXPLANATIONS[name]}
              </li>
            ))}
          </ul>
        </Help>
        <InlineDiagnostics diagnostics={diagnostics} section="class" />
      </section>

      <section aria-label="Plan">
        <h3>What the move does (plan)</h3>
        <Hint>
          The kernel operations the move performs, in order. One step becomes a suggestion in the
          workspace; several steps make a macro that is replayed as a unit.
        </Hint>
        <ol className={styles.list}>
          {plan.map((step) => (
            <li key={step.id} className={styles.item} data-step-index={step.index}>
              <span className={styles.itemBody}>
                <span>
                  {step.index + 1}. <strong>{step.moveName}</strong>
                </span>
                <span className={styles.muted}>
                  {step.operationKind}
                  {step.recorded ? " — replayed from its recording" : " — driven by selections"}
                </span>
              </span>
              <span className={styles.badge}>{CLASS_LABELS[step.transitionClass]}</span>
            </li>
          ))}
        </ol>
        <div className={styles.inline}>
          <label htmlFor={firstId}>First step</label>
          <select
            id={firstId}
            value={firstStep?.moveId ?? ""}
            disabled={disabled}
            onChange={(event) => onChange(changeFirstPrimitive(draft, event.target.value))}
          >
            {primitives.map((option) => (
              <option key={option.moveId} value={option.moveId}>
                {option.name}
              </option>
            ))}
          </select>
          {plan.length > 1 ? (
            <button
              type="button"
              className={styles.button}
              disabled={disabled}
              onClick={() => onChange(removeLastStep(draft))}
            >
              Remove the last step
            </button>
          ) : (
            <span className={styles.muted}>
              A plan needs at least one step, so there is nothing to remove.
            </span>
          )}
        </div>
        <p className={styles.example}>
          Example: “Split goal conjunction” turns a goal A and B into one goal for A and one for B.
          Changing the first step replaces the selections and patterns below with that
          operation&apos;s.
        </p>
        <InlineDiagnostics diagnostics={diagnostics} section="plan" />
      </section>

      <section aria-label="Selection contract">
        <h3>What you select (selection contract)</h3>
        <Hint>
          The parts of the proof you click before using the move, such as the goal to split or the
          hypothesis to use. Tick a box to require it.
        </Hint>
        <ul className={styles.list}>
          {slotViews(draft).map((slot) => (
            <li key={slot.id} className={styles.item}>
              <span className={styles.itemBody}>
                <span className={styles.code}>{slot.id}</span>
                <span className={styles.muted}>
                  {slot.role}, {slot.semanticRole}
                </span>
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={slot.required}
                  disabled={disabled || slot.locked}
                  onChange={(event) =>
                    onChange(setSlotRequired(draft, slot.id, event.target.checked))
                  }
                />{" "}
                Required
                {slot.locked ? " (always, for this operation)" : ""}
              </label>
            </li>
          ))}
        </ul>
        <InlineDiagnostics diagnostics={diagnostics} section="contract" />
      </section>

      <section aria-label="Patterns">
        <h3>What a selection must look like (patterns)</h3>
        <Hint>
          A pattern says which selections the move applies to. Names that are not declared
          operators, such as p and q, stand for any expression. Pick a pattern by selecting an
          occurrence in a stored proof state below and using it for a slot.
        </Hint>
        <p className={styles.example}>
          Example: And(p, q) matches any conjunction; Not(p) matches any negation.
        </p>
        <ul className={styles.list}>
          {patternViews(draft).map((pattern) => (
            <li key={pattern.id} className={styles.item}>
              <span className={styles.itemBody}>
                <span className={styles.code}>{pattern.text}</span>
                <span className={styles.muted}>for the selection “{pattern.slotId}”</span>
              </span>
              <span className={styles.inline}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={disabled || draft.body.patterns.length <= 1}
                  onClick={() => onChange(removePattern(draft, pattern.id))}
                  aria-label={`Remove the pattern for ${pattern.slotId}`}
                >
                  Remove
                </button>
                <WhyDisabled
                  reason={
                    draft.body.patterns.length <= 1
                      ? "A move needs at least one pattern."
                      : undefined
                  }
                />
              </span>
            </li>
          ))}
        </ul>
        <InlineDiagnostics diagnostics={diagnostics} section="patterns" />
      </section>

      <section aria-label="Parameters">
        <h3>Choices asked each time (parameters)</h3>
        {draft.body.parameters.length === 0 ? (
          <p className={styles.empty}>
            This operation asks for no choices: once you select, it can be applied.
          </p>
        ) : (
          <>
            <Hint>
              Some operations need a choice, such as which term to substitute. The workspace shows a
              menu each time the move is applied; your examples record the choice made in the stored
              step.
            </Hint>
            <ul className={styles.list}>
              {draft.body.parameters.map((parameter) => (
                <li key={parameter.id} className={styles.item}>
                  <span>{parameter.label}</span>
                  <span className={styles.badge}>{parameter.source}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <InlineDiagnostics diagnostics={diagnostics} section="parameters" />
      </section>

      <section aria-label="Required artifacts">
        <h3>Library items it relies on (required artifacts)</h3>
        {choosable.length === 0 ? (
          <p className={styles.empty}>
            Nothing to choose: this session&apos;s library has no definitions or results yet. Most
            moves rely on none.
          </p>
        ) : (
          <>
            <Hint>
              Tick a definition or result the move needs. It is offered only where the item is
              available. Most moves rely on none.
            </Hint>
            <ul className={styles.list}>
              {choosable.map(({ artifact }) => {
                const kind = artifact.kind as "definition" | "result";
                const checked = draft.body.requiredArtifacts.some(
                  (reference) => reference.kind === kind && reference.id === artifact.id,
                );
                return (
                  <li key={`${kind}:${artifact.id}`} className={styles.item}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={() => onChange(toggleArtifact(draft, { kind, id: artifact.id }))}
                      />{" "}
                      {artifact.name} <span className={styles.muted}>({kind})</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <InlineDiagnostics diagnostics={diagnostics} section="artifacts" />
      </section>
    </section>
  );
}
