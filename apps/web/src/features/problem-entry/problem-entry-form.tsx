"use client";

import { useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { createLatexRenderer, createPresentation } from "@proof/language";
import {
  BACKGROUND_LEVELS,
  createProofNodeSchema,
  operatorDeclarationSchema,
  problemSetupDiagnosticSchema,
  problemSetupReviewSchema,
  type OperatorDeclaration,
  type ProblemDraft,
  type ProblemSetupDiagnostic,
  type ProblemSetupOptions,
  type ProblemSetupReview,
  type ProofNode,
} from "@proof/protocol";
import { z } from "zod";
import {
  draftPathLabel,
  emptyProblemForm,
  formToDraft,
  missingRequiredFields,
  type DeclarationRow,
  type FormProblem,
  type ProblemForm,
} from "./draft-form";
import { recordRecentSession } from "./recent-sessions";
import { StatementField } from "./statement-field";
import styles from "./problem-entry.module.css";

type Reviewed = Readonly<{
  /** The exact draft that was reviewed; approval sends this, never the live form. */
  draft: ProblemDraft;
  draftKey: string;
  review: ProblemSetupReview;
  node: ProofNode;
  operators: readonly OperatorDeclaration[];
  /** Chosen once per review, so a retried approval is idempotent. */
  sessionId: string;
}>;

type TextField =
  | "title"
  | "statement"
  | "backgroundLevel"
  | "backgroundSummary"
  | "backgroundAssumptions"
  | "backgroundDomains"
  | "maximumLevel"
  | "preferredDomains"
  | "notation";

type Notice =
  | Readonly<{ kind: "problems"; problems: readonly FormProblem[] }>
  | Readonly<{ kind: "diagnostics"; diagnostics: readonly ProblemSetupDiagnostic[] }>
  | Readonly<{ kind: "error"; message: string }>;

export type ProblemEntryFormProps = Readonly<{
  options: ProblemSetupOptions;
  /** Navigate to the created session; defaults to a full navigation. */
  navigate?: (url: string) => void;
  createSessionId?: () => string;
}>;

const apiFailureSchema = z
  .object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }).strict(),
    details: z.unknown().optional(),
  })
  .strict();

/**
 * New problem (design plan §4.1, §4.4 without the formalizer). The draft stays in the browser.
 * "Check setup" asks the worker to validate it and shows the mathematical content; only
 * "Start exploring" on an unchanged reviewed draft creates the session and root node.
 * Any edit after review discards the review.
 */
export function ProblemEntryForm({
  options,
  navigate = (url) => window.location.assign(url),
  createSessionId = () => `session:${crypto.randomUUID()}`,
}: ProblemEntryFormProps) {
  const [form, setForm] = useState<ProblemForm>(emptyProblemForm);
  const [reviewed, setReviewed] = useState<Reviewed>();
  const [notice, setNotice] = useState<Notice>();
  const [busy, setBusy] = useState<"review" | "approve">();
  const nextKey = useRef(100);

  const packOperators = useMemo(() => operatorsByPack(options), [options]);
  const selectedOperators = useMemo(
    () =>
      options.packs.flatMap((pack) =>
        form.packIds.includes(pack.id) ? (packOperators.get(pack.id) ?? []) : [],
      ),
    [form.packIds, options.packs, packOperators],
  );
  const latex = useMemo(
    () => createLatexRenderer({ operators: selectedOperators }),
    [selectedOperators],
  );

  const current = useMemo(() => formToDraft(form, options), [form, options]);
  const approvable =
    reviewed !== undefined && current.ok && JSON.stringify(current.draft) === reviewed.draftKey;

  /** Every edit goes through here, and every edit invalidates the review. */
  const update = (change: (previous: ProblemForm) => ProblemForm) => {
    setForm(change);
    setReviewed(undefined);
    setNotice(undefined);
  };
  const key = () => (nextKey.current += 1);
  /** Read the event value now; state updaters run later. */
  const text =
    (field: TextField) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const value = event.currentTarget.value;
      update((previous) => ({ ...previous, [field]: value }));
    };

  const review = async () => {
    setReviewed(undefined);
    const missing = missingRequiredFields(form);
    if (!current.ok || missing.length > 0) {
      const known = new Set(missing.map(({ field }) => field));
      const others = current.ok ? [] : current.problems.filter(({ field }) => !known.has(field));
      setNotice({ kind: "problems", problems: [...missing, ...others] });
      return;
    }
    const draft = current.draft;
    setBusy("review");
    setNotice(undefined);
    try {
      const response = await postJson("/api/problem-drafts/validate", { draft });
      if (response.ok) {
        const parsed = z
          .object({
            ok: z.literal(true),
            data: z.object({ ok: z.literal(true), review: problemSetupReviewSchema }).strict(),
          })
          .strict()
          .safeParse(response.body);
        const operators = parsed.success
          ? parseOperators(parsed.data.data.review.operators)
          : undefined;
        const node =
          parsed.success && operators !== undefined
            ? createProofNodeSchema({ operators }).safeParse(parsed.data.data.review.rootNode)
            : undefined;
        if (!parsed.success || operators === undefined || node === undefined || !node.success) {
          setNotice({ kind: "error", message: "The proof service returned an invalid review." });
          return;
        }
        setReviewed({
          draft,
          draftKey: JSON.stringify(draft),
          review: parsed.data.data.review,
          node: node.data,
          operators,
          sessionId: createSessionId(),
        });
        return;
      }
      setNotice(failureNotice(response.body));
    } catch {
      setNotice({ kind: "error", message: "The proof service could not be reached." });
    } finally {
      setBusy(undefined);
    }
  };

  const approve = async () => {
    if (reviewed === undefined || !approvable) return;
    setBusy("approve");
    setNotice(undefined);
    try {
      const response = await postJson("/api/proof-sessions", {
        sessionId: reviewed.sessionId,
        draft: reviewed.draft,
        reviewedDigest: reviewed.review.digest,
      });
      if (response.ok) {
        recordRecentSession({
          id: reviewed.sessionId,
          title: reviewed.review.metadata.problem.title,
        });
        navigate(`/sessions/${encodeURIComponent(reviewed.sessionId)}`);
        return;
      }
      const failure = failureNotice(response.body);
      if (response.status === 409 || response.status === 422) setReviewed(undefined);
      setNotice(failure);
    } catch {
      setNotice({
        kind: "error",
        message: "The proof service could not be reached. Approving again is safe.",
      });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <form
      className={styles.entry}
      aria-label="New problem"
      onSubmit={(event) => {
        event.preventDefault();
        void review();
      }}
    >
      <Section title="Problem">
        <Field label="Problem title" required>
          <input value={form.title} onChange={text("title")} aria-required="true" />
        </Field>
        <Field label="Problem statement" required>
          <textarea
            rows={4}
            value={form.statement}
            onChange={text("statement")}
            aria-required="true"
          />
        </Field>
      </Section>

      <Section title="Background knowledge">
        <p className={styles.sectionIntro}>
          Tell us what a reader may assume when exploring this problem.
        </p>
        <Field label="Assumed level" required>
          <input
            placeholder="first-year undergraduate"
            value={form.backgroundLevel}
            onChange={text("backgroundLevel")}
          />
        </Field>
        <Field label="What the reader is expected to know" required>
          <textarea rows={2} value={form.backgroundSummary} onChange={text("backgroundSummary")} />
        </Field>
      </Section>

      <details className={styles.section}>
        <summary className={styles.disclosure}>More setup choices (optional)</summary>
        <Field label="Specific background assumptions (one per line)">
          <textarea
            rows={2}
            value={form.backgroundAssumptions}
            onChange={text("backgroundAssumptions")}
          />
        </Field>
        <Field label="Areas of mathematics">
          <input
            placeholder="algebra, real analysis"
            value={form.backgroundDomains}
            onChange={text("backgroundDomains")}
          />
        </Field>
        <Field label="Highest level of included results">
          <select value={form.maximumLevel} onChange={text("maximumLevel")}>
            <option value="">Unspecified</option>
            {BACKGROUND_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Preferred areas of mathematics">
          <input value={form.preferredDomains} onChange={text("preferredDomains")} />
        </Field>
        <Field label="Notation preferences (one per line)">
          <textarea rows={2} value={form.notation} onChange={text("notation")} />
        </Field>
        <fieldset className={styles.choices}>
          <legend>Include extra mathematical results</legend>
          <p className={styles.sectionIntro}>
            Choose additional results and methods to make available while exploring.
          </p>
          {options.layers.map((layer) => (
            <label key={layer.id} className={styles.choice}>
              <input
                type="checkbox"
                checked={form.layerIds.includes(layer.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  update((f) => ({ ...f, layerIds: toggle(f.layerIds, layer.id, checked) }));
                }}
              />
              <span>
                <strong>{layer.label}</strong> — {layer.description}
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className={styles.choices}>
          <legend>Notation and concepts</legend>
          {options.packs.map((pack) => (
            <label key={pack.id} className={styles.choice}>
              <input
                type="checkbox"
                disabled={pack.alwaysActive}
                checked={pack.alwaysActive || form.packIds.includes(pack.id)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  update((f) => ({ ...f, packIds: toggle(f.packIds, pack.id, checked) }));
                }}
              />
              <span>
                <strong>{pack.name}</strong> — {pack.description}
                {pack.alwaysActive ? (
                  <em className={styles.hint}> Always included.</em>
                ) : (
                  <em className={styles.hint}>
                    {" "}
                    Adds {(packOperators.get(pack.id) ?? []).map(({ symbol }) => symbol).join(", ")}
                    .
                  </em>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      </details>

      <Section title="What is known and what to prove">
        <p className={styles.sectionIntro}>
          Enter any assumptions and a goal. Add variables or objects if they appear in these
          statements.
        </p>
        <fieldset className={styles.rows}>
          <legend>Variables and objects</legend>
          <p className={styles.sectionIntro}>For example, add x as a real number or A as a set.</p>
          {form.declarations.map((row, index) => (
            <DeclarationEditor
              key={row.key}
              index={index}
              row={row}
              sorts={options.sorts}
              onChange={(next) =>
                update((f) => ({ ...f, declarations: replaceAt(f.declarations, index, next) }))
              }
              onRemove={() =>
                update((f) => ({ ...f, declarations: removeAt(f.declarations, index) }))
              }
            />
          ))}
          <button
            type="button"
            className={styles.secondary}
            onClick={() =>
              update((f) => ({
                ...f,
                declarations: [...f.declarations, { key: key(), symbol: "", sort: "real" }],
              }))
            }
          >
            Add variable or object
          </button>
        </fieldset>
        <fieldset className={styles.rows}>
          <legend>What is already known</legend>
          {form.hypotheses.map((row, index) => (
            <StatementField
              key={row.key}
              label={`Hypothesis ${index + 1}`}
              row={row}
              latex={latex}
              onChange={(next) =>
                update((f) => ({ ...f, hypotheses: replaceAt(f.hypotheses, index, next) }))
              }
              onRemove={() => update((f) => ({ ...f, hypotheses: removeAt(f.hypotheses, index) }))}
            />
          ))}
          <button
            type="button"
            className={styles.secondary}
            onClick={() =>
              update((f) => ({
                ...f,
                hypotheses: [...f.hypotheses, { key: key(), format: "latex", text: "" }],
              }))
            }
          >
            Add hypothesis
          </button>
        </fieldset>
        <fieldset className={styles.rows}>
          <legend>What to prove</legend>
          {form.goals.map((row, index) => (
            <StatementField
              key={row.key}
              label={`Goal ${index + 1}`}
              required={index === 0}
              row={row}
              latex={latex}
              onChange={(next) => update((f) => ({ ...f, goals: replaceAt(f.goals, index, next) }))}
              onRemove={
                form.goals.length > 1
                  ? () => update((f) => ({ ...f, goals: removeAt(f.goals, index) }))
                  : undefined
              }
            />
          ))}
          <button
            type="button"
            className={styles.secondary}
            onClick={() =>
              update((f) => ({
                ...f,
                goals: [...f.goals, { key: key(), format: "latex", text: "" }],
              }))
            }
          >
            Add goal
          </button>
        </fieldset>
      </Section>

      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={busy !== undefined}>
          {busy === "review" ? "Checking…" : "Check setup"}
        </button>
      </div>

      {notice === undefined ? null : <NoticeView notice={notice} />}

      {reviewed === undefined ? (
        <p className={styles.gateNote} role="status">
          A proof session is created only after you approve the checked setup.
        </p>
      ) : (
        <ReviewPanel
          reviewed={reviewed}
          sorts={options.sorts}
          approvable={approvable}
          busy={busy === "approve"}
          layers={options.layers}
          packs={options.packs}
          onApprove={() => void approve()}
        />
      )}
    </form>
  );
}

function ReviewPanel({
  reviewed,
  sorts,
  approvable,
  busy,
  layers,
  packs,
  onApprove,
}: Readonly<{
  reviewed: Reviewed;
  sorts: ProblemSetupOptions["sorts"];
  approvable: boolean;
  busy: boolean;
  layers: ProblemSetupOptions["layers"];
  packs: ProblemSetupOptions["packs"];
  onApprove: () => void;
}>) {
  const presentation = useMemo(
    () => createPresentation({ operators: reviewed.operators }),
    [reviewed.operators],
  );
  const [goal] = reviewed.node.state.goals;
  const context = goal?.sequent.context;
  return (
    <section className={styles.review} aria-label="Review">
      <h2>Review your setup</h2>
      <p>Check that the problem, assumptions, and goal are represented as you intend.</p>
      <dl className={styles.reviewList}>
        <dt>Problem</dt>
        <dd>
          <strong>{reviewed.draft.problem.title}</strong>
          <p>{reviewed.draft.problem.statement}</p>
        </dd>
        <dt>Background knowledge</dt>
        <dd>
          {reviewed.draft.background.level || reviewed.draft.background.summary
            ? [reviewed.draft.background.level, reviewed.draft.background.summary]
                .filter(Boolean)
                .join(" — ")
            : "Not specified"}
        </dd>
        {reviewed.draft.background.assumptions.length > 0 ? (
          <>
            <dt>Additional assumptions</dt>
            <dd>{reviewed.draft.background.assumptions.join("; ")}</dd>
          </>
        ) : null}
        <dt>Included results</dt>
        <dd>
          {reviewed.review.metadata.libraryLayerIds
            .map((id) => layers.find((layer) => layer.id === id)?.label)
            .filter((label): label is string => label !== undefined)
            .join(", ") || "None selected"}
        </dd>
        <dt>Notation and concepts</dt>
        <dd>
          {reviewed.review.activePackIds
            .map((id) => packs.find((pack) => pack.id === id)?.name)
            .filter((name): name is string => name !== undefined)
            .join(", ") || "None selected"}
        </dd>
        <dt>Variables and objects</dt>
        <dd>
          {context === undefined || context.declarations.length === 0
            ? "None"
            : context.declarations.map((declaration) => (
                <code key={declaration.id} className={styles.token}>
                  {declaration.symbol}: {sortLabel(sorts, declaration.sort)}
                </code>
              ))}
        </dd>
        <dt>Hypotheses</dt>
        <dd>
          {context === undefined || context.hypotheses.length === 0 ? (
            "None"
          ) : (
            <ol>
              {context.hypotheses.map((hypothesis) => (
                <li key={hypothesis.id}>
                  <Rendered
                    presentation={presentation}
                    expression={hypothesis.statement.expression}
                  />
                </li>
              ))}
            </ol>
          )}
        </dd>
        <dt>Goals</dt>
        <dd>
          <ol>
            {reviewed.node.state.goals.map((target) => (
              <li key={target.id}>
                <Rendered
                  presentation={presentation}
                  expression={target.sequent.conclusion.expression}
                />
              </li>
            ))}
          </ol>
        </dd>
      </dl>
      {approvable ? null : (
        <p role="alert" className={styles.warning}>
          The setup changed after you checked it. Check it again before starting.
        </p>
      )}
      <button
        type="button"
        className={styles.primary}
        disabled={!approvable || busy}
        onClick={onApprove}
      >
        {busy ? "Starting…" : "Start exploring"}
      </button>
    </section>
  );
}

function Rendered({
  presentation,
  expression,
}: Readonly<{
  presentation: ReturnType<typeof createPresentation>;
  expression: Parameters<ReturnType<typeof createPresentation>["latex"]>[0];
}>) {
  return (
    <span className={styles.rendered}>
      <code>{presentation.latex(expression)}</code>
      <span className={styles.prose}>{presentation.naturalLanguage(expression)}</span>
    </span>
  );
}

function DeclarationEditor({
  index,
  row,
  sorts,
  onChange,
  onRemove,
}: Readonly<{
  index: number;
  row: DeclarationRow;
  sorts: ProblemSetupOptions["sorts"];
  onChange: (row: DeclarationRow) => void;
  onRemove: () => void;
}>) {
  return (
    <div className={styles.declaration}>
      <input
        aria-label={`Variable or object ${index + 1}`}
        placeholder="e.g. x"
        spellCheck={false}
        value={row.symbol}
        onChange={(event) => onChange({ ...row, symbol: event.currentTarget.value })}
      />
      <select
        aria-label={`Kind of symbol ${index + 1}`}
        value={row.sort}
        onChange={(event) => onChange({ ...row, sort: event.currentTarget.value })}
      >
        {sorts.map((sort) => (
          <option key={sort.id} value={sort.id}>
            {sort.label}
          </option>
        ))}
      </select>
      <button type="button" className={styles.linkButton} onClick={onRemove}>
        Remove declaration {index + 1}
      </button>
    </div>
  );
}

function NoticeView({ notice }: Readonly<{ notice: Notice }>) {
  if (notice.kind === "error") {
    return (
      <p role="alert" className={styles.warning}>
        {notice.message}
      </p>
    );
  }
  const items =
    notice.kind === "problems"
      ? notice.problems.map(({ field, message }) => ({ label: field, message }))
      : notice.diagnostics.map(({ path, message, code }) => ({
          label: `${draftPathLabel(path)} (${code})`,
          message,
        }));
  return (
    <div role="alert" className={styles.warning}>
      <p>The setup cannot be checked yet:</p>
      <ul>
        {items.map((item, index) => (
          <li key={index}>
            <strong>{item.label}:</strong> {item.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className={styles.section}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** The required marker is CSS-generated so the label text stays exactly `label`. */
function Field({
  label,
  required,
  children,
}: Readonly<{ label: string; required?: boolean; children: ReactNode }>) {
  return (
    <label className={styles.field}>
      <span data-marker={required === true ? "required" : undefined}>{label}</span>
      {children}
    </label>
  );
}

async function postJson(
  url: string,
  body: unknown,
): Promise<Readonly<{ ok: boolean; status: number; body: unknown }>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

function failureNotice(body: unknown): Notice {
  const failure = apiFailureSchema.safeParse(body);
  if (!failure.success) return { kind: "error", message: "The request failed." };
  const diagnostics = z
    .object({ diagnostics: z.array(problemSetupDiagnosticSchema).min(1) })
    .strict()
    .safeParse(failure.data.details);
  return diagnostics.success
    ? { kind: "diagnostics", diagnostics: diagnostics.data.diagnostics }
    : { kind: "error", message: failure.data.error.message };
}

function operatorsByPack(
  options: ProblemSetupOptions,
): ReadonlyMap<string, readonly OperatorDeclaration[]> {
  return new Map(
    options.packs.map((pack) => [pack.id, parseOperators(pack.operators) ?? []] as const),
  );
}

function parseOperators(input: readonly unknown[]): readonly OperatorDeclaration[] | undefined {
  const parsed = z.array(operatorDeclarationSchema).safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

function sortLabel(sorts: ProblemSetupOptions["sorts"], sort: unknown): string {
  const key = JSON.stringify(sort);
  return sorts.find((choice) => JSON.stringify(choice.sort) === key)?.label ?? key;
}

function toggle(values: readonly string[], value: string, checked: boolean): string[] {
  const rest = values.filter((candidate) => candidate !== value);
  return checked ? [...rest, value] : rest;
}

function replaceAt<Row>(rows: readonly Row[], index: number, row: Row): Row[] {
  return rows.map((candidate, position) => (position === index ? row : candidate));
}

function removeAt<Row>(rows: readonly Row[], index: number): Row[] {
  return rows.filter((_row, position) => position !== index);
}
