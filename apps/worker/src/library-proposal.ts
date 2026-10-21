/**
 * Deterministic handling of a librarian proposal (`docs/ai-agents-architecture.md` section 2).
 *
 * A proposal is evidence only. Everything here is a pure function of the stored call (its
 * context and validated output): each proposed result is assembled into the library's result
 * shape, run through `admitLibraryArtifact` in the construction's operator environment and
 * background profile, checked against the profile's declared domains and level, and given its
 * deterministic variants. A result that applies a constant the environment does not declare
 * carries that constant's declaration itself (`LibraryResult.operators`): it is a library
 * constant, dormant in a session until a committed step applies the result. Rejected results keep
 * their reasons. Because the outcome depends on nothing but the stored call, the proposal route, the decision route and the setup approval all
 * derive the same admitted set, and none of them accepts an artifact from a client.
 *
 * The gate for the `initial-problem` layer admits approved artifacts only, and a person approves
 * a result by keeping it. So a result is judged in its recordable form (approved by the web
 * reviewer) while the proposal shows it as a draft: the verdict is exactly the one the setup
 * approval will get, and no result claims approval before it has one.
 */
import { createPresentation, type Presentation } from "@proof/language";
import type {
  LibrarianContext,
  LibrarianProposal,
  LibrarianResult,
  LibrarianTopUpContext,
} from "@proof/llm";
import {
  admitLibraryArtifact,
  checkBackgroundAdmission,
  generateVariants,
  mentionedSymbols,
  mergeLibraryOperators,
  type BackgroundProfile,
  type LibraryResult,
} from "@proof/library";
import {
  freeSymbolNames,
  parseStatementView,
  substituteMathJson,
  type OperatorDeclaration,
  type PlainMathJson,
} from "@proof/mathjson-model";
import { resolveAgainstRegistry } from "./approved-background";
import { definitionHash } from "./approved-catalog";
import { extendOperators } from "./session-constants";

/** The single human actor of the web application; library approvals are recorded under it. */
export const LIBRARY_REVIEWER_ID = "actor:web";
/** Generated results rank below the curated packs' (priority 100). */
const LIBRARIAN_RESULT_PRIORITY = 50;
/** The gate needs a session for the `initial-problem` layer; the verdict does not depend on it. */
const GATE_SESSION_ID = "session:library-preview";

/** A result of an initial-library proposal that passed the gate, with its variants. */
export type EvaluatedLibraryResult = Readonly<{
  /** The result as proposed: a draft, tagged with its variant family when it has variants. */
  artifact: LibraryResult;
  variants: readonly LibraryResult[];
  /** Symbols of the proposal's new constants that the result (or a variant) applies. */
  newConstantSymbols: readonly string[];
}>;

export type RejectedLibraryResult = Readonly<{
  id: string;
  name: string;
  /** Plain-language reasons, one per failed check. */
  reasons: readonly string[];
  /** Admission codes, or `unreadable` / `outside-background`. */
  codes: readonly string[];
}>;

export type EvaluatedNewConstant = Readonly<{
  operator: OperatorDeclaration;
  rationale: string;
  /** IDs of the admitted results that apply the constant. */
  usedBy: readonly string[];
}>;

export type LibraryProposalEvaluation = Readonly<{
  results: readonly EvaluatedLibraryResult[];
  rejected: readonly RejectedLibraryResult[];
  newConstants: readonly EvaluatedNewConstant[];
  rejectedConstants: readonly Readonly<{ symbol: string; reason: string }>[];
  /** The operator environment the results were judged in. */
  operators: readonly OperatorDeclaration[];
}>;

type InitialContext = Extract<LibrarianContext, { kind: "initial" }>;

/** Judge every result of a proposal. Pure; the same stored call always gives the same answer. */
export function evaluateLibraryProposal(
  input: Readonly<{ callId: string; context: InitialContext; proposal: LibrarianProposal }>,
): LibraryProposalEvaluation {
  const { callId, context, proposal } = input;
  const constants = resolveNewConstants(context.constants, proposal.newConstants);
  const operators = constants.environment;
  const presentation = presentationFor(operators);
  const newSymbols = new Set(constants.accepted.map(({ operator }) => operator.symbol));
  const offered: Offered = {
    operators: context.constants,
    constants: constants.accepted.map(({ operator }) => operator),
    full: operators,
  };

  const results: EvaluatedLibraryResult[] = [];
  const rejected: RejectedLibraryResult[] = proposal.unusable.map(({ id, reason }) => ({
    id,
    name: id,
    reasons: [reason],
    codes: ["unreadable"],
  }));
  for (const proposed of proposal.results) {
    const outcome = evaluateResult(proposed, callId, context.background, offered, presentation);
    if (!outcome.ok) {
      rejected.push({
        id: proposed.id,
        name: proposed.name,
        reasons: outcome.reasons,
        codes: outcome.codes,
      });
      continue;
    }
    const used = usedNewConstants(outcome.artifact, outcome.variants, newSymbols);
    results.push({
      artifact: outcome.artifact,
      variants: outcome.variants,
      newConstantSymbols: used,
    });
  }
  return Object.freeze({
    results,
    rejected,
    newConstants: constants.accepted.map(({ operator, rationale }) => ({
      operator,
      rationale,
      usedBy: results
        .filter(({ newConstantSymbols }) => newConstantSymbols.includes(operator.symbol))
        .map(({ artifact }) => artifact.id),
    })),
    rejectedConstants: constants.rejected,
    operators,
  });
}

/**
 * The name a proof-time top-up's recorded approval carries. No person reviews a top-up: the
 * deterministic admission gate admits it, and this actor says so honestly instead of claiming
 * a human or the model approved it.
 */
export const TOP_UP_REVIEWER_ID = "service:library-gate";
const TOP_UP_JUDGEMENT: Judgement = {
  layer: "proof-time-background",
  reviewerId: TOP_UP_REVIEWER_ID,
};

/** The verdict on a top-up proposal: what the gate admitted (in recordable form) and what it did not. */
export type TopUpEvaluation = Readonly<{
  /**
   * Admitted results with their variants, approved by `TOP_UP_REVIEWER_ID` in the
   * `proof-time-background` layer, exactly as they are recorded. A result that applies a constant
   * the session does not yet declare carries it (`LibraryResult.operators`).
   */
  results: readonly EvaluatedLibraryResult[];
  rejected: readonly RejectedLibraryResult[];
  /** Constants the proposal declared that an admitted result applies: new library constants. */
  newConstants: readonly EvaluatedNewConstant[];
  /** Constants set aside, with the reason (a clash, or no admitted result applies them). */
  rejectedConstants: readonly Readonly<{ symbol: string; reason: string }>[];
}>;

/**
 * Judge a top-up proposal (`new-constants` or `no-relevant-results`) for a session in progress.
 * Pure: the same stored call, operators, profile and library always give the same verdict.
 *
 * - Results are judged in the session's effective operators. The librarian may declare constants:
 *   each is checked deterministically (a repeat of an active or available constant is a reference;
 *   one that clashes on symbol, identifier or LaTeX trigger with the active constants, the
 *   available library constants, the packs or the registry is set aside with its reason), and an
 *   accepted one is carried by every result that applies it. A result that applies a set-aside
 *   constant is rejected with that reason.
 * - A result whose identifier or (alpha-renamed) statement and premises repeat one already in the
 *   library, or one admitted earlier in the proposal, is rejected as a duplicate.
 * - A `new-constants` result must apply at least one newly activated constant.
 */
export function evaluateTopUpProposal(
  input: Readonly<{
    callId: string;
    context: LibrarianTopUpContext;
    proposal: LibrarianProposal;
    /** The session's effective operators (its active constants). */
    operators: readonly OperatorDeclaration[];
    /** The library constants the session's library already declares and has not activated. */
    available?: readonly OperatorDeclaration[];
    /** The global operator registry's declarations (a constant must not clash with them). */
    registry?: readonly OperatorDeclaration[];
    /** The session's current background profile. */
    profile: BackgroundProfile;
    /** The results the session library already holds, other than the ones this call adds. */
    existing: readonly LibraryResult[];
  }>,
): TopUpEvaluation {
  const { callId, context, proposal, operators, profile } = input;
  const constants = resolveTopUpConstants(
    operators,
    input.available ?? [],
    input.registry ?? [],
    proposal.newConstants,
  );
  const full = extendOperators(
    operators,
    constants.accepted.map(({ operator }) => operator),
  );
  const presentation = presentationFor(full);
  const offered: Offered = {
    operators,
    constants: constants.accepted.map(({ operator }) => operator),
    full,
  };
  const activated =
    context.kind === "new-constants"
      ? new Set(context.newConstants.map(({ symbol }) => symbol))
      : undefined;
  const takenIds = new Set<string>(input.existing.map(({ id }) => id));
  const takenStatements = new Map<string, string>(
    input.existing.map((result) => [statementKey(result), result.name]),
  );

  const results: EvaluatedLibraryResult[] = [];
  const rejected: RejectedLibraryResult[] = proposal.unusable.map(({ id, reason }) => ({
    id,
    name: id,
    reasons: [reason],
    codes: ["unreadable"],
  }));
  const reject = (proposed: LibrarianResult, code: string, reason: string) =>
    rejected.push({ id: proposed.id, name: proposed.name, reasons: [reason], codes: [code] });

  for (const proposed of proposal.results) {
    if (takenIds.has(proposed.id)) {
      reject(
        proposed,
        "duplicate-id",
        `The identifier ${proposed.id} is already used in the library.`,
      );
      continue;
    }
    const heads = proposedSymbols(proposed);
    const refused = constants.rejected.filter(({ symbol }) => heads.has(symbol));
    if (refused.length > 0) {
      reject(
        proposed,
        "needs-new-constant",
        `This result needs the new constant ${refused.map(({ symbol }) => symbol).join(", ")}, which cannot be added: ${refused.map(({ reason }) => reason).join(" ")}`,
      );
      continue;
    }
    const outcome = evaluateResult(
      proposed,
      callId,
      profile,
      offered,
      presentation,
      TOP_UP_JUDGEMENT,
    );
    if (!outcome.ok) {
      rejected.push({
        id: proposed.id,
        name: proposed.name,
        reasons: outcome.reasons,
        codes: outcome.codes,
      });
      continue;
    }
    if (activated !== undefined && ![...activated].some((symbol) => heads.has(symbol))) {
      reject(
        proposed,
        "not-about-new-constants",
        `This result applies none of the newly activated constants (${[...activated].sort().join(", ")}), which this request asked for.`,
      );
      continue;
    }
    const repeats = takenStatements.get(statementKey(outcome.artifact));
    if (repeats !== undefined) {
      reject(proposed, "duplicate-statement", `This repeats the library result "${repeats}".`);
      continue;
    }
    takenIds.add(outcome.artifact.id);
    takenStatements.set(statementKey(outcome.artifact), outcome.artifact.name);
    // A variant that repeats a library statement (or an earlier variant) is left out quietly.
    const variants = outcome.variants.filter((variant) => {
      const key = statementKey(variant);
      if (takenStatements.has(key)) return false;
      takenStatements.set(key, variant.name);
      takenIds.add(variant.id);
      return true;
    });
    results.push({
      artifact: withApproval(outcome.artifact, TOP_UP_REVIEWER_ID),
      variants: variants.map((variant) => withApproval(variant, TOP_UP_REVIEWER_ID)),
      newConstantSymbols: [],
    });
  }
  // A constant is new to the library only through an admitted result that applies it.
  const used = new Set(
    results.flatMap(({ artifact, variants }) =>
      [artifact, ...variants].flatMap((result) =>
        (result.operators ?? []).map(({ symbol }) => symbol),
      ),
    ),
  );
  const rejectedConstants = [
    ...constants.rejected,
    ...constants.accepted
      .filter(({ operator }) => !used.has(operator.symbol))
      .map(({ operator }) => ({
        symbol: operator.symbol,
        reason: "No admitted result applies this constant, so it was not added.",
      })),
  ];
  return Object.freeze({
    results,
    rejected,
    newConstants: constants.accepted
      .filter(({ operator }) => used.has(operator.symbol))
      .map(({ operator, rationale }) => ({
        operator,
        rationale,
        usedBy: results
          .filter(({ artifact }) =>
            (artifact.operators ?? []).some(({ symbol }) => symbol === operator.symbol),
          )
          .map(({ artifact }) => artifact.id),
      })),
    rejectedConstants,
  });
}

type TopUpConstants = Readonly<{
  /** Constants the session does not yet declare that results may carry. */
  accepted: readonly Readonly<{ operator: OperatorDeclaration; rationale: string }>[];
  rejected: readonly Readonly<{ symbol: string; reason: string }>[];
}>;

/**
 * Check the constants a top-up proposal declares, deterministically. A constant that repeats an
 * active or an available library constant, declared identically, is a reference to it and is
 * accepted: the results that apply it carry it, exactly as they did when it was new, so judging the
 * same stored call again after a step activated the constant gives the same artifacts (a replay
 * by call ID records nothing twice). The same symbol declared differently is a clash. A new
 * constant must not clash on symbol, identifier or LaTeX trigger with the active constants, the
 * available library constants, the packs' operators or the registry, and must be a valid
 * declaration over known sorts (its schema).
 */
function resolveTopUpConstants(
  operators: readonly OperatorDeclaration[],
  available: readonly OperatorDeclaration[],
  registry: readonly OperatorDeclaration[],
  proposed: LibrarianProposal["newConstants"],
): TopUpConstants {
  const accepted: { operator: OperatorDeclaration; rationale: string }[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  let environment = extendOperators(operators, available);
  const same = (left: OperatorDeclaration, right: OperatorDeclaration) =>
    definitionHash(left) === definitionHash(right);
  for (const { operator, rationale } of proposed) {
    const reject = (reason: string) => rejected.push({ symbol: operator.symbol, reason });
    const packs = resolveAgainstRegistry([operator]);
    const resolved = packs.constants[0];
    if (packs.conflicts.length > 0 || resolved === undefined) {
      reject(packs.conflicts.join(" "));
      continue;
    }
    const active = operators.find(({ symbol }) => symbol === resolved.symbol);
    if (active !== undefined) {
      if (same(active, resolved)) accepted.push({ operator: active, rationale });
      else reject(`${resolved.symbol} is already a constant of this proof, declared differently.`);
      continue;
    }
    const registered = registry.find(({ symbol }) => symbol === resolved.symbol);
    if (registered !== undefined && !same(registered, resolved)) {
      reject(`${resolved.symbol} is already a registered operator, declared differently.`);
      continue;
    }
    const known = environment.find(({ symbol }) => symbol === resolved.symbol);
    if (known !== undefined) {
      if (same(known, resolved)) accepted.push({ operator: known, rationale });
      else {
        reject(
          `${resolved.symbol} is already an available library constant, declared differently.`,
        );
      }
      continue;
    }
    const merged = mergeLibraryOperators([environment, registry, [resolved]]);
    if (!merged.ok) {
      reject(merged.message);
      continue;
    }
    const within = mergeLibraryOperators([environment, [resolved]]);
    if (!within.ok) {
      reject(within.message);
      continue;
    }
    environment = within.operators;
    accepted.push({ operator: resolved, rationale });
  }
  return { accepted, rejected };
}

/** Every symbol in a proposed result's statement, premises and patterns. */
function proposedSymbols(proposed: LibrarianResult): Set<string> {
  const symbols = new Set<string>();
  mentionedSymbols(proposed.statement.expression, symbols);
  proposed.premises.forEach(({ expression }) => mentionedSymbols(expression, symbols));
  proposed.patterns.forEach(({ expression }) => mentionedSymbols(expression, symbols));
  return symbols;
}

/**
 * A key under which two results with the same premises and statement, up to the names of their
 * parameters, coincide. Parameters are renamed in order of first appearance.
 */
export function statementKey(
  result: Pick<LibraryResult, "parameters" | "premises" | "statement">,
): string {
  const parameters = new Set(result.parameters.map(({ symbol }) => symbol));
  const formulas = [
    ...result.premises.map(({ expression }) => expression),
    result.statement.expression,
  ];
  const order: string[] = [];
  formulas.forEach((formula) => orderedParameters(formula, parameters, order));
  const substitutions = order.map((symbol, index) => ({
    symbol,
    replacement: `parameter_${index + 1}`,
  }));
  const renamed = formulas.map((formula) => {
    const substituted = safely(() => substituteMathJson(formula, substitutions), undefined);
    return substituted?.ok === true ? substituted.expression : formula;
  });
  return JSON.stringify(renamed);
}

function orderedParameters(
  expression: PlainMathJson,
  parameters: ReadonlySet<string>,
  order: string[],
): void {
  if (typeof expression === "string") {
    if (parameters.has(expression) && !order.includes(expression)) order.push(expression);
    return;
  }
  if (Array.isArray(expression)) {
    expression.forEach((child) => orderedParameters(child as PlainMathJson, parameters, order));
    return;
  }
  if (typeof expression === "object" && expression !== null) {
    if ("sym" in expression && typeof expression.sym === "string") {
      orderedParameters(expression.sym, parameters, order);
    }
    if ("fn" in expression) {
      (expression.fn as readonly PlainMathJson[]).forEach((child) =>
        orderedParameters(child, parameters, order),
      );
    }
  }
}

type ResultOutcome =
  | Readonly<{ ok: true; artifact: LibraryResult; variants: readonly LibraryResult[] }>
  | Readonly<{ ok: false; reasons: readonly string[]; codes: readonly string[] }>;

/** How a proposal's results are judged: in which layer, and who the recorded approval names. */
type Judgement = Readonly<{
  layer: "initial-problem" | "proof-time-background";
  reviewerId: string;
}>;
const INITIAL_JUDGEMENT: Judgement = { layer: "initial-problem", reviewerId: LIBRARY_REVIEWER_ID };

/** The operators a proposal's results are judged in. */
type Offered = Readonly<{
  /** What a result is valid in without constants of its own. */
  operators: readonly OperatorDeclaration[];
  /** Constants a result that applies them carries (`LibraryResult.operators`). */
  constants: readonly OperatorDeclaration[];
  /** `operators` and `constants` together: for rendering and for explaining a failure. */
  full: readonly OperatorDeclaration[];
}>;

function evaluateResult(
  proposed: LibrarianResult,
  callId: string,
  profile: BackgroundProfile,
  offered: Offered,
  presentation: Presentation,
  judgement: Judgement = INITIAL_JUDGEMENT,
): ResultOutcome {
  const { layer, reviewerId } = judgement;
  const { operators } = offered;
  const symbols = proposedSymbols(proposed);
  const carried = offered.constants.filter(({ symbol }) => symbols.has(symbol));
  const reasons: string[] = [];
  const codes: string[] = [];
  const gate = admitLibraryArtifact({
    artifact: assembleArtifact(proposed, callId, presentation, layer, carried, {
      status: "approved",
      reviewerId,
    }),
    layer,
    sessionId: GATE_SESSION_ID,
    profile,
    environment: { operators },
  });
  if (!gate.ok) {
    for (const diagnostic of gate.diagnostics) {
      codes.push(diagnostic.code);
      reasons.push(
        diagnostic.code === "invalid-artifact"
          ? explainInvalidResult(proposed, offered.full)
          : diagnostic.message,
      );
    }
  }
  // The gate admits the initial-problem layer on approval alone; the profile's declared domains
  // and level still bound what the librarian may classify a result as. The proof-time layer
  // checks the classification against the profile itself.
  if (layer === "initial-problem") {
    const background = checkBackgroundAdmission(proposed.classification, profile);
    if (!background.ok) {
      for (const diagnostic of background.diagnostics) {
        if (
          diagnostic.code === "domain-outside-background" ||
          diagnostic.code === "level-above-background"
        ) {
          codes.push("outside-background");
          reasons.push(diagnostic.message);
        }
      }
    }
  }
  if (!gate.ok || reasons.length > 0 || gate.artifact.kind !== "result") {
    return {
      ok: false,
      reasons: dedupe(reasons.length > 0 ? reasons : ["Not a library result."]),
      codes: dedupe(codes),
    };
  }

  const draft: LibraryResult = { ...gate.artifact, approval: { status: "draft" } };
  const generated = generateVariants(draft, { operators });
  if (!generated.ok) return { ok: true, artifact: draft, variants: [] };
  const variants = generated.variants.filter(
    (variant) =>
      admitLibraryArtifact({
        artifact: withApproval(variant, reviewerId),
        layer,
        sessionId: GATE_SESSION_ID,
        profile,
        environment: { operators },
      }).ok,
  );
  return { ok: true, artifact: generated.source, variants };
}

/** The proposed result in the library's result shape, with the fields the worker owns. */
function assembleArtifact(
  proposed: LibrarianResult,
  callId: string,
  presentation: Presentation,
  layer: Judgement["layer"],
  carried: readonly OperatorDeclaration[],
  approval: LibraryResult["approval"],
): unknown {
  return {
    ...(carried.length === 0 ? {} : { operators: carried }),
    kind: "result",
    id: proposed.id,
    name: proposed.name,
    description: proposed.description,
    renderings: renderResult(
      presentation,
      proposed.statement.expression,
      proposed.premises.map(({ expression }) => expression),
    ),
    classification: proposed.classification,
    provenance: { kind: "generated", role: "librarian", contextId: callId },
    approval,
    layer,
    related: [],
    priority: LIBRARIAN_RESULT_PRIORITY,
    parameters: proposed.parameters,
    statement: proposed.statement,
    premises: proposed.premises,
    sideConditions: [],
    applicationDirections: proposed.applicationDirections,
    patterns: proposed.patterns,
  };
}

/** Deterministic renderings in the style of the curated packs: `premises ⊢ conclusion`. */
function renderResult(
  presentation: Presentation,
  statement: PlainMathJson,
  premises: readonly PlainMathJson[],
): { latex: string; naturalLanguage: string } {
  try {
    const latex = presentation.latex(statement);
    const prose = presentation.naturalLanguage(statement);
    if (premises.length === 0) return { latex, naturalLanguage: sentence(prose) };
    return {
      latex: `${premises.map((premise) => presentation.latex(premise)).join(String.raw`,\ `)}\\vdash ${latex}`,
      naturalLanguage: sentence(
        `If ${premises.map((premise) => presentation.naturalLanguage(premise)).join(" and ")}, then ${prose}`,
      ),
    };
  } catch {
    const text = JSON.stringify(premises.length === 0 ? statement : { premises, statement });
    return { latex: text, naturalLanguage: text };
  }
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function presentationFor(operators: readonly OperatorDeclaration[]): Presentation {
  try {
    return createPresentation({ operators });
  } catch {
    return createPresentation();
  }
}

/** Why a proposed result is not a valid library result, in words a reader can act on. */
function explainInvalidResult(
  proposed: LibrarianResult,
  operators: readonly OperatorDeclaration[],
): string {
  const parameters = new Set(proposed.parameters.map(({ symbol }) => symbol));
  const problems: string[] = [];
  const check = (label: string, expression: PlainMathJson, proposition: boolean) => {
    const unknown = safely(() => freeSymbolNames(expression, { operators }), []).filter(
      (symbol) => !parameters.has(symbol),
    );
    if (unknown.length > 0) {
      problems.push(
        `${label} uses ${unknown.join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a parameter, built-in symbol or available operator.`,
      );
    } else if (
      proposition &&
      safely(
        () => parseStatementView(expression, { declarations: proposed.parameters, operators }),
        undefined,
      ) === undefined
    ) {
      problems.push(`${label} is not a well-sorted proposition over its parameters.`);
    }
  };
  check("The statement", proposed.statement.expression, true);
  proposed.premises.forEach(({ expression }, index) =>
    check(`Premise ${index + 1}`, expression, true),
  );
  proposed.patterns.forEach(({ expression, requirement }, index) =>
    check(`Pattern ${index + 1}`, expression, requirement.role === "proposition"),
  );
  return problems.length > 0
    ? problems.join(" ")
    : "The result does not form a valid library result for these operators and sorts.";
}

type ConstantResolution = Readonly<{
  accepted: readonly Readonly<{ operator: OperatorDeclaration; rationale: string }>[];
  rejected: readonly Readonly<{ symbol: string; reason: string }>[];
  /** The context's constants followed by the accepted ones. */
  environment: readonly OperatorDeclaration[];
}>;

/**
 * Admit the proposal's new constants one by one: a constant that clashes with the global operator
 * registry or with the environment is set aside with its reason (the results that need it then
 * fail the gate), and one that repeats a registry operator's symbol and signature becomes that
 * registry operator.
 */
function resolveNewConstants(
  contextConstants: readonly OperatorDeclaration[],
  proposed: LibrarianProposal["newConstants"],
): ConstantResolution {
  const accepted: { operator: OperatorDeclaration; rationale: string }[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  let environment: readonly OperatorDeclaration[] = contextConstants;
  for (const { operator, rationale } of proposed) {
    const resolution = resolveAgainstRegistry([operator]);
    const resolved = resolution.constants[0];
    if (resolution.conflicts.length > 0 || resolved === undefined) {
      rejected.push({ symbol: operator.symbol, reason: resolution.conflicts.join(" ") });
      continue;
    }
    const merged = mergeLibraryOperators([environment, [resolved]]);
    if (!merged.ok) {
      rejected.push({ symbol: operator.symbol, reason: merged.message });
      continue;
    }
    environment = merged.operators;
    accepted.push({ operator: resolved, rationale });
  }
  return { accepted, rejected, environment };
}

function usedNewConstants(
  artifact: LibraryResult,
  variants: readonly LibraryResult[],
  newSymbols: ReadonlySet<string>,
): readonly string[] {
  if (newSymbols.size === 0) return [];
  const carried = new Set(
    [artifact, ...variants].flatMap((result) =>
      (result.operators ?? []).map(({ symbol }) => symbol),
    ),
  );
  return [...newSymbols].filter((symbol) => carried.has(symbol)).sort();
}

function withApproval(artifact: LibraryResult, reviewerId: string): LibraryResult {
  return { ...artifact, approval: { status: "approved", reviewerId } } as LibraryResult;
}

/**
 * The results a person kept, in the form that is recorded: approved by the reviewer, with their
 * variants, and with the new constants that the kept results apply.
 */
export type ApprovedInitialLibrary = Readonly<{
  constructionId: string;
  decisionId: string;
  /** When the person decided; additions are recorded at this time so a retry is identical. */
  decidedAt: string;
  reviewerId: string;
  /** The kept results, approved. */
  results: readonly LibraryResult[];
  /** The generated variants of the kept results, approved. */
  variants: readonly LibraryResult[];
  /** New constants that the kept results apply; they join the session's operators. */
  constants: readonly OperatorDeclaration[];
  /** The operator environment the results were judged in at proposal time. */
  environment: readonly OperatorDeclaration[];
  /** The profile the results were judged against. */
  profile: BackgroundProfile;
}>;

/** The part of an approved library that the proposal itself determines. */
export type KeptLibraryResults = Pick<
  ApprovedInitialLibrary,
  "reviewerId" | "results" | "variants" | "constants" | "environment"
>;

/** Keep the named admitted results. Returns the unknown IDs when some are not admitted. */
export function selectApprovedResults(
  evaluation: LibraryProposalEvaluation,
  approvedIds: readonly string[],
  reviewerId: string,
):
  | Readonly<{ ok: true; kept: KeptLibraryResults }>
  | Readonly<{ ok: false; unknown: readonly string[] }> {
  const admitted = new Map<string, EvaluatedLibraryResult>(
    evaluation.results.map((entry) => [entry.artifact.id, entry]),
  );
  const unknown = approvedIds.filter((id) => !admitted.has(id));
  if (unknown.length > 0) return { ok: false, unknown };
  const kept = evaluation.results.filter(({ artifact }) => approvedIds.includes(artifact.id));
  const symbols = new Set(kept.flatMap(({ newConstantSymbols }) => newConstantSymbols));
  return {
    ok: true,
    kept: {
      reviewerId,
      results: kept.map(({ artifact }) => withApproval(artifact, reviewerId)),
      variants: kept.flatMap(({ variants }) => variants.map((v) => withApproval(v, reviewerId))),
      constants: evaluation.newConstants
        .filter(({ operator }) => symbols.has(operator.symbol))
        .map(({ operator }) => operator),
      environment: evaluation.operators,
    },
  };
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function safely<Value>(work: () => Value, fallback: Value): Value {
  try {
    return work();
  } catch {
    return fallback;
  }
}
