/**
 * Manual problem and session creation (design plan §4.1, §4.4 without LLM roles; roadmap N26).
 *
 * Drafts stay with the client until approval: they are not proof state, have no history to keep,
 * and persisting them would only add a second place where unapproved mathematics lives. The
 * worker offers two operations over a draft:
 *
 * - `validateProblemDraft` is pure. It parses LaTeX through the Compute Engine dictionary (with
 *   the selected packs' parse triggers), checks every symbol against the declarations and the
 *   selected packs' operators, and builds the exact root node, operator environment and session
 *   metadata approval would store, with a digest of them. Diagnostics name the draft field.
 * - `approveProblemSession` re-validates the draft, refuses a digest other than the reviewed one,
 *   and creates the session and its root node in one transaction through
 *   `initializeProofSession`. Nothing is written before that call, so a rejected approval writes
 *   nothing. A retried approval with the same session ID and content replays; different content
 *   under an existing ID is a conflict.
 *
 * Only the MathJSON is stored; LaTeX is input syntax. New mathematics entering here is the
 * `setup` payload source of the command protocol.
 */
import {
  admitLibraryArtifact,
  libraryPacksForOperators,
  starterLibraryPacks,
  type LibraryPack,
} from "@proof/library";
import { createLatexRenderer, type LatexRenderer } from "@proof/language";
import {
  RESERVED_BUILTIN_SYMBOLS,
  declarationIdSchema,
  freeSymbolNames,
  parseStatementView,
} from "@proof/mathjson-model";
import {
  PROBLEM_SETUP_LAYER_CHOICES,
  PROBLEM_SETUP_SORT_CHOICES,
  createProofNodeSchema,
  problemApprovalRequestSchema,
  problemDraftSchema,
  problemSetupSort,
  proofSessionMetadataSchema,
  type OperatorDeclaration,
  type PlainMathJson,
  type ProblemDraft,
  type ProblemSetupDiagnostic,
  type ProblemSetupDiagnosticCode,
  type ProblemSetupOptions,
  type ProblemSetupInitialLibrary,
  type ProblemSetupReview,
  type ProblemStatementInput,
  type ProofNode,
  type ProofSessionMetadata,
} from "@proof/protocol";
import { definitionHash } from "./approved-catalog";
import type { ApprovedInitialLibrary } from "./library-proposal";
import {
  freezeDetached,
  initializeProofSession,
  jsonEquals,
  loadNode,
  loadSession,
  proofSessionIdSchema,
  transactionFailure,
  type ProofSession,
  type ProofSessionId,
  type ProofStore,
  type RepositoryFailure,
} from "./proof-repository";

/** The fixed identities of a manually entered root node; unique within its session. */
export const PROBLEM_ROOT_NODE_ID = "node:root";
export const PROBLEM_ROOT_STATE_ID = "state:root";

type Diagnostics = readonly [ProblemSetupDiagnostic, ...ProblemSetupDiagnostic[]];

export type ValidatedProblemDraft = Readonly<{
  draft: ProblemDraft;
  rootNode: ProofNode;
  operators: readonly OperatorDeclaration[];
  metadata: ProofSessionMetadata;
  review: ProblemSetupReview;
}>;

export type ProblemDraftValidation =
  | Readonly<{ ok: true; diagnostics: readonly []; value: ValidatedProblemDraft }>
  | Readonly<{ ok: false; diagnostics: Diagnostics }>;

/** The menus of the entry form: sorts, library layers and the reviewed starter packs. */
export function problemSetupOptions(
  packs: readonly LibraryPack[] = starterLibraryPacks(),
): ProblemSetupOptions {
  return freezeDetached({
    sorts: PROBLEM_SETUP_SORT_CHOICES.map(({ id, label, sort }) => ({ id, label, sort })),
    layers: PROBLEM_SETUP_LAYER_CHOICES.map(({ id, layer, label, description }) => ({
      id,
      layer,
      label,
      description,
    })),
    packs: packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description,
      domain: pack.domain,
      alwaysActive: pack.operators.length === 0,
      operators: pack.operators,
    })),
  }) as ProblemSetupOptions;
}

/**
 * Operators the session gets besides its packs': the constants of an approved background and the
 * new constants of an approved initial library, which the worker resolved from storage. They
 * follow the packs' operators in the session environment. The approved library's artifacts are
 * checked against the environment and recorded as setup additions when the session is created.
 */
export type ProblemDraftOptions = Readonly<{
  constants?: readonly OperatorDeclaration[];
  library?: ApprovedInitialLibrary | undefined;
}>;

const APPROVED_CONSTANTS_ORIGIN = "the approved background constants";
const APPROVED_LIBRARY_CONSTANTS_ORIGIN = "the approved library constants";

/**
 * The operators of a session: the selected packs' (catalog order), then the approved background
 * constants, then the approved library's new constants.
 */
export function resolveSessionOperators(
  selectedPackIds: readonly string[],
  packs: readonly LibraryPack[],
  constants: readonly OperatorDeclaration[],
  add: (code: ProblemSetupDiagnosticCode, message: string, path: readonly PathKey[]) => void,
  packIdsPath: readonly PathKey[],
  libraryConstants: readonly OperatorDeclaration[] = [],
): Readonly<{
  operators: readonly OperatorDeclaration[];
  /** Where each operator symbol comes from, as a phrase: "the pack pack:sets" and so on. */
  origin: ReadonlyMap<string, string>;
}> {
  const selected = new Set(selectedPackIds);
  const operators: OperatorDeclaration[] = [];
  const origin = new Map<string, string>();
  for (const pack of packs.filter((candidate) => selected.has(candidate.id))) {
    for (const operator of pack.operators) {
      const existing = operators.find((candidate) => candidate.symbol === operator.symbol);
      if (existing === undefined) {
        operators.push(operator);
        origin.set(operator.symbol, `the pack ${pack.id}`);
      } else if (!jsonEquals(existing, operator)) {
        add(
          "pack-operator-conflict",
          `The packs ${origin.get(operator.symbol)?.replace("the pack ", "") ?? "?"} and ${pack.id} declare ${operator.symbol} differently.`,
          [...packIdsPath, selectedPackIds.indexOf(pack.id)],
        );
      }
    }
  }
  const addConstants = (
    declared: readonly OperatorDeclaration[],
    label: string,
    constantsOrigin: string,
    path: PathKey,
  ) => {
    for (const constant of declared) {
      const same = operators.find((candidate) => candidate.symbol === constant.symbol);
      if (same !== undefined) {
        // The same declaration is a reference to the existing operator; another one is a clash.
        if (!jsonEquals(same, constant)) {
          add(
            "pack-operator-conflict",
            `The ${label} ${constant.symbol} differs from the operator ${constant.symbol} of ${origin.get(constant.symbol) ?? "?"}.`,
            [path],
          );
        }
        continue;
      }
      const trigger = constant.presentation?.latex?.parse?.trigger;
      const clash = operators.find(
        (candidate) =>
          candidate.id === constant.id ||
          (trigger !== undefined && candidate.presentation?.latex?.parse?.trigger === trigger),
      );
      if (clash !== undefined) {
        add(
          "pack-operator-conflict",
          `The ${label} ${constant.symbol} reuses the ID or LaTeX trigger of the operator ${clash.symbol}.`,
          [path],
        );
        continue;
      }
      operators.push(constant);
      origin.set(constant.symbol, constantsOrigin);
    }
  };
  addConstants(constants, "approved constant", APPROVED_CONSTANTS_ORIGIN, "approvedBackground");
  addConstants(
    libraryConstants,
    "approved library constant",
    APPROVED_LIBRARY_CONSTANTS_ORIGIN,
    "approvedLibrary",
  );
  return { operators, origin };
}

/** Validate a draft and build exactly what approval would store. Pure. */
export function validateProblemDraft(
  input: unknown,
  packs: readonly LibraryPack[] = starterLibraryPacks(),
  options: ProblemDraftOptions = {},
): ProblemDraftValidation {
  const diagnostics: ProblemSetupDiagnostic[] = [];
  const add = (code: ProblemSetupDiagnosticCode, message: string, path: readonly PathKey[]) =>
    diagnostics.push({ code, message, path: [...path] });

  const parsed = problemDraftSchema.safeParse(input);
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) =>
      add("invalid-draft", issue.message, issuePath(issue.path)),
    );
    return failed(diagnostics);
  }
  const draft = parsed.data;

  addDuplicateChoices(draft.libraryLayerIds, ["libraryLayerIds"], "library layer", add);
  addDuplicateChoices(draft.packs, ["packs"], "pack", add);
  addDuplicateChoices(draft.preferences?.domains ?? [], ["preferences", "domains"], "domain", add);
  addDuplicateChoices(
    draft.preferences?.notation ?? [],
    ["preferences", "notation"],
    "notation preference",
    add,
  );

  // The session's operators are the selected packs' operators, in catalog order, then the
  // constants of an approved background.
  const selected = new Set(draft.packs);
  const { operators, origin: operatorOrigin } = resolveSessionOperators(
    draft.packs,
    packs,
    options.constants ?? [],
    add,
    ["packs"],
    options.library?.constants ?? [],
  );
  const operatorSymbols = new Set(operators.map((operator) => operator.symbol));

  let declarationsValid = true;
  const declaredSymbols = new Set<string>();
  draft.declarations.forEach(({ symbol }, index) => {
    const path = ["declarations", index, "symbol"] as const;
    if (declaredSymbols.has(symbol)) {
      declarationsValid = false;
      add("duplicate-symbol", `The symbol ${symbol} is declared more than once.`, path);
    } else if (RESERVED_BUILTIN_SYMBOLS.has(symbol)) {
      declarationsValid = false;
      add("reserved-symbol", `${symbol} is a built-in symbol and cannot be declared.`, path);
    } else if (operatorSymbols.has(symbol)) {
      declarationsValid = false;
      add(
        "operator-symbol",
        `${symbol} is an operator of ${operatorOrigin.get(symbol) ?? "the setup"}.`,
        path,
      );
    }
    declaredSymbols.add(symbol);
  });
  const declarations = draft.declarations.map(({ symbol, sort }) => ({
    id: declarationIdSchema.parse(`declaration:${symbol}`),
    symbol,
    sort: problemSetupSort(sort),
    role: "universal-parameter" as const,
  }));

  const latex = cachedLatexRenderer(operators);
  const unselectedOperators = new Map<string, string>();
  for (const pack of packs) {
    if (selected.has(pack.id)) continue;
    for (const operator of pack.operators) {
      if (!operatorSymbols.has(operator.symbol) && !unselectedOperators.has(operator.symbol)) {
        unselectedOperators.set(operator.symbol, pack.id);
      }
    }
  }

  const statement = (
    kind: "hypotheses" | "goals",
    statementInput: ProblemStatementInput,
    index: number,
  ): PlainMathJson | undefined => {
    const label = kind === "goals" ? `Goal ${index + 1}` : `Hypothesis ${index + 1}`;
    let expression: PlainMathJson;
    if (statementInput.format === "latex") {
      const parsedLatex = latex.parse(statementInput.latex);
      if (!parsedLatex.ok) {
        add(
          "latex-parse-failed",
          `${label}: ${parsedLatex.diagnostics.map(({ message }) => message).join(" ")}`,
          [kind, index, "latex"],
        );
        return undefined;
      }
      expression = parsedLatex.expression;
    } else {
      expression = statementInput.expression;
    }
    const expressionPath = [
      kind,
      index,
      statementInput.format === "latex" ? "latex" : "expression",
    ] as const;

    const unknown = freeSymbolNames(expression, { operators }).filter(
      (symbol) => !declaredSymbols.has(symbol) && !RESERVED_BUILTIN_SYMBOLS.has(symbol),
    );
    for (const symbol of unknown) {
      const pack = unselectedOperators.get(symbol);
      if (pack === undefined) {
        add(
          "undeclared-symbol",
          `${label} uses ${symbol}, which is not declared. Declare it with a sort.`,
          expressionPath,
        );
      } else {
        add(
          "pack-not-selected",
          `${label} uses the operator ${symbol}; select the pack ${pack} to use it.`,
          expressionPath,
        );
      }
    }
    if (unknown.length === 0 && declarationsValid) {
      const view = safely(() => parseStatementView(expression, { declarations, operators }));
      if (view === undefined) {
        add(
          "not-a-proposition",
          `${label} is not a well-sorted proposition over the declared symbols. Check the sorts ` +
            "of its symbols, and declare the variables of untyped quantifiers (or bind them " +
            "with a set, as in \\forall x \\in \\R).",
          expressionPath,
        );
      }
    }
    return expression;
  };

  const hypotheses = draft.hypotheses.map((input, index) => statement("hypotheses", input, index));
  const goals = draft.goals.map((input, index) => statement("goals", input, index));
  if (options.library !== undefined) {
    addLibraryDiagnostics(options.library, draft, operators, add);
  }
  if (diagnostics.length > 0) return failed(diagnostics);

  const context = {
    declarations,
    hypotheses: hypotheses.map((expression, index) => ({
      id: `hypothesis:${index + 1}`,
      statement: { expression },
    })),
  };
  const rootNodeInput = {
    id: PROBLEM_ROOT_NODE_ID,
    state: {
      id: PROBLEM_ROOT_STATE_ID,
      goals: goals.map((expression, index) => ({
        id: `goal:${index + 1}`,
        sequent: { context, conclusion: { expression } },
      })),
      obligations: [],
    },
  };
  const node = safely(() => createProofNodeSchema({ operators }).safeParse(rootNodeInput));
  if (node === undefined || !node.success) {
    (node?.error.issues ?? [{ message: "The root state is invalid.", path: [] }]).forEach((issue) =>
      add("invalid-root-state", issue.message, ["rootNode", ...issuePath(issue.path)]),
    );
    return failed(diagnostics);
  }

  const preferences = {
    ...(draft.preferences?.domains?.length ? { domains: draft.preferences.domains } : {}),
    ...(draft.preferences?.notation?.length ? { notation: draft.preferences.notation } : {}),
  };
  const metadata = proofSessionMetadataSchema.safeParse({
    problem: { title: draft.problem.title, statement: draft.problem.statement },
    background: draft.background,
    ...(Object.keys(preferences).length === 0 ? {} : { preferences }),
    libraryLayerIds: draft.libraryLayerIds,
    // Operators that only the approved initial library introduced stay dormant until a step
    // applies a result that uses them (see `active-constants.ts`).
    ...(options.library === undefined || options.library.constants.length === 0
      ? {}
      : { libraryConstants: options.library.constants.map(({ symbol }) => symbol) }),
  });
  if (!metadata.success) {
    metadata.error.issues.forEach((issue) =>
      add("invalid-draft", issue.message, issuePath(issue.path)),
    );
    return failed(diagnostics);
  }

  const rootNode = node.data;
  const activePackIds = libraryPacksForOperators(operators, packs).map((pack) => pack.id);
  const digest = problemSetupDigest(rootNode, operators, metadata.data, options.library);
  const initialLibrary =
    options.library === undefined ? undefined : summarizeInitialLibrary(options.library);
  const value = freezeDetached({
    draft,
    rootNode,
    operators,
    metadata: metadata.data,
    review: {
      rootNode,
      operators,
      metadata: metadata.data,
      activePackIds,
      ...(initialLibrary === undefined ? {} : { initialLibrary }),
      digest,
    },
  }) as ValidatedProblemDraft;
  return Object.freeze({ ok: true as const, diagnostics: [] as const, value });
}

/** The session the gate is asked about when no session exists yet; the verdict ignores it. */
const SETUP_REVIEW_SESSION_ID = "session:setup-review";

/**
 * The approved library must be recordable in the session this setup would create: its layer is
 * active, and every result (with its variants) passes the gate in the session's operators and
 * background. Anything the gate would reject at approval is reported now, with the check.
 */
function addLibraryDiagnostics(
  library: ApprovedInitialLibrary,
  draft: ProblemDraft,
  operators: readonly OperatorDeclaration[],
  add: (code: ProblemSetupDiagnosticCode, message: string, path: readonly PathKey[]) => void,
): void {
  if (!draft.libraryLayerIds.includes("layer:initial-problem")) {
    add(
      "approved-library-invalid",
      "The approved library belongs to the Initial problem library; include that layer in the setup, or stop using the library.",
      ["libraryLayerIds"],
    );
  }
  for (const artifact of [...library.results, ...library.variants]) {
    const gate = admitLibraryArtifact({
      artifact,
      layer: "initial-problem",
      sessionId: SETUP_REVIEW_SESSION_ID,
      profile: draft.background,
      environment: { operators },
    });
    if (gate.ok) continue;
    const invalid = gate.diagnostics.some(({ code }) => code === "invalid-artifact");
    add(
      "approved-library-invalid",
      invalid
        ? `The approved result "${artifact.name}" is not valid with this setup's operators. Select the notation packs it needs, or build the library again.`
        : `The approved result "${artifact.name}" cannot be added: ${gate.diagnostics.map(({ message }) => message).join(" ")}`,
      ["approvedLibrary"],
    );
  }
}

/** What the review shows of an approved library: the kept results and what comes with them. */
function summarizeInitialLibrary(library: ApprovedInitialLibrary): ProblemSetupInitialLibrary {
  return {
    results: library.results.map((result) => ({
      id: result.id,
      name: result.name,
      description: result.description,
      statement: result.statement.expression,
      premises: result.premises.map(({ expression }) => expression),
    })),
    variantCount: library.variants.length,
    addedOperatorSymbols: library.constants.map(({ symbol }) => symbol),
  };
}

/** A statement applies an operator that the setup did not approve (formalizer spec section 3). */
export type UnapprovedConstantDiagnostic = Readonly<{
  code: "unapproved-constant";
  message: string;
  path: readonly PathKey[];
}>;

/**
 * Every operator a draft's hypotheses and goals apply that is neither a reserved built-in, nor an
 * operator of the selected packs or the approved constants, nor a symbol the draft declares. LaTeX
 * is read with the approved operators' parse triggers, so notation outside that set is not
 * recognized as an operator either. A statement that does not parse is left to the usual
 * validation diagnostics.
 */
export function unapprovedConstantDiagnostics(
  draft: ProblemDraft,
  packs: readonly LibraryPack[] = starterLibraryPacks(),
  options: ProblemDraftOptions = {},
): readonly UnapprovedConstantDiagnostic[] {
  const { operators } = resolveSessionOperators(
    draft.packs,
    packs,
    options.constants ?? [],
    () => undefined,
    ["packs"],
    options.library?.constants ?? [],
  );
  const approved = new Set(operators.map((operator) => operator.symbol));
  const declared = new Set(draft.declarations.map(({ symbol }) => symbol));
  const unselectedPack = new Map<string, string>();
  for (const pack of packs) {
    if (draft.packs.includes(pack.id)) continue;
    for (const operator of pack.operators) {
      if (!approved.has(operator.symbol) && !unselectedPack.has(operator.symbol)) {
        unselectedPack.set(operator.symbol, pack.id);
      }
    }
  }
  const latex = cachedLatexRenderer(operators);
  const diagnostics: UnapprovedConstantDiagnostic[] = [];
  const check = (kind: "hypotheses" | "goals", input: ProblemStatementInput, index: number) => {
    let expression: PlainMathJson;
    if (input.format === "latex") {
      const parsed = latex.parse(input.latex);
      if (!parsed.ok) return;
      expression = parsed.expression;
    } else {
      expression = input.expression;
    }
    const heads = functionHeads(expression);
    const label = kind === "goals" ? `Goal ${index + 1}` : `Hypothesis ${index + 1}`;
    const used = safely(() => freeSymbolNames(expression, { operators })) ?? [];
    for (const symbol of used) {
      if (!heads.has(symbol) || declared.has(symbol) || RESERVED_BUILTIN_SYMBOLS.has(symbol)) {
        continue;
      }
      const pack = unselectedPack.get(symbol);
      diagnostics.push({
        code: "unapproved-constant",
        message:
          `${label} applies the operator ${symbol}, which is not an approved constant.` +
          (pack === undefined
            ? ` The approved operators are: ${[...approved].join(", ") || "none"}.`
            : ` It belongs to the pack ${pack}, which is not selected.`),
        path: [kind, index, input.format === "latex" ? "latex" : "expression"],
      });
    }
  };
  draft.hypotheses.forEach((input, index) => check("hypotheses", input, index));
  draft.goals.forEach((input, index) => check("goals", input, index));
  return diagnostics;
}

/** Function heads (applied symbols) that occur anywhere in a plain MathJSON expression. */
function functionHeads(expression: PlainMathJson, result: Set<string> = new Set()): Set<string> {
  let operands: readonly PlainMathJson[] = [];
  if (Array.isArray(expression)) {
    const [head, ...rest] = expression;
    if (typeof head === "string") result.add(head);
    operands = rest as PlainMathJson[];
  } else if (typeof expression === "object" && expression !== null && "fn" in expression) {
    const [head, ...rest] = expression.fn;
    if (typeof head === "string") result.add(head);
    operands = rest as PlainMathJson[];
  }
  operands.forEach((operand) => functionHeads(operand, result));
  return result;
}

/**
 * `sha256:` digest of exactly what approval stores. An approved initial library is part of it
 * (its approved results and their variants, in full), so approving with another library than the
 * one reviewed is stale; a setup without a library hashes as it always did.
 */
export function problemSetupDigest(
  rootNode: ProofNode,
  operators: readonly OperatorDeclaration[],
  metadata: ProofSessionMetadata,
  library?: ApprovedInitialLibrary,
): ProblemSetupReview["digest"] {
  return definitionHash({
    rootNode,
    operators,
    metadata,
    ...(library === undefined
      ? {}
      : { initialLibrary: { results: library.results, variants: library.variants } }),
  });
}

export type ApproveProblemSessionResult =
  | Readonly<{
      status: "created" | "replayed";
      session: ProofSession;
      node: ProofNode;
    }>
  | Readonly<{ status: "invalid-request"; message: string }>
  | Readonly<{ status: "invalid-draft"; diagnostics: Diagnostics }>
  | Readonly<{ status: "review-stale"; message: string }>
  | Readonly<{ status: "session-conflict"; message: string }>
  | Readonly<{ status: "failed"; failure: RepositoryFailure }>;

export type ApproveProblemSessionOptions = Readonly<{
  packs?: readonly LibraryPack[];
  /** Constants of an approved background, resolved by the caller from storage. */
  constants?: readonly OperatorDeclaration[];
  /**
   * An approved initial library, resolved by the caller from storage. Approval checks it and
   * covers it with the digest; recording its additions is the caller's step after the session
   * exists (`recordInitialLibrary`), because the library has its own transaction.
   */
  library?: ApprovedInitialLibrary | undefined;
}>;

/**
 * Approve a reviewed draft: the only way a manually entered problem becomes a session. The root
 * node is created only here, in the same transaction as its session.
 */
export async function approveProblemSession(
  store: ProofStore,
  requestInput: unknown,
  options: ApproveProblemSessionOptions = {},
): Promise<ApproveProblemSessionResult> {
  const request = problemApprovalRequestSchema.safeParse(requestInput);
  const sessionId = request.success
    ? proofSessionIdSchema.safeParse(request.data.sessionId)
    : undefined;
  if (!request.success || sessionId === undefined || !sessionId.success) {
    return { status: "invalid-request", message: "The approval request is invalid." };
  }
  const validated = validateProblemDraft(request.data.draft, options.packs, {
    ...(options.constants === undefined ? {} : { constants: options.constants }),
    ...(options.library === undefined ? {} : { library: options.library }),
  });
  if (!validated.ok) return { status: "invalid-draft", diagnostics: validated.diagnostics };
  const { value } = validated;
  if (value.review.digest !== request.data.reviewedDigest) {
    return {
      status: "review-stale",
      message: "The draft no longer produces the reviewed root state; review it again.",
    };
  }

  const existing = await readApprovedSession(store, sessionId.data, value);
  if (existing !== undefined) return existing;

  const initialized = await initializeProofSession(store, {
    sessionId: sessionId.data,
    rootNode: value.rootNode,
    operators: value.operators,
    metadata: value.metadata,
  });
  if (initialized.status === "committed") {
    return { status: "created", session: initialized.session, node: initialized.node };
  }
  // A concurrent approval may have won the unique-key race, or the commit may be uncertain.
  return (
    (await readApprovedSession(store, sessionId.data, value)) ?? {
      status: "failed",
      failure: initialized,
    }
  );
}

/** A replay when the session exists with this content; a conflict when with other content. */
async function readApprovedSession(
  store: ProofStore,
  sessionId: ProofSessionId,
  value: ValidatedProblemDraft,
): Promise<ApproveProblemSessionResult | undefined> {
  let loaded: Readonly<{ session: ProofSession; root: ProofNode | undefined }> | undefined;
  try {
    loaded = await store.transaction(async (transaction) => {
      const session = await loadSession(transaction, sessionId);
      if (!session.ok) return undefined;
      const root = await loadNode(
        transaction,
        session.session,
        session.environment,
        session.session.rootNodeId,
        "current-node-not-found",
        "invalid-current-node",
      );
      return { session: session.session, root: root.ok ? root.node : undefined };
    });
  } catch (error: unknown) {
    return {
      status: "failed",
      failure: transactionFailure(error, "The session could not be read."),
    };
  }
  if (loaded === undefined) return undefined;
  const same =
    loaded.root !== undefined &&
    jsonEquals(loaded.root, value.rootNode) &&
    jsonEquals(loaded.session.operators, value.operators) &&
    jsonEquals(loaded.session.metadata, value.metadata);
  return same && loaded.root !== undefined
    ? { status: "replayed", session: loaded.session, node: loaded.root }
    : {
        status: "session-conflict",
        message: `The session ${sessionId} already exists with different content.`,
      };
}

type PathKey = string | number;

function issuePath(path: readonly PropertyKey[]): PathKey[] {
  return path.filter((key): key is PathKey => typeof key === "string" || typeof key === "number");
}

function addDuplicateChoices(
  values: readonly string[],
  path: readonly PathKey[],
  label: string,
  add: (code: ProblemSetupDiagnosticCode, message: string, path: readonly PathKey[]) => void,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value))
      add("duplicate-choice", `The ${label} ${value} is chosen twice.`, [...path, index]);
    seen.add(value);
  });
}

function failed(diagnostics: readonly ProblemSetupDiagnostic[]): ProblemDraftValidation {
  const frozen = freezeDetached(diagnostics) ?? diagnostics;
  return Object.freeze({ ok: false as const, diagnostics: frozen as Diagnostics });
}

function safely<Value>(work: () => Value): Value | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

const LATEX_CACHE_LIMIT = 16;
const latexRenderers = new Map<string, LatexRenderer>();

/** Renderers build a Compute Engine dictionary; reuse one per operator environment. */
function cachedLatexRenderer(operators: readonly OperatorDeclaration[]): LatexRenderer {
  const key = JSON.stringify(operators);
  const cached = latexRenderers.get(key);
  if (cached !== undefined) return cached;
  const renderer = createLatexRenderer({ operators });
  if (latexRenderers.size >= LATEX_CACHE_LIMIT) {
    latexRenderers.delete(latexRenderers.keys().next().value as string);
  }
  latexRenderers.set(key, renderer);
  return renderer;
}
