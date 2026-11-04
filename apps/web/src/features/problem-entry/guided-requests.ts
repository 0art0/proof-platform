import {
  backgroundProfileSchema,
  operatorDeclarationSchema,
  plainMathJsonSchema,
  problemDraftSchema,
  problemSetupReviewSchema,
  type BackgroundProfile,
  type OperatorDeclaration,
  type ProblemDraft,
  type ProblemSetupReview,
} from "@proof/protocol";
import { z } from "zod";
import { nonProposalSchema, postAi } from "./ai-api";

/**
 * The guided problem entry's calls to the web application's routes. Each returns a plain result:
 * what the worker answered, or a message a person can read. Requests name stored calls and
 * decisions; they never carry declarations or artifacts the worker did not produce, except the
 * person's own edits to a background, which the worker checks (`background-amendment.ts`).
 */

export type Failed = Readonly<{ ok: false; message: string; status?: number | undefined }>;

const constantSchema = z.object({ operator: operatorDeclarationSchema, rationale: z.string() });
export type ProposedConstant = z.infer<typeof constantSchema>;

const proposalSchema = z.object({
  kind: z.literal("background-proposal"),
  background: backgroundProfileSchema,
  constants: z.array(constantSchema),
});
export type BackgroundProposal = z.infer<typeof proposalSchema>;

const backgroundAnswerSchema = z.union([
  z.object({ status: z.literal("proposed"), callId: z.string(), proposal: proposalSchema }),
  nonProposalSchema,
]);

export type ProposedBackground = Readonly<{
  ok: true;
  callId: string;
  proposal: BackgroundProposal;
}>;

/**
 * Ask for a background. An answer that does not pass validation is asked for once more, with a
 * new call: both calls are recorded, and the person is spared an error they cannot act on.
 */
export async function proposeBackground(
  input: Readonly<{
    constructionId: string;
    createId: (prefix: string) => string;
    problem: Readonly<{ title: string; statement: string }>;
    revision?: Readonly<{ previousCallId: string; feedback: string }> | undefined;
  }>,
): Promise<ProposedBackground | Failed> {
  let answer = await askBackground(input);
  if (!answer.ok && answer.status === 422) answer = await askBackground(input);
  return answer;
}

async function askBackground(
  input: Parameters<typeof proposeBackground>[0],
): Promise<ProposedBackground | Failed> {
  const answer = await postAi("/api/ai/background", {
    constructionId: input.constructionId,
    id: input.createId("llm-call:background"),
    problem: input.problem,
    ...(input.revision === undefined ? {} : { revision: input.revision }),
  });
  if (!answer.ok) return { ok: false, message: answer.message, status: answer.status };
  const parsed = backgroundAnswerSchema.safeParse(answer.data);
  if (!parsed.success) return invalid();
  if (parsed.data.status !== "proposed") {
    const result = parsed.data.result;
    return {
      ok: false,
      message:
        result.kind === "declined"
          ? `No background was suggested: ${result.reason}`
          : `More detail is needed: ${result.rationale}`,
    };
  }
  return { ok: true, callId: parsed.data.callId, proposal: parsed.data.proposal };
}

const libraryResultSchema = z.object({
  artifact: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    statement: z.object({ expression: plainMathJsonSchema }),
    premises: z.array(z.object({ expression: plainMathJsonSchema })),
    renderings: z.object({ latex: z.string(), naturalLanguage: z.string() }),
  }),
  variants: z.array(z.object({ id: z.string() })),
  newConstantSymbols: z.array(z.string()),
});
export type LibraryResult = z.infer<typeof libraryResultSchema>;

const libraryAnswerSchema = z.union([
  z.object({
    status: z.literal("proposed"),
    callId: z.string(),
    results: z.array(libraryResultSchema),
    newConstants: z.array(constantSchema),
  }),
  nonProposalSchema,
]);

export type BuiltLibrary = Readonly<{
  ok: true;
  callId: string;
  /** The background proposal the library was built from. */
  backgroundCallId: string;
  results: readonly LibraryResult[];
  newConstants: readonly ProposedConstant[];
  /** Why the library is empty, when the librarian declined or asked for more detail. */
  note?: string | undefined;
}>;

type LibraryInput = Readonly<{
  constructionId: string;
  createId: (prefix: string) => string;
  backgroundCallId: string;
}>;

/**
 * Build a library from a background proposal under review; the librarian never sees the problem.
 * An answer that does not pass validation is asked for once more, as for a background.
 */
export async function buildLibrary(input: LibraryInput): Promise<BuiltLibrary | Failed> {
  const answer = await askLibrary(input);
  return !answer.ok && answer.status === 422 ? askLibrary(input) : answer;
}

async function askLibrary(input: LibraryInput): Promise<BuiltLibrary | Failed> {
  const answer = await postAi("/api/ai/library", {
    constructionId: input.constructionId,
    id: input.createId("llm-call:library"),
    backgroundProposal: { callId: input.backgroundCallId },
    packs: [],
  });
  if (!answer.ok) return { ok: false, message: answer.message, status: answer.status };
  const parsed = libraryAnswerSchema.safeParse(answer.data);
  if (!parsed.success) return invalid();
  if (parsed.data.status !== "proposed") {
    // The library is optional: a refusal or a request for detail is an empty library with a note.
    const result = parsed.data.result;
    return {
      ok: true,
      callId: "",
      backgroundCallId: input.backgroundCallId,
      results: [],
      newConstants: [],
      note: result.kind === "declined" ? result.reason : result.rationale,
    };
  }
  return {
    ok: true,
    callId: parsed.data.callId,
    backgroundCallId: input.backgroundCallId,
    results: parsed.data.results,
    newConstants: parsed.data.newConstants,
  };
}

/** The person's edits to a background, as the worker checks them. */
export type BackgroundAmendment = Readonly<{
  background: BackgroundProfile;
  constants: readonly OperatorDeclaration[];
}>;

const decisionAnswerSchema = z.object({ status: z.literal("recorded") }).passthrough();

/** Approve a background proposal, with the person's edits when there are any. */
export async function approveBackground(
  input: Readonly<{
    constructionId: string;
    decisionId: string;
    callId: string;
    amendment: BackgroundAmendment | undefined;
  }>,
): Promise<Readonly<{ ok: true }> | Failed> {
  const answer = await postAi("/api/ai/background/decisions", {
    constructionId: input.constructionId,
    decisionId: input.decisionId,
    callId: input.callId,
    decision: "approved",
    rationale:
      input.amendment === undefined ? "Accepted as proposed." : "Accepted with the person's edits.",
    decidedAt: new Date().toISOString(),
    ...(input.amendment === undefined ? {} : { amendment: input.amendment }),
  });
  if (!answer.ok) return { ok: false, message: answer.message, status: answer.status };
  return decisionAnswerSchema.safeParse(answer.data).success ? { ok: true } : invalid();
}

const libraryDecisionAnswerSchema = z.object({
  status: z.literal("recorded"),
  approvedLibrary: z.object({ variantCount: z.number().int().nonnegative() }),
});

/** Keep library results; the worker reads the artifacts from the stored call. */
export async function approveLibrary(
  input: Readonly<{
    constructionId: string;
    decisionId: string;
    callId: string;
    resultIds: readonly string[];
  }>,
): Promise<Readonly<{ ok: true; variantCount: number }> | Failed> {
  const answer = await postAi("/api/ai/library/decisions", {
    constructionId: input.constructionId,
    decisionId: input.decisionId,
    callId: input.callId,
    approvedResultIds: input.resultIds,
    decidedAt: new Date().toISOString(),
  });
  if (!answer.ok) return { ok: false, message: answer.message, status: answer.status };
  const parsed = libraryDecisionAnswerSchema.safeParse(answer.data);
  return parsed.success
    ? { ok: true, variantCount: parsed.data.approvedLibrary.variantCount }
    : invalid();
}

const formalizeAnswerSchema = z.union([
  z.object({
    status: z.literal("ready-for-review"),
    callId: z.string(),
    draft: problemDraftSchema,
  }),
  nonProposalSchema,
]);
const needsReviewSchema = z.object({
  status: z.literal("needs-review"),
  callId: z.string(),
  draft: problemDraftSchema,
  diagnostics: z.array(z.object({ code: z.string(), message: z.string() })).min(1),
});

export type DraftedSetup =
  | Readonly<{ ok: true; callId: string; draft: ProblemDraft }>
  /** A draft that did not pass the worker's check, for a person to fix. */
  | Readonly<{ ok: false; message: string; callId: string; draft: ProblemDraft }>
  | Failed;

export type SetupContext = Pick<
  ProblemDraft,
  "problem" | "background" | "libraryLayerIds" | "packs"
>;

/** Draft the variables, hypotheses and goals with the approved background and library. */
export async function draftSetup(
  input: Readonly<{
    constructionId: string;
    createId: (prefix: string) => string;
    context: SetupContext;
    backgroundDecisionId: string;
    libraryDecisionId: string | undefined;
  }>,
): Promise<DraftedSetup> {
  const answer = await postAi("/api/ai/formalize", {
    constructionId: input.constructionId,
    id: input.createId("llm-call:formalize"),
    ...input.context,
    approvedBackground: { decisionId: input.backgroundDecisionId },
    ...(input.libraryDecisionId === undefined
      ? {}
      : { approvedLibrary: { decisionId: input.libraryDecisionId } }),
  });
  if (!answer.ok) {
    const review = needsReviewSchema.safeParse(answer.details);
    return review.success
      ? {
          ok: false,
          message: review.data.diagnostics.map(({ message }) => message).join(" "),
          callId: review.data.callId,
          draft: review.data.draft,
        }
      : { ok: false, message: answer.message, status: answer.status };
  }
  const parsed = formalizeAnswerSchema.safeParse(answer.data);
  if (!parsed.success) return invalid();
  if (parsed.data.status !== "ready-for-review") {
    const result = parsed.data.result;
    return {
      ok: false,
      message:
        result.kind === "declined"
          ? `The setup was not drafted: ${result.reason}`
          : `The setup needs more detail: ${result.rationale}`,
    };
  }
  return { ok: true, callId: parsed.data.callId, draft: parsed.data.draft };
}

const validateAnswerSchema = z.object({ ok: z.literal(true), review: problemSetupReviewSchema });

/** The approvals a setup check and a session approval name. */
export type ApprovalReferences = Readonly<{
  approvedBackground: Readonly<{ constructionId: string; decisionId: string }>;
  approvedLibrary?: Readonly<{ constructionId: string; decisionId: string }> | undefined;
}>;

/** Check a drafted setup; the answer is the exact review the approval must name. */
export async function checkSetup(
  draft: ProblemDraft,
  references: ApprovalReferences,
): Promise<Readonly<{ ok: true; review: ProblemSetupReview }> | Failed> {
  const answer = await postAi("/api/problem-drafts/validate", { draft, ...references });
  if (!answer.ok) {
    const diagnostics = z
      .object({ diagnostics: z.array(z.object({ message: z.string() })).min(1) })
      .safeParse(answer.details);
    return {
      ok: false,
      message: diagnostics.success
        ? diagnostics.data.diagnostics.map(({ message }) => message).join(" ")
        : answer.message,
      status: answer.status,
    };
  }
  const parsed = validateAnswerSchema.safeParse(answer.data);
  return parsed.success ? { ok: true, review: parsed.data.review } : invalid();
}

/** Create the session from the checked setup; only this creates the root node. */
export async function startSession(
  input: Readonly<{
    sessionId: string;
    draft: ProblemDraft;
    review: ProblemSetupReview;
    references: ApprovalReferences;
  }>,
): Promise<Readonly<{ ok: true }> | Failed> {
  const answer = await postAi("/api/proof-sessions", {
    sessionId: input.sessionId,
    draft: input.draft,
    reviewedDigest: input.review.digest,
    ...input.references,
  });
  return answer.ok ? { ok: true } : { ok: false, message: answer.message, status: answer.status };
}

function invalid(): Failed {
  return { ok: false, message: "The proof service returned an invalid response." };
}
