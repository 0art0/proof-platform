import { recordInteractionEventRequestSchema } from "@proof/protocol";
import type { z } from "zod";

type WithoutId<Request> = Request extends unknown ? Omit<Request, "id"> : never;

/**
 * An interaction event as the workspace reports it (unbranded input; the recorder validates it
 * strictly and assigns the client event ID).
 */
export type InteractionEventInput = WithoutId<z.input<typeof recordInteractionEventRequestSchema>>;

export type InteractionRecorder = (event: InteractionEventInput) => void;

/**
 * Report interaction events (refinement §12.1) to the proof service in the order they happen.
 * Posts are serialized so the worker assigns sequence numbers in reporting order. Recording is
 * best effort: a failed post never blocks or changes the workspace.
 */
export function createInteractionRecorder(sessionId: string): InteractionRecorder {
  let queue: Promise<void> = Promise.resolve();
  const url = `/api/proof-sessions/${encodeURIComponent(sessionId)}/interaction-events`;
  return (event) => {
    const request = recordInteractionEventRequestSchema.safeParse({
      id: `interaction:web-${crypto.randomUUID()}`,
      ...event,
    });
    if (!request.success) return;
    const body = JSON.stringify(request.data);
    queue = queue.then(async () => {
      try {
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          cache: "no-store",
        });
      } catch {
        // Interaction evidence is advisory; the proof state is never affected.
      }
    });
  };
}
