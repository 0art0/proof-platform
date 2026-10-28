import type {
  PlanCandidate,
  PlanUnit,
  PlanView,
  Translation,
  UnitOutputs,
} from "./proof-plan-contract";

/**
 * Walking a proof plan in the browser (`docs/motivated-proof-plans.md` section 3). The proof
 * service is stateless about the walk: each request says which unit is being translated, where it
 * started and what earlier steps produced. This module keeps that state; it is pure.
 */

export type UnitStatus =
  | "pending"
  | "realized"
  | "skipped"
  | "no-move"
  | "missing-construction"
  | "uncertain"
  | "unsupported"
  | "stuck";

/** The statuses that go into the missing-move report. */
export const REPORTED_STATUSES: ReadonlySet<UnitStatus> = new Set([
  "no-move",
  "missing-construction",
  "uncertain",
  "unsupported",
  "stuck",
]);

export type UnitRecord = Readonly<{
  status: UnitStatus;
  /** Moves applied for the unit. */
  moves: readonly string[];
  reason?: string | undefined;
  candidateCount?: number | undefined;
  alternatives?: readonly PlanCandidate[] | undefined;
  /** Whether the person moved on past a reported unit. */
  skipped?: boolean | undefined;
}>;

export type Walk = Readonly<{
  planCallId: string;
  units: readonly PlanUnit[];
  /** The unit being translated; `units.length` when the walk is over. */
  index: number;
  /** The proof node the walk is at. */
  nodeId: string;
  /** Where the current unit started, once it has. */
  start?: Readonly<{ nodeId: string; focusTargetId: string }> | undefined;
  movesSoFar: readonly string[];
  /** The goal each focus key currently names (`theorem`, `case:<label>`). */
  focus: Readonly<Record<string, string>>;
  /** The hypotheses each step label names. */
  refs: Readonly<Record<string, readonly string[]>>;
  records: Readonly<Record<string, UnitRecord>>;
}>;

export function startWalk(view: PlanView, nodeId: string): Walk {
  return {
    planCallId: view.callId,
    units: view.units,
    index: 0,
    nodeId,
    movesSoFar: [],
    focus: { theorem: view.initialState.goalId },
    refs: {},
    records: {},
  };
}

export function currentUnit(walk: Walk): PlanUnit | undefined {
  return walk.units[walk.index];
}

export function walkFinished(walk: Walk): boolean {
  return walk.index >= walk.units.length;
}

/**
 * The start of the current unit: the node it starts at and the goal its focus names. Undefined
 * when no goal is known for the focus (a case whose split was skipped).
 */
export function unitStart(walk: Walk): Walk["start"] {
  if (walk.start !== undefined) return walk.start;
  const unit = currentUnit(walk);
  const focusTargetId = unit === undefined ? undefined : walk.focus[unit.focus];
  return focusTargetId === undefined ? undefined : { nodeId: walk.nodeId, focusTargetId };
}

function advance(walk: Walk, stepId: string, record: UnitRecord): Walk {
  return {
    ...walk,
    index: walk.index + 1,
    start: undefined,
    movesSoFar: [],
    records: { ...walk.records, [stepId]: record },
  };
}

function realize(walk: Walk, unit: PlanUnit, outputs: UnitOutputs): Walk {
  const focus = { ...walk.focus };
  if (outputs.focusTargetId !== undefined) focus[unit.focus] = outputs.focusTargetId;
  for (const [caseId, goalId] of Object.entries(outputs.caseTargets ?? {})) {
    focus[`case:${caseId}`] = goalId;
  }
  return advance(
    { ...walk, focus, refs: { ...walk.refs, [unit.stepId]: outputs.produced } },
    unit.stepId,
    { status: "realized", moves: walk.movesSoFar },
  );
}

/**
 * Record what a translation said. A realized unit advances the walk; an unsupported one too (it
 * can never be carried out). A proposed move leaves the walk where it is until it is applied; any
 * other answer stops at the unit, and the person decides whether to skip it.
 */
export function afterTranslation(walk: Walk, translation: Translation): Walk {
  const unit = currentUnit(walk);
  if (unit === undefined) return walk;
  const start = unitStart(walk);
  const started = start === undefined ? walk : { ...walk, start };
  if (translation.status === "realized") return realize(started, unit, translation.outputs);
  if (translation.status === "proposed") return started;
  const record: UnitRecord = {
    status: translation.status,
    moves: walk.movesSoFar,
    reason: translation.reason,
    candidateCount: translation.candidateCount,
    alternatives: translation.alternatives,
  };
  if (translation.status === "unsupported") return advance(started, unit.stepId, record);
  return { ...started, records: { ...walk.records, [unit.stepId]: record } };
}

/** A unit whose focus is unknown cannot start; it is reported as stuck. */
export function focusUnknown(walk: Walk): Walk {
  const unit = currentUnit(walk);
  if (unit === undefined) return walk;
  return {
    ...walk,
    records: {
      ...walk.records,
      [unit.stepId]: {
        status: "stuck",
        moves: [],
        reason:
          "The goal this step works on is not known, because an earlier step that creates it was skipped.",
      },
    },
  };
}

/** A proposed move was committed; the unit continues from the new node. */
export function afterApplied(walk: Walk, moveName: string, nodeId: string): Walk {
  const start = unitStart(walk);
  return {
    ...walk,
    ...(start === undefined ? {} : { start }),
    nodeId,
    movesSoFar: [...walk.movesSoFar, moveName],
  };
}

/** Move past the current unit without carrying it out; a reported status is kept. */
export function skipUnit(walk: Walk): Walk {
  const unit = currentUnit(walk);
  if (unit === undefined) return walk;
  const existing = walk.records[unit.stepId];
  return advance(walk, unit.stepId, {
    ...(existing ?? { status: "skipped", moves: walk.movesSoFar }),
    ...(existing === undefined ? {} : { skipped: true }),
  });
}

/** Carry on from another proof node, e.g. after the person changed the proof by hand. */
export function continueFrom(walk: Walk, nodeId: string): Walk {
  return { ...walk, nodeId, start: undefined, movesSoFar: [] };
}

export type MissingMoveReport = Readonly<{
  planCallId: string;
  entries: readonly Readonly<{
    number: string;
    stepId: string;
    form: string;
    claim: string | null;
    motivation: string | null;
    justification: unknown;
    status: UnitStatus;
    reason: string | undefined;
    movesApplied: readonly string[];
    candidateCount: number | undefined;
    bestCandidates: readonly Readonly<{ label: string; probability: number | undefined }>[];
  }>[];
}>;

/** The units the platform could not carry out, with what was offered (section 3.4). */
export function missingMoveReport(walk: Walk, view: PlanView): MissingMoveReport {
  const steps = new Map(view.plan.steps.map((step) => [step.id, step]));
  return {
    planCallId: walk.planCallId,
    entries: walk.units.flatMap((unit) => {
      const record = walk.records[unit.stepId];
      if (record === undefined || !REPORTED_STATUSES.has(record.status)) return [];
      const step = steps.get(unit.stepId);
      return [
        {
          number: unit.number,
          stepId: unit.stepId,
          form: unit.form,
          claim: step?.claim?.prose ?? null,
          motivation: step?.motivation ?? null,
          justification: step?.by,
          status: record.status,
          reason: record.reason,
          movesApplied: record.moves,
          candidateCount: record.candidateCount,
          bestCandidates: (record.alternatives ?? []).map(({ label, probability }) => ({
            label,
            probability,
          })),
        },
      ];
    }),
  };
}
