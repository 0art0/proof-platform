import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readSessionLibraryEvents: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../../../../../server/proof-service", async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, readSessionLibraryEvents: mocks.readSessionLibraryEvents };
});

import { ProofServiceError } from "../../../../../../server/proof-service";
import { GET } from "./route";

const context = { params: Promise.resolve({ sessionId: "session:test" }) };

afterEach(() => mocks.readSessionLibraryEvents.mockReset());

describe("GET /api/proof-sessions/:sessionId/library/events", () => {
  it("returns the addition events with no-store and forwards cancellation", async () => {
    const events = { sessionId: "session:test", readOnly: true, events: [] };
    const request = new Request(
      "http://proof.test/api/proof-sessions/session%3Atest/library/events",
    );
    mocks.readSessionLibraryEvents.mockResolvedValue(events);

    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toEqual({ ok: true, data: events });
    expect(mocks.readSessionLibraryEvents).toHaveBeenCalledExactlyOnceWith("session:test", {
      signal: request.signal,
    });
  });

  it("preserves a service failure", async () => {
    mocks.readSessionLibraryEvents.mockRejectedValue(
      new ProofServiceError("invalid_upstream_response", "Invalid response.", 502),
    );
    const response = await GET(
      new Request("http://proof.test/api/proof-sessions/session%3Atest/library/events"),
      context,
    );
    expect(response.status).toBe(502);
  });
});
