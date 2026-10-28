/**
 * Handlers of the quantifier operations: introducing a universal parameter, instantiating a
 * universal hypothesis, choosing an existential witness and unpacking an existential hypothesis.
 * A typed binder `∀x∈S` or `∃x∈S` additionally declares or discharges its membership `x ∈ S`.
 */
import {
  builtinBinderSorts,
  freeSymbolNames,
  freshSymbolName,
  substituteMathJson,
  type ContextualSequent,
  type Declaration,
  type DeclarationId,
  type Hypothesis,
  type Obligation,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProofState,
  type Sort,
  type StatementId,
} from "@proof/mathjson-model";
import { alphaEquivalentWithOperators } from "../alpha-equivalence";
import { readQuantifier, type ReadQuantifier } from "../expression";
import {
  appendHypothesis,
  findDeclaration,
  findHypothesis,
  findHypothesisIndex,
  hypothesis,
  hypothesisIdCollision,
  idCollision,
  internalFailure,
  missingHypothesis,
  notApplicable,
  replaceHypothesis,
  replaceTarget,
  replaceWithObligations,
  replacementFailed,
  success,
  targetIdCollision,
  withConclusion,
  type InternalResult,
  type LocatedTarget,
  type OperationOfKind,
  type TargetEntry,
} from "./shared";

export function introduceUniversal(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"introduce-universal">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const quantifier = readQuantifier(target.entry.sequent.conclusion.expression, "ForAll");
  if (quantifier === undefined) {
    return notApplicable(state, "The target conclusion is not a universal statement.");
  }
  if (quantifier.domain !== undefined) {
    return introduceTypedUniversal(state, target, operation, quantifier, operators);
  }
  const declaration = findDeclaration(target.entry.sequent, quantifier.symbol);
  if (declaration?.role !== "universal-parameter") {
    return notApplicable(
      state,
      "The bound symbol requires a universal-parameter declaration in the local context.",
    );
  }
  if (contextDependsOnSymbol(target.entry.sequent, quantifier.symbol, operators, true)) {
    return notApplicable(
      state,
      "The universal parameter occurs freely in a local hypothesis or construction.",
    );
  }
  return success(
    replaceTarget(state, operation.target, target.index, [
      withConclusion(target.entry, quantifier.body),
    ]),
    "equivalence",
  );
}

/**
 * Open a typed `∀x∈S` goal. The binder is self-contained, so x is not declared beforehand: the
 * context gains a fresh universal parameter (named x, or x with a numeric suffix when x is taken)
 * and the hypothesis `x ∈ S`, and the goal becomes the body at that parameter.
 */
function introduceTypedUniversal(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"introduce-universal">,
  quantifier: ReadQuantifier,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const { parameterDeclarationId, membershipHypothesisId } = operation;
  if (parameterDeclarationId === undefined || membershipHypothesisId === undefined) {
    return internalFailure(
      state,
      "arity-mismatch",
      "Introducing a typed universal needs a parameter declaration ID and a membership hypothesis ID.",
    );
  }
  const fresh = freshBinderParameter(target.entry.sequent, quantifier, "ForAll", operators);
  if (fresh === undefined) {
    return notApplicable(state, "The typed binder's domain is not a well-sorted set.");
  }
  const idFailure = parameterIdFailure(
    state,
    target.entry.sequent,
    parameterDeclarationId,
    membershipHypothesisId,
    [],
  );
  if (idFailure !== undefined) return idFailure;
  const body = renameBoundSymbol(quantifier.body, quantifier.symbol, fresh.symbol, operators);
  if (body === undefined) return replacementFailed(state);
  const replacement = withParameter(
    withConclusion(target.entry, body),
    {
      id: parameterDeclarationId,
      symbol: fresh.symbol,
      sort: fresh.sort,
      role: "universal-parameter",
    },
    [
      hypothesis(membershipHypothesisId, [
        "Element",
        fresh.symbol,
        quantifier.domain as PlainMathJson,
      ]),
    ],
  );
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

export function instantiateUniversalHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"instantiate-universal-hypothesis">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const selected = findHypothesis(target.entry.sequent, operation.hypothesisId);
  if (selected === undefined) return missingHypothesis(state);
  const quantifier = readQuantifier(selected.statement.expression, "ForAll");
  if (quantifier === undefined) {
    return notApplicable(state, "The selected hypothesis is not universal.");
  }
  const collision = hypothesisIdCollision(target.entry.sequent, [operation.resultHypothesisId]);
  if (collision !== undefined) return idCollision(state, collision);
  const instantiated = substituteBoundSymbol(
    quantifier.body,
    quantifier.symbol,
    operation.term,
    operators,
  );
  if (instantiated === undefined) return replacementFailed(state);
  const derived = appendHypothesis(
    target.entry,
    hypothesis(operation.resultHypothesisId, instantiated),
  );
  if (quantifier.domain === undefined) {
    return success(replaceTarget(state, operation.target, target.index, [derived]), "equivalence");
  }
  return instantiateTypedMembership(
    state,
    target,
    operation,
    quantifier.domain,
    derived,
    operators,
  );
}

/**
 * The membership `t ∈ S` a typed binder `∀x∈S` needs for the instantiation at `t`: a matching
 * hypothesis discharges it, otherwise it becomes an obligation and the transition is a
 * strengthening.
 */
function instantiateTypedMembership(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"instantiate-universal-hypothesis">,
  domain: PlainMathJson,
  derived: TargetEntry,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const membership: PlainMathJson = ["Element", operation.term, domain];
  const discharged = target.entry.sequent.context.hypotheses.some((candidate) =>
    alphaEquivalentWithOperators(candidate.statement.expression, membership, operators),
  );
  if (discharged) {
    return success(replaceTarget(state, operation.target, target.index, [derived]), "equivalence");
  }
  if (operation.membershipObligationId === undefined) {
    return internalFailure(
      state,
      "arity-mismatch",
      "Instantiating a typed universal at an unproven member needs a membership obligation ID.",
    );
  }
  const obligationCollision = targetIdCollision(state, [operation.membershipObligationId]);
  if (obligationCollision !== undefined) return idCollision(state, obligationCollision);
  const obligation: Obligation = {
    id: operation.membershipObligationId,
    provenance: { kind: "binder-membership", hypothesisId: operation.hypothesisId },
    sequent: {
      context: structuredClone(target.entry.sequent.context),
      conclusion: { expression: structuredClone(membership) },
    },
  };
  const next = replaceWithObligations(state, target, operation.target, derived, [obligation]);
  return success(next, "strengthening");
}

export function chooseExistentialWitness(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"choose-existential-witness">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const quantifier = readQuantifier(target.entry.sequent.conclusion.expression, "Exists");
  if (quantifier === undefined) {
    return notApplicable(state, "The target conclusion is not existential.");
  }
  const instantiated = substituteBoundSymbol(
    quantifier.body,
    quantifier.symbol,
    operation.witness,
    operators,
  );
  if (instantiated === undefined) return replacementFailed(state);
  // A typed binder `∃x∈S` is witnessed by `t ∈ S ∧ body[t/x]`: the membership stays part of
  // the goal rather than a separate obligation, so it cannot be dropped.
  const conclusion: PlainMathJson =
    quantifier.domain === undefined
      ? instantiated
      : ["And", ["Element", operation.witness, quantifier.domain], instantiated];
  return success(
    replaceTarget(state, operation.target, target.index, [
      withConclusion(target.entry, conclusion),
    ]),
    "strengthening",
  );
}

export function unpackExistentialHypothesis(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"unpack-existential-hypothesis">,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const hypothesisIndex = findHypothesisIndex(target.entry.sequent, operation.hypothesisId);
  if (hypothesisIndex < 0) return missingHypothesis(state);
  const selected = target.entry.sequent.context.hypotheses[hypothesisIndex] as Hypothesis;
  const quantifier = readQuantifier(selected.statement.expression, "Exists");
  if (quantifier === undefined) {
    return notApplicable(state, "The selected hypothesis is not existential.");
  }
  if (quantifier.domain !== undefined) {
    return unpackTypedExistential(state, target, operation, hypothesisIndex, quantifier, operators);
  }
  const declaration = findDeclaration(target.entry.sequent, quantifier.symbol);
  if (declaration?.role !== "local-witness") {
    return notApplicable(
      state,
      "The bound symbol requires a local-witness declaration in the local context.",
    );
  }
  if (
    contextDependsOnSymbol(
      target.entry.sequent,
      quantifier.symbol,
      operators,
      false,
      operation.hypothesisId,
    )
  ) {
    return notApplicable(
      state,
      "The existential witness is not fresh for the rest of the contextual sequent.",
    );
  }
  const collision = hypothesisIdCollision(target.entry.sequent, [operation.resultHypothesisId]);
  if (collision !== undefined) return idCollision(state, collision);
  const replacement = replaceHypothesis(target.entry, hypothesisIndex, [
    hypothesis(operation.resultHypothesisId, quantifier.body),
  ]);
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

/**
 * Unpack a typed `∃x∈S` hypothesis into a fresh local witness w, replacing it by `w ∈ S`
 * followed by the body at w.
 */
function unpackTypedExistential(
  state: ProofState,
  target: LocatedTarget,
  operation: OperationOfKind<"unpack-existential-hypothesis">,
  hypothesisIndex: number,
  quantifier: ReadQuantifier,
  operators: readonly OperatorDeclaration[],
): InternalResult {
  const { witnessDeclarationId, membershipHypothesisId } = operation;
  if (witnessDeclarationId === undefined || membershipHypothesisId === undefined) {
    return internalFailure(
      state,
      "arity-mismatch",
      "Unpacking a typed existential needs a witness declaration ID and a membership hypothesis ID.",
    );
  }
  const fresh = freshBinderParameter(target.entry.sequent, quantifier, "Exists", operators);
  if (fresh === undefined) {
    return notApplicable(state, "The typed binder's domain is not a well-sorted set.");
  }
  const idFailure = parameterIdFailure(
    state,
    target.entry.sequent,
    witnessDeclarationId,
    membershipHypothesisId,
    [operation.resultHypothesisId],
  );
  if (idFailure !== undefined) return idFailure;
  const body = renameBoundSymbol(quantifier.body, quantifier.symbol, fresh.symbol, operators);
  if (body === undefined) return replacementFailed(state);
  const replaced = replaceHypothesis(target.entry, hypothesisIndex, [
    hypothesis(membershipHypothesisId, [
      "Element",
      fresh.symbol,
      quantifier.domain as PlainMathJson,
    ]),
    hypothesis(operation.resultHypothesisId, body),
  ]);
  const replacement = withParameter(
    replaced,
    { id: witnessDeclarationId, symbol: fresh.symbol, sort: fresh.sort, role: "local-witness" },
    [],
  );
  return success(
    replaceTarget(state, operation.target, target.index, [replacement]),
    "equivalence",
  );
}

/** The name and sort a typed binder's variable takes when it enters the local context. */
function freshBinderParameter(
  sequent: ContextualSequent,
  quantifier: ReadQuantifier,
  operator: "ForAll" | "Exists",
  operators: readonly OperatorDeclaration[],
): Readonly<{ symbol: string; sort: Sort }> | undefined {
  const bindings = new Map(
    sequent.context.declarations.map((declaration) => [declaration.symbol, declaration.sort]),
  );
  const sort = builtinBinderSorts(
    operator,
    [["Element", quantifier.symbol, quantifier.domain as PlainMathJson], quantifier.body],
    bindings,
    operators,
  )?.get(quantifier.symbol);
  if (sort === undefined) return undefined;
  const taken = new Set<string>([
    ...sequent.context.declarations.map((declaration) => declaration.symbol),
    ...operators.map((candidate) => candidate.symbol),
    ...freeSymbolNames(quantifier.domain as PlainMathJson, { operators }),
  ]);
  return { symbol: freshSymbolName(quantifier.symbol, taken), sort };
}

function parameterIdFailure(
  state: ProofState,
  sequent: ContextualSequent,
  declarationId: DeclarationId,
  membershipHypothesisId: StatementId,
  otherHypothesisIds: readonly StatementId[],
): Extract<InternalResult, { ok: false }> | undefined {
  if (sequent.context.declarations.some((declaration) => declaration.id === declarationId)) {
    return idCollision(state, declarationId);
  }
  const collision = hypothesisIdCollision(sequent, [membershipHypothesisId, ...otherHypothesisIds]);
  return collision === undefined ? undefined : idCollision(state, collision);
}

function renameBoundSymbol(
  body: PlainMathJson,
  symbol: string,
  renamed: string,
  operators: readonly OperatorDeclaration[],
): PlainMathJson | undefined {
  return symbol === renamed ? body : substituteBoundSymbol(body, symbol, renamed, operators);
}

function withParameter(
  entry: TargetEntry,
  declaration: Declaration,
  appended: readonly Hypothesis[],
): TargetEntry {
  return {
    ...entry,
    sequent: {
      ...entry.sequent,
      context: {
        ...entry.sequent.context,
        declarations: [...entry.sequent.context.declarations, declaration],
        hypotheses: [...entry.sequent.context.hypotheses, ...appended],
      },
    },
  };
}

function substituteBoundSymbol(
  body: PlainMathJson,
  symbol: string,
  replacement: PlainMathJson,
  operators: readonly OperatorDeclaration[],
): PlainMathJson | undefined {
  const result = substituteMathJson(body, [{ symbol, replacement }], { operators });
  return result.ok ? result.expression : undefined;
}

function contextDependsOnSymbol(
  sequent: ContextualSequent,
  symbol: string,
  operators: readonly OperatorDeclaration[],
  ignoreConclusion: boolean,
  ignoredHypothesisId?: StatementId,
): boolean {
  const expressions: PlainMathJson[] = [];
  if (!ignoreConclusion) expressions.push(sequent.conclusion.expression);
  sequent.context.hypotheses.forEach((candidate) => {
    if (candidate.id !== ignoredHypothesisId) expressions.push(candidate.statement.expression);
  });
  sequent.context.declarations.forEach((declaration) => {
    if (
      declaration.role === "construction-metavariable" &&
      declaration.resolution.status === "resolved"
    ) {
      expressions.push(declaration.resolution.value);
    }
  });
  return expressions.some((expression) =>
    freeSymbolNames(expression, { operators }).includes(symbol),
  );
}
