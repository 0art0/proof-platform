import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { pathSegments, readJsonBody, writeJson } from "./http-util";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

/** A server that answers every request with what `readJsonBody` made of it. */
async function serve(maxBytes: number): Promise<string> {
  const server = createServer((request, response) => {
    void readJsonBody(request, { maxBytes }).then((body) => {
      if (body.ok) writeJson(response, 200, { value: body.value });
      else writeJson(response, body.status, { message: body.message });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function post(origin: string, contentType: string | undefined, body: string): Promise<Response> {
  return fetch(origin, {
    method: "POST",
    ...(contentType === undefined ? {} : { headers: { "content-type": contentType } }),
    body,
  });
}

/** A request whose body is `chunks` of 1 KiB, counting how many the reader pulled. */
function streamedRequest(chunks: number, contentType = "application/json") {
  const state = { pulled: 0 };
  const stream = new Readable({
    read() {
      state.pulled += 1;
      this.push(state.pulled <= chunks ? Buffer.alloc(1024, 0x20) : null);
    },
  });
  const request = Object.assign(stream, {
    headers: { "content-type": contentType },
  }) as unknown as IncomingMessage;
  return { request, state, stream };
}

describe("pathSegments", () => {
  it("splits the path, drops empty segments and the query, and decodes escapes", () => {
    expect(pathSegments("/proof-sessions/session%3Aa//nodes/?x=1#y")).toEqual([
      "proof-sessions",
      "session:a",
      "nodes",
    ]);
    expect(pathSegments("/")).toEqual([]);
    expect(pathSegments(undefined)).toEqual([]);
  });

  it("is undefined for an undecodable escape", () => {
    expect(pathSegments("/proof-sessions/%E0%A4%A")).toBeUndefined();
  });
});

describe("writeJson", () => {
  it("answers JSON that must not be cached, including when no route chose a cache policy", async () => {
    const origin = await serve(1024);
    const response = await post(origin, "application/json", '{"a":1}');
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ value: { a: 1 } });
  });
});

describe("readJsonBody content type", () => {
  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "application/json;charset=UTF-8",
    "Application/JSON",
    "  APPLICATION/json ; charset=utf-8",
  ])("accepts %j", async (contentType) => {
    const origin = await serve(1024);
    const response = await post(origin, contentType, '{"a":[1,2]}');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: { a: [1, 2] } });
  });

  it.each([
    "text/plain",
    "application/jsonx",
    "application/json-seq",
    "application/vnd.api+json",
    "text/html; application/json",
  ])("answers 415 for %j", async (contentType) => {
    const origin = await serve(1024);
    const response = await post(origin, contentType, "{}");
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ message: "Content-Type must be application/json." });
  });

  it("answers 415 without a content type", async () => {
    const origin = await serve(1024);
    const response = await fetch(origin, { method: "POST", body: new Uint8Array([123, 125]) });
    expect(response.status).toBe(415);
  });
});

describe("readJsonBody size and syntax", () => {
  it("accepts a body of exactly maxBytes and rejects one byte more with 413", async () => {
    const origin = await serve(64);
    const exact = JSON.stringify({ p: "x".repeat(64 - '{"p":""}'.length) });
    expect(new TextEncoder().encode(exact).byteLength).toBe(64);
    expect((await post(origin, "application/json", exact)).status).toBe(200);

    const over = await post(origin, "application/json", `${exact} `);
    expect(over.status).toBe(413);
    expect(over.headers.get("cache-control")).toBe("no-store");
    expect(over.headers.get("connection")).toBe("close");
    expect(await over.json()).toEqual({ message: "The JSON request body is too large." });
  });

  it("answers 413 for a body far over maxBytes, even a charset-qualified one", async () => {
    const origin = await serve(1024);
    const response = await post(
      origin,
      "application/json; charset=utf-8",
      JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }),
    );
    expect(response.status).toBe(413);
  });

  it("answers 400 for an empty or malformed body", async () => {
    const origin = await serve(1024);
    const empty = await post(origin, "application/json", "");
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ message: "A JSON request body is required." });
    const malformed = await post(origin, "application/json", "{");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ message: "The JSON request body is malformed." });
  });

  it("stops reading once the body exceeds maxBytes, and leaves the request usable", async () => {
    const { request, state, stream } = streamedRequest(10_000);
    expect(await readJsonBody(request, { maxBytes: 4 * 1024 })).toEqual({
      ok: false,
      status: 413,
      message: "The JSON request body is too large.",
    });
    // The stream may fill its own buffer ahead of the reader, but nothing keeps draining it: it
    // settles far short of the 10 MiB body, and it is not destroyed (the answer is still to be
    // written).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const settled = state.pulled;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.pulled).toBe(settled);
    expect(settled).toBeLessThan(200);
    expect(stream.destroyed).toBe(false);
  });

  it("answers 400 when the request stream fails", async () => {
    const stream = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });
    const request = Object.assign(stream, {
      headers: { "content-type": "application/json" },
    }) as unknown as IncomingMessage;
    expect(await readJsonBody(request, { maxBytes: 1024 })).toEqual({
      ok: false,
      status: 400,
      message: "The JSON request body could not be read.",
    });
  });
});
