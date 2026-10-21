/**
 * What the worker does with a move author's proposal (design plan section 13.3, refinement 7.1).
 *
 * A proposal is evidence in a stored LLM call. This module compiles it into the existing
 * authored-move template language and runs the deterministic checks over it in the session's own
 * environment: the template's schema, every example through the kernel (`validateMoveTemplate`),
 * and the generality notes. Nothing here records a draft or approves anything: a person submits
 * the possibly edited template through `author-move-draft` and reviews it with `review-move-draft`.
 * It also reads a proposal back from storage, for a revision and for the draft's provenance link.
 */
import type { KernelEnvironment } from "@proof/kernel";
import {
  compileMoveAuthorProposal,
  type MoveAuthorContext,
  type MoveAuthorFinding,
  type MoveAuthorProposal,
} from "@proof/llm";
import type { LibraryProvenance } from "@proof/library";
import {
  authoredMoveTemplateSchema,
  describeGenerality,
  validateMoveTemplate,
  type GeneralityNote,
  type MoveTemplateValidation,
} from "@proof/moves/authoring";
import type { OperatorDeclaration } from "@proof/protocol";
import { readLlmCall, type LlmCallOwner, type LlmCallStore } from "./llm-call-repository";

/** The session's environment a proposal's examples run in. */
export type ProposalEnvironment = Readonly<{
  operators: readonly OperatorDeclaration[];
  results?: KernelEnvironment["results"];
  artifactExists: (reference: { kind: string; id: string }) => boolean;
}>;

export type ProposalEvaluation = Readonly<{
  /** The compiled template. It may still break a rule; `validation` says which. */
  template: Record<string, unknown>;
  validation: MoveTemplateValidation;
  /** Notes about generality that are not failures. */
  generality: readonly GeneralityNote[];
}>;

/** Compile a proposal and run the deterministic checks of the authored-move language over it. */
export function evaluateMoveProposal(
  proposal: MoveAuthorProposal,
  context: MoveAuthorContext,
  environment: ProposalEnvironment,
): ProposalEvaluation {
  const kernel: KernelEnvironment = {
    operators: environment.operators,
    ...(environment.results === undefined ? {} : { results: environment.results }),
  };
  const template = compileMoveAuthorProposal({
    proposal,
    context,
    withExamples: true,
    environment: kernel,
  });
  const validation = validateMoveTemplate(template, {
    operators: environment.operators,
    ...(environment.results === undefined ? {} : { results: environment.results }),
    artifactExists: environment.artifactExists,
  });
  const parsed = authoredMoveTemplateSchema.safeParse(template);
  return {
    template,
    validation,
    generality: parsed.success ? describeGenerality(parsed.data, environment.operators) : [],
  };
}

const MAX_FINDINGS = 20;
const MAX_FINDING_LENGTH = 600;

/** What the platform's own checks found, in the form the next revision is shown. */
export function proposalFindings(evaluation: ProposalEvaluation): readonly MoveAuthorFinding[] {
  const found: MoveAuthorFinding[] = [];
  if (!evaluation.validation.ok) {
    for (const diagnostic of evaluation.validation.diagnostics) {
      found.push({
        code: diagnostic.code,
        message: diagnostic.message.slice(0, MAX_FINDING_LENGTH),
        ...(diagnostic.exampleId === undefined ? {} : { exampleId: diagnostic.exampleId }),
      });
    }
  }
  for (const note of evaluation.generality) {
    found.push({ code: note.code, message: note.message.slice(0, MAX_FINDING_LENGTH) });
  }
  return found.slice(0, MAX_FINDINGS);
}

export type StoredProposal = Readonly<{
  callId: string;
  executorCallId: string;
  proposal: MoveAuthorProposal;
  context: MoveAuthorContext;
}>;

export type ReadProposalResult =
  | Readonly<{ status: "found"; stored: StoredProposal }>
  /** No such call in the session's evidence. */
  | Readonly<{
      status: "missing";
      failure: Readonly<{
        status: "rejected" | "uncertain";
        diagnostics: readonly [{ code: string; message: string }];
      }>;
    }>
  /** The call exists but is not a validated move-author proposal. */
  | Readonly<{ status: "not-a-proposal" }>;

/** Read a validated move-author proposal of the session back from storage, never from a client. */
export async function readStoredProposal(
  llmCalls: LlmCallStore,
  sessionId: string,
  callId: string,
): Promise<ReadProposalResult> {
  const owner: LlmCallOwner = { kind: "proof-session", id: sessionId };
  const stored = await readLlmCall(llmCalls, owner, callId);
  if (stored.status !== "found") return { status: "missing", failure: stored };
  const { record } = stored;
  const { envelope } = record.preparedCall;
  if (
    record.status !== "completed" ||
    record.role !== "move-author" ||
    envelope.role !== "move-author" ||
    record.evidence.status !== "validated" ||
    record.evidence.output?.kind !== "move-proposal"
  ) {
    return { status: "not-a-proposal" };
  }
  return {
    status: "found",
    stored: {
      callId,
      executorCallId: envelope.context.executorCallId,
      proposal: record.evidence.output,
      context: envelope.context,
    },
  };
}

/** The provenance a draft carries when a model proposed it: both calls, by ID. */
export function proposalProvenance(
  moveAuthorCallId: string,
  executorCallId: string,
): LibraryProvenance {
  return {
    kind: "generated",
    role: "move-author",
    contextId: moveAuthorCallId,
    sourceContextId: executorCallId,
  };
}
