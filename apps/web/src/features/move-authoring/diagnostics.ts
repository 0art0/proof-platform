/**
 * Readable views of the worker's template diagnostics and of refused authoring commands.
 */
import type { TemplateDiagnosticView } from "./api-contract";

export type DiagnosticSection =
  | "details"
  | "contract"
  | "patterns"
  | "parameters"
  | "artifacts"
  | "plan"
  | "class"
  | "examples"
  | "template";

/** Plain-language names of the editor sections, as the section headings show them. */
export const SECTION_LABELS: Readonly<Record<DiagnosticSection, string>> = Object.freeze({
  details: "Name and description",
  contract: "What you select",
  patterns: "What a selection must look like",
  parameters: "Choices asked each time",
  artifacts: "Library items it relies on",
  plan: "What the move does",
  class: "Kind of step",
  examples: "Examples",
  template: "The move as a whole",
});

export const SECTION_ORDER: readonly DiagnosticSection[] = [
  "details",
  "contract",
  "patterns",
  "parameters",
  "artifacts",
  "plan",
  "class",
  "examples",
  "template",
];

/** The editor section a diagnostic belongs to, from its path into the template. */
export function sectionOf(diagnostic: TemplateDiagnosticView): DiagnosticSection {
  const head = diagnostic.path?.[0];
  switch (head) {
    case "id":
    case "name":
    case "description":
      return "details";
    case "selectionContract":
      return "contract";
    case "patterns":
      return "patterns";
    case "parameters":
      return "parameters";
    case "requiredArtifacts":
      return "artifacts";
    case "plan":
      return "plan";
    case "transitionClass":
      return "class";
    case "examples":
      return "examples";
    default:
      return diagnostic.exampleId === undefined ? "template" : "examples";
  }
}

export type DiagnosticGroup = Readonly<{
  section: DiagnosticSection;
  label: string;
  diagnostics: readonly TemplateDiagnosticView[];
}>;

/** The diagnostics grouped by editor section, in the editor's order. */
export function groupDiagnostics(
  diagnostics: readonly TemplateDiagnosticView[],
): readonly DiagnosticGroup[] {
  const groups = new Map<DiagnosticSection, TemplateDiagnosticView[]>();
  for (const diagnostic of diagnostics) {
    const section = sectionOf(diagnostic);
    groups.set(section, [...(groups.get(section) ?? []), diagnostic]);
  }
  return SECTION_ORDER.flatMap((section) => {
    const list = groups.get(section);
    return list === undefined
      ? []
      : [{ section, label: SECTION_LABELS[section], diagnostics: list }];
  });
}

/** Diagnostics that belong to one example, by its ID. */
export function diagnosticsForExample(
  diagnostics: readonly TemplateDiagnosticView[],
  exampleId: string,
  exampleIndex: number,
): readonly TemplateDiagnosticView[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.exampleId === exampleId ||
      (diagnostic.path?.[0] === "examples" && diagnostic.path[1] === exampleIndex),
  );
}

const DIAGNOSTIC_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "invalid-template": "Not a well-formed template",
  "unknown-primitive": "Unknown primitive",
  "primitive-mismatch": "Plan step does not match its primitive",
  "slot-mismatch": "Selection slot does not match the primitive",
  "parameter-mismatch": "Parameter does not match the primitive",
  "unknown-artifact": "Required artifact not available",
  "class-mismatch": "Declared class differs from the kernel's",
  "missing-example": "Examples missing",
  "example-invalid": "Example is not usable",
  "example-incomplete": "Example needs a menu choice",
  "example-failed": "Example did not run",
  "example-mismatch": "Example outcome differs",
  "example-accepted": "Negative example was accepted",
  "macro-step-unmatched": "A recorded step found no match",
  "plan-inconsistent": "Plan disagrees with itself",
});

export function diagnosticTitle(code: string): string {
  return DIAGNOSTIC_TITLES[code] ?? code;
}

const DIAGNOSTIC_ADVICE: Readonly<Record<string, string>> = Object.freeze({
  "invalid-template": "Fill in the field named here; every part of the move must be complete.",
  "unknown-primitive": "Pick the first step again from the list of kernel operations.",
  "primitive-mismatch": "Pick the step again from the list of kernel operations.",
  "slot-mismatch": "Pick the first step again so its selections are restored.",
  "parameter-mismatch": "Pick the first step again so its parameters are restored.",
  "unknown-artifact": "Untick this library item, or add it to the session's library first.",
  "class-mismatch":
    "Set the kind of step to what the kernel reports, or change the steps so they produce the kind you want.",
  "missing-example": "Add two examples that should work and one that should be refused.",
  "example-invalid": "Remove this example and add it again from a stored proof state.",
  "example-incomplete": "Add the example again from a recorded step so its menu choices are kept.",
  "example-failed": "The move could not be applied here; remove the example or fix the plan.",
  "example-mismatch": "The kernel produced a different result; remove the example or fix the plan.",
  "example-accepted":
    "The kernel allowed this selection; pick a selection the move should refuse instead.",
  "macro-step-unmatched":
    "A later step found nothing to act on; shorten the plan or change the examples.",
  "plan-inconsistent": "Rebuild the plan from a recorded path.",
});

/** One sentence on what to do about a diagnostic, in plain words. */
export function diagnosticAdvice(code: string): string | undefined {
  return DIAGNOSTIC_ADVICE[code];
}

const REVIEW_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  "review-notes-required": "A rejection or a change request needs notes explaining it.",
  "move-validation-failed": "The template does not pass validation, so it cannot be approved.",
  "draft-not-found": "The session has no such draft; reload the page.",
  "draft-already-reviewed": "This draft already has a recorded review.",
  "draft-corrupt": "The stored template does not match its recorded digest.",
  "invalid-template": "The template is not a well-formed authored move.",
  "library-admission-rejected": "The library did not admit the record.",
  "payload-source-rejected": "Only a human may author or review moves.",
  "event-id-conflict": "This command ID is bound to a different record.",
  "session-read-only": "This session is read-only (imported artifact).",
  "stale-alias": "The session changed since this page loaded; reload and try again.",
});

export type AuthoringFailureView = Readonly<{
  /** A sentence naming the action and the reason. */
  message: string;
  /** The validation diagnostics that came with the refusal, if any. */
  diagnostics: readonly TemplateDiagnosticView[];
}>;

/** A refused authoring command as one readable sentence plus any validation diagnostics. */
export function describeAuthoringFailure(
  action: string,
  failure: Readonly<{
    status: number;
    code: string;
    message: string;
    validation?: readonly TemplateDiagnosticView[] | undefined;
  }>,
): AuthoringFailureView {
  const reason = REVIEW_REFUSALS[failure.code] ?? failure.message;
  const hint =
    failure.status === 0 || failure.status >= 500
      ? " Try again once the proof service is available."
      : "";
  return {
    message: `${action} refused (${failure.code}): ${reason}${hint}`,
    diagnostics: failure.validation ?? [],
  };
}

/** `path` as a dotted location, for display next to a diagnostic. */
export function formatDiagnosticPath(path: readonly (string | number)[] | undefined): string {
  return path === undefined || path.length === 0 ? "" : path.join(".");
}
