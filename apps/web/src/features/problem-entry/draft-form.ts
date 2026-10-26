import { isPlainMathJson } from "@proof/mathjson-model";
import type {
  BackgroundLevel,
  BackgroundProfile,
  OperatorDeclaration,
  PlainMathJson,
  ProblemDraft,
  ProblemSetupOptions,
  ProblemStatementInput,
} from "@proof/protocol";

/**
 * Editable form state of a problem draft (roadmap N26). The draft lives only in the browser until
 * approval; `formToDraft` turns it into the strict draft the worker validates.
 */
export type StatementFormat = ProblemStatementInput["format"];

export type StatementRow = Readonly<{ key: number; format: StatementFormat; text: string }>;
export type DeclarationRow = Readonly<{ key: number; symbol: string; sort: string }>;

export type ProblemForm = Readonly<{
  title: string;
  statement: string;
  backgroundLevel: string;
  backgroundSummary: string;
  /** One assumption per line. */
  backgroundAssumptions: string;
  /** Comma-separated. */
  backgroundDomains: string;
  maximumLevel: BackgroundLevel | "";
  /** Comma-separated. */
  preferredDomains: string;
  /** One preference per line. */
  notation: string;
  layerIds: readonly string[];
  /** Optional packs only; always-active packs are not part of the draft. */
  packIds: readonly string[];
  declarations: readonly DeclarationRow[];
  hypotheses: readonly StatementRow[];
  goals: readonly StatementRow[];
}>;

export function emptyProblemForm(): ProblemForm {
  return {
    title: "",
    statement: "",
    backgroundLevel: "",
    backgroundSummary: "",
    backgroundAssumptions: "",
    backgroundDomains: "",
    maximumLevel: "",
    preferredDomains: "",
    notation: "",
    layerIds: ["layer:global", "layer:initial-problem"],
    packIds: [],
    declarations: [{ key: 1, symbol: "", sort: "proposition" }],
    hypotheses: [],
    goals: [{ key: 2, format: "latex", text: "" }],
  };
}

export type FormProblem = Readonly<{ field: string; message: string }>;

export type FormToDraftResult =
  | Readonly<{ ok: true; draft: ProblemDraft }>
  | Readonly<{ ok: false; problems: readonly FormProblem[] }>;

/** Assemble the strict draft; MathJSON text must already be JSON. */
export function formToDraft(form: ProblemForm, options: ProblemSetupOptions): FormToDraftResult {
  const problems: FormProblem[] = [];
  const statements = (rows: readonly StatementRow[], label: string) =>
    rows.map((row, index): ProblemStatementInput => {
      const field = `${label} ${index + 1}`;
      if (row.text.trim().length === 0) {
        problems.push({ field, message: `${field} is empty.` });
        return { format: "latex", latex: " " };
      }
      if (row.format === "latex") return { format: "latex", latex: row.text };
      const expression = parseMathJsonText(row.text);
      if (!expression.ok) problems.push({ field, message: `${field}: ${expression.message}` });
      return { format: "mathjson", expression: expression.ok ? expression.expression : 0 };
    });

  const draft = {
    ...formSetupContext(form, options),
    declarations: form.declarations.map(({ symbol, sort }) => ({ symbol: symbol.trim(), sort })),
    hypotheses: statements(form.hypotheses, "Hypothesis"),
    goals: statements(form.goals, "Goal"),
  } as ProblemDraft;
  return problems.length === 0 ? { ok: true, draft } : { ok: false, problems };
}

/** The part of a draft the AI roles may see: everything except declarations and statements. */
export type SetupContext = Pick<
  ProblemDraft,
  "problem" | "background" | "preferences" | "libraryLayerIds" | "packs"
>;

export function formSetupContext(form: ProblemForm, options: ProblemSetupOptions): SetupContext {
  const optionalPacks = new Set(
    options.packs.filter((pack) => !pack.alwaysActive).map((pack) => pack.id),
  );
  const assumptions = lines(form.backgroundAssumptions);
  const backgroundDomains = commaList(form.backgroundDomains);
  const preferredDomains = commaList(form.preferredDomains);
  const notation = lines(form.notation);
  return {
    problem: { title: problemTitle(form), statement: form.statement.trim() },
    background: {
      level: form.backgroundLevel.trim(),
      summary: form.backgroundSummary.trim(),
      assumptions,
      ...(backgroundDomains.length === 0 ? {} : { domains: backgroundDomains }),
      ...(form.maximumLevel === "" ? {} : { maximumLevel: form.maximumLevel }),
    },
    ...(preferredDomains.length === 0 && notation.length === 0
      ? {}
      : {
          preferences: {
            ...(preferredDomains.length === 0 ? {} : { domains: preferredDomains }),
            ...(notation.length === 0 ? {} : { notation }),
          },
        }),
    libraryLayerIds: options.layers
      .map((layer) => layer.id)
      .filter((id) => form.layerIds.includes(id)),
    packs: options.packs
      .map((pack) => pack.id)
      .filter((id) => optionalPacks.has(id) && form.packIds.includes(id)),
  } as SetupContext;
}

/** The entered title, or one taken from the start of the statement when none is entered. */
export function problemTitle(form: Pick<ProblemForm, "title" | "statement">): string {
  const title = form.title.trim();
  if (title.length > 0) return title;
  const [first = ""] = form.statement.trim().split(/\n|(?<=[.?!])\s/);
  const line = first.replace(/\s+/g, " ").trim();
  if (line.length <= TITLE_LENGTH) return line;
  const cut = line.slice(0, TITLE_LENGTH);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const TITLE_LENGTH = 60;

/** The required fields the AI roles need: the problem and the background, not the statements. */
export function missingSetupFields(form: ProblemForm): readonly FormProblem[] {
  return missingRequiredFields(form).filter(
    ({ field }) => !field.startsWith("Variable or object") && !field.startsWith("Goal"),
  );
}

/** Editable rows for the declarations and statements of a draft (an AI draft, for example). */
export function draftStatementRows(
  draft: Pick<ProblemDraft, "declarations" | "hypotheses" | "goals">,
  nextKey: () => number,
): Pick<ProblemForm, "declarations" | "hypotheses" | "goals"> {
  const row = (input: ProblemStatementInput): StatementRow =>
    input.format === "latex"
      ? { key: nextKey(), format: "latex", text: input.latex }
      : { key: nextKey(), format: "mathjson", text: JSON.stringify(input.expression) };
  return {
    declarations: draft.declarations.map(({ symbol, sort }) => ({ key: nextKey(), symbol, sort })),
    hypotheses: draft.hypotheses.map(row),
    goals: draft.goals.map(row),
  };
}

/**
 * A background the user accepted: the proposal's profile and constants, and the approval decision
 * through which the worker resolves those constants. The browser holds the constants only to show
 * them and to preview LaTeX; requests name the decision and never carry declarations.
 */
export type AcceptedBackground = Readonly<{
  decisionId: string;
  /** The stored proposer call the decision approved. */
  callId: string;
  profile: BackgroundProfile;
  constants: readonly Readonly<{ operator: OperatorDeclaration; rationale: string }>[];
}>;

/**
 * A library the user approved: the decision through which the worker resolves the kept results
 * from the stored librarian call. The browser holds the names, the variant count and the new
 * constants only to show them and to preview LaTeX; requests name the decision and never carry
 * artifacts.
 */
export type ApprovedLibrary = Readonly<{
  decisionId: string;
  /** The stored librarian call the decision approved results of. */
  callId: string;
  /** The accepted background the library was built for. */
  backgroundDecisionId: string;
  results: readonly Readonly<{ id: string; name: string }>[];
  /** Equivalent reshapings generated from the kept results; they are added with them. */
  variantCount: number;
  /** Operators the kept results add beyond the packs and the accepted background. */
  constants: readonly OperatorDeclaration[];
}>;

/** The background fields of the form for an accepted profile; they stay editable by hand. */
export function withBackgroundProfile(
  profile: BackgroundProfile,
): Pick<
  ProblemForm,
  | "backgroundLevel"
  | "backgroundSummary"
  | "backgroundAssumptions"
  | "backgroundDomains"
  | "maximumLevel"
> {
  return {
    backgroundLevel: profile.level,
    backgroundSummary: profile.summary,
    backgroundAssumptions: profile.assumptions.join("\n"),
    backgroundDomains: (profile.domains ?? []).join(", "),
    maximumLevel: profile.maximumLevel ?? "",
  };
}

/**
 * Every required field that is still empty, in form order, so one check reports them all (the
 * worker would otherwise reject them one diagnostic at a time). Field names match the form labels.
 */
export function missingRequiredFields(form: ProblemForm): readonly FormProblem[] {
  const problems: FormProblem[] = [];
  const need = (field: string, value: string) => {
    if (value.trim().length === 0) problems.push({ field, message: "This is required." });
  };
  need("Problem statement", form.statement);
  need("Assumed level", form.backgroundLevel);
  need("What the reader is expected to know", form.backgroundSummary);
  form.declarations.forEach((row, index) => {
    if (row.symbol.trim().length === 0) {
      const field = `Variable or object ${index + 1}`;
      problems.push({ field, message: "Enter a name, or remove this row." });
    }
  });
  form.goals.forEach((row, index) => {
    if (row.text.trim().length === 0) {
      const field = `Goal ${index + 1}`;
      problems.push({ field, message: `${field} is empty.` });
    }
  });
  return problems;
}

export type MathJsonText =
  Readonly<{ ok: true; expression: PlainMathJson }> | Readonly<{ ok: false; message: string }>;

/** Parse MathJSON typed as JSON text; only plain MathJSON is accepted. */
export function parseMathJsonText(text: string): MathJsonText {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, message: "The MathJSON is not valid JSON." };
  }
  return isPlainMathJson(value)
    ? { ok: true, expression: value }
    : { ok: false, message: "The JSON is not plain MathJSON." };
}

/** A readable label for a worker diagnostic path such as `["goals", 0, "latex"]`. */
export function draftPathLabel(path: readonly (string | number)[]): string {
  const [head, index] = path;
  const position = typeof index === "number" ? ` ${index + 1}` : "";
  switch (head) {
    case "goals":
      return `Goal${position}`;
    case "hypotheses":
      return `Hypothesis${position}`;
    case "declarations":
      return `Declaration${position}`;
    case "packs":
      return "Packs";
    case "libraryLayerIds":
      return "Library layers";
    case "problem":
      return "Problem";
    case "background":
      return "Background";
    case "preferences":
      return "Preferences";
    default:
      return "Draft";
  }
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function commaList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
