import type { MacroLink } from "@proof/protocol";

/** "move:introduce-implication" becomes "Introduce implication". */
export function humanizeMoveId(identifier: string): string {
  const words = identifier
    .replace(/^[a-z]+:/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return words.length === 0 ? identifier : words.charAt(0).toUpperCase() + words.slice(1);
}

/** The macro's display name: its authored name when known, else its identifier in words. */
export function macroDisplayName(
  moveId: string,
  names?: ReadonlyMap<string, string> | undefined,
): string {
  return names?.get(moveId) ?? humanizeMoveId(moveId);
}

/** "Macro Introduce two implications, step 2 of 3": the label of one step of an application. */
export function macroStepLabel(
  link: Pick<MacroLink, "moveId" | "stepIndex" | "stepCount">,
  names?: ReadonlyMap<string, string> | undefined,
): string {
  return `Macro ${macroDisplayName(link.moveId, names)}, step ${link.stepIndex} of ${link.stepCount}`;
}

export function stepCountText(count: number): string {
  return `${count}-step move`;
}

const STEP_FAILURE =
  /^Macro step (\d+) of (\d+)(?: \(([^)]+)\))? (?:could not be applied|was rejected): ([\s\S]*)$/;

/**
 * Words for the 422 `macro-step-failed` refusal: which step could not be applied and that nothing
 * was changed. Any other failure is returned unchanged.
 */
export function explainMacroFailure(code: string | undefined, message: string): string {
  if (code !== "macro-step-failed") return message;
  const match = STEP_FAILURE.exec(message);
  if (match === null) return `${message} Nothing was changed.`;
  const [, step, count, id, reason] = match;
  return `This multi-step move stopped at step ${step} of ${count}${
    id === undefined ? "" : ` (${id})`
  }: ${reason?.trim()} None of its steps were applied, so the proof is unchanged.`;
}
