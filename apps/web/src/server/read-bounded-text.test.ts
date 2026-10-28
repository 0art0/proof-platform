import { describe, expect, it, vi } from "vitest";
import { BoundedBodyError, readBoundedText } from "./read-bounded-text";

const encoder = new TextEncoder();

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function source(body: ReadableStream<Uint8Array> | null, headers: HeadersInit = {}) {
  return { headers: new Headers(headers), body };
}

describe("readBoundedText", () => {
  it("returns the text of a body within the limit, including one with no body", async () => {
    await expect(readBoundedText(source(streamOf([encoder.encode("hello")])), 5)).resolves.toBe(
      "hello",
    );
    await expect(readBoundedText(source(null), 5)).resolves.toBe("");
  });

  it("decodes a multi-byte character that is split across chunks", async () => {
    const bytes = encoder.encode("a∑b");
    const split = [bytes.slice(0, 2), bytes.slice(2)];
    await expect(readBoundedText(source(streamOf(split)), bytes.byteLength)).resolves.toBe("a∑b");
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("x"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const reader = vi.spyOn(body, "getReader");
    await expect(
      readBoundedText(source(body, { "content-length": "11" }), 10),
    ).rejects.toMatchObject({ reason: "too-large" });
    expect(reader).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
  });

  it("counts bytes when no length is declared or the declared length is too small", async () => {
    for (const headers of [{}, { "content-length": "3" }]) {
      await expect(
        readBoundedText(
          source(streamOf([encoder.encode("0123456"), encoder.encode("789a")]), headers),
          10,
        ),
      ).rejects.toMatchObject({ reason: "too-large" });
    }
  });

  it("cancels the stream at the first byte past the limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode("xxxx"));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(readBoundedText(source(body), 10)).rejects.toBeInstanceOf(BoundedBodyError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("accepts a body of exactly the limit", async () => {
    await expect(
      readBoundedText(source(streamOf([encoder.encode("01234"), encoder.encode("56789")])), 10),
    ).resolves.toBe("0123456789");
  });

  it("reports a stream that fails or was already read as unreadable", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("connection reset");
      },
    });
    await expect(readBoundedText(source(failing), 10)).rejects.toMatchObject({
      reason: "unreadable",
    });

    const used = streamOf([encoder.encode("x")]);
    used.getReader();
    await expect(readBoundedText(source(used), 10)).rejects.toMatchObject({
      reason: "unreadable",
    });
  });
});
