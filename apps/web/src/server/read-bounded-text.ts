/** Why a body could not be read within its limit. */
export type BoundedBodyFailure = "too-large" | "unreadable";

export class BoundedBodyError extends Error {
  readonly reason: BoundedBodyFailure;

  constructor(reason: BoundedBodyFailure) {
    super(reason === "too-large" ? "The body exceeds its size limit." : "The body was unreadable.");
    this.name = "BoundedBodyError";
    this.reason = reason;
  }
}

/**
 * Read a request or response body as UTF-8 text without ever buffering more than `maxBytes`. A
 * declared `Content-Length` over the limit is refused before any byte is read; otherwise the bytes
 * are counted as they arrive and the stream is cancelled at the first byte past the limit, so a
 * body that omits or understates its length cannot be buffered whole.
 */
export async function readBoundedText(
  source: Readonly<{ headers: Headers; body: ReadableStream<Uint8Array> | null }>,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(source.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await source.body?.cancel().catch(() => undefined);
    throw new BoundedBodyError("too-large");
  }
  if (source.body === null) return "";

  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    const reader = source.body.getReader();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedBodyError("too-large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof BoundedBodyError) throw error;
    throw new BoundedBodyError("unreadable");
  }
}
