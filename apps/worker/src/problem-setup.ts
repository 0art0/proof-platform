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
import { libraryPacksForOperators, starterLibraryPacks, type LibraryPack } from "@proof/library";
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
  type ProblemSetupReview,
  type ProblemStatementInput,
  type ProofNode,
  type ProofSessionMetadata,
} from "@proof/protocol";
import { definitionHash } from "./approved-catalog";
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

/** Validate a draft and build exactly what approval would store. Pure. */
export function validateProblemDraft(
  input: unknown,
  packs: readonly LibraryPack[] = starterLibraryPacks(),
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

  // The session's operators are the selected packs' operators, in catalog order.
  const selected = new Set(draft.packs);
  const operators: OperatorDeclaration[] = [];
  const operatorPack = new Map<string, string>();
  for (const pack of packs.filter((candidate) => selected.has(candidate.id))) {
    for (const operator of pack.operators) {
      const existing = operators.find((candidate) => candidate.symbol === operator.symbol);
      if (existing === undefined) {
        operators.push(operator);
        operatorPack.set(operator.symbol, pack.id);
      } else if (!jsonEquals(existing, operator)) {
        add(
          "pack-operator-conflict",
          `The packs ${operatorPack.get(operator.symbol) ?? "?"} and ${pack.id} declare ${operator.symbol} differently.`,
          ["packs", draft.packs.indexOf(pack.id)],
        );
      }
    }
  }
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
        `${symbol} is an operator of the pack ${operatorPack.get(symbol) ?? "?"}.`,
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
  });
  if (!metadata.success) {
    metadata.error.issues.forEach((issue) =>
      add("invalid-draft", issue.message, issuePath(issue.path)),
    );
    return failed(diagnostics);
  }

  const rootNode = node.data;
  const activePackIds = libraryPacksForOperators(operators, packs).map((pack) => pack.id);
  const digest = problemSetupDigest(rootNode, operators, metadata.data);
  const value = freezeDetached({
    draft,
    rootNode,
    operators,
    metadata: metadata.data,
    review: { rootNode, operators, metadata: metadata.data, activePackIds, digest },
  }) as ValidatedProblemDraft;
  return Object.freeze({ ok: true as const, diagnostics: [] as const, value });
}

/** `sha256:` digest of exactly what approval stores. */
export function problemSetupDigest(
  rootNode: ProofNode,
  operators: readonly OperatorDeclaration[],
  metadata: ProofSessionMetadata,
): ProblemSetupReview["digest"] {
  return definitionHash({ rootNode, operators, metadata });
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

export type ApproveProblemSessionOptions = Readonly<{ packs?: readonly LibraryPack[] }>;

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
  const validated = validateProblemDraft(request.data.draft, options.packs);
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
