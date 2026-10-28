import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_PROOF_SESSION_ID,
  ensureDevelopmentProofSession,
} from "../development-session";
import { MemoryProofStore } from "../memory-proof-store";
import {
  MIN_REMOTE_TOKEN_LENGTH,
  accessPolicyFromEnv,
  assertBindAllowed,
  checkRequestAccess,
  isLoopbackHost,
  normalizedHostName,
  tokensMatch,
  type HttpAccessPolicy,
} from "./access-control";
import { createProofHttpService, type ProofHttpService } from ".";

const TOKEN = "t".repeat(MIN_REMOTE_TOKEN_LENGTH);
const SESSION_PATH = `/proof-sessions/${encodeURIComponent(DEVELOPMENT_PROOF_SESSION_ID)}`;

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function runningService(access?: HttpAccessPolicy): Promise<number> {
  const store = new MemoryProofStore();
  await ensureDevelopmentProofSession(store);
  const service = createProofHttpService(store, access === undefined ? {} : { access });
  services.push(service);
  const { origin } = await service.listen();
  return Number(new URL(origin).port);
}

type Answer = Readonly<{ status: number; headers: Record<string, unknown>; body: unknown }>;

/** A GET to the loopback worker with exact headers; `fetch` cannot set `Host`. */
function get(port: number, headers: OutgoingHttpHeaders, path = SESSION_PATH): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        }),
      );
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

function diagnosticCode(answer: Answer): unknown {
  return (answer.body as { diagnostics?: { code?: unknown }[] }).diagnostics?.[0]?.code;
}

describe("isLoopbackHost", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "localhost",
    "LOCALHOST",
  ])("treats %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    "",
    "0.0.0.0",
    "::",
    "10.0.0.5",
    "128.0.0.1",
    "192.168.1.5",
    "127.0.0.1.evil.example",
    "::ffff:127.0.0.1",
    "example.com",
    "proof-worker",
  ])("treats %j as non-loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("normalizedHostName", () => {
  it.each([
    ["localhost", "localhost"],
    ["LocalHost:8787", "localhost"],
    ["127.0.0.1:1", "127.0.0.1"],
    ["[::1]:8787", "::1"],
    ["[::1]", "::1"],
    ["proof-worker.internal", "proof-worker.internal"],
  ])("reads %j as %j", (value, expected) => {
    expect(normalizedHostName(value)).toBe(expected);
  });

  it.each([
    "",
    "evil.example/path",
    "user@localhost",
    "localhost:port",
    "localhost:123456",
    "local host",
    "localhost, evil.example",
    "::1",
    "*",
    "exa\\mple.com",
  ])("rejects %j", (value) => {
    expect(normalizedHostName(value)).toBeUndefined();
  });
});

describe("accessPolicyFromEnv", () => {
  it("defaults to no token and no extra hosts, and treats an empty token as unset", () => {
    expect(accessPolicyFromEnv({})).toEqual({ allowedHosts: [] });
    expect(accessPolicyFromEnv({ PROOF_HTTP_TOKEN: "", PROOF_HTTP_ALLOWED_HOSTS: "" })).toEqual({
      allowedHosts: [],
    });
  });

  it("reads the token and a comma-separated host list, ignoring ports and blank entries", () => {
    expect(
      accessPolicyFromEnv({
        PROOF_HTTP_TOKEN: TOKEN,
        PROOF_HTTP_ALLOWED_HOSTS: " Proof-Worker ,10.0.0.5:8787,,[fd00::1]",
      }),
    ).toEqual({ token: TOKEN, allowedHosts: ["proof-worker", "10.0.0.5", "fd00::1"] });
  });

  it("rejects a token that cannot travel in a header and malformed host entries", () => {
    expect(() => accessPolicyFromEnv({ PROOF_HTTP_TOKEN: "has space" })).toThrow(
      /PROOF_HTTP_TOKEN/,
    );
    expect(() => accessPolicyFromEnv({ PROOF_HTTP_TOKEN: "new\nline" })).toThrow(
      /PROOF_HTTP_TOKEN/,
    );
    for (const entry of ["*", "a/b", "user@host", "bad host"]) {
      expect(() => accessPolicyFromEnv({ PROOF_HTTP_ALLOWED_HOSTS: `ok,${entry}` })).toThrow(
        /PROOF_HTTP_ALLOWED_HOSTS/,
      );
    }
  });
});

describe("assertBindAllowed", () => {
  it("allows a loopback bind with or without a token", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"]) {
      expect(() => assertBindAllowed({ allowedHosts: [] }, host)).not.toThrow();
    }
  });

  it("refuses any other bind without a token of at least 32 characters", () => {
    for (const host of ["0.0.0.0", "::", "", "10.0.0.5", "proof-worker"]) {
      expect(() => assertBindAllowed({ allowedHosts: [] }, host)).toThrow(/PROOF_HTTP_TOKEN/);
      expect(() =>
        assertBindAllowed(
          { token: "x".repeat(MIN_REMOTE_TOKEN_LENGTH - 1), allowedHosts: [] },
          host,
        ),
      ).toThrow(/at least 32 characters/);
      expect(() => assertBindAllowed({ token: TOKEN, allowedHosts: [] }, host)).not.toThrow();
    }
  });
});

describe("tokensMatch", () => {
  it("accepts only the identical token", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch(TOKEN, `${TOKEN.slice(0, -1)}u`)).toBe(false);
    expect(tokensMatch(TOKEN, TOKEN.slice(0, -1))).toBe(false);
    expect(tokensMatch(TOKEN, `${TOKEN}t`)).toBe(false);
    expect(tokensMatch(TOKEN, "")).toBe(false);
    expect(tokensMatch(TOKEN, TOKEN.toUpperCase())).toBe(false);
  });
});

describe("checkRequestAccess", () => {
  const open: HttpAccessPolicy = { allowedHosts: [] };
  const guarded: HttpAccessPolicy = { token: TOKEN, allowedHosts: ["proof-worker"] };
  const check = (
    policy: HttpAccessPolicy,
    bindHost: string | undefined,
    headers: Record<string, string>,
  ) => checkRequestAccess(policy, bindHost, { headers });

  it.each(["localhost", "localhost:8787", "127.0.0.1:8787", "[::1]:8787", "LOCALHOST"])(
    "accepts the loopback Host %s on any bind",
    (host) => {
      expect(check(open, "127.0.0.1", { host })).toBeUndefined();
      expect(check(open, undefined, { host })).toBeUndefined();
    },
  );

  it("rejects a missing, unparseable or foreign Host with 403", () => {
    for (const headers of [
      {},
      { host: "" },
      { host: "evil.example" },
      { host: "evil.example:8787" },
      { host: "localhost.evil.example" },
      { host: "127.0.0.2:8787" },
      { host: "user@localhost" },
      { host: "localhost/../" },
      { host: "2130706433" },
    ]) {
      expect(check(open, "127.0.0.1", headers)).toMatchObject({
        status: 403,
        code: "host-not-allowed",
      });
    }
  });

  it("accepts the bind host, but not a wildcard listen address, and the configured extras", () => {
    expect(check(open, "10.0.0.5", { host: "10.0.0.5:8787" })).toBeUndefined();
    expect(check(open, "fd00::1", { host: "[fd00::1]:8787" })).toBeUndefined();
    expect(check(open, "Proof-Worker", { host: "proof-worker" })).toBeUndefined();
    expect(check(open, "0.0.0.0", { host: "0.0.0.0:8787" })).toMatchObject({ status: 403 });
    expect(check(open, "::", { host: "[::]:8787" })).toMatchObject({ status: 403 });
    expect(check(open, "10.0.0.5", { host: "10.0.0.6" })).toMatchObject({ status: 403 });
    expect(
      check(guarded, "0.0.0.0", { host: "proof-worker:8787", authorization: `Bearer ${TOKEN}` }),
    ).toBeUndefined();
  });

  it("requires the bearer token only when one is configured", () => {
    expect(check(open, "127.0.0.1", { host: "localhost" })).toBeUndefined();
    expect(
      check(open, "127.0.0.1", { host: "localhost", authorization: "Bearer anything" }),
    ).toBeUndefined();
    for (const authorization of [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(1)}`,
      "Bearer wrong",
      `Basic ${TOKEN}`,
      TOKEN,
      `Bearer ${TOKEN} extra`,
    ]) {
      expect(
        check(guarded, "127.0.0.1", {
          host: "localhost",
          ...(authorization === undefined ? {} : { authorization }),
        }),
      ).toMatchObject({ status: 401, code: "unauthorized" });
    }
    for (const authorization of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER  ${TOKEN}`]) {
      expect(check(guarded, "127.0.0.1", { host: "localhost", authorization })).toBeUndefined();
    }
  });

  it("checks the Host before the token", () => {
    expect(check(guarded, "127.0.0.1", { host: "evil.example" })).toMatchObject({ status: 403 });
    expect(
      check(guarded, "127.0.0.1", { host: "evil.example", authorization: `Bearer ${TOKEN}` }),
    ).toMatchObject({ status: 403 });
  });
});

describe("proof HTTP service access control", () => {
  it("serves unchanged without a token on loopback host names", async () => {
    const port = await runningService();
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const answer = await get(port, { host });
      expect(answer.status).toBe(200);
    }
    expect((await get(port, { host: `127.0.0.1:${port}`, authorization: "Bearer x" })).status).toBe(
      200,
    );
  });

  it("answers an unknown Host with a no-store 403 diagnostic and no data", async () => {
    const port = await runningService();
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.2", "0.0.0.0"]) {
      const answer = await get(port, { host });
      expect(answer.status).toBe(403);
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(answer.headers["content-type"]).toContain("application/json");
      expect(answer.body).toEqual({
        diagnostics: [{ code: "host-not-allowed", message: expect.any(String) }],
      });
    }
    // Any route, including one that does not exist, is behind the Host check.
    expect((await get(port, { host: "evil.example" }, "/nowhere")).status).toBe(403);
  });

  it("rejects a request without a Host header", async () => {
    const port = await runningService();
    // HTTP/1.0 may omit Host; Node itself refuses an HTTP/1.1 request without one with a 400.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port }, () => {
        socket.write(`GET ${SESSION_PATH} HTTP/1.0\r\n\r\n`);
      });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      socket.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 403 /);
    expect(raw).toContain('"code":"host-not-allowed"');
  });

  it("accepts the configured extra hosts and rejects the rest", async () => {
    const port = await runningService({ allowedHosts: ["proof-worker"] });
    expect((await get(port, { host: `proof-worker:${port}` })).status).toBe(200);
    expect((await get(port, { host: "other-worker" })).status).toBe(403);
  });

  it("answers 401 with a no-store diagnostic unless the bearer token matches", async () => {
    const port = await runningService({ token: TOKEN, allowedHosts: [] });
    const host = `127.0.0.1:${port}`;

    for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, `Basic ${TOKEN}`]) {
      const answer = await get(port, {
        host,
        ...(authorization === undefined ? {} : { authorization }),
      });
      expect(answer.status).toBe(401);
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(answer.headers["www-authenticate"]).toBe("Bearer");
      expect(answer.headers["content-type"]).toContain("application/json");
      expect(answer.body).toEqual({
        diagnostics: [{ code: "unauthorized", message: expect.any(String) }],
      });
      expect(JSON.stringify(answer.body)).not.toContain(TOKEN);
    }

    const accepted = await get(port, { host, authorization: `Bearer ${TOKEN}` });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ session: { id: DEVELOPMENT_PROOF_SESSION_ID } });
    // The token guards every route, not only the ones that exist.
    expect((await get(port, { host }, "/nowhere")).status).toBe(401);
    expect((await get(port, { host, authorization: `Bearer ${TOKEN}` }, "/nowhere")).status).toBe(
      404,
    );
  });

  it("still enforces the Host when the token is right", async () => {
    const port = await runningService({ token: TOKEN, allowedHosts: [] });
    const answer = await get(port, { host: "evil.example", authorization: `Bearer ${TOKEN}` });
    expect(answer.status).toBe(403);
    expect(diagnosticCode(answer)).toBe("host-not-allowed");
  });

  it("refuses to listen on a non-loopback host without a long enough token", async () => {
    const store = new MemoryProofStore();
    for (const access of [undefined, { token: "short", allowedHosts: [] }] as const) {
      const service = createProofHttpService(store, access === undefined ? {} : { access });
      services.push(service);
      await expect(service.listen({ host: "0.0.0.0", port: 0 })).rejects.toThrow(
        /PROOF_HTTP_TOKEN/,
      );
      expect(service.server.listening).toBe(false);
    }
  });
});
