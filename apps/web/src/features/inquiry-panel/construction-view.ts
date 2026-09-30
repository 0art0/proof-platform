/**
 * The construction-task view model (refinement §5; roadmap N34): one N11 task from a stored
 * snapshot, with its requirements grouped by role, its candidates, status, scope and allowed
 * dependencies. Pure and read-only: it reads the stored task and never derives a requirement's
 * role or evidence. A heuristic requirement is never shown as an assumption, and a necessary one
 * is never shown as enough to finish the task.
 */
import type {
  ConstructionCandidate,
  ConstructionRequirement,
  ConstructionRequirementRole,
  ConstructionTask,
  Sort,
} from "@proof/mathjson-model";

export type RoleGroup = Readonly<{
  role: ConstructionRequirementRole;
  label: string;
  /** What a requirement of this role establishes, and what it does not. */
  meaning: string;
  requirements: readonly ConstructionRequirement[];
}>;

export const ROLE_TEXT: Readonly<
  Record<ConstructionRequirementRole, Readonly<{ label: string; meaning: string }>>
> = Object.freeze({
  necessary: {
    label: "Necessary",
    meaning:
      "Any valid choice must satisfy these. They can exclude candidates but do not finish the task.",
  },
  sufficient: {
    label: "Sufficient",
    meaning:
      "A choice satisfying these would finish the task. On resolution the remaining ones become obligations.",
  },
  heuristic: {
    label: "Heuristic",
    meaning:
      "Worth investigating; no implication is established. These are never assumptions or obligations.",
  },
});

export const ROLE_ORDER: readonly ConstructionRequirementRole[] = [
  "necessary",
  "sufficient",
  "heuristic",
];

export type EvidenceText = Readonly<{ kind: "target" | "attestation" | "none"; text: string }>;

export function evidenceText(requirement: ConstructionRequirement): EvidenceText {
  switch (requirement.evidence.kind) {
    case "target":
      return { kind: "target", text: "the proof state already requires it (a stored target)" };
    case "attestation":
      return {
        kind: "attestation",
        text: `an attested argument (${requirement.evidence.attestationId}), not judged by the kernel`,
      };
    case "none":
      return { kind: "none", text: "no implication established" };
  }
}

export type TaskDependencies = Readonly<{
  /** Scope declarations the construction may mention, in placeholder-parameter order. */
  declarations: readonly string[];
  /** Other tasks whose placeholders it may use, with their names when they are in the snapshot. */
  tasks: readonly Readonly<{ id: string; displayName: string | undefined }>[];
}>;

export type ConstructionTaskModel = Readonly<{
  task: ConstructionTask;
  statusLabel: string;
  open: boolean;
  origin: Readonly<{ kind: "existential-goal" | "auxiliary-request"; text: string }>;
  sort: string;
  /** All three roles, in a fixed order, so an empty role is visibly empty. */
  roles: readonly RoleGroup[];
  candidates: readonly ConstructionCandidate[];
  dependencies: TaskDependencies;
  /** The scope's declared symbols and their sorts, for the scope line. */
  scope: readonly Readonly<{ symbol: string; sort: string }>[];
  outcome: string | undefined;
}>;

const STATUS_LABELS: Readonly<Record<ConstructionTask["status"], string>> = Object.freeze({
  unresolved: "Unresolved",
  "partially-specified": "Partially specified",
  resolved: "Resolved",
  abandoned: "Abandoned",
});

export function sortLabel(sort: Sort): string {
  if (sort.kind === "proposition") return "proposition";
  if (sort.kind === "named") {
    const parts = sort.arguments?.map(sortLabel).join(", ");
    return parts ? `${sort.id}<${parts}>` : sort.id;
  }
  return `(${sort.signature.parameters.map(sortLabel).join(", ")}) → ${sortLabel(sort.signature.result)}`;
}

/** The view of `task`; `tasks` are the snapshot's tasks, for naming the ones it depends on. */
export function constructionTaskModel(
  task: ConstructionTask,
  tasks: readonly ConstructionTask[],
): ConstructionTaskModel {
  const names = new Map(tasks.map(({ id, displayName }) => [id as string, displayName]));
  return {
    task,
    statusLabel: STATUS_LABELS[task.status],
    open: task.status === "unresolved" || task.status === "partially-specified",
    origin:
      task.origin.kind === "existential-goal"
        ? {
            kind: "existential-goal",
            text: `the existential ${task.origin.target.kind} ${task.origin.target.id}`,
          }
        : {
            kind: "auxiliary-request",
            text: `an auxiliary request: ${task.origin.description}`,
          },
    sort: sortLabel(task.sort),
    roles: ROLE_ORDER.map((role) => ({
      role,
      ...ROLE_TEXT[role],
      requirements: task.requirements.filter((requirement) => requirement.role === role),
    })),
    candidates: task.candidates,
    dependencies: {
      declarations: task.allowedDependencies.declarations,
      tasks: task.allowedDependencies.tasks.map((id) => ({ id, displayName: names.get(id) })),
    },
    scope: task.scope.declarations.map(({ symbol, sort }) => ({ symbol, sort: sortLabel(sort) })),
    outcome:
      task.status === "resolved"
        ? `Resolved by candidate ${task.resolution.candidateId}; ${task.resolution.obligationIds.length} sufficient requirement(s) became obligations.`
        : task.status === "abandoned"
          ? "Abandoned; the record is kept."
          : undefined,
  };
}
