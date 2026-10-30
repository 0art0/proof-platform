import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readBoundedJson, RequestBodyError, validateSameOriginRequest } from "./http";

// Next reports the request URL as localhost on its own port; `host` is what the browser sent.
function mutation(origin: string, host: string | null, fetchSite = "same-origin"): Request {
  const headers: Record<string, string> = { origin, "sec-fetch-site": fetchSite };
  if (host !== null) headers.host = host;
  return new Request("http://localhost:3000/api/x", { method: "POST", headers });
}

describe("validateSameOriginRequest", () => {
  it("accepts the request URL's origin, and a loopback origin naming the Host it reached", () => {
    for (const [origin, host] of [
      ["http://localhost:3000", null],
      ["http://localhost:3000", "localhost:3000"],
      ["http://127.0.0.1:3000", "127.0.0.1:3000"],
      ["http://[::1]:3000", "[::1]:3000"],
      // A port forward from 40061 to the server's port 3000.
      ["http://127.0.0.1:40061", "127.0.0.1:40061"],
      ["http://localhost:40061", "localhost:40061"],
    ] as const) {
      expect(validateSameOriginRequest(mutation(origin, host))).toBe(undefined);
    }
  });

  it("rejects foreign and rebinding origins, other local pages, and cross-site fetches", () => {
    for (const [origin, host, fetchSite] of [
      ["http://evil.example:3000", "localhost:3000", "same-origin"],
      // DNS rebinding: the attacker's name resolves to loopback, so Host matches the origin.
      ["http://evil.example:3000", "evil.example:3000", "same-origin"],
      ["http://127.0.0.1:5000", "127.0.0.1:40061", "same-origin"],
      ["http://127.0.0.1:40061", null, "same-origin"],
      ["http://127.0.0.1:40061", "127.0.0.1:40061", "same-site"],
      ["http://localhost:3000", "localhost:3000", "cross-site"],
    ] as const) {
      expect(validateSameOriginRequest(mutation(origin, host, fetchSite))?.status).toBe(403);
    }
  });
});

function streamedRequest(body: ReadableStream<Uint8Array>): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
}

describe("readBoundedJson", () => {
  it("parses a JSON body within the limit", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      body: JSON.stringify({ a: 1 }),
    });
    await expect(readBoundedJson(request, 64)).resolves.toEqual({ a: 1 });
  });

  it("answers 413 for a declared length over the limit", async () => {
    const request = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-length": "65" },
      body: "{}",
    });
    await expect(readBoundedJson(request, 64)).rejects.toMatchObject({ status: 413 });
  });

  it("answers 413 and cancels a streamed body that declares no length", async () => {
    const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
    let pulls = 0;
    let cancelled = false;
    const request = streamedRequest(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    expect(request.headers.get("content-length")).toBeNull();

    const failure = await readBoundedJson(request, 64 * 1024).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RequestBodyError);
    expect(failure).toMatchObject({ status: 413 });
    expect(cancelled).toBe(true);
    // 64 KiB is four chunks; reading stops right after the chunk that crosses the limit.
    expect(pulls).toBeLessThan(10);
  });

  it("answers 400 for an empty or malformed body", async () => {
    for (const body of ["", "{"]) {
      const request = new Request("http://localhost/api/test", { method: "POST", body });
      await expect(readBoundedJson(request, 64)).rejects.toMatchObject({ status: 400 });
    }
    await expect(
      readBoundedJson(new Request("http://localhost/api/test", { method: "POST" }), 64),
    ).rejects.toMatchObject({ status: 400 });
  });
});
