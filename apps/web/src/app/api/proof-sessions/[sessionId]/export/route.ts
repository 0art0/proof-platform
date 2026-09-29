import { artifactFileName, exportProofArtifact } from "../../../../../server/proof-service";
import { proofProtocolAnswer, proofServiceFailure } from "../../http";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

type RouteContext = Readonly<{
  params: Promise<Readonly<{ sessionId: string }>>;
}>;

/**
 * Download a session's versioned proof artifact (roadmap N27). A success is the artifact JSON
 * itself, not wrapped, as an attachment; a failure is the usual `{ ok: false, error, details }`.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { sessionId } = await context.params;
  try {
    const answer = await exportProofArtifact(sessionId, { signal: request.signal });
    if (!answer.ok) return proofProtocolAnswer(answer);
    return new Response(JSON.stringify(answer.body), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${artifactFileName(sessionId)}"`,
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return proofServiceFailure(error);
  }
}
