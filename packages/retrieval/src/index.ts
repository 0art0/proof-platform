import {
  BUILTIN_BINDER_SPECIFICATIONS,
  RESERVED_BUILTIN_SYMBOLS,
  createProofStateSchema,
  mathJsonEquals,
  operatorDeclarationsSchema,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type RetrievalWildcard,
} from "@proof/mathjson-model";
import {
  createLibraryResultSchema,
  libraryArtifactReferenceSchema,
  variantFamilySchema,
  type ApplicationRequirement,
  type LibraryArtifactReference,
  type LibraryResult,
  type VariantFamily,
} from "@proof/library";
import {
  moveDefinitionSchema,
  type MoveDefinition,
  type MovePattern,
  type MoveSelectionSlot,
} from "@proof/moves";
import {
  resolveProofSelection,
  resolveProofSelectionQuery,
  type ResolvedProofSelection,
  type ResolvedProofSelectionQuery,
  type ResolvedProofSelectionQuerySubject,
} from "@proof/selections";

export interface RankedCandidate {
  readonly id: string;
  readonly rank: readonly number[];
}

export type RetrievalEnvironment = Readonly<{
  operators?: readonly OperatorDeclaration[];
}>;

export type RetrievalCatalog = Readonly<{
  results: readonly LibraryResult[];
  moves: readonly MoveDefinition[];
  variantFamilies: readonly VariantFamily[];
}>;

export type RetrievalDiagnosticCode =
  "invalid-environment" | "invalid-catalog" | "invalid-query" | "selection-rejected";

export type RetrievalDiagnostic = Readonly<{
  code: RetrievalDiagnosticCode;
  message: string;
}>;

export type CreateRetrievalIndexResult =
  | Readonly<{ ok: true; index: RetrievalIndex; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [RetrievalDiagnostic] }>;

export type SuggestionSubstitution = Readonly<{
  symbol: string;
  expression: PlainMathJson;
}>;

export type RetrievalSuggestion = RankedCandidate &
  Readonly<{
    source: "result" | "move";
    artifactId: string;
    patternId: string;
    name: string;
    exactRepresentationMatch: boolean;
    substitutions: readonly SuggestionSubstitution[];
    reasons: readonly string[];
    selectionMatches: readonly RetrievalSelectionMatch[];
    unresolvedSelectionSlots: readonly string[];
    unresolvedParameters: readonly string[];
    applicability: "applicable" | "requires-input";
    abstractionFit: "not-used" | "compatible" | "unknown";
    variantFamilyId?: string | undefined;
  }>;

export type RetrievalSelectionMatch = Readonly<{
  selectionId: string;
  patternId?: string | undefined;
  selectionSlotId?: string | undefined;
}>;

export type ResolvedRetrievalSelection = ResolvedProofSelection | ResolvedProofSelectionQuery;

export type RetrievalVariantGroup = Readonly<{
  familyId: string;
  name: string;
  suggestionIds: readonly string[];
}>;

export type RetrievalQueryResult =
  | Readonly<{
      ok: true;
      selection: ResolvedRetrievalSelection;
      suggestions: readonly RetrievalSuggestion[];
      variantGroups: readonly RetrievalVariantGroup[];
      diagnostics: readonly [];
    }>
  | Readonly<{ ok: false; diagnostics: readonly [RetrievalDiagnostic] }>;

export interface RetrievalIndex {
  readonly resultCount: number;
  readonly moveCount: number;
  readonly patternCount: number;
  query(stateInput: unknown, selectionInput: unknown, optionsInput?: unknown): RetrievalQueryResult;
}

type IndexedPatternBase = Readonly<{
  indexKey: string;
  pattern: PlainMathJson;
  patternId: string;
  wildcardSymbols: ReadonlySet<string>;
  specificity: number;
}>;

type IndexedResultPattern = IndexedPatternBase &
  Readonly<{
    source: "result";
    artifact: LibraryResult;
    requirement: ApplicationRequirement;
  }>;

type IndexedMovePattern = IndexedPatternBase &
  Readonly<{
    source: "move";
    artifact: MoveDefinition;
    slot: MoveSelectionSlot;
  }>;

type IndexedPattern = IndexedResultPattern | IndexedMovePattern;

type QueryOptions = Readonly<{
  availableArtifacts: readonly LibraryArtifactReference[];
  limit: number;
}>;

type RetrievalSubject = Readonly<{
  id: string;
  selection: ResolvedProofSelection;
  abstraction?: RetrievalWildcard | undefined;
  lexicalScopeKey: string;
}>;

type CandidateSubjectMatch = Readonly<{
  candidate: IndexedPattern;
  subject: RetrievalSubject;
}>;

type MoveAssignment = Readonly<{
  slot: MoveSelectionSlot;
  subject: RetrievalSubject;
}>;

type MoveMatchPlan = Readonly<{
  assignments: readonly MoveAssignment[];
  patternMatches: readonly RetrievalSelectionMatch[];
  bindings: ReadonlyMap<string, PlainMathJson>;
  abstractionFit: RetrievalSuggestion["abstractionFit"];
}>;

class DeterministicRetrievalIndex implements RetrievalIndex {
  readonly resultCount: number;
  readonly moveCount: number;
  readonly patternCount: number;
  readonly #operators: readonly OperatorDeclaration[];
  readonly #entriesByKey: ReadonlyMap<string, readonly IndexedPattern[]>;
  readonly #familiesById: ReadonlyMap<string, VariantFamily>;
  readonly #approvedResultIds: ReadonlySet<string>;

  constructor(
    catalog: RetrievalCatalog,
    operators: readonly OperatorDeclaration[],
    entriesByKey: ReadonlyMap<string, readonly IndexedPattern[]>,
  ) {
    this.resultCount = catalog.results.length;
    this.moveCount = catalog.moves.length;
    this.patternCount = [...entriesByKey.values()].reduce(
      (total, candidates) => total + candidates.length,
      0,
    );
    this.#operators = operators;
    this.#entriesByKey = entriesByKey;
    this.#familiesById = new Map(catalog.variantFamilies.map((family) => [family.id, family]));
    this.#approvedResultIds = new Set(
      catalog.results
        .filter((result) => result.approval.status === "approved")
        .map((result) => result.id),
    );
    Object.freeze(this);
  }

  query(
    stateInput: unknown,
    selectionInput: unknown,
    optionsInput: unknown = {},
  ): RetrievalQueryResult {
    try {
      return this.queryInternal(stateInput, selectionInput, optionsInput);
    } catch {
      return retrievalFailure(
        "invalid-query",
        "The retrieval boundary could not inspect its input safely.",
      );
    }
  }

  private queryInternal(
    stateInput: unknown,
    selectionInput: unknown,
    optionsInput: unknown,
  ): RetrievalQueryResult {
    const options = parseQueryOptions(optionsInput);
    if (options === undefined) {
      return retrievalFailure("invalid-query", "The retrieval query options are invalid.");
    }
    const resolved = resolveRetrievalSelection(
      stateInput as ProofState,
      selectionInput,
      this.#operators,
    );
    if (!resolved.ok) {
      return retrievalFailure("selection-rejected", resolved.message);
    }
    const stateResult = createProofStateSchema({ operators: this.#operators }).safeParse(
      stateInput,
    );
    if (!stateResult.success) {
      return retrievalFailure("selection-rejected", "The proof state could not be revalidated.");
    }

    const allCandidates = uniqueCandidates([...this.#entriesByKey.values()].flat());
    const candidateMatches = resolved.subjects.flatMap((subject) =>
      candidateEntriesForSubject(subject, this.#entriesByKey, allCandidates).map((candidate) => ({
        candidate,
        subject,
      })),
    );
    const available = new Set<string>(
      options.availableArtifacts.map((reference) => artifactReferenceKey(reference)),
    );
    this.#approvedResultIds.forEach((id) =>
      available.add(artifactReferenceKey({ kind: "result", id })),
    );

    const suggestions = [
      ...uniqueSuggestions(
        candidateMatches.flatMap((match) =>
          buildSuggestionsForMatch(
            match,
            resolved.subjects,
            stateResult.data,
            available,
            this.#operators,
          ),
        ),
      ),
    ]
      .sort(compareSuggestions)
      .slice(0, options.limit);

    return freezeDetached({
      ok: true as const,
      selection: resolved.selection,
      suggestions,
      variantGroups: buildVariantGroups(suggestions, this.#familiesById),
      diagnostics: [] as const,
    });
  }
}

type ResolvedRetrievalInput =
  | Readonly<{
      ok: true;
      selection: ResolvedRetrievalSelection;
      subjects: readonly RetrievalSubject[];
    }>
  | Readonly<{ ok: false; message: string }>;

function resolveRetrievalSelection(
  state: ProofState,
  input: unknown,
  operators: readonly OperatorDeclaration[],
): ResolvedRetrievalInput {
  if (isStrictRecord(input) && input.kind === "selection-query") {
    const resolved = resolveProofSelectionQuery(state, input, { operators });
    return resolved.ok
      ? {
          ok: true,
          selection: resolved.query,
          subjects: resolved.query.selections.map((subject) =>
            subjectFromResolvedQuery(subject, state, operators),
          ),
        }
      : {
          ok: false,
          message:
            resolved.diagnostics[0]?.message ?? "The proof selection query could not be resolved.",
        };
  }
  const resolved = resolveProofSelection(state, input, { operators });
  return resolved.ok
    ? {
        ok: true,
        selection: resolved.selection,
        subjects: [
          {
            id: "selection:primary",
            selection: resolved.selection,
            lexicalScopeKey: selectionLexicalScopeKey(state, resolved.selection, operators),
          },
        ],
      }
    : {
        ok: false,
        message: resolved.diagnostics[0]?.message ?? "The proof selection could not be resolved.",
      };
}

function subjectFromResolvedQuery(
  subject: ResolvedProofSelectionQuerySubject,
  state: ProofState,
  operators: readonly OperatorDeclaration[],
): RetrievalSubject {
  return {
    id: subject.id,
    selection: subject.selection,
    lexicalScopeKey: selectionLexicalScopeKey(state, subject.selection, operators),
    ...(subject.abstraction === undefined ? {} : { abstraction: subject.abstraction }),
  };
}

function candidateEntriesForSubject(
  subject: RetrievalSubject,
  entriesByKey: ReadonlyMap<string, readonly IndexedPattern[]>,
  allCandidates: readonly IndexedPattern[],
): readonly IndexedPattern[] {
  if (subject.abstraction !== undefined) return allCandidates;
  const key = structuralIndexKey(subject.selection.fragment, new Set());
  return uniqueCandidates([
    ...(entriesByKey.get(key) ?? []),
    ...(key === WILDCARD_INDEX_KEY ? [] : (entriesByKey.get(WILDCARD_INDEX_KEY) ?? [])),
  ]);
}

function buildSuggestionsForMatch(
  match: CandidateSubjectMatch,
  subjects: readonly RetrievalSubject[],
  state: ProofState,
  available: ReadonlySet<string>,
  operators: readonly OperatorDeclaration[],
): readonly RetrievalSuggestion[] {
  const { candidate, subject } = match;
  if (candidate.artifact.approval.status !== "approved") return [];
  if (
    candidate.source === "move" &&
    !candidate.artifact.requiredArtifacts.every((reference) =>
      available.has(artifactReferenceKey(reference)),
    )
  ) {
    return [];
  }

  if (candidate.source === "result") {
    if (subjects.length !== 1 || !requirementMatches(candidate.requirement, subject.selection)) {
      return [];
    }
    const matchResult = matchSubjectPattern(
      candidate.pattern,
      candidate.wildcardSymbols,
      subject,
      candidate.requirement.role,
      new Map(),
    );
    if (matchResult === undefined) return [];
    const applicability =
      candidate.artifact.premises.length === 0 && candidate.artifact.sideConditions.length === 0
        ? "applicable"
        : "requires-input";
    return [
      buildSuggestion(candidate, subject.selection, matchResult.bindings, {
        selectionMatches: [{ selectionId: subject.id, patternId: candidate.patternId }],
        unresolvedSelectionSlots: [],
        unresolvedParameters: [],
        applicability:
          subject.abstraction === undefined ? applicability : ("requires-input" as const),
        abstractionFit: matchResult.abstractionFit,
      }),
    ];
  }

  if (!subjectFitsSlot(candidate.slot, subject)) {
    return [];
  }
  return enumerateMoveAssignments(candidate.artifact, candidate.slot, subject, subjects)
    .flatMap((assignments) =>
      matchMoveAssignmentPatterns(candidate.artifact, assignments, operators),
    )
    .filter(
      (plan) =>
        moveRelationshipsMatch(candidate.artifact, plan.assignments) &&
        moveContextIsAvailableForAssignments(candidate.artifact, plan.assignments, state),
    )
    .flatMap((plan) => {
      const canonicalPatternId = plan.patternMatches
        .flatMap(({ patternId }) => (patternId === undefined ? [] : [patternId]))
        .sort(compareStrings)[0];
      if (canonicalPatternId !== undefined && candidate.patternId !== canonicalPatternId) {
        return [];
      }
      const assignedSlotIds = new Set(plan.assignments.map(({ slot }) => slot.id));
      const unresolvedSelectionSlots = candidate.artifact.selectionContract.slots
        .filter((slot) => slot.required && !assignedSlotIds.has(slot.id))
        .map(({ id }) => id)
        .sort(compareStrings);
      const unresolvedParameters = candidate.artifact.parameters
        .map(({ id }) => id)
        .sort(compareStrings);
      const applicability =
        unresolvedSelectionSlots.length === 0 &&
        unresolvedParameters.length === 0 &&
        plan.abstractionFit === "not-used"
          ? "applicable"
          : "requires-input";
      return [
        buildSuggestion(candidate, subject.selection, plan.bindings, {
          selectionMatches: plan.patternMatches,
          unresolvedSelectionSlots,
          unresolvedParameters,
          applicability,
          abstractionFit: plan.abstractionFit,
        }),
      ];
    });
}

function enumerateMoveAssignments(
  move: MoveDefinition,
  primarySlot: MoveSelectionSlot,
  primarySubject: RetrievalSubject,
  subjects: readonly RetrievalSubject[],
): readonly (readonly MoveAssignment[])[] {
  if (subjects.length > move.selectionContract.slots.length) return [];
  const remainingSubjects = subjects
    .filter(({ id }) => id !== primarySubject.id)
    .sort((left, right) => compareStrings(left.id, right.id));
  const remainingSlots = move.selectionContract.slots
    .filter(({ id }) => id !== primarySlot.id)
    .sort((left, right) => compareStrings(left.id, right.id));
  const results: MoveAssignment[][] = [];
  const assign = (
    subjectIndex: number,
    availableSlots: readonly MoveSelectionSlot[],
    assignments: readonly MoveAssignment[],
  ): void => {
    const nextSubject = remainingSubjects[subjectIndex];
    if (nextSubject === undefined) {
      results.push([...assignments].sort(compareMoveAssignments));
      return;
    }
    availableSlots.forEach((slot, slotIndex) => {
      if (
        !subjectFitsSlot(slot, nextSubject) ||
        !sameTarget(primarySubject.selection, nextSubject.selection)
      ) {
        return;
      }
      assign(
        subjectIndex + 1,
        [...availableSlots.slice(0, slotIndex), ...availableSlots.slice(slotIndex + 1)],
        [...assignments, { slot, subject: nextSubject }],
      );
    });
  };
  assign(0, remainingSlots, [{ slot: primarySlot, subject: primarySubject }]);
  return results;
}

type PatternMatchBranch = Readonly<{
  bindings: ReadonlyMap<string, PlainMathJson>;
  bindingScopes: ReadonlyMap<string, string>;
  matches: readonly RetrievalSelectionMatch[];
  abstractionFit: RetrievalSuggestion["abstractionFit"];
  queryHolePatterns: ReadonlyMap<string, readonly QueryHolePattern[]>;
  queryHoleScopes: ReadonlyMap<string, string>;
}>;

type QueryHolePattern = Readonly<{
  expression: PlainMathJson;
  wildcardSymbols: ReadonlySet<string>;
}>;

function matchMoveAssignmentPatterns(
  move: MoveDefinition,
  assignments: readonly MoveAssignment[],
  operators: readonly OperatorDeclaration[],
): readonly MoveMatchPlan[] {
  let branches: readonly PatternMatchBranch[] = [
    {
      bindings: new Map(),
      bindingScopes: new Map(),
      matches: [],
      abstractionFit: "not-used",
      queryHolePatterns: new Map(),
      queryHoleScopes: new Map(),
    },
  ];
  for (const assignment of [...assignments].sort(compareMoveAssignments)) {
    branches = constrainQueryHoleScopes(branches, assignment.subject);
    const patterns = move.patterns
      .filter(({ selectionSlotId }) => selectionSlotId === assignment.slot.id)
      .sort((left, right) => compareStrings(left.id, right.id));
    if (patterns.length === 0) {
      const slotAbstractionFit =
        assignment.subject.abstraction === undefined
          ? "not-used"
          : abstractionFitForRole(assignment.subject.abstraction, assignment.slot.semanticRole);
      branches =
        slotAbstractionFit === undefined
          ? []
          : branches.map((branch) => ({
              ...branch,
              matches: [
                ...branch.matches,
                { selectionId: assignment.subject.id, selectionSlotId: assignment.slot.id },
              ],
              abstractionFit: combineAbstractionFit(branch.abstractionFit, slotAbstractionFit),
            }));
      continue;
    }
    branches = branches.flatMap((branch) =>
      patterns.flatMap((pattern) => {
        const abstraction = assignment.subject.abstraction;
        const wildcardSymbols = collectMoveWildcardSymbols(pattern, operators);
        const previousHolePatterns =
          abstraction === undefined ? [] : (branch.queryHolePatterns.get(abstraction.id) ?? []);
        const nextHolePattern = { expression: pattern.expression, wildcardSymbols };
        if (
          abstraction !== undefined &&
          !queryHolePatternsUnify([...previousHolePatterns, nextHolePattern])
        ) {
          return [];
        }
        const matched = matchSubjectPattern(
          pattern.expression,
          wildcardSymbols,
          assignment.subject,
          assignment.slot.semanticRole,
          branch.bindings,
        );
        if (matched === undefined) return [];
        const bindingScopes = extendBindingScopes(
          branch,
          matched.bindings,
          wildcardSymbols,
          assignment.subject,
        );
        if (bindingScopes === undefined) return [];
        const queryHolePatterns = new Map(branch.queryHolePatterns);
        if (abstraction !== undefined) {
          queryHolePatterns.set(abstraction.id, [...previousHolePatterns, nextHolePattern]);
        }
        return [
          {
            bindings: matched.bindings,
            bindingScopes,
            matches: [
              ...branch.matches,
              {
                selectionId: assignment.subject.id,
                selectionSlotId: assignment.slot.id,
                patternId: pattern.id,
              },
            ],
            abstractionFit: combineAbstractionFit(branch.abstractionFit, matched.abstractionFit),
            queryHolePatterns,
            queryHoleScopes: branch.queryHoleScopes,
          },
        ];
      }),
    );
  }
  return branches.map((branch) => ({
    assignments,
    patternMatches: [...branch.matches].sort(compareSelectionMatches),
    bindings: branch.bindings,
    abstractionFit: branch.abstractionFit,
  }));
}

function matchSubjectPattern(
  pattern: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  subject: RetrievalSubject,
  requiredRole: "proposition" | "term" | "binder" | "any",
  initialBindings: ReadonlyMap<string, PlainMathJson>,
):
  | Readonly<{
      bindings: ReadonlyMap<string, PlainMathJson>;
      abstractionFit: RetrievalSuggestion["abstractionFit"];
    }>
  | undefined {
  if (subject.abstraction !== undefined) {
    const abstractionFit = abstractionFitForRole(subject.abstraction, requiredRole);
    return abstractionFit === undefined
      ? undefined
      : { bindings: new Map(initialBindings), abstractionFit };
  }
  const bindings = matchPattern(
    pattern,
    subject.selection.fragment,
    wildcardSymbols,
    initialBindings,
  );
  return bindings === undefined ? undefined : { bindings, abstractionFit: "not-used" };
}

function extendBindingScopes(
  branch: PatternMatchBranch,
  bindings: ReadonlyMap<string, PlainMathJson>,
  wildcardSymbols: ReadonlySet<string>,
  subject: RetrievalSubject,
): ReadonlyMap<string, string> | undefined {
  const scopes = new Map(branch.bindingScopes);
  for (const symbol of wildcardSymbols) {
    if (subject.abstraction === undefined && !bindings.has(symbol)) continue;
    const previousScope = scopes.get(symbol);
    if (previousScope !== undefined && previousScope !== subject.lexicalScopeKey) {
      return undefined;
    }
    scopes.set(symbol, subject.lexicalScopeKey);
  }
  return scopes;
}

function constrainQueryHoleScopes(
  branches: readonly PatternMatchBranch[],
  subject: RetrievalSubject,
): readonly PatternMatchBranch[] {
  const abstraction = subject.abstraction;
  if (abstraction === undefined) return branches;
  return branches.flatMap((branch) => {
    const previousScope = branch.queryHoleScopes.get(abstraction.id);
    if (previousScope !== undefined && previousScope !== subject.lexicalScopeKey) return [];
    const queryHoleScopes = new Map(branch.queryHoleScopes);
    queryHoleScopes.set(abstraction.id, subject.lexicalScopeKey);
    return [{ ...branch, queryHoleScopes }];
  });
}

function queryHolePatternsUnify(patterns: readonly QueryHolePattern[]): boolean {
  const first = patterns[0];
  if (first === undefined) return true;
  const wildcardSymbols = new Set(patterns.flatMap(({ wildcardSymbols }) => [...wildcardSymbols]));
  const bindings = new Map<string, PlainMathJson>();
  return patterns
    .slice(1)
    .every(({ expression }) =>
      unifyPatternExpressions(first.expression, expression, wildcardSymbols, bindings),
    );
}

function unifyPatternExpressions(
  leftInput: PlainMathJson,
  rightInput: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  bindings: Map<string, PlainMathJson>,
): boolean {
  const left = dereferencePatternVariable(leftInput, wildcardSymbols, bindings);
  const right = dereferencePatternVariable(rightInput, wildcardSymbols, bindings);
  const leftSymbol = symbolValue(left);
  const rightSymbol = symbolValue(right);
  if (leftSymbol !== undefined && wildcardSymbols.has(leftSymbol)) {
    return bindPatternVariable(leftSymbol, right, wildcardSymbols, bindings);
  }
  if (rightSymbol !== undefined && wildcardSymbols.has(rightSymbol)) {
    return bindPatternVariable(rightSymbol, left, wildcardSymbols, bindings);
  }
  const leftParts = functionParts(left);
  const rightParts = functionParts(right);
  if (leftParts !== undefined || rightParts !== undefined) {
    if (leftParts === undefined || rightParts === undefined) return false;
    if (leftParts.operands.length !== rightParts.operands.length) return false;
    if (
      !unifyPatternExpressions(leftParts.operator, rightParts.operator, wildcardSymbols, bindings)
    ) {
      return false;
    }
    return leftParts.operands.every((operand, index) => {
      const rightOperand = rightParts.operands[index];
      return (
        rightOperand !== undefined &&
        unifyPatternExpressions(operand, rightOperand, wildcardSymbols, bindings)
      );
    });
  }
  return mathJsonEquals(left, right);
}

function bindPatternVariable(
  symbol: string,
  expression: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  bindings: Map<string, PlainMathJson>,
): boolean {
  const expressionSymbol = symbolValue(expression);
  if (expressionSymbol === symbol) return true;
  if (patternVariableOccurs(symbol, expression, wildcardSymbols, bindings)) return false;
  bindings.set(symbol, expression);
  return true;
}

function dereferencePatternVariable(
  expression: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  bindings: ReadonlyMap<string, PlainMathJson>,
): PlainMathJson {
  let current = expression;
  const seen = new Set<string>();
  while (true) {
    const symbol = symbolValue(current);
    if (symbol === undefined || !wildcardSymbols.has(symbol) || seen.has(symbol)) return current;
    const bound = bindings.get(symbol);
    if (bound === undefined) return current;
    seen.add(symbol);
    current = bound;
  }
}

function patternVariableOccurs(
  symbol: string,
  expressionInput: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  bindings: ReadonlyMap<string, PlainMathJson>,
): boolean {
  const expression = dereferencePatternVariable(expressionInput, wildcardSymbols, bindings);
  const expressionSymbol = symbolValue(expression);
  if (expressionSymbol !== undefined) return expressionSymbol === symbol;
  const parts = functionParts(expression);
  return (
    parts !== undefined &&
    (parts.operator === symbol ||
      parts.operands.some((operand) =>
        patternVariableOccurs(symbol, operand, wildcardSymbols, bindings),
      ))
  );
}

function abstractionFitForRole(
  wildcard: RetrievalWildcard,
  role: "proposition" | "term" | "binder" | "any",
): RetrievalSuggestion["abstractionFit"] | undefined {
  if (role === "binder") return undefined;
  if (wildcard.sort === undefined || role === "any") return "unknown";
  if (wildcard.sort.kind === "proposition") {
    return role === "proposition" ? "compatible" : undefined;
  }
  return role === "term" ? "unknown" : undefined;
}

function combineAbstractionFit(
  left: RetrievalSuggestion["abstractionFit"],
  right: RetrievalSuggestion["abstractionFit"],
): RetrievalSuggestion["abstractionFit"] {
  if (left === "unknown" || right === "unknown") return "unknown";
  if (left === "compatible" || right === "compatible") return "compatible";
  return "not-used";
}

function moveRelationshipsMatch(
  move: MoveDefinition,
  assignments: readonly MoveAssignment[],
): boolean {
  const bySlot = new Map(assignments.map(({ slot, subject }) => [slot.id, subject]));
  const target = bySlot.get("target");
  if (move.implementation.operationKind === "close-by-hypothesis") {
    const fact = bySlot.get("fact");
    return target === undefined || fact === undefined || subjectsCanRepresentEqual(target, fact);
  }
  if (move.implementation.operationKind === "close-false-hypothesis") {
    const falseSelection = bySlot.get("false");
    return (
      falseSelection === undefined ||
      falseSelection.abstraction !== undefined ||
      mathJsonEquals(falseSelection.selection.fragment, "False")
    );
  }
  if (move.implementation.operationKind === "apply-implication-hypothesis") {
    const implication = bySlot.get("implication");
    const antecedent = bySlot.get("antecedent");
    if (implication?.abstraction !== undefined) return true;
    const operands =
      implication === undefined
        ? undefined
        : functionParts(implication.selection.fragment)?.operands;
    return (
      implication === undefined ||
      antecedent === undefined ||
      (functionParts(implication.selection.fragment)?.operator === "Implies" &&
        operands?.[0] !== undefined &&
        (antecedent.abstraction !== undefined ||
          mathJsonEquals(operands[0], antecedent.selection.fragment)))
    );
  }
  return true;
}

function subjectsCanRepresentEqual(left: RetrievalSubject, right: RetrievalSubject): boolean {
  return (
    left.abstraction !== undefined ||
    right.abstraction !== undefined ||
    mathJsonEquals(left.selection.fragment, right.selection.fragment)
  );
}

function sameTarget(left: ResolvedProofSelection, right: ResolvedProofSelection): boolean {
  return (
    left.anchor.target.kind === right.anchor.target.kind &&
    left.anchor.target.id === right.anchor.target.id
  );
}

function subjectFitsSlot(slot: MoveSelectionSlot, subject: RetrievalSubject): boolean {
  return (
    slotMatches(slot, subject.selection) &&
    (subject.abstraction === undefined ||
      abstractionFitForRole(subject.abstraction, slot.semanticRole) !== undefined)
  );
}

function selectionLexicalScopeKey(
  state: ProofState,
  selection: ResolvedProofSelection,
  operators: readonly OperatorDeclaration[],
): string {
  const collection = selection.anchor.target.kind === "goal" ? state.goals : state.obligations;
  const target = collection.find(({ id }) => id === selection.anchor.target.id);
  const statement = selection.anchor.statement;
  const root =
    statement.kind === "conclusion"
      ? target?.sequent.conclusion.expression
      : target?.sequent.context.hypotheses.find(({ id }) => id === statement.id)?.statement
          .expression;
  const path = selection.kind === "exact" ? selection.path : selection.containerPath;
  const binderPaths: string[] = [];
  let expression = root;
  const traversed: number[] = [];
  for (const operandIndex of path) {
    if (expression === undefined) break;
    const parts = functionParts(expression);
    if (parts === undefined) break;
    const customBinder = operators.find(({ symbol }) => symbol === parts.operator)?.binder;
    const builtinBinder =
      parts.operator === "ForAll" || parts.operator === "Exists"
        ? BUILTIN_BINDER_SPECIFICATIONS[parts.operator]
        : undefined;
    const binder = customBinder ?? builtinBinder;
    if (binder?.scopedOperands.includes(operandIndex) === true) {
      binderPaths.push(`${traversed.join(".")}:${parts.operator}`);
    }
    expression = parts.operands[operandIndex];
    traversed.push(operandIndex);
  }
  const targetKey = `${selection.anchor.target.kind}:${selection.anchor.target.id}`;
  if (binderPaths.length === 0) return `${targetKey}:free`;
  const statementKey =
    statement.kind === "conclusion" ? "conclusion" : `hypothesis:${statement.id}`;
  return `${targetKey}:${statementKey}:${binderPaths.join("/")}`;
}

function compareMoveAssignments(left: MoveAssignment, right: MoveAssignment): number {
  return (
    compareStrings(left.slot.id, right.slot.id) || compareStrings(left.subject.id, right.subject.id)
  );
}

function compareSelectionMatches(
  left: RetrievalSelectionMatch,
  right: RetrievalSelectionMatch,
): number {
  return (
    compareStrings(left.selectionSlotId ?? "", right.selectionSlotId ?? "") ||
    compareStrings(left.selectionId, right.selectionId) ||
    compareStrings(left.patternId ?? "", right.patternId ?? "")
  );
}

/** Build an immutable structural index over each result variant and move pattern. */
export function createRetrievalIndex(
  catalogInput: unknown,
  environment: RetrievalEnvironment = {},
): CreateRetrievalIndexResult {
  try {
    const operatorsInput = environment.operators ?? [];
    if (!isJsonData(operatorsInput)) {
      return retrievalFailure("invalid-environment", "The operator environment is not plain data.");
    }
    const operators = operatorDeclarationsSchema.parse(structuredClone(operatorsInput));
    const parsedCatalog = parseCatalog(catalogInput, operators);
    if (parsedCatalog === undefined) {
      return retrievalFailure(
        "invalid-catalog",
        "The retrieval catalog or its variant links are invalid.",
      );
    }
    const frozenCatalog = freezeDetached(parsedCatalog);
    const frozenOperators = freezeDetached(operators);
    if (frozenCatalog === undefined || frozenOperators === undefined) {
      return retrievalFailure("invalid-catalog", "The retrieval catalog could not be detached.");
    }
    return {
      ok: true,
      index: new DeterministicRetrievalIndex(
        frozenCatalog,
        frozenOperators,
        buildStructuralIndex(frozenCatalog, frozenOperators),
      ),
      diagnostics: [],
    };
  } catch {
    return retrievalFailure(
      "invalid-environment",
      "The retrieval index boundary could not inspect its input safely.",
    );
  }
}

function parseCatalog(
  input: unknown,
  operators: readonly OperatorDeclaration[],
): RetrievalCatalog | undefined {
  if (!isStrictRecord(input) || !hasExactKeys(input, ["results", "moves", "variantFamilies"])) {
    return undefined;
  }
  const resultInputs = copyDenseArray(input.results);
  const moveInputs = copyDenseArray(input.moves);
  const familyInputs = copyDenseArray(input.variantFamilies);
  if (resultInputs === undefined || moveInputs === undefined || familyInputs === undefined) {
    return undefined;
  }
  const resultSchema = createLibraryResultSchema({ operators });
  const results = resultInputs.map((value) => safeParse(resultSchema, value));
  const moves = moveInputs.map((value) => safeParse(moveDefinitionSchema, value));
  const families = familyInputs.map((value) => safeParse(variantFamilySchema, value));
  if (
    results.some((value) => value === undefined) ||
    moves.some((value) => value === undefined) ||
    families.some((value) => value === undefined)
  ) {
    return undefined;
  }
  const catalog: RetrievalCatalog = {
    results: results as LibraryResult[],
    moves: moves as MoveDefinition[],
    variantFamilies: families as VariantFamily[],
  };
  return catalogLinksAreValid(catalog) ? catalog : undefined;
}

function catalogLinksAreValid(catalog: RetrievalCatalog): boolean {
  if (
    hasDuplicate(catalog.results.map((result) => result.id)) ||
    hasDuplicate(catalog.moves.map((move) => move.id)) ||
    hasDuplicate(catalog.variantFamilies.map((family) => family.id))
  ) {
    return false;
  }
  const resultsById = new Map(catalog.results.map((result) => [result.id, result]));
  const familiesById = new Map(catalog.variantFamilies.map((family) => [family.id, family]));
  for (const family of catalog.variantFamilies) {
    for (const memberId of family.memberIds) {
      const member = resultsById.get(memberId);
      if (member?.variantFamilyId !== family.id) return false;
    }
  }
  return catalog.results.every((result) => {
    if (result.variantFamilyId === undefined) return true;
    return familiesById.get(result.variantFamilyId)?.memberIds.includes(result.id) === true;
  });
}

function buildStructuralIndex(
  catalog: RetrievalCatalog,
  operators: readonly OperatorDeclaration[],
): ReadonlyMap<string, readonly IndexedPattern[]> {
  const mutable = new Map<string, IndexedPattern[]>();
  const append = (entry: IndexedPattern): void => {
    const bucket = mutable.get(entry.indexKey) ?? [];
    bucket.push(entry);
    mutable.set(entry.indexKey, bucket);
  };

  catalog.results.forEach((result) => {
    const wildcardSymbols = new Set(result.parameters.map((parameter) => parameter.symbol));
    result.patterns.forEach((pattern) => {
      append({
        source: "result",
        artifact: result,
        pattern: pattern.expression,
        patternId: pattern.id,
        requirement: pattern.requirement,
        wildcardSymbols,
        specificity: patternSpecificity(pattern.expression, wildcardSymbols),
        indexKey: structuralIndexKey(pattern.expression, wildcardSymbols),
      });
    });
  });
  catalog.moves.forEach((move) => {
    move.patterns.forEach((pattern) => {
      const slot = move.selectionContract.slots.find(
        (candidate) => candidate.id === pattern.selectionSlotId,
      );
      if (slot === undefined) return;
      const wildcardSymbols = collectMoveWildcardSymbols(pattern, operators);
      append({
        source: "move",
        artifact: move,
        pattern: pattern.expression,
        patternId: pattern.id,
        slot,
        wildcardSymbols,
        specificity: patternSpecificity(pattern.expression, wildcardSymbols),
        indexKey: structuralIndexKey(pattern.expression, wildcardSymbols),
      });
    });
  });
  return new Map(
    [...mutable].map(([key, entries]) => [
      key,
      Object.freeze([...entries].sort(compareIndexedPatterns)),
    ]),
  );
}

function collectMoveWildcardSymbols(
  pattern: MovePattern,
  operators: readonly OperatorDeclaration[],
): ReadonlySet<string> {
  const result = new Set<string>();
  const fixedOperators = new Set(operators.map((operator) => operator.symbol));
  walkExpression(pattern.expression, (symbol, functionHead) => {
    if (
      !RESERVED_BUILTIN_SYMBOLS.has(symbol) &&
      !fixedOperators.has(symbol) &&
      (!functionHead || !fixedOperators.has(symbol))
    ) {
      result.add(symbol);
    }
  });
  return result;
}

function moveContextIsAvailableForAssignments(
  move: MoveDefinition,
  assignments: readonly MoveAssignment[],
  state: ProofState,
): boolean {
  const operationKind = move.implementation.operationKind;
  if (operationKind !== "close-by-hypothesis" && operationKind !== "apply-implication-hypothesis") {
    return true;
  }
  const referenceSelection = assignments[0]?.subject.selection;
  if (referenceSelection === undefined) return false;
  const collection =
    referenceSelection.anchor.target.kind === "goal" ? state.goals : state.obligations;
  const target = collection.find((entry) => entry.id === referenceSelection.anchor.target.id);
  if (target === undefined) return false;
  const bySlot = new Map(assignments.map(({ slot, subject }) => [slot.id, subject]));
  if (operationKind === "close-by-hypothesis") {
    const targetSubject = bySlot.get("target");
    const fact = bySlot.get("fact");
    if (fact !== undefined && targetSubject !== undefined) {
      return subjectsCanRepresentEqual(fact, targetSubject);
    }
    const targetExpression =
      targetSubject?.selection.fragment ?? target.sequent.conclusion.expression;
    if (fact !== undefined) {
      return (
        fact.abstraction !== undefined || mathJsonEquals(fact.selection.fragment, targetExpression)
      );
    }
    if (targetSubject?.abstraction !== undefined) {
      return target.sequent.context.hypotheses.length > 0;
    }
    return target.sequent.context.hypotheses.some((hypothesis) =>
      mathJsonEquals(hypothesis.statement.expression, targetExpression),
    );
  }
  const implication = bySlot.get("implication");
  if (implication === undefined) return true;
  const selectedAntecedent = bySlot.get("antecedent");
  if (implication.abstraction !== undefined) {
    return (
      selectedAntecedent !== undefined ||
      target.sequent.context.hypotheses.some(
        (hypothesis) =>
          implication.selection.anchor.statement.kind !== "hypothesis" ||
          implication.selection.anchor.statement.id !== hypothesis.id,
      )
    );
  }
  const operands = functionParts(implication.selection.fragment)?.operands;
  const antecedent = operands?.[0];
  return (
    functionParts(implication.selection.fragment)?.operator === "Implies" &&
    antecedent !== undefined &&
    (selectedAntecedent === undefined
      ? target.sequent.context.hypotheses.some((hypothesis) =>
          mathJsonEquals(hypothesis.statement.expression, antecedent),
        )
      : selectedAntecedent.abstraction !== undefined ||
        mathJsonEquals(selectedAntecedent.selection.fragment, antecedent))
  );
}

function requirementMatches(
  requirement: ApplicationRequirement,
  selection: ResolvedProofSelection,
): boolean {
  const section = selectionSection(selection);
  return (
    (requirement.section === "any" || requirement.section === section) &&
    (requirement.polarity === "any" || requirement.polarity === selection.position.polarity) &&
    (requirement.role === "any" || requirement.role === selection.position.role)
  );
}

function slotMatches(slot: MoveSelectionSlot, selection: ResolvedProofSelection): boolean {
  const statementKind = selection.anchor.statement.kind;
  const requiresWholeStatement = slot.role !== "rewrite-occurrence" && slot.role !== "witness";
  const isWholeStatement = selection.kind === "exact" && selection.path.length === 0;
  const targetRoleMatches =
    slot.role === "target-conclusion"
      ? statementKind === "conclusion"
      : slot.role === "hypothesis" || slot.role === "antecedent-fact" || slot.role === "equality"
        ? statementKind === "hypothesis"
        : true;
  return (
    (!requiresWholeStatement || isWholeStatement) &&
    targetRoleMatches &&
    (slot.semanticRole === "any" || slot.semanticRole === selection.position.role)
  );
}

function selectionSection(selection: ResolvedProofSelection): ApplicationRequirement["section"] {
  if (selection.anchor.statement.kind === "hypothesis") return "hypothesis";
  return selection.anchor.target.kind;
}

function buildSuggestion(
  candidate: IndexedPattern,
  selection: ResolvedProofSelection,
  bindings: ReadonlyMap<string, PlainMathJson>,
  evidence: Pick<
    RetrievalSuggestion,
    | "selectionMatches"
    | "unresolvedSelectionSlots"
    | "unresolvedParameters"
    | "applicability"
    | "abstractionFit"
  >,
): RetrievalSuggestion {
  const exactRepresentationMatch =
    evidence.abstractionFit === "not-used" && mathJsonEquals(candidate.pattern, selection.fragment);
  const noNewObligations =
    candidate.source === "move" ||
    (candidate.artifact.premises.length === 0 && candidate.artifact.sideConditions.length === 0);
  const guaranteed =
    candidate.source === "result" &&
    exactRepresentationMatch &&
    noNewObligations &&
    evidence.applicability === "applicable";
  const directProgress =
    selection.anchor.statement.kind === "conclusion" && selection.anchor.target.kind === "goal";
  const locality =
    candidate.source === "result"
      ? 10
      : Math.max(0, 10 - candidate.artifact.selectionContract.slots.length);
  const priority = candidate.source === "result" ? candidate.artifact.priority : 50;
  const selectionMatches = [...evidence.selectionMatches].sort(compareSelectionMatches);
  const id = stableSuggestionId(candidate, selectionMatches);
  const reasons = [
    exactRepresentationMatch
      ? "The stored MathJSON pattern matches exactly."
      : evidence.abstractionFit === "not-used"
        ? "The MathJSON structure matches with deterministic substitutions."
        : "The retrieval-only abstraction is compatible with this catalog pattern.",
    `The selection contract fits ${selectionSection(selection)} in ${selection.position.polarity} polarity.`,
    noNewObligations
      ? "The catalog entry declares no additional premise obligations."
      : "Applying this result may require premises or side conditions.",
  ];
  if (selectionMatches.length > 1) {
    reasons.push("Every selected occurrence is assigned to a distinct compatible selection slot.");
  }
  if (evidence.unresolvedSelectionSlots.length > 0) {
    reasons.push(
      `Required selection slots still need input: ${evidence.unresolvedSelectionSlots.join(", ")}.`,
    );
  }
  if (evidence.unresolvedParameters.length > 0) {
    reasons.push(`Move parameters still need input: ${evidence.unresolvedParameters.join(", ")}.`);
  }
  return {
    id,
    source: candidate.source,
    artifactId: candidate.artifact.id,
    patternId: candidate.patternId,
    name: candidate.artifact.name,
    exactRepresentationMatch,
    substitutions: [...bindings]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([symbol, expression]) => ({ symbol, expression })),
    rank: [
      guaranteed ? 1 : 0,
      noNewObligations ? 1 : 0,
      evidence.applicability === "applicable" ? 1 : 0,
      candidate.specificity,
      directProgress ? 1 : 0,
      locality,
      priority,
      exactRepresentationMatch ? 1 : 0,
    ],
    reasons,
    selectionMatches,
    unresolvedSelectionSlots: evidence.unresolvedSelectionSlots,
    unresolvedParameters: evidence.unresolvedParameters,
    applicability: evidence.applicability,
    abstractionFit: evidence.abstractionFit,
    ...(candidate.source === "result" && candidate.artifact.variantFamilyId !== undefined
      ? { variantFamilyId: candidate.artifact.variantFamilyId }
      : {}),
  };
}

function stableSuggestionId(
  candidate: IndexedPattern,
  selectionMatches: readonly RetrievalSelectionMatch[],
): string {
  const parts = [
    "suggestion",
    candidate.source,
    candidate.artifact.id,
    candidate.patternId,
    ...selectionMatches.flatMap((match) => [
      match.selectionId,
      match.selectionSlotId ?? "none",
      match.patternId ?? "none",
    ]),
  ];
  return parts.map((part) => `${part.length}:${part}`).join(":");
}

function compareSuggestions(left: RetrievalSuggestion, right: RetrievalSuggestion): number {
  const length = Math.max(left.rank.length, right.rank.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right.rank[index] ?? 0) - (left.rank[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return compareStrings(left.id, right.id);
}

function compareIndexedPatterns(left: IndexedPattern, right: IndexedPattern): number {
  return (
    compareStrings(left.source, right.source) ||
    compareStrings(left.artifact.id, right.artifact.id) ||
    compareStrings(left.patternId, right.patternId)
  );
}

function buildVariantGroups(
  suggestions: readonly RetrievalSuggestion[],
  familiesById: ReadonlyMap<string, VariantFamily>,
): readonly RetrievalVariantGroup[] {
  const grouped = new Map<string, string[]>();
  suggestions.forEach((suggestion) => {
    if (suggestion.variantFamilyId === undefined) return;
    const ids = grouped.get(suggestion.variantFamilyId) ?? [];
    ids.push(suggestion.id);
    grouped.set(suggestion.variantFamilyId, ids);
  });
  return [...grouped]
    .filter(([, ids]) => ids.length >= 2)
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([familyId, suggestionIds]) => ({
      familyId,
      name: familiesById.get(familyId)?.name ?? familyId,
      suggestionIds,
    }));
}

function matchPattern(
  pattern: PlainMathJson,
  candidate: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  initialBindings: ReadonlyMap<string, PlainMathJson> = new Map(),
): ReadonlyMap<string, PlainMathJson> | undefined {
  const bindings = new Map(initialBindings);
  return matchExpression(pattern, candidate, wildcardSymbols, bindings) ? bindings : undefined;
}

function matchExpression(
  pattern: PlainMathJson,
  candidate: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
  bindings: Map<string, PlainMathJson>,
): boolean {
  const patternSymbol = symbolValue(pattern);
  if (patternSymbol !== undefined && wildcardSymbols.has(patternSymbol)) {
    return bindWildcard(patternSymbol, candidate, bindings);
  }
  const patternParts = functionParts(pattern);
  const candidateParts = functionParts(candidate);
  if (patternParts !== undefined || candidateParts !== undefined) {
    if (patternParts === undefined || candidateParts === undefined) return false;
    if (wildcardSymbols.has(patternParts.operator)) {
      if (!bindWildcard(patternParts.operator, candidateParts.operator, bindings)) return false;
    } else if (patternParts.operator !== candidateParts.operator) {
      return false;
    }
    return (
      patternParts.operands.length === candidateParts.operands.length &&
      patternParts.operands.every((operand, index) => {
        const candidateOperand = candidateParts.operands[index];
        return (
          candidateOperand !== undefined &&
          matchExpression(operand, candidateOperand, wildcardSymbols, bindings)
        );
      })
    );
  }
  const candidateSymbol = symbolValue(candidate);
  if (patternSymbol !== undefined || candidateSymbol !== undefined) {
    return patternSymbol !== undefined && patternSymbol === candidateSymbol;
  }
  return mathJsonEquals(pattern, candidate);
}

function bindWildcard(
  symbol: string,
  value: PlainMathJson,
  bindings: Map<string, PlainMathJson>,
): boolean {
  const previous = bindings.get(symbol);
  if (previous !== undefined) return mathJsonEquals(previous, value);
  bindings.set(symbol, value);
  return true;
}

const WILDCARD_INDEX_KEY = "*";

function structuralIndexKey(
  expression: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
): string {
  const symbol = symbolValue(expression);
  if (symbol !== undefined)
    return wildcardSymbols.has(symbol) ? WILDCARD_INDEX_KEY : `sym:${symbol}`;
  const parts = functionParts(expression);
  if (parts !== undefined) {
    return wildcardSymbols.has(parts.operator)
      ? WILDCARD_INDEX_KEY
      : `fn:${parts.operator}:${parts.operands.length}`;
  }
  return `literal:${JSON.stringify(expression)}`;
}

function patternSpecificity(
  expression: PlainMathJson,
  wildcardSymbols: ReadonlySet<string>,
): number {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) return wildcardSymbols.has(symbol) ? 0 : 2;
  const parts = functionParts(expression);
  if (parts === undefined) return 2;
  return (
    (wildcardSymbols.has(parts.operator) ? 0 : 3) +
    parts.operands.reduce<number>(
      (total, operand) => total + patternSpecificity(operand, wildcardSymbols),
      0,
    )
  );
}

type FunctionParts = Readonly<{
  operator: string;
  operands: readonly PlainMathJson[];
}>;

function functionParts(expression: PlainMathJson): FunctionParts | undefined {
  if (Array.isArray(expression)) {
    const operator = expression[0];
    return typeof operator === "string"
      ? { operator, operands: expression.slice(1) as readonly PlainMathJson[] }
      : undefined;
  }
  if (typeof expression !== "object" || expression === null || !("fn" in expression)) {
    return undefined;
  }
  const operator = expression.fn[0];
  return typeof operator === "string" ? { operator, operands: expression.fn.slice(1) } : undefined;
}

function symbolValue(expression: PlainMathJson): string | undefined {
  if (typeof expression === "string") return expression;
  return typeof expression === "object" &&
    expression !== null &&
    !Array.isArray(expression) &&
    "sym" in expression
    ? expression.sym
    : undefined;
}

function walkExpression(
  expression: PlainMathJson,
  visit: (symbol: string, functionHead: boolean) => void,
): void {
  const symbol = symbolValue(expression);
  if (symbol !== undefined) {
    visit(symbol, false);
    return;
  }
  const parts = functionParts(expression);
  if (parts === undefined) return;
  visit(parts.operator, true);
  parts.operands.forEach((operand) => walkExpression(operand, visit));
}

function parseQueryOptions(value: unknown): QueryOptions | undefined {
  if (!isStrictRecord(value)) return undefined;
  const allowedKeys = ["availableArtifacts", "limit"];
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.includes(key))) {
    return undefined;
  }
  const availableInputs =
    value.availableArtifacts === undefined ? [] : copyDenseArray(value.availableArtifacts);
  if (availableInputs === undefined) return undefined;
  const availableArtifacts = availableInputs.map((input) => {
    if (!isJsonData(input)) return undefined;
    const parsed = libraryArtifactReferenceSchema.safeParse(input);
    return parsed.success ? parsed.data : undefined;
  });
  if (availableArtifacts.some((reference) => reference === undefined)) return undefined;
  const limit = value.limit ?? 8;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return undefined;
  }
  return {
    availableArtifacts: availableArtifacts as LibraryArtifactReference[],
    limit,
  };
}

function artifactReferenceKey(reference: Readonly<{ kind: string; id: string }>): string {
  return `${reference.kind}\u0000${reference.id}`;
}

function uniqueCandidates(candidates: readonly IndexedPattern[]): readonly IndexedPattern[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}\u0000${candidate.artifact.id}\u0000${candidate.patternId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSuggestions(
  suggestions: readonly RetrievalSuggestion[],
): readonly RetrievalSuggestion[] {
  const seen = new Set<string>();
  return suggestions.filter(({ id }) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function copyDenseArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== "length" &&
        (typeof key !== "string" ||
          !Number.isInteger(Number(key)) ||
          Number(key) < 0 ||
          Number(key) >= value.length),
    )
  ) {
    return undefined;
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      return undefined;
    }
    result.push(descriptor.value);
  }
  return result;
}

function isStrictRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && "value" in descriptor,
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = (keys as string[]).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isJsonData(value: unknown, ancestors: ReadonlySet<object> = new Set()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    if (keys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonData(descriptor.value, nextAncestors)
      )
        return false;
    }
    return keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" &&
          Number.isInteger(Number(key)) &&
          Number(key) >= 0 &&
          Number(key) < value.length),
    );
  }
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isJsonData(descriptor.value, nextAncestors)
    );
  });
}

function safeParse<Output>(
  schema: Readonly<{ safeParse(value: unknown): { success: boolean; data?: Output } }>,
  value: unknown,
): Output | undefined {
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function retrievalFailure(
  code: RetrievalDiagnosticCode,
  message: string,
): Readonly<{ ok: false; diagnostics: readonly [RetrievalDiagnostic] }> {
  return { ok: false, diagnostics: [{ code, message }] };
}

function freezeDetached<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value) as Value);
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
