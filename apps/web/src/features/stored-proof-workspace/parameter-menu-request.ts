import {
  protocolRequiresInputResponseSchema,
  type MenuChoices,
  type ProtocolRequiresInputResponse,
} from "@proof/protocol";
import { protocolCommandApiResponseSchema } from "./api-contract";

/** The legacy preview route's actor; the menu round trip records nothing under it. */
const WEB_ACTOR = { id: "actor:web", kind: "human" } as const;

export type ParameterMenuRequest = Readonly<{
  commandId: string;
  nodeId: string;
  suggestionSetId: string;
  suggestionId: string;
  menuChoices: MenuChoices;
}>;

export type ParameterMenuResult =
  | Readonly<{
      ok: true;
      menus: ProtocolRequiresInputResponse["menus"];
      missingParameters: readonly string[];
    }>
  /** The move needed no further input, so the preview was recorded under the command ID. */
  | Readonly<{ ok: true; previewRecorded: true }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Ask the command protocol (N25) for the input menus of a displayed move. The worker
 * regenerates the menus from the stored snapshot and records nothing while input is missing;
 * the web app never computes a menu itself.
 */
export async function requestParameterMenus(
  sessionId: string,
  request: ParameterMenuRequest,
): Promise<ParameterMenuResult> {
  try {
    const response = await fetch(
      `/api/proof-sessions/${encodeURIComponent(sessionId)}/protocol-commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: request.commandId,
          actor: WEB_ACTOR,
          basis: { nodeId: request.nodeId, suggestionSetId: request.suggestionSetId },
          command: {
            kind: "preview",
            suggestion: request.suggestionId,
            suggestionSetId: request.suggestionSetId,
            ...(Object.keys(request.menuChoices).length === 0
              ? {}
              : { menuChoices: request.menuChoices }),
          },
        }),
        cache: "no-store",
      },
    );
    const parsed = protocolCommandApiResponseSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.ok !== response.ok) return invalidMenuResponse();
    if (parsed.data.ok) return { ok: true, previewRecorded: true };
    if (parsed.data.error.code !== "requires-input") {
      return { ok: false, message: parsed.data.error.message || "The input menus were refused." };
    }
    const details = protocolRequiresInputResponseSchema.safeParse(parsed.data.details);
    if (
      !details.success ||
      details.data.commandId !== request.commandId ||
      details.data.suggestionSetId !== request.suggestionSetId ||
      details.data.chosenSuggestionId !== request.suggestionId
    ) {
      return invalidMenuResponse();
    }
    return {
      ok: true,
      menus: details.data.menus,
      missingParameters: details.data.missingParameters,
    };
  } catch {
    return { ok: false, message: "The input menus could not be reached." };
  }
}

function invalidMenuResponse(): ParameterMenuResult {
  return { ok: false, message: "The proof service returned invalid input menus." };
}
