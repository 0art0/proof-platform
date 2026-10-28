/**
 * HTTP routes for manual problem and session creation (roadmap N26):
 *
 * - `GET /problem-setup/options`: sort, layer and pack menus;
 * - `POST /problem-drafts/validate` `{ draft, approvedBackground? }`: 200 `{ ok: true, review }` or
 *   422 `{ ok: false, diagnostics }` with draft paths; writes nothing;
 * - `POST /proof-sessions` `{ sessionId, draft, reviewedDigest, approvedBackground? }`: approval.
 *   201 creates the session and root node; 200 replays an identical approval; 422 an invalid
 *   draft; 409 a stale review or an existing session with other content. Only a 201 writes.
 *
 * `approvedBackground` is `{ constructionId, decisionId }`, naming an approved background decision
 * (`POST /ai/background/decisions`). The worker resolves its constants from storage and adds them
 * to the session's operators; a missing decision is 404, a rejected one 409. The reviewed digest
 * covers the operators, so approving with other constants than the review used is stale.
 *
 * `approvedLibrary` is `{ constructionId, decisionId }` too, naming an approved library decision
 * (`POST /ai/library/decisions`). The worker resolves the kept results from the stored librarian
 * call, runs the library gate again in the setup's operators, adds the new constants the kept
 * results apply to the session's operators, and shows the results in the review (its digest
 * covers them in full). Only a 201 or a replayed 200 records them, as `setup` additions to the
 * session's `initial-problem` layer, idempotently (see `approved-library.ts`): if recording is
 * interrupted the answer is 503, and approving again with the same request finishes it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createProofNodeSchema,
  problemDraftValidationResponseSchema,
  problemSetupDiagnosticSchema,
  problemSetupOptionsSchema,
  proofSessionMetadataSchema,
  type OperatorDeclaration,
} from "@proof/protocol";
import { z } from "zod";
import {
  constructionApprovedBackgroundSchema,
  loadApprovedConstants,
} from "../approved-background";
import {
  constructionApprovedLibrarySchema,
  loadApprovedLibrary,
  recordInitialLibrary,
} from "../approved-library";
import type { ApprovedInitialLibrary } from "../library-proposal";
import { approveProblemSession, problemSetupOptions, validateProblemDraft } from "../problem-setup";
import { proofSessionSchema, type ProofSession } from "../proof-repository";
import { readJsonBody, writeJson } from "./http-util";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export const problemSessionResponseSchema = z
  .object({
    session: proofSessionSchema.refine(
      (session) => session.metadata === undefined,
      "HTTP session objects omit metadata.",
    ),
    /** The root node the approval created. */
    node: z.unknown(),
    metadata: proofSessionMetadataSchema,
    replayed: z.boolean(),
  })
  .strict();

export const problemDraftFailureResponseSchema = z
  .object({ diagnostics: z.array(problemSetupDiagnosticSchema).min(1) })
  .strict();

/** Handle a problem-setup route; false when the request is for another route. */
export async function handleProblemSetupRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const path = pathname(request.url);
  if (path === "/problem-setup/options" && request.method === "GET") {
    writeValidatedJson(response, 200, problemSetupOptionsSchema, problemSetupOptions());
    return true;
  }

  if (path === "/problem-drafts/validate" && request.method === "POST") {
    const body = await readStrictJson(request, draftValidationBodySchema);
    if (!body.ok) {
      writeJson(response, body.status, invalidRequest(body.message));
      return true;
    }
    const approvals = await resolveApprovals(context, {
      approvedBackground: body.value.approvedBackground,
      approvedLibrary: body.value.approvedLibrary,
    });
    if (!approvals.ok) {
      writeJson(response, approvals.status, { diagnostics: approvals.diagnostics });
      return true;
    }
    const validated = validateProblemDraft(body.value.draft, undefined, {
      constants: approvals.constants,
      library: approvals.library,
    });
    if (validated.ok) {
      writeValidatedJson(response, 200, problemDraftValidationResponseSchema, {
        ok: true,
        review: validated.value.review,
      });
    } else {
      writeValidatedJson(response, 422, problemDraftValidationResponseSchema, {
        ok: false,
        diagnostics: validated.diagnostics,
      });
    }
    return true;
  }

  if (path === "/proof-sessions" && request.method === "POST") {
    const body = await readStrictJson(request, z.unknown());
    if (!body.ok) {
      writeJson(response, body.status, invalidRequest(body.message));
      return true;
    }
    const split = splitApprovals(body.value);
    if (!split.ok) {
      writeJson(response, 400, invalidRequest("The approved background or library is invalid."));
      return true;
    }
    const approvals = await resolveApprovals(context, split);
    if (!approvals.ok) {
      writeJson(response, approvals.status, { diagnostics: approvals.diagnostics });
      return true;
    }
    const approved = await approveProblemSession(context.store, split.request, {
      constants: approvals.constants,
      library: approvals.library,
    });
    switch (approved.status) {
      case "invalid-request":
        writeJson(response, 400, invalidRequest(approved.message));
        return true;
      case "invalid-draft":
        writeValidatedJson(response, 422, problemDraftFailureResponseSchema, {
          diagnostics: approved.diagnostics,
        });
        return true;
      case "review-stale":
      case "session-conflict":
        writeJson(response, 409, {
          diagnostics: [{ code: approved.status, message: approved.message }],
        });
        return true;
      case "failed":
        writeJson(response, repositoryFailureStatus(approved.failure), {
          diagnostics: approved.failure.diagnostics,
        });
        return true;
      case "created":
      case "replayed": {
        // The approved library is recorded for the new session and, idempotently, again for a
        // replay, which finishes an interrupted recording.
        if (approvals.library !== undefined && context.library !== undefined) {
          const recorded = await recordInitialLibrary(
            context.library,
            approved.session.id,
            approvals.library,
          );
          if (!recorded.ok) {
            writeJson(response, recorded.status, { diagnostics: recorded.diagnostics });
            return true;
          }
        }
        writeValidatedJson(
          response,
          approved.status === "created" ? 201 : 200,
          problemSessionResponseSchema.extend({
            node: createProofNodeSchema({ operators: approved.session.operators }),
          }),
          {
            session: withoutMetadata(approved.session),
            node: approved.node,
            metadata: approved.session.metadata,
            replayed: approved.status === "replayed",
          },
        );
        return true;
      }
    }
  }
  return false;
}

const draftValidationBodySchema = z
  .object({
    draft: z.unknown(),
    approvedBackground: constructionApprovedBackgroundSchema.optional(),
    approvedLibrary: constructionApprovedLibrarySchema.optional(),
  })
  .strict();

type ApprovedBackgroundReference = z.infer<typeof constructionApprovedBackgroundSchema>;
type ApprovedLibraryReference = z.infer<typeof constructionApprovedLibrarySchema>;
type ApprovalReferences = Readonly<{
  approvedBackground?: ApprovedBackgroundReference | undefined;
  approvedLibrary?: ApprovedLibraryReference | undefined;
}>;

/**
 * Separate the optional `approvedBackground` and `approvedLibrary` references from an approval
 * body, leaving the strict protocol request (`sessionId`, `draft`, `reviewedDigest`) exactly as
 * the client sent it.
 */
function splitApprovals(
  value: unknown,
): (Readonly<{ ok: true; request: unknown }> & ApprovalReferences) | Readonly<{ ok: false }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: true, request: value };
  }
  const { approvedBackground, approvedLibrary, ...request } = value as Record<string, unknown>;
  const background =
    approvedBackground === undefined
      ? undefined
      : constructionApprovedBackgroundSchema.safeParse(approvedBackground);
  const library =
    approvedLibrary === undefined
      ? undefined
      : constructionApprovedLibrarySchema.safeParse(approvedLibrary);
  if (background?.success === false || library?.success === false) return { ok: false };
  if (background === undefined && library === undefined) return { ok: true, request: value };
  return {
    ok: true,
    request,
    approvedBackground: background?.data,
    approvedLibrary: library?.data,
  };
}

type ResolvedApprovals =
  | Readonly<{
      ok: true;
      constants: readonly OperatorDeclaration[];
      library: ApprovedInitialLibrary | undefined;
    }>
  | Readonly<{
      ok: false;
      status: number;
      diagnostics: readonly [Readonly<{ code: string; message: string }>];
    }>;

/**
 * The constants of the referenced approved background and the results of the referenced approved
 * library, resolved from storage (none if absent). The library's gate runs again here, so it is
 * judged against what is stored now, never against anything the request says.
 */
async function resolveApprovals(
  context: ServiceContext,
  references: ApprovalReferences,
): Promise<ResolvedApprovals> {
  let constants: readonly OperatorDeclaration[] = [];
  if (references.approvedBackground !== undefined) {
    const loaded = await loadApprovedConstants(
      context.llmCalls,
      references.approvedBackground.constructionId,
      references.approvedBackground.decisionId,
    );
    if (!loaded.ok) return loaded;
    constants = loaded.constants;
  }
  let library: ApprovedInitialLibrary | undefined;
  if (references.approvedLibrary !== undefined) {
    if (context.library === undefined) {
      return {
        ok: false,
        status: 503,
        diagnostics: [{ code: "library-unavailable", message: "Library storage is unavailable." }],
      };
    }
    const loaded = await loadApprovedLibrary(
      context.llmCalls,
      references.approvedLibrary.constructionId,
      references.approvedLibrary.decisionId,
    );
    if (!loaded.ok) return loaded;
    library = loaded.library;
  }
  return { ok: true, constants, library };
}

function withoutMetadata(session: ProofSession): ProofSession {
  const { id, rootNodeId, currentNodeId, operators } = session;
  return { id, rootNodeId, currentNodeId, operators };
}

function pathname(requestTarget: string | undefined): string | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

type StrictJson<Output> =
  | Readonly<{ ok: true; value: Output }>
  | Readonly<{ ok: false; status: 400 | 413 | 415; message: string }>;

async function readStrictJson<Output>(
  request: IncomingMessage,
  schema: z.ZodType<Output>,
): Promise<StrictJson<Output>> {
  const body = await readJsonBody(request, { maxBytes: MAX_REQUEST_BODY_BYTES });
  if (!body.ok) return body;
  const parsed = schema.safeParse(body.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, status: 400, message: "The JSON request does not match its strict schema." };
}

function invalidRequest(message: string): unknown {
  return { diagnostics: [{ code: "invalid-request", message }] };
}

function writeValidatedJson<Output>(
  response: ServerResponse,
  status: number,
  schema: z.ZodType<Output>,
  body: unknown,
): void {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    writeJson(response, 500, {
      diagnostics: [
        { code: "invalid-response", message: "The response failed runtime validation." },
      ],
    });
    return;
  }
  writeJson(response, status, parsed.data);
}
