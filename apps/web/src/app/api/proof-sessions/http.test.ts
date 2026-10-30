import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readBoundedJson, RequestBodyError, validateSameOriginRequest } from "./http";

function mutation(url: string, origin: string, fetchSite = "same-origin"): Request {
  return new Request(url, {
    method: "POST",
    headers: { origin, "sec-fetch-site": fetchSite },
  });
}

describe("validateSameOriginRequest", () => {
  it("accepts the request's own origin and its loopback aliases on the same port", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      expect(validateSameOriginRequest(mutation("http://localhost:3000/api/x", origin))).toBe(
        undefined,
      );
    }
  });

  it("rejects other hosts, ports and schemes, and cross-site fetches", () => {
    for (const [url, origin, fetchSite] of [
      ["http://localhost:3000/api/x", "http://evil.example:3000", "same-origin"],
      ["http://localhost:3000/api/x", "http://127.0.0.1:3001", "same-origin"],
      ["http://localhost:3000/api/x", "https://127.0.0.1:3000", "same-origin"],
      ["http://app.example/api/x", "http://localhost", "same-origin"],
      ["http://localhost:3000/api/x", "http://127.0.0.1:3000", "cross-site"],
    ] as const) {
      expect(validateSameOriginRequest(mutation(url, origin, fetchSite))?.status).toBe(403);
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
