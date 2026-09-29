/**
 * Read-only library routes (design plan §17.1, roadmap N32):
 *
 * - `GET /proof-sessions/:id/library`: the session's effective library. The global layer is the
 *   approved catalog the session retrieves from (`source: "approved-catalog"`); every artifact the
 *   library store (or, for an imported read-only session, the import record) holds for the global
 *   and session layers follows (`source: "stored-library"`), in the store's listing order.
 * - `GET /proof-sessions/:id/library/events`: the session's addition events in sequence order,
 *   admitted and rejected, each with its admission diagnostics.
 *
 * Both routes only read what is stored or approved; admission and variant generation are never
 * re-run to answer them.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { LibraryAdditionEvent, LibraryArtifact, VariantFamily } from "@proof/library";
import { proofArtifactImportRecordSchema } from "@proof/protocol";
import { listLibrary, readAdditionEvents } from "../library-repository";
import {
  loadSession,
  proofSessionIdSchema,
  safeParse,
  transactionFailure,
  type ProofSessionId,
} from "../proof-repository";
import { repositoryFailureStatus, type ServiceContext } from "./shared";

export type LibraryEntrySource = "approved-catalog" | "stored-library";
export type LibraryEntry = Readonly<{ source: LibraryEntrySource; artifact: LibraryArtifact }>;

export type SessionLibraryResponse = Readonly<{
  sessionId: string;
  /** True for a session imported from an artifact: its library is the artifact's static record. */
  readOnly: boolean;
  entries: readonly LibraryEntry[];
  variantFamilies: readonly VariantFamily[];
}>;

export type SessionLibraryEventsResponse = Readonly<{
  sessionId: string;
  readOnly: boolean;
  events: readonly LibraryAdditionEvent[];
}>;

type Failure = Readonly<{
  status: "rejected" | "uncertain";
  diagnostics: readonly [Readonly<{ code: string; message: string }>];
}>;

/** Handle a library route; false when the request is for another route. */
export async function handleLibraryRoute(
  context: ServiceContext,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const segments = pathSegments(request.url);
  if (segments === undefined || segments[0] !== "proof-sessions" || segments[2] !== "library") {
    return false;
  }
  const events = segments.length === 4 && segments[3] === "events";
  if (segments.length !== 3 && !events) return false;
  const sessionId = proofSessionIdSchema.safeParse(segments[1]);
  if (!sessionId.success) return false;
  if (request.method !== "GET") {
    response.setHeader("allow", "GET");
    writeJson(response, 405, {
      diagnostics: [{ code: "method-not-allowed", message: "Use GET." }],
    });
    return true;
  }
  const result = events
    ? await readEvents(context, sessionId.data)
    : await readLibrary(context, sessionId.data);
  if ("diagnostics" in result) {
    writeJson(response, repositoryFailureStatus(result), { diagnostics: result.diagnostics });
  } else {
    writeJson(response, 200, result);
  }
  return true;
}

type ImportedLibrary = Readonly<{
  artifacts: readonly LibraryArtifact[];
  events: readonly LibraryAdditionEvent[];
}>;

type SessionBasis = Readonly<{
  operators: Parameters<ServiceContext["definitions"]["catalog"]>[0];
  imported: ImportedLibrary | undefined;
}>;

async function readBasis(
  context: ServiceContext,
  sessionId: ProofSessionId,
): Promise<SessionBasis | Failure> {
  try {
    return await context.store.transaction(async (transaction): Promise<SessionBasis | Failure> => {
      const loaded = await loadSession(transaction, sessionId, context.definitions);
      if (!loaded.ok) return loaded.failure;
      const operators = loaded.session.operators;
      const importInput = await transaction.readArtifactImport(sessionId);
      if (importInput === undefined) return { operators, imported: undefined };
      const record = safeParse(proofArtifactImportRecordSchema, importInput);
      if (record === undefined || record.sessionId !== sessionId) {
        return failure("invalid-proof-history", "The stored artifact import record is invalid.");
      }
      return {
        operators,
        imported: {
          // The import record was fully validated when the artifact was imported.
          artifacts: record.library.finalLibrary as unknown as readonly LibraryArtifact[],
          events: record.library.additionEvents as unknown as readonly LibraryAdditionEvent[],
        },
      };
    });
  } catch (error: unknown) {
    return transactionFailure(error, "The proof session could not be read.");
  }
}

async function readLibrary(
  context: ServiceContext,
  sessionId: ProofSessionId,
): Promise<SessionLibraryResponse | Failure> {
  const basis = await readBasis(context, sessionId);
  if ("diagnostics" in basis) return basis;
  const catalog = context.definitions.catalog(basis.operators);
  let stored: readonly LibraryArtifact[];
  if (basis.imported !== undefined) {
    stored = basis.imported.artifacts;
  } else if (context.library === undefined) {
    stored = [];
  } else {
    const listed = await listLibrary(context.library, { sessionId });
    if (listed.status !== "found") return listed;
    stored = listed.artifacts;
  }
  return {
    sessionId,
    readOnly: basis.imported !== undefined,
    entries: [
      ...catalog.results.map((artifact) => ({ source: "approved-catalog" as const, artifact })),
      ...stored.map((artifact) => ({ source: "stored-library" as const, artifact })),
    ],
    variantFamilies: catalog.variantFamilies,
  };
}

async function readEvents(
  context: ServiceContext,
  sessionId: ProofSessionId,
): Promise<SessionLibraryEventsResponse | Failure> {
  const basis = await readBasis(context, sessionId);
  if ("diagnostics" in basis) return basis;
  const readOnly = basis.imported !== undefined;
  if (basis.imported !== undefined) {
    return { sessionId, readOnly, events: basis.imported.events };
  }
  if (context.library === undefined) return { sessionId, readOnly, events: [] };
  const read = await readAdditionEvents(context.library, sessionId);
  if (read.status !== "found") return read;
  return { sessionId, readOnly, events: read.events };
}

function failure(code: string, message: string): Failure {
  return { status: "rejected", diagnostics: [{ code, message }] };
}

function pathSegments(requestTarget: string | undefined): string[] | undefined {
  try {
    return new URL(requestTarget ?? "/", "http://proof.local").pathname
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
