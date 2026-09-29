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
  type DeclarationRow,
  type FormProblem,
  type ProblemForm,
} from "./draft-form";
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
 * "Review draft" asks the worker to validate it and shows exactly what would be stored; only
 * "Approve and create session" on an unchanged reviewed draft creates the session and root node.
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
    if (!current.ok) {
      setNotice({ kind: "problems", problems: current.problems });
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
        <Field label="Problem title">
          <input value={form.title} onChange={text("title")} />
        </Field>
        <Field label="Problem statement">
          <textarea rows={4} value={form.statement} onChange={text("statement")} />
        </Field>
      </Section>

      <Section title="Background">
        <Field label="Background level">
          <input
            placeholder="first-year undergraduate"
            value={form.backgroundLevel}
            onChange={text("backgroundLevel")}
          />
        </Field>
        <Field label="Background summary">
          <textarea rows={2} value={form.backgroundSummary} onChange={text("backgroundSummary")} />
        </Field>
        <Field label="Assumed background (one per line)">
          <textarea
            rows={2}
            value={form.backgroundAssumptions}
            onChange={text("backgroundAssumptions")}
          />
        </Field>
        <Field label="Background domains (comma-separated)">
          <input value={form.backgroundDomains} onChange={text("backgroundDomains")} />
        </Field>
        <Field label="Maximum background level">
          <select value={form.maximumLevel} onChange={text("maximumLevel")}>
            <option value="">Unspecified</option>
            {BACKGROUND_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Preferences">
        <Field label="Preferred domains (comma-separated)">
          <input value={form.preferredDomains} onChange={text("preferredDomains")} />
        </Field>
        <Field label="Notation preferences (one per line)">
          <textarea rows={2} value={form.notation} onChange={text("notation")} />
        </Field>
      </Section>

      <Section title="Library">
        <fieldset className={styles.choices}>
          <legend>Library layers</legend>
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
          <legend>Packs</legend>
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
                  <em className={styles.hint}> Always active (standard notation).</em>
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
      </Section>

      <Section title="Initial proof state">
        <fieldset className={styles.rows}>
          <legend>Declarations</legend>
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
            Add declaration
          </button>
        </fieldset>
        <fieldset className={styles.rows}>
          <legend>Hypotheses</legend>
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
          <legend>Goals</legend>
          {form.goals.map((row, index) => (
            <StatementField
              key={row.key}
              label={`Goal ${index + 1}`}
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
          {busy === "review" ? "Reviewing…" : "Review draft"}
        </button>
      </div>

      {notice === undefined ? null : <NoticeView notice={notice} />}

      {reviewed === undefined ? (
        <p className={styles.gateNote} role="status">
          Nothing is stored until you review the draft and approve it.
        </p>
      ) : (
        <ReviewPanel
          reviewed={reviewed}
          sorts={options.sorts}
          approvable={approvable}
          busy={busy === "approve"}
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
  onApprove,
}: Readonly<{
  reviewed: Reviewed;
  sorts: ProblemSetupOptions["sorts"];
  approvable: boolean;
  busy: boolean;
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
      <h2>Review</h2>
      <p>
        Approving creates a session whose root node is exactly this state. The statements below are
        the stored MathJSON, rendered back.
      </p>
      <dl className={styles.reviewList}>
        <dt>Declarations</dt>
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
        <dt>Active packs</dt>
        <dd>{reviewed.review.activePackIds.join(", ")}</dd>
        <dt>Library layers</dt>
        <dd>{reviewed.review.metadata.libraryLayerIds.join(", ") || "None"}</dd>
        <dt>Review digest</dt>
        <dd>
          <code>{reviewed.review.digest.slice(0, 19)}…</code>
        </dd>
      </dl>
      {approvable ? null : (
        <p role="alert" className={styles.warning}>
          The draft changed after review. Review it again before approving.
        </p>
      )}
      <button
        type="button"
        className={styles.primary}
        disabled={!approvable || busy}
        onClick={onApprove}
      >
        {busy ? "Creating session…" : "Approve and create session"}
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
        aria-label={`Symbol ${index + 1}`}
        placeholder="x"
        spellCheck={false}
        value={row.symbol}
        onChange={(event) => onChange({ ...row, symbol: event.currentTarget.value })}
      />
      <select
        aria-label={`Sort ${index + 1}`}
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
      <p>The draft cannot be reviewed yet:</p>
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

function Field({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
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
