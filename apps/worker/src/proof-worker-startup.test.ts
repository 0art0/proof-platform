import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { startProofWorker, type StartedProofWorker } from "./proof-worker-startup";

const TOKEN = "s".repeat(32);
const SESSION_PATH = "/proof-sessions/session%3Adevelopment";

const workers: StartedProofWorker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

async function start(env: Record<string, string>): Promise<number> {
  const worker = await startProofWorker({ PROOF_STORE: "memory", PROOF_HTTP_PORT: "0", ...env });
  workers.push(worker);
  return Number(new URL(worker.origin).port);
}

/** The status of a GET to the loopback worker, with exact headers (`fetch` cannot set `Host`). */
function status(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path: SESSION_PATH, headers },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("startProofWorker access control", () => {
  it("starts on the default loopback bind with no token and no extra configuration", async () => {
    const port = await start({});
    expect(await status(port, { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await status(port, { host: `localhost:${port}` })).toBe(200);
    expect(await status(port, { host: "evil.example" })).toBe(403);
  });

  it("requires the token on every request once PROOF_HTTP_TOKEN is set, even on loopback", async () => {
    const port = await start({ PROOF_HTTP_TOKEN: "short" });
    const host = `127.0.0.1:${port}`;
    expect(await status(port, { host })).toBe(401);
    expect(await status(port, { host, authorization: "Bearer wrong" })).toBe(401);
    expect(await status(port, { host, authorization: "Bearer short" })).toBe(200);
  });

  it.each([
    ["0.0.0.0", undefined],
    ["0.0.0.0", ""],
    ["0.0.0.0", "x".repeat(31)],
    ["::", undefined],
    ["", undefined],
    ["192.0.2.1", undefined],
  ])(
    "refuses to start on non-loopback PROOF_HTTP_HOST=%j with PROOF_HTTP_TOKEN=%j",
    async (host, token) => {
      await expect(
        startProofWorker({
          PROOF_STORE: "memory",
          PROOF_HTTP_PORT: "0",
          PROOF_HTTP_HOST: host,
          ...(token === undefined ? {} : { PROOF_HTTP_TOKEN: token }),
        }),
      ).rejects.toThrow(/PROOF_HTTP_TOKEN.*at least 32 characters/s);
    },
  );

  it("starts on a non-loopback host with a long token and enforces token and Host", async () => {
    const port = await start({ PROOF_HTTP_HOST: "0.0.0.0", PROOF_HTTP_TOKEN: TOKEN });
    const host = `127.0.0.1:${port}`;
    expect(await status(port, { host })).toBe(401);
    expect(await status(port, { host, authorization: `Bearer ${TOKEN}` })).toBe(200);
    // The wildcard bind address is not a name clients may send; real names are opt-in.
    expect(await status(port, { host: `0.0.0.0:${port}`, authorization: `Bearer ${TOKEN}` })).toBe(
      403,
    );
    expect(await status(port, { host: "evil.example", authorization: `Bearer ${TOKEN}` })).toBe(
      403,
    );
  });

  it("accepts the hosts listed in PROOF_HTTP_ALLOWED_HOSTS", async () => {
    const port = await start({
      PROOF_HTTP_HOST: "0.0.0.0",
      PROOF_HTTP_TOKEN: TOKEN,
      PROOF_HTTP_ALLOWED_HOSTS: "proof-worker, 10.0.0.5",
    });
    const authorization = `Bearer ${TOKEN}`;
    expect(await status(port, { host: `proof-worker:${port}`, authorization })).toBe(200);
    expect(await status(port, { host: "10.0.0.5", authorization })).toBe(200);
    expect(await status(port, { host: "10.0.0.6", authorization })).toBe(403);
  });

  it("rejects malformed access settings before touching the store", async () => {
    await expect(
      startProofWorker({ PROOF_STORE: "memory", PROOF_HTTP_TOKEN: "a b" }),
    ).rejects.toThrow(/PROOF_HTTP_TOKEN/);
    await expect(
      startProofWorker({ PROOF_STORE: "memory", PROOF_HTTP_ALLOWED_HOSTS: "*" }),
    ).rejects.toThrow(/PROOF_HTTP_ALLOWED_HOSTS/);
    // No store is configured, yet the access error comes first.
    await expect(startProofWorker({ PROOF_HTTP_HOST: "0.0.0.0" })).rejects.toThrow(
      /PROOF_HTTP_TOKEN/,
    );
  });
});
