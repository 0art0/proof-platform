/**
 * The compact inquiry summary (refinement §10; roadmap N34): the active objective, the current
 * attempt, the unresolved construction choices and the most relevant obstruction or next
 * requirement. Everything is derived from stored data: the session's inquiry records, folded
 * with their explicit status changes (`currentInquiryStatus`, N22), and the current snapshot's
 * `constructions`. Nothing is recomputed from history and no intention is inferred.
 *
 * Reasons keep their provenance. A relationship recorded as a later interpretation is never used
 * to select what is shown as the active objective, attempt or obstruction: it is listed apart,
 * worded by the N23 explainer as "On a later interpretation, …".
 */
import {
  createInquiryExplainer,
  type InquiryExplainer,
  type InquiryExplanationContext,
  type InquiryRecordView,
} from "@proof/language";
import {
  isOpenConstructionTask,
  type ConstructionTask,
  type ProofState,
} from "@proof/mathjson-model";
import {
  currentInquiryStatus,
  type InquiryRecord,
  type OperatorDeclaration,
} from "@proof/protocol";

type Kind<K extends InquiryRecord["kind"]> = Extract<InquiryRecord, { kind: K }>;
export type QuestionRecord = Kind<"question">;
export type ObjectiveRecord = Kind<"objective">;
export type AttemptRecord = Kind<"attempt">;
export type RequirementRecord = Kind<"requirement">;
export type ObstructionRecord = Kind<"obstruction">;
export type RelationshipRecord = Kind<"relationship">;

export type ObjectiveEntry = Readonly<{
  record: ObjectiveRecord;
  question: QuestionRecord | undefined;
  status: string;
  /** Whether the objective's focus is an open target of the current snapshot. */
  focusOpen: boolean;
}>;

export type AttemptEntry = Readonly<{ record: AttemptRecord; status: string }>;

/** What most needs attention for the active objective. */
export type InquiryBlocker =
  | Readonly<{ kind: "obstruction"; record: ObstructionRecord; status: string }>
  | Readonly<{ kind: "requirement"; record: RequirementRecord; status: string }>;

export type InquirySummary = Readonly<{
  activeObjective: ObjectiveEntry | undefined;
  /** The active objective's own latest attempt that is in progress or blocked. */
  currentAttempt: AttemptEntry | undefined;
  /** The attempt that proposed the active objective, when the objective has no attempt yet. */
  proposingAttempt: AttemptEntry | undefined;
  blocker: InquiryBlocker | undefined;
  /** Relationships recorded as later interpretations about what is shown; never intentions. */
  laterInterpretations: readonly RelationshipRecord[];
  /** Open construction tasks of the current snapshot, in state order. */
  unresolvedConstructions: readonly ConstructionTask[];
}>;

const MAX_LATER_INTERPRETATIONS = 5;

/** The current status of every record that has a lifecycle, folded from its status changes. */
export function foldStatuses(records: readonly InquiryRecord[]): ReadonlyMap<string, string> {
  const changes = new Map<string, InquiryRecord[]>();
  for (const record of records) {
    if (record.kind !== "status-change") continue;
    const list = changes.get(record.subjectId);
    if (list === undefined) changes.set(record.subjectId, [record]);
    else list.push(record);
  }
  const statuses = new Map<string, string>();
  for (const record of records) {
    const status = currentInquiryStatus(
      { id: record.id, kind: record.kind },
      changes.get(record.id) ?? [],
    );
    if (status !== undefined) statuses.set(record.id, status);
  }
  return statuses;
}

function isOpenTarget(state: ProofState, focus: NonNullable<ObjectiveRecord["focus"]>): boolean {
  return (focus.target.kind === "goal" ? state.goals : state.obligations).some(
    ({ id }) => id === focus.target.id,
  );
}

const byLatest = (left: InquiryRecord, right: InquiryRecord) => right.sequence - left.sequence;

/** Derive the compact summary for the current snapshot from the stored records. */
export function summarizeInquiry(
  input: Readonly<{
    records: readonly InquiryRecord[];
    state: ProofState;
  }>,
): InquirySummary {
  const { records, state } = input;
  const statuses = foldStatuses(records);
  const statusOf = (record: InquiryRecord) => statuses.get(record.id) ?? "";
  const byId = new Map(records.map((record) => [record.id as string, record]));
  const unresolvedConstructions = (state.constructions ?? []).filter(isOpenConstructionTask);

  const objectives = records.filter(
    (record): record is ObjectiveRecord =>
      record.kind === "objective" && statusOf(record) === "active",
  );
  const entries: ObjectiveEntry[] = objectives.map((record) => {
    const question = byId.get(record.questionId);
    return {
      record,
      question: question?.kind === "question" ? question : undefined,
      status: statusOf(record),
      focusOpen: record.focus !== undefined && isOpenTarget(state, record.focus),
    };
  });
  // An objective on an open target of this snapshot comes first, then a required one, then the
  // most recently recorded.
  entries.sort(
    (left, right) =>
      Number(right.focusOpen) - Number(left.focusOpen) ||
      Number(right.record.necessity === "required") -
        Number(left.record.necessity === "required") ||
      byLatest(left.record, right.record),
  );
  const activeObjective = entries[0];

  const attemptEntry = (record: InquiryRecord | undefined): AttemptEntry | undefined =>
    record?.kind === "attempt" ? { record, status: statusOf(record) } : undefined;
  const currentAttempt =
    activeObjective === undefined
      ? undefined
      : attemptEntry(
          records
            .filter(
              (record): record is AttemptRecord =>
                record.kind === "attempt" &&
                record.objectiveId === activeObjective.record.id &&
                ["in-progress", "blocked"].includes(statusOf(record)),
            )
            .sort(byLatest)[0],
        );
  const proposingAttempt =
    activeObjective === undefined ||
    currentAttempt !== undefined ||
    activeObjective.record.parentAttemptId === undefined
      ? undefined
      : attemptEntry(byId.get(activeObjective.record.parentAttemptId));

  const relevant = new Set<string>();
  if (activeObjective !== undefined) {
    relevant.add(activeObjective.record.id);
    relevant.add(activeObjective.record.questionId);
  }
  for (const attempt of [currentAttempt, proposingAttempt]) {
    if (attempt !== undefined) relevant.add(attempt.record.id);
  }

  const blocker = topBlocker({ records, statusOf, relevant, currentAttempt, proposingAttempt });
  if (blocker !== undefined) relevant.add(blocker.record.id);

  const laterInterpretations = records
    .filter(
      (record): record is RelationshipRecord =>
        record.kind === "relationship" &&
        record.reason?.provenance === "later-interpretation" &&
        (relevant.has(record.to) || record.from.some((id) => relevant.has(id))),
    )
    .sort(byLatest)
    .slice(0, MAX_LATER_INTERPRETATIONS);

  return {
    activeObjective,
    currentAttempt,
    proposingAttempt,
    blocker,
    laterInterpretations,
    unresolvedConstructions,
  };
}

const ROLE_ORDER = { sufficient: 0, necessary: 1, heuristic: 2 } as const;

function topBlocker(
  input: Readonly<{
    records: readonly InquiryRecord[];
    statusOf: (record: InquiryRecord) => string;
    relevant: ReadonlySet<string>;
    currentAttempt: AttemptEntry | undefined;
    proposingAttempt: AttemptEntry | undefined;
  }>,
): InquiryBlocker | undefined {
  const { records, statusOf, relevant } = input;
  if (relevant.size === 0) return undefined;
  const openObstructions = records.filter(
    (record): record is ObstructionRecord =>
      record.kind === "obstruction" && statusOf(record) === "open",
  );

  // An obstruction the objective or its attempt is recorded as addressing. A later
  // interpretation says nothing about what was contemporaneously addressed, so it is not used.
  const addressed = new Set(
    records.flatMap((record) =>
      record.kind === "relationship" &&
      record.relation === "addresses" &&
      record.reason?.provenance !== "later-interpretation" &&
      record.from.some((id) => relevant.has(id))
        ? [record.to as string]
        : [],
    ),
  );
  const fromAddressed = openObstructions
    .filter((record) => addressed.has(record.id))
    .sort(byLatest);
  const attempts = new Set(
    [input.currentAttempt, input.proposingAttempt].flatMap((entry) =>
      entry === undefined ? [] : [entry.record.id as string],
    ),
  );
  const ofAttempt = openObstructions
    .filter((record) => attempts.has(record.attemptId))
    .sort(byLatest);
  const obstruction = fromAddressed[0] ?? ofAttempt[0];
  if (obstruction !== undefined) {
    return { kind: "obstruction", record: obstruction, status: "open" };
  }

  const requirement = records
    .filter(
      (record): record is RequirementRecord =>
        record.kind === "requirement" &&
        attempts.has(record.subjectId) &&
        statusOf(record) === "open",
    )
    .sort(
      (left, right) =>
        ROLE_ORDER[left.role] - ROLE_ORDER[right.role] || left.sequence - right.sequence,
    )[0];
  return requirement === undefined
    ? undefined
    : { kind: "requirement", record: requirement, status: "open" };
}

// ---------------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------------

export type ExplanationInput = Readonly<{
  records: readonly InquiryRecord[];
  /** Stored snapshots by node ID (the history's nodes, and at least the current node). */
  nodes: ReadonlyMap<string, ProofState>;
  /** Stored transition classes by child node ID. */
  transitions?: ReadonlyMap<string, "equivalence" | "strengthening" | "weakening">;
  /** Names of the displayed suggestions and of the results and moves they carry. */
  suggestions?: Readonly<{
    setId: string;
    items: readonly Readonly<{
      id: string;
      name: string;
      source: "result" | "move";
      artifactId: string;
    }>[];
  }>;
}>;

/** The N23 explanation context over stored data only. */
export function explanationContext(input: ExplanationInput): InquiryExplanationContext {
  const items = input.suggestions?.items ?? [];
  const named = (source: "result" | "move") =>
    new Map(
      items.filter((item) => item.source === source).map((item) => [item.artifactId, item.name]),
    );
  return {
    nodes: input.nodes,
    records: new Map(
      input.records.map((record) => [record.id as string, record as InquiryRecordView]),
    ),
    transitions: new Map(
      [...(input.transitions ?? [])].map(([node, transitionClass]) => [node, { transitionClass }]),
    ),
    methodNames: { moves: named("move"), results: named("result") },
    suggestionLabels:
      input.suggestions === undefined
        ? new Map()
        : new Map([[input.suggestions.setId, new Map(items.map((item) => [item.id, item.name]))]]),
  };
}

export function createSummaryExplainer(
  operators: readonly OperatorDeclaration[],
): InquiryExplainer {
  return createInquiryExplainer({ operators });
}

export type SummarySentence = Readonly<{ id: string; text: string }>;

export type InquiryDescription = Readonly<{
  objective: (SummarySentence & { status: string; necessity: string }) | undefined;
  attempt: (SummarySentence & { status: string; proposedBy: boolean }) | undefined;
  /** "This method would suffice if … were established" for the attempt shown. */
  sufficiency: string | undefined;
  blocker: (SummarySentence & { kind: InquiryBlocker["kind"] }) | undefined;
  later: readonly SummarySentence[];
}>;

/** The deterministic template sentences of the summary's records. */
export function describeInquiry(
  summary: InquirySummary,
  explainer: InquiryExplainer,
  context: InquiryExplanationContext,
): InquiryDescription {
  const say = (record: InquiryRecord): SummarySentence => ({
    id: record.id,
    text: explainer.explain(record as InquiryRecordView, context).text,
  });
  const shown = summary.currentAttempt ?? summary.proposingAttempt;
  return {
    objective:
      summary.activeObjective === undefined
        ? undefined
        : {
            ...say(summary.activeObjective.record),
            status: summary.activeObjective.status,
            necessity: summary.activeObjective.record.necessity,
          },
    attempt:
      shown === undefined
        ? undefined
        : {
            ...say(shown.record),
            status: shown.status,
            proposedBy: shown === summary.proposingAttempt,
          },
    sufficiency:
      shown === undefined
        ? undefined
        : explainer.explainSufficiency(shown.record.id, context)?.text,
    blocker:
      summary.blocker === undefined
        ? undefined
        : { ...say(summary.blocker.record), kind: summary.blocker.kind },
    later: summary.laterInterpretations.map(say),
  };
}
