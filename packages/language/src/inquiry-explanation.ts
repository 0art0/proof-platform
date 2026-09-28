/**
 * Deterministic explanation templates over inquiry records (refinement §3.4).
 *
 * The records are stored history: they reference mathematics by identity (a proof node and one
 * of its targets, statements, subexpressions or construction tasks). The explainer never
 * recomputes proof state. It reads the stored node snapshots, records, transitions and labels the
 * caller passes in `InquiryExplanationContext`, and renders the referenced MathJSON with the N04
 * natural-language renderer. Anything missing from the context is named by its identifier, so
 * rendering is total.
 *
 * `packages/language` sits below `packages/protocol`, so the record types here are the minimal
 * structural shape of protocol's stored `InquiryRecord`; stored records are assignable to them.
 *
 * Wording rules:
 * - a reason is always shown with its provenance, and a later interpretation is worded as such;
 *   intention-bearing relations without a contemporaneous reason are never phrased as intentions;
 * - a method-encoded reason is the objective the named method encodes, not a participant's reason;
 * - necessary, sufficient and heuristic requirements, validated and informal support, and
 *   equivalence, strengthening, weakening and sorry steps are named explicitly.
 */
import type {
  ConstructionTask,
  ContextualSequent,
  PlainMathJson,
  ProofState,
  Sort,
} from "@proof/mathjson-model";
import { expressionParts } from "./expression";
import { createLatexRenderer } from "./latex";
import { createNaturalLanguageRenderer } from "./natural-language";
import type { PresentationOptions } from "./presentation";
import { articleFor, createTerminology } from "./terminology";

// ---------------------------------------------------------------------------------------------
// Structural input types (mirroring protocol `inquiry.ts`)
// ---------------------------------------------------------------------------------------------

type Opt<T> = T | undefined;

export type InquiryTargetView = Readonly<{ kind: "goal" | "obligation"; id: string }>;
export type InquiryStatementSelectorView =
  Readonly<{ kind: "conclusion" }> | Readonly<{ kind: "hypothesis"; id: string }>;

export type InquiryMathReferenceView =
  | Readonly<{ kind: "target"; nodeId: string; target: InquiryTargetView }>
  | Readonly<{
      kind: "statement";
      nodeId: string;
      target: InquiryTargetView;
      statement: InquiryStatementSelectorView;
    }>
  | Readonly<{
      kind: "occurrence";
      nodeId: string;
      target: InquiryTargetView;
      statement: InquiryStatementSelectorView;
      path: readonly number[];
    }>
  | Readonly<{ kind: "construction-task"; nodeId: string; taskId: string }>
  | Readonly<{
      kind: "construction-requirement";
      nodeId: string;
      taskId: string;
      requirementId: string;
    }>
  /** A premise or side condition of a displayed result suggestion (N24). */
  | Readonly<{
      kind: "result-condition";
      nodeId: string;
      suggestionSetId: string;
      suggestionId: string;
      condition: Readonly<{ kind: "premise" | "side-condition"; index: number }>;
    }>;

export type PropositionReferenceView =
  | Readonly<{
      kind: "target";
      nodeId: string;
      target: InquiryTargetView;
      withoutHypotheses?: Opt<readonly string[]>;
      negated?: Opt<true>;
    }>
  | Readonly<{
      kind: "statement";
      nodeId: string;
      target: InquiryTargetView;
      statement: InquiryStatementSelectorView;
      negated?: Opt<true>;
    }>
  | Readonly<{
      kind: "construction-requirement";
      nodeId: string;
      taskId: string;
      requirementId: string;
      negated?: Opt<true>;
    }>;

export type MethodReferenceView =
  | Readonly<{ kind: "move"; moveId: string }>
  | Readonly<{ kind: "library-result"; resultId: string }>
  /** One of the platform's inquiry methods (N24). */
  | Readonly<{
      kind: "inquiry-method";
      methodId: "try-result" | "investigate-hypothesis" | "extract-conditional-lemma";
    }>
  | Readonly<{ kind: "manual" }>;

export type LogicalSupportView =
  | Readonly<{ kind: "transition"; childNodeId: string }>
  | Readonly<{ kind: "proof-target"; nodeId: string; target: InquiryTargetView }>
  | Readonly<{
      kind: "construction-requirement";
      nodeId: string;
      taskId: string;
      requirementId: string;
    }>
  | Readonly<{
      kind: "informal";
      status: "conjectured" | "plausible" | "checked-on-examples";
      note?: Opt<string>;
    }>;

export type InquiryReasonView = Readonly<{
  provenance: "explicit-user" | "agent" | "method-encoded" | "later-interpretation";
  basisIds?: Opt<readonly string[]>;
  method?: Opt<MethodReferenceView>;
  note?: Opt<string>;
}>;

export type InquiryQuestionView =
  | Readonly<{ form: "establish"; proposition: PropositionReferenceView }>
  | Readonly<{
      form: "construct";
      object:
        | Readonly<{ kind: "construction-task"; nodeId: string; taskId: string }>
        | Readonly<{ kind: "unassigned"; displayName: string; sort: Sort }>;
    }>
  | Readonly<{ form: "determine"; proposition: PropositionReferenceView }>
  | Readonly<{
      form: "explore";
      objects: readonly InquiryMathReferenceView[];
      aspect: "structure" | "relationship" | "hypothesis" | "family";
    }>;

export type DecisionOptionView =
  | Readonly<{ kind: "record"; recordId: string }>
  | Readonly<{ kind: "suggestion"; suggestionSetId: string; suggestionId: string }>
  | Readonly<{ kind: "method"; method: MethodReferenceView }>;

type SelectionAnchorView = Readonly<{
  stateId: string;
  target: InquiryTargetView;
  statement: InquiryStatementSelectorView;
}>;

export type InquirySelectionView =
  | Readonly<{ kind: "exact"; anchor: SelectionAnchorView; path: readonly number[] }>
  | Readonly<{
      kind: "associative";
      anchor: SelectionAnchorView;
      containerPath: readonly number[];
      startOperand: number;
      endOperand: number;
    }>;

export type InquiryRelationView =
  | "wouldSufficeFor"
  | "requires"
  | "motivatedBy"
  | "addresses"
  | "specializes"
  | "generalizes"
  | "tests"
  | "reuses";

export type InquiryDiagnosticCodeView =
  | "unmet-condition"
  | "failed-match"
  | "forbidden-dependency"
  | "counterexample"
  | "search-exhausted"
  | "uncertain";

type RecordBase = Readonly<{
  id: string;
  sequence: number;
  /** The anchor node the record was recorded at. */
  nodeId: string;
  actor: Readonly<{ id: string; kind: "human" | "agent" }>;
}>;

/** The fields of a stored inquiry record that explanations use. */
export type InquiryRecordView = RecordBase &
  (
    | Readonly<{ kind: "question"; question: InquiryQuestionView }>
    | Readonly<{
        kind: "objective";
        questionId: string;
        necessity: "required" | "elective";
        focus?: Opt<Readonly<{ nodeId: string; target: InquiryTargetView }>>;
        parentAttemptId?: Opt<string>;
      }>
    | Readonly<{
        kind: "attempt";
        objectiveId: string;
        method: MethodReferenceView;
        selections?: Opt<readonly InquirySelectionView[]>;
        suggestion?: Opt<Readonly<{ suggestionSetId: string; suggestionId: string }>>;
      }>
    | Readonly<{
        kind: "requirement";
        subjectId: string;
        proposition: PropositionReferenceView;
        role: "necessary" | "sufficient" | "heuristic";
        support?: Opt<LogicalSupportView>;
      }>
    | Readonly<{
        kind: "observation";
        references?: Opt<readonly InquiryMathReferenceView[]>;
        diagnostic?: Opt<Readonly<{ code: InquiryDiagnosticCodeView; detail?: Opt<string> }>>;
        note?: Opt<string>;
        support?: Opt<LogicalSupportView>;
      }>
    | Readonly<{
        kind: "obstruction";
        attemptId: string;
        cause:
          | Readonly<{ kind: "unmet-requirement"; requirementId: string }>
          | Readonly<{ kind: "observation"; observationId: string }>;
        observationIds?: Opt<readonly string[]>;
        potentialResponses?: Opt<readonly MethodReferenceView[]>;
      }>
    | Readonly<{
        kind: "decision";
        subjectId?: Opt<string>;
        selected: DecisionOptionView;
        alternatives?: Opt<readonly DecisionOptionView[]>;
        reason?: Opt<InquiryReasonView>;
      }>
    | Readonly<{
        kind: "relationship";
        relation: InquiryRelationView;
        from: readonly string[];
        to: string;
        support?: Opt<LogicalSupportView>;
        reason?: Opt<InquiryReasonView>;
      }>
    | Readonly<{
        kind: "status-change";
        subjectId: string;
        status: string;
        reason?: Opt<InquiryReasonView>;
      }>
  );

/** A stored transition, keyed by its child node. */
export type InquiryTransitionView = Readonly<{
  transitionClass: "equivalence" | "strengthening" | "weakening";
  /** The kernel evidence kind, when it was stored. */
  evidence?: Opt<"structural" | "library-result" | "background-inference" | "sorry">;
}>;

/** Stored data the explanations read. Nothing here is recomputed. */
export type InquiryExplanationContext = Readonly<{
  /** Stored proof-node snapshots by node ID. */
  nodes: ReadonlyMap<string, ProofState>;
  /** Stored inquiry records by ID; referenced records are looked up here. */
  records: ReadonlyMap<string, InquiryRecordView>;
  /** Stored transitions by child node ID. */
  transitions?: ReadonlyMap<string, InquiryTransitionView>;
  /** Display names of approved moves and library results by ID. */
  methodNames?: Readonly<{
    moves?: ReadonlyMap<string, string>;
    results?: ReadonlyMap<string, string>;
  }>;
  /** Labels of displayed suggestions, by suggestion set ID and then suggestion ID. */
  suggestionLabels?: ReadonlyMap<string, ReadonlyMap<string, string>>;
}>;

export type InquiryTemplateId =
  | "question"
  | "objective"
  | "attempt"
  | "requirement:sufficient"
  | "requirement:necessary"
  | "requirement:heuristic"
  | "observation"
  | "obstruction"
  | "decision"
  | `relationship:${InquiryRelationView}`
  | `relationship:${InquiryRelationView}:later-interpretation`
  | "status-change"
  | "status-change:abandoned-after"
  | "sufficiency";

export type InquiryExplanation = Readonly<{
  recordId: string;
  template: InquiryTemplateId;
  text: string;
}>;

export type InquiryExplainer = Readonly<{
  /** Render one record's template sentences. */
  explain(record: InquiryRecordView, context: InquiryExplanationContext): InquiryExplanation;
  /** Render records in sequence order. */
  explainAll(
    records: Iterable<InquiryRecordView>,
    context: InquiryExplanationContext,
  ): readonly InquiryExplanation[];
  /**
   * "This method would suffice if [requirements] were established": the sufficient requirements
   * recorded for an attempt or question, read from `context.records` in sequence order.
   * Undefined when there are none.
   */
  explainSufficiency(
    subjectId: string,
    context: InquiryExplanationContext,
  ): InquiryExplanation | undefined;
}>;

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const INTENTION_RELATIONS: ReadonlySet<InquiryRelationView> = new Set([
  "motivatedBy",
  "addresses",
  "tests",
  "reuses",
]);

const MAX_REFERENCE_DEPTH = 4;

/**
 * A proposition as a clause ("$x$ is positive") or a noun ("the negation of …"). A `framed` clause
 * starts with its hypotheses ("under the hypothesis that …, …") and takes a comma after "that".
 */
type Proposition = Readonly<{ kind: "clause" | "noun"; text: string; framed?: boolean }>;

function joinList(items: readonly string[], conjunction: string): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0] ?? ""} ${conjunction} ${items[1] ?? ""}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items[items.length - 1] ?? ""}`;
}

function capitalize(text: string): string {
  return text.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

function quoted(text: string): string {
  return `“${text}”`;
}

function introduced(word: string, proposition: Proposition): string {
  if (proposition.kind === "noun") return `${word} ${proposition.text} holds`;
  return `${word}${proposition.framed === true ? "," : ""} ${proposition.text}`;
}

const thatForm = (proposition: Proposition) => introduced("that", proposition);
const whetherForm = (proposition: Proposition) => introduced("whether", proposition);

/** The object of "establish": "that …", or the noun itself. */
function establishForm(proposition: Proposition): string {
  return proposition.kind === "noun" ? proposition.text : thatForm(proposition);
}

/** Drop a period that follows a quotation already ending a sentence ("“… used.”."). */
function tidy(text: string): string {
  return text.replace(/([.!?])”\./g, "$1”");
}

/** End a sentence with a period unless it already ends with punctuation (inside a quote). */
function period(text: string): string {
  return /[.!?]”?$/.test(text) ? text : `${text}.`;
}

function expressionAt(
  expression: PlainMathJson,
  path: readonly number[],
): PlainMathJson | undefined {
  let current: PlainMathJson | undefined = expression;
  for (const index of path) {
    current = current === undefined ? undefined : expressionParts(current)?.operands[index];
  }
  return current;
}

const STATUS_WORDS: Readonly<Record<string, string>> = Object.freeze({
  "in-progress": "in progress",
  "checked-on-examples": "checked on examples",
});

const DIAGNOSTIC_NOUNS: Readonly<Record<InquiryDiagnosticCodeView, string>> = Object.freeze({
  "unmet-condition": "an unmet condition",
  "failed-match": "a failed match",
  "forbidden-dependency": "a forbidden dependency",
  counterexample: "a counterexample",
  "search-exhausted":
    "a search that ended without success, which does not show that no argument exists",
  uncertain: "an uncertain outcome",
});

const INQUIRY_METHOD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "try-result": "Try this theorem",
  "investigate-hypothesis": "Test the role of a hypothesis",
  "extract-conditional-lemma": "Extract a conditional lemma",
});

const TRANSITION_EVIDENCE_WORDS: Readonly<
  Record<NonNullable<InquiryTransitionView["evidence"]>, string>
> = Object.freeze({
  structural: "a structural step",
  "library-result": "a library result",
  "background-inference": "background inference",
  sorry: "a sorry, assumed without proof",
});

/** Build an explainer whose mathematics uses one operator environment, as `createPresentation`. */
export function createInquiryExplainer(options: PresentationOptions = {}): InquiryExplainer {
  const latex = createLatexRenderer({ operators: options.operators ?? [] });
  const naturalLanguage = createNaturalLanguageRenderer({
    latex,
    dictionaries: options.dictionaries ?? [],
    overrides: options.overrides ?? [],
    relationStyle: options.relationStyle ?? "words",
  });
  const terminology = createTerminology(options.dictionaries ?? []);

  const session = (context: InquiryExplanationContext) => {
    // --- Mathematics -------------------------------------------------------------------------

    const nodeName = (nodeId: string) => `proof node ${nodeId}`;

    const targetOf = (nodeId: string, target: InquiryTargetView) => {
      const state = context.nodes.get(nodeId);
      const list =
        state === undefined ? [] : target.kind === "goal" ? state.goals : state.obligations;
      return list.find(({ id }) => id === target.id);
    };

    const missingTarget = (nodeId: string, target: InquiryTargetView) =>
      `the ${target.kind} ${target.id} of ${nodeName(nodeId)}`;

    const clause = (expression: PlainMathJson, sequent: ContextualSequent | undefined) =>
      naturalLanguage.statement(expression, {
        declarations: sequent?.context.declarations ?? [],
      });

    const statementOf = (sequent: ContextualSequent, selector: InquiryStatementSelectorView) =>
      selector.kind === "conclusion"
        ? sequent.conclusion.expression
        : sequent.context.hypotheses.find(({ id }) => id === selector.id)?.statement.expression;

    /** "under the hypothesis that H and without the hypothesis that K, C". */
    const sequentClause = (
      sequent: ContextualSequent,
      without: readonly string[] = [],
    ): Proposition => {
      const kept = sequent.context.hypotheses.filter(({ id }) => !without.includes(id));
      const removed = sequent.context.hypotheses.filter(({ id }) => without.includes(id));
      const hypotheses = (items: typeof kept, prefix: string) =>
        items.length === 0
          ? []
          : [
              `${prefix} ${items.length === 1 ? "hypothesis" : "hypotheses"} ${joinList(
                items.map(({ statement }) => `that ${clause(statement.expression, sequent)}`),
                "and",
              )}`,
            ];
      const frame = [...hypotheses(kept, "under the"), ...hypotheses(removed, "without the")];
      const conclusion = clause(sequent.conclusion.expression, sequent);
      return frame.length === 0
        ? { kind: "clause", text: conclusion }
        : { kind: "clause", text: `${frame.join(" and ")}, ${conclusion}`, framed: true };
    };

    const taskOf = (nodeId: string, taskId: string): ConstructionTask | undefined =>
      context.nodes.get(nodeId)?.constructions?.find(({ id }) => id === taskId);

    const objectName = (displayName: string) =>
      /^(?:[A-Za-z]|\\[A-Za-z]+|[\u0370-\u03ff])(?:_\{?[A-Za-z0-9]+\}?)?$/u.test(displayName)
        ? `$${displayName}$`
        : quoted(displayName);

    const taskName = (nodeId: string, taskId: string) => {
      const task = taskOf(nodeId, taskId);
      return task === undefined
        ? `the object of construction task ${taskId}`
        : objectName(task.displayName);
    };

    const sortPhrase = (sort: Sort): string => {
      const noun = terminology.sortNoun(sort);
      return noun === undefined ? "an object" : `${articleFor(noun)} ${noun.singular}`;
    };

    const requirementOf = (nodeId: string, taskId: string, requirementId: string) =>
      taskOf(nodeId, taskId)?.requirements.find(({ id }) => id === requirementId);

    const requirementClause = (nodeId: string, taskId: string, requirementId: string) => {
      const requirement = requirementOf(nodeId, taskId, requirementId);
      if (requirement === undefined) return undefined;
      const declarations = taskOf(nodeId, taskId)?.scope.declarations ?? [];
      return naturalLanguage.statement(requirement.statement.expression, { declarations });
    };

    const proposition = (reference: PropositionReferenceView): Proposition => {
      const negate = (expression: PlainMathJson, sequent: ContextualSequent | undefined) =>
        clause(["Not", expression], sequent);
      switch (reference.kind) {
        case "target": {
          const found = targetOf(reference.nodeId, reference.target);
          if (found === undefined) {
            const text = `the conclusion of ${missingTarget(reference.nodeId, reference.target)}`;
            return {
              kind: "noun",
              text: reference.negated === true ? `the negation of ${text}` : text,
            };
          }
          const without = reference.withoutHypotheses ?? [];
          const plain = found.sequent.context.hypotheses.length === 0 && without.length === 0;
          if (reference.negated !== true) return sequentClause(found.sequent, without);
          return plain
            ? { kind: "clause", text: negate(found.sequent.conclusion.expression, found.sequent) }
            : {
                kind: "noun",
                text: `the negation of the statement ${thatForm(sequentClause(found.sequent, without))}`,
              };
        }
        case "statement": {
          const sequent = targetOf(reference.nodeId, reference.target)?.sequent;
          const expression =
            sequent === undefined ? undefined : statementOf(sequent, reference.statement);
          if (expression === undefined) {
            const label =
              reference.statement.kind === "conclusion"
                ? "the conclusion"
                : `the hypothesis ${reference.statement.id}`;
            const text = `${label} of ${missingTarget(reference.nodeId, reference.target)}`;
            return {
              kind: "noun",
              text: reference.negated === true ? `the negation of ${text}` : text,
            };
          }
          return {
            kind: "clause",
            text:
              reference.negated === true
                ? negate(expression, sequent)
                : clause(expression, sequent),
          };
        }
        case "construction-requirement": {
          const requirement = requirementOf(
            reference.nodeId,
            reference.taskId,
            reference.requirementId,
          );
          if (requirement === undefined) {
            const text = `construction requirement ${reference.requirementId} of task ${reference.taskId}`;
            return {
              kind: "noun",
              text: reference.negated === true ? `the negation of ${text}` : text,
            };
          }
          const declarations = taskOf(reference.nodeId, reference.taskId)?.scope.declarations ?? [];
          const expression = requirement.statement.expression;
          return {
            kind: "clause",
            text: naturalLanguage.statement(
              reference.negated === true ? ["Not", expression] : expression,
              { declarations },
            ),
          };
        }
      }
    };

    const mathReference = (reference: InquiryMathReferenceView): string => {
      switch (reference.kind) {
        case "target": {
          const found = targetOf(reference.nodeId, reference.target);
          return found === undefined
            ? missingTarget(reference.nodeId, reference.target)
            : `the ${reference.target.kind} ${thatForm(sequentClause(found.sequent))}`;
        }
        case "statement":
        case "occurrence": {
          const sequent = targetOf(reference.nodeId, reference.target)?.sequent;
          const statement =
            sequent === undefined ? undefined : statementOf(sequent, reference.statement);
          const role = reference.statement.kind === "conclusion" ? "conclusion" : "hypothesis";
          if (statement === undefined) {
            return `a ${role} of ${missingTarget(reference.nodeId, reference.target)}`;
          }
          if (reference.kind === "statement")
            return `the ${role} that ${clause(statement, sequent)}`;
          const occurrence = expressionAt(statement, reference.path);
          return occurrence === undefined
            ? `a subexpression of the ${role} that ${clause(statement, sequent)}`
            : naturalLanguage.term(occurrence, {
                declarations: sequent?.context.declarations ?? [],
              });
        }
        case "construction-task":
          return taskName(reference.nodeId, reference.taskId);
        case "construction-requirement": {
          const requirement = requirementOf(
            reference.nodeId,
            reference.taskId,
            reference.requirementId,
          );
          const text = requirementClause(
            reference.nodeId,
            reference.taskId,
            reference.requirementId,
          );
          return requirement === undefined || text === undefined
            ? `construction requirement ${reference.requirementId} of task ${reference.taskId}`
            : `the ${requirement.role} requirement that ${text}`;
        }
        case "result-condition": {
          const { kind, index } = reference.condition;
          const label = kind === "premise" ? "premise" : "side condition";
          return `${label} ${index + 1} of the result in ${suggestion(reference.suggestionSetId, reference.suggestionId)}`;
        }
        default:
          return "an unrecognized mathematical reference";
      }
    };

    // --- Methods, support, reasons -----------------------------------------------------------

    const method = (reference: MethodReferenceView): string => {
      switch (reference.kind) {
        case "move":
          return `the move ${quoted(context.methodNames?.moves?.get(reference.moveId) ?? reference.moveId)}`;
        case "library-result":
          return `the result ${quoted(
            context.methodNames?.results?.get(reference.resultId) ?? reference.resultId,
          )}`;
        case "inquiry-method":
          return `the method ${quoted(INQUIRY_METHOD_NAMES[reference.methodId] ?? reference.methodId)}`;
        case "manual":
          return "manual work";
        default:
          return "an unrecognized method";
      }
    };

    const suggestion = (setId: string, suggestionId: string) => {
      const label = context.suggestionLabels?.get(setId)?.get(suggestionId);
      return label === undefined
        ? `the displayed suggestion ${suggestionId}`
        : `the displayed suggestion ${quoted(label)}`;
    };

    const constructionEvidence = (
      evidence: NonNullable<ReturnType<typeof requirementOf>>["evidence"],
    ) =>
      evidence.kind === "target"
        ? `the ${evidence.target.kind} ${evidence.target.id}, which the proof already requires`
        : evidence.kind === "attestation"
          ? `attestation ${evidence.attestationId}`
          : "no established implication";

    const support = (value: LogicalSupportView): string => {
      switch (value.kind) {
        case "transition": {
          const transition = context.transitions?.get(value.childNodeId);
          if (transition === undefined) {
            return `evidence: the recorded transition to ${nodeName(value.childNodeId)}`;
          }
          const how =
            transition.evidence === undefined
              ? ""
              : `, justified by ${TRANSITION_EVIDENCE_WORDS[transition.evidence]}`;
          const caveat =
            transition.transitionClass === "weakening"
              ? ", which does not by itself show sufficiency"
              : "";
          return `evidence: the ${transition.transitionClass} step to ${nodeName(value.childNodeId)}${how}${caveat}`;
        }
        case "proof-target":
          return `evidence: the ${value.target.kind} ${value.target.id} of ${nodeName(value.nodeId)}, which the proof already requires`;
        case "construction-requirement": {
          const requirement = requirementOf(value.nodeId, value.taskId, value.requirementId);
          const name = taskName(value.nodeId, value.taskId);
          return requirement === undefined
            ? `evidence: construction requirement ${value.requirementId} of ${name}`
            : `evidence: the ${requirement.role} construction requirement ${value.requirementId} of ${name}, supported by ${constructionEvidence(requirement.evidence)}`;
        }
        case "informal": {
          const note = value.note === undefined ? "" : `; note: ${quoted(value.note)}`;
          return `informal status: ${STATUS_WORDS[value.status] ?? value.status}, not validated evidence${note}`;
        }
      }
    };

    const withSupport = (value: LogicalSupportView | undefined) =>
      value === undefined ? "" : ` (${support(value)})`;

    const provenancePhrase = (reason: InquiryReasonView): string => {
      switch (reason.provenance) {
        case "explicit-user":
          return "stated explicitly by the participant";
        case "agent":
          return "recorded by the agent when it acted";
        case "method-encoded":
          return `the objective encoded in ${reason.method === undefined ? "the chosen method" : method(reason.method)}, not separately stated by a participant`;
        case "later-interpretation":
          return "a later interpretation, not a reason recorded at the time";
      }
    };

    const reasonSentence = (
      reason: InquiryReasonView | undefined,
      depth: number,
      includeBasis = true,
    ): string => {
      if (reason === undefined) return "";
      const content = [
        ...(includeBasis && (reason.basisIds ?? []).length > 0
          ? [
              `based on ${joinList(
                (reason.basisIds ?? []).map((id) => recordNoun(id, depth)),
                "and",
              )}`,
            ]
          : []),
        ...(reason.note === undefined ? [] : [quoted(reason.note)]),
      ];
      const body = content.length === 0 ? "" : `: ${content.join("; ")}`;
      return ` ${period(`Reason, ${provenancePhrase(reason)}${body}`)}`;
    };

    // --- Records -----------------------------------------------------------------------------

    /** A `brief` phrase omits a construction's sort and origin, for references. */
    const questionPhrase = (
      question: InquiryQuestionView,
      mood: "base" | "gerund",
      brief = false,
    ): string => {
      const verb = (base: string, gerund: string) => (mood === "base" ? base : gerund);
      switch (question.form) {
        case "establish":
          return `${verb("establish", "establishing")} ${establishForm(proposition(question.proposition))}`;
        case "determine":
          return `${verb("determine", "determining")} ${whetherForm(proposition(question.proposition))}`;
        case "construct": {
          const object = question.object;
          if (object.kind === "unassigned") {
            return `${verb("construct", "constructing")} ${sortPhrase(object.sort)} ${objectName(object.displayName)}`;
          }
          const task = taskOf(object.nodeId, object.taskId);
          if (task === undefined) {
            return `${verb("construct", "constructing")} the object of construction task ${object.taskId}`;
          }
          if (brief) return `${verb("construct", "constructing")} ${objectName(task.displayName)}`;
          const origin =
            task.origin.kind === "existential-goal"
              ? `, a witness for the claim that ${naturalLanguage.statement(
                  task.origin.statement.expression,
                  { declarations: task.scope.declarations },
                )}`
              : `, requested as ${quoted(task.origin.description)}`;
          return `${verb("construct", "constructing")} ${objectName(task.displayName)}, ${sortPhrase(task.sort)}${origin}`;
        }
        case "explore": {
          const objects = question.objects.map(mathReference);
          const phrase =
            question.aspect === "structure"
              ? `the structure of ${joinList(objects, "and")}`
              : question.aspect === "relationship"
                ? `the relationship between ${joinList(objects, "and")}`
                : question.aspect === "hypothesis"
                  ? `the role of ${joinList(objects, "and")}`
                  : `the family formed by ${joinList(objects, "and")}`;
          return `${verb("explore", "exploring")} ${phrase}`;
        }
      }
    };

    /** "This construction is required to depend only on [available parameters]." */
    const dependencySentence = (question: InquiryQuestionView): string => {
      if (question.form !== "construct" || question.object.kind !== "construction-task") return "";
      const { nodeId, taskId } = question.object;
      const task = taskOf(nodeId, taskId);
      if (task === undefined) return "";
      const parameters = [
        ...task.allowedDependencies.declarations.map((symbol) => `$${latex.serialize(symbol)}$`),
        ...task.allowedDependencies.tasks.map(
          (id) => `the construction of ${taskName(nodeId, id)}`,
        ),
      ];
      return parameters.length === 0
        ? " This construction is required to depend on no parameters."
        : ` This construction is required to depend only on ${joinList(parameters, "and")}.`;
    };

    const lookup = (id: string) => context.records.get(id);

    const questionOf = (objectiveId: string) => {
      const objective = lookup(objectiveId);
      if (objective?.kind !== "objective") return undefined;
      const question = lookup(objective.questionId);
      return question?.kind === "question" ? question.question : undefined;
    };

    const observationNoun = (record: Extract<InquiryRecordView, { kind: "observation" }>) => {
      if (record.diagnostic !== undefined) {
        const detail =
          record.diagnostic.detail === undefined ? "" : ` (${quoted(record.diagnostic.detail)})`;
        return `the observation of ${DIAGNOSTIC_NOUNS[record.diagnostic.code]}${detail}`;
      }
      if ((record.references ?? []).length > 0) {
        return `the observation about ${joinList((record.references ?? []).map(mathReference), "and")}`;
      }
      return `the observation ${quoted(record.note ?? record.id)}`;
    };

    const requirementNoun = (record: Extract<InquiryRecordView, { kind: "requirement" }>) =>
      `the ${record.role} requirement ${thatForm(proposition(record.proposition))}`;

    const obstructionCause = (
      record: Extract<InquiryRecordView, { kind: "obstruction" }>,
      depth: number,
    ) => {
      if (record.cause.kind === "unmet-requirement") {
        const requirement = lookup(record.cause.requirementId);
        return requirement?.kind === "requirement"
          ? `${requirementNoun(requirement)} is unmet`
          : `the requirement ${record.cause.requirementId} is unmet`;
      }
      return `of ${recordNoun(record.cause.observationId, depth)}`;
    };

    const optionNoun = (option: DecisionOptionView, depth: number): string =>
      option.kind === "record"
        ? recordNoun(option.recordId, depth)
        : option.kind === "suggestion"
          ? suggestion(option.suggestionSetId, option.suggestionId)
          : method(option.method);

    /** A noun phrase for a referenced record. */
    const recordNoun = (id: string, depth = 0): string => {
      const record = lookup(id);
      if (record === undefined || depth > MAX_REFERENCE_DEPTH) return `the inquiry record ${id}`;
      const next = depth + 1;
      switch (record.kind) {
        case "question":
          return `the question of ${questionPhrase(record.question, "gerund", true)}`;
        case "objective": {
          const question = lookup(record.questionId);
          return question?.kind === "question"
            ? `the objective of ${questionPhrase(question.question, "gerund", true)}`
            : `the objective ${record.id}`;
        }
        case "attempt":
          return `the attempt with ${method(record.method)}`;
        case "requirement":
          return requirementNoun(record);
        case "observation":
          return observationNoun(record);
        case "obstruction":
          return record.cause.kind === "unmet-requirement"
            ? `the obstruction that ${obstructionCause(record, next)}`
            : `the obstruction arising from ${recordNoun(record.cause.observationId, next)}`;
        case "decision":
          return `the decision to select ${optionNoun(record.selected, next)}`;
        case "relationship":
          return `the recorded ${record.relation} relationship ${record.id}`;
        case "status-change":
          return `the change of ${recordNoun(record.subjectId, next)} to ${statusWord(record.status)}`;
      }
    };

    const statusWord = (status: string) => STATUS_WORDS[status] ?? status;

    const selectionPhrase = (anchorNodeId: string, selection: InquirySelectionView): string => {
      const state = context.nodes.get(anchorNodeId);
      const sequent =
        state === undefined || state.id !== selection.anchor.stateId
          ? undefined
          : targetOf(anchorNodeId, selection.anchor.target)?.sequent;
      const statement =
        sequent === undefined ? undefined : statementOf(sequent, selection.anchor.statement);
      const declarations = sequent?.context.declarations ?? [];
      if (statement === undefined) return "a selection";
      if (selection.kind === "exact") {
        const selected = expressionAt(statement, selection.path);
        return selected === undefined
          ? "a selection"
          : naturalLanguage.term(selected, { declarations });
      }
      const container = expressionAt(statement, selection.containerPath);
      const parts = container === undefined ? undefined : expressionParts(container);
      if (parts === undefined) return "a selection";
      const operands = parts.operands.slice(selection.startOperand, selection.endOperand);
      return naturalLanguage.term([parts.operator, ...operands] as PlainMathJson, { declarations });
    };

    // --- Template sentences ------------------------------------------------------------------

    /** The focus of an objective; its question's own target is not rendered twice. */
    const focusSentence = (
      focus: Readonly<{ nodeId: string; target: InquiryTargetView }>,
      question: InquiryRecordView | undefined,
    ): string => {
      const proposition =
        question?.kind === "question" &&
        (question.question.form === "establish" || question.question.form === "determine")
          ? question.question.proposition
          : undefined;
      if (
        proposition?.kind === "target" &&
        proposition.nodeId === focus.nodeId &&
        proposition.target.kind === focus.target.kind &&
        proposition.target.id === focus.target.id
      ) {
        return `It focuses on that ${focus.target.kind}.`;
      }
      const found = targetOf(focus.nodeId, focus.target);
      return `It focuses on ${
        found === undefined
          ? missingTarget(focus.nodeId, focus.target)
          : `the ${focus.target.kind} ${thatForm(sequentClause(found.sequent))}`
      }.`;
    };

    const explainRecord = (record: InquiryRecordView): InquiryExplanation => {
      const result = (template: InquiryTemplateId, text: string): InquiryExplanation =>
        Object.freeze({ recordId: record.id, template, text: tidy(text) });
      switch (record.kind) {
        case "question":
          return result(
            "question",
            `Question: ${questionPhrase(record.question, "base")}.${dependencySentence(record.question)}`,
          );
        case "objective": {
          const question = lookup(record.questionId);
          const goal =
            question?.kind === "question"
              ? questionPhrase(question.question, "base")
              : `pursue the question ${record.questionId}`;
          const necessity =
            record.necessity === "required"
              ? " The proof requires this objective."
              : " This objective is elective: it is not needed to finish the original proof.";
          const focus =
            record.focus === undefined ? "" : ` ${focusSentence(record.focus, question)}`;
          const parent =
            record.parentAttemptId === undefined
              ? ""
              : ` It was proposed by ${recordNoun(record.parentAttemptId)}.`;
          return result("objective", `Objective: ${goal}.${necessity}${focus}${parent}`);
        }
        case "attempt": {
          const question = questionOf(record.objectiveId);
          const purpose =
            question === undefined
              ? `For the objective ${record.objectiveId}`
              : `To ${questionPhrase(question, "base")}`;
          const selections = (record.selections ?? []).map((selection) =>
            selectionPhrase(record.nodeId, selection),
          );
          const on = selections.length === 0 ? "" : ` on ${joinList(selections, "and")}`;
          const chosen =
            record.suggestion === undefined
              ? ""
              : `, chosen as ${suggestion(record.suggestion.suggestionSetId, record.suggestion.suggestionId)}`;
          return result("attempt", `${purpose}, try ${method(record.method)}${on}${chosen}.`);
        }
        case "requirement": {
          const subject = recordNoun(record.subjectId);
          const claim = proposition(record.proposition);
          const head = `${capitalize(record.role)} requirement for ${subject}: ${
            claim.kind === "noun" ? `${claim.text} holds` : claim.text
          }.`;
          const evidence = withSupport(record.support);
          switch (record.role) {
            case "sufficient":
              return result(
                "requirement:sufficient",
                `${head} Establishing it would suffice, together with any other sufficient requirements recorded for it${evidence}.`,
              );
            case "necessary":
              return result(
                "requirement:necessary",
                `${head} It is a necessary condition: it can exclude candidates but does not suffice${evidence}.`,
              );
            case "heuristic":
              return result(
                "requirement:heuristic",
                `${head} It is worth investigating, with no established implication${evidence}.`,
              );
          }
          break;
        }
        case "observation": {
          const references = (record.references ?? []).map(mathReference);
          const head =
            references.length === 0
              ? "Observation"
              : `Observation about ${joinList(references, "and")}`;
          const first =
            record.diagnostic !== undefined
              ? `${head}: ${DIAGNOSTIC_NOUNS[record.diagnostic.code]}${
                  record.diagnostic.detail === undefined
                    ? ""
                    : ` (${quoted(record.diagnostic.detail)})`
                }.`
              : record.note !== undefined && references.length === 0
                ? period(`${head}: ${quoted(record.note)}`)
                : `${head}.`;
          const note =
            record.note === undefined || !(record.diagnostic !== undefined || references.length > 0)
              ? ""
              : ` ${period(`Note: ${quoted(record.note)}`)}`;
          const status =
            record.support === undefined
              ? " It is unchecked."
              : ` It is supported (${support(record.support)}).`;
          return result("observation", `${first}${note}${status}`);
        }
        case "obstruction": {
          const attempt = capitalize(recordNoun(record.attemptId));
          const also = (record.observationIds ?? []).map((id) => recordNoun(id));
          const seeAlso = also.length === 0 ? "" : ` See also ${joinList(also, "and")}.`;
          const responses = (record.potentialResponses ?? []).map(method);
          const possible =
            responses.length === 0 ? "" : ` Possible responses: ${joinList(responses, "or")}.`;
          return result(
            "obstruction",
            `${attempt} is blocked because ${obstructionCause(record, 0)}.${seeAlso}${possible}`,
          );
        }
        case "decision": {
          const chooser = record.actor.kind === "agent" ? "The agent" : "The participant";
          const alternatives = (record.alternatives ?? []).map((option) => optionNoun(option, 0));
          const over = alternatives.length === 0 ? "" : ` over ${joinList(alternatives, "and")}`;
          const about =
            record.subjectId === undefined ? "" : `For ${recordNoun(record.subjectId)}, `;
          const who = about === "" ? chooser : chooser.toLowerCase();
          return result(
            "decision",
            `${about}${who} selected ${optionNoun(record.selected, 0)}${over}.${reasonSentence(record.reason, 0)}`,
          );
        }
        case "relationship":
          return explainRelationship(record, result);
        case "status-change": {
          const subject = lookup(record.subjectId);
          const noun = capitalize(recordNoun(record.subjectId));
          const basis = record.reason?.basisIds ?? [];
          if (subject?.kind === "attempt" && record.status === "abandoned" && basis.length > 0) {
            return result(
              "status-change:abandoned-after",
              `${noun} was abandoned after ${joinList(
                basis.map((id) => recordNoun(id)),
                "and",
              )}.${reasonSentence(record.reason, 0, false)}`,
            );
          }
          return result(
            "status-change",
            `${noun} was marked ${statusWord(record.status)}.${reasonSentence(record.reason, 0)}`,
          );
        }
      }
    };

    /** A claim is established; any other question (determine, construct, explore) is settled. */
    const claimOf = (id: string): Readonly<{ verb: "establish" | "settle"; text: string }> => {
      const record = lookup(id);
      if (record?.kind === "requirement") {
        return { verb: "establish", text: establishForm(proposition(record.proposition)) };
      }
      if (record?.kind === "question" && record.question.form === "establish") {
        return { verb: "establish", text: establishForm(proposition(record.question.proposition)) };
      }
      return { verb: "settle", text: recordNoun(id) };
    };

    const claimsPhrase = (ids: readonly string[]): string => {
      const claims = ids.map(claimOf);
      const gerund = (verb: "establish" | "settle") =>
        verb === "establish" ? "establishing" : "settling";
      const first = claims[0]?.verb ?? "establish";
      return claims.every(({ verb }) => verb === first)
        ? `${gerund(first)} ${joinList(
            claims.map(({ text }) => text),
            "and",
          )}`
        : joinList(
            claims.map(({ verb, text }) => `${gerund(verb)} ${text}`),
            "and",
          );
    };

    /** An action phrase for "To address [obstruction], [action]". */
    const actionOf = (id: string): string => {
      const record = lookup(id);
      switch (record?.kind) {
        case "attempt":
          return `try ${method(record.method)}`;
        case "question":
          return questionPhrase(record.question, "base");
        case "objective": {
          const question = lookup(record.questionId);
          return question?.kind === "question"
            ? `pursue the objective of ${questionPhrase(question.question, "gerund", true)}`
            : `pursue the objective ${id}`;
        }
        default:
          return `pursue ${recordNoun(id)}`;
      }
    };

    const explainRelationship = (
      record: Extract<InquiryRecordView, { kind: "relationship" }>,
      result: (template: InquiryTemplateId, text: string) => InquiryExplanation,
    ): InquiryExplanation => {
      const from = record.from.map((id) => recordNoun(id));
      const fromList = joinList(from, "and");
      const plural = record.from.length > 1;
      const to = recordNoun(record.to);
      const evidence = withSupport(record.support);
      const reason = reasonSentence(record.reason, 0);
      const later = record.reason?.provenance === "later-interpretation";

      if (INTENTION_RELATIONS.has(record.relation) && later) {
        const reading: Record<string, string> = {
          motivatedBy: "motivated by",
          addresses: "addressing",
          tests: "testing",
          reuses: "reusing",
        };
        return result(
          `relationship:${record.relation}:later-interpretation`,
          `On a later interpretation, ${fromList} can be read as ${reading[record.relation] ?? record.relation} ${to}${evidence}.${reason}`,
        );
      }

      switch (record.relation) {
        case "wouldSufficeFor":
          return result(
            "relationship:wouldSufficeFor",
            `${capitalize(claimsPhrase(record.from))} would ${claimOf(record.to).verb} ${claimOf(record.to).text}${evidence}.${reason}`,
          );
        case "requires":
          return result(
            "relationship:requires",
            `${capitalize(fromList)} ${plural ? "require" : "requires"} ${to}${evidence}.${reason}`,
          );
        case "motivatedBy":
          return result(
            "relationship:motivatedBy",
            `${capitalize(fromList)} ${plural ? "were" : "was"} chosen in response to ${to}${evidence}.${reason}`,
          );
        case "addresses":
          return result(
            "relationship:addresses",
            `To address ${to}, ${joinList(record.from.map(actionOf), "and")}${evidence}.${reason}`,
          );
        case "specializes":
          return result(
            "relationship:specializes",
            `${capitalize(fromList)} ${plural ? "are special cases" : "is a special case"} of ${to}${evidence}.${reason}`,
          );
        case "generalizes":
          return result(
            "relationship:generalizes",
            `${capitalize(fromList)} ${plural ? "generalize" : "generalizes"} ${to}${evidence}.${reason}`,
          );
        case "tests":
          return result(
            "relationship:tests",
            `${capitalize(fromList)} ${plural ? "investigate" : "investigates"} ${to}${evidence}.${reason}`,
          );
        case "reuses":
          return result(
            "relationship:reuses",
            `${capitalize(fromList)} ${plural ? "reuse" : "reuses"} ${to}${evidence}.${reason}`,
          );
      }
    };

    const explainSufficiency = (subjectId: string): InquiryExplanation | undefined => {
      const requirements = [...context.records.values()]
        .filter(
          (record): record is Extract<InquiryRecordView, { kind: "requirement" }> =>
            record.kind === "requirement" &&
            record.subjectId === subjectId &&
            record.role === "sufficient",
        )
        .sort((left, right) => left.sequence - right.sequence);
      if (requirements.length === 0) return undefined;
      const subject = lookup(subjectId);
      const head = subject?.kind === "attempt" ? "This method" : capitalize(recordNoun(subjectId));
      const claims = requirements.map((requirement) => {
        const claim = thatForm(proposition(requirement.proposition));
        return `${claim}${withSupport(requirement.support)}`;
      });
      return Object.freeze({
        recordId: subjectId,
        template: "sufficiency" as const,
        text: `${head} would suffice if it were established ${joinList(claims, "and")}.`,
      });
    };

    return { explainRecord, explainSufficiency };
  };

  return Object.freeze({
    explain: (record: InquiryRecordView, context: InquiryExplanationContext) =>
      session(context).explainRecord(record),
    explainAll: (records: Iterable<InquiryRecordView>, context: InquiryExplanationContext) => {
      const { explainRecord } = session(context);
      return Object.freeze(
        [...records].sort((left, right) => left.sequence - right.sequence).map(explainRecord),
      );
    },
    explainSufficiency: (subjectId: string, context: InquiryExplanationContext) =>
      session(context).explainSufficiency(subjectId),
  });
}
