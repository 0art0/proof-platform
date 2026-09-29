import { isPlainMathJson } from "@proof/mathjson-model";
import type {
  BackgroundLevel,
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

  const optionalPacks = new Set(
    options.packs.filter((pack) => !pack.alwaysActive).map((pack) => pack.id),
  );
  const assumptions = lines(form.backgroundAssumptions);
  const backgroundDomains = commaList(form.backgroundDomains);
  const preferredDomains = commaList(form.preferredDomains);
  const notation = lines(form.notation);
  const draft = {
    problem: { title: form.title.trim(), statement: form.statement.trim() },
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
    declarations: form.declarations.map(({ symbol, sort }) => ({ symbol: symbol.trim(), sort })),
    hypotheses: statements(form.hypotheses, "Hypothesis"),
    goals: statements(form.goals, "Goal"),
  } as ProblemDraft;
  return problems.length === 0 ? { ok: true, draft } : { ok: false, problems };
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
