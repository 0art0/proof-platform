import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submitIntent: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("../../../../server/orchestrator-gateway", () => ({
  submitOrchestratorIntent: mocks.submitIntent,
}));

import { POST } from "./route";

const LOCAL_ORIGIN = "http://127.0.0.1:3000";

function request(
  options: Readonly<{
    body?: string;
    contentType?: string;
    forwardedHost?: string;
    host?: string;
    origin?: string | null;
    secFetchSite?: string | null;
    url?: string;
  }> = {},
): Request {
  const headers = new Headers({
    "Content-Type": options.contentType ?? "application/json; charset=utf-8",
    Host: options.host ?? "127.0.0.1:3000",
  });
  if (options.origin !== null) headers.set("Origin", options.origin ?? LOCAL_ORIGIN);
  if (options.secFetchSite !== null) {
    headers.set("Sec-Fetch-Site", options.secFetchSite ?? "same-origin");
  }
  if (options.forwardedHost) headers.set("X-Forwarded-Host", options.forwardedHost);

  return new Request(options.url ?? `${LOCAL_ORIGIN}/api/orchestrator/intent`, {
    method: "POST",
    headers,
    body: options.body ?? JSON.stringify({ message: "Build the next bounded slice" }),
  });
}

afterEach(() => {
  mocks.submitIntent.mockReset();
});

describe("POST /api/orchestrator/intent", () => {
  it("submits a same-origin JSON request through the bounded gateway", async () => {
    mocks.submitIntent.mockResolvedValue({
      messageId: "msg-abcdef123456",
      status: "pending",
      next: "Read the reply later.",
    });

    const response = await POST(request());

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(await response.json()).toMatchObject({
      ok: true,
      data: { messageId: "msg-abcdef123456", status: "pending" },
    });
    expect(mocks.submitIntent).toHaveBeenCalledExactlyOnceWith("Build the next bounded slice");
  });

  it.each([
    ["cross-origin", request({ origin: "https://hostile.example" })],
    ["missing Origin", request({ origin: null })],
    ["cross-site Fetch Metadata", request({ secFetchSite: "cross-site" })],
    ["missing Fetch Metadata", request({ secFetchSite: null })],
    ["host mismatch", request({ host: "localhost:3000" })],
    ["forwarded-host mismatch", request({ forwardedHost: "hostile.example" })],
    [
      "non-loopback exposure",
      request({
        host: "192.0.2.10:3000",
        origin: "http://192.0.2.10:3000",
        url: "http://192.0.2.10:3000/api/orchestrator/intent",
      }),
    ],
  ])("rejects %s requests", async (_label, hostileRequest) => {
    const response = await POST(hostileRequest);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "forbidden_origin" },
    });
    expect(mocks.submitIntent).not.toHaveBeenCalled();
  });

  it("rejects a simple text/plain request before parsing its JSON body", async () => {
    const response = await POST(request({ contentType: "text/plain" }));

    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "unsupported_media_type" },
    });
    expect(mocks.submitIntent).not.toHaveBeenCalled();
  });

  it("rejects malformed and extra browser input without calling the gateway", async () => {
    const malformed = await POST(request({ body: "not json" }));
    const extra = await POST(
      request({ body: JSON.stringify({ message: "Do work", approve: true }) }),
    );

    expect(malformed.status).toBe(400);
    expect(extra.status).toBe(400);
    expect(mocks.submitIntent).not.toHaveBeenCalled();
  });
});
