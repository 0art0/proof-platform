import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readBoundedJson, RequestBodyError } from "./http";

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
