import { afterEach, describe, expect, it } from "vitest";
import {
  createProofNodeSchema,
  problemDraftValidationResponseSchema,
  problemSetupOptionsSchema,
} from "@proof/protocol";
import { validateProblemDraft } from "../problem-setup";
import { setDraft } from "../problem-setup.testing";
import {
  InspectableMemoryProofStore as MemoryProofStore,
  key,
} from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function running(store = new MemoryProofStore()) {
  const service = createProofHttpService(store);
  services.push(service);
  return { store, origin: (await service.listen()).origin };
}

function post(origin: string, path: string, body: unknown, contentType = "application/json") {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function digestOf(draft: unknown): string {
  const result = validateProblemDraft(draft);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value.review.digest;
}

function counts(store: MemoryProofStore) {
  return { sessions: store.sessions.size, nodes: store.nodes.size };
}

describe("problem setup HTTP routes", () => {
  it("serves the entry menus", async () => {
    const { origin } = await running();
    const response = await fetch(`${origin}/problem-setup/options`);
    expect(response.status).toBe(200);
    const options = problemSetupOptionsSchema.parse(await response.json());
    expect(options.packs.map(({ id }) => id)).toContain("pack:sets");
  });

  it("validates a draft into a review without writing anything", async () => {
    const { origin, store } = await running();
    const response = await post(origin, "/problem-drafts/validate", { draft: setDraft() });
    expect(response.status).toBe(200);
    const body = problemDraftValidationResponseSchema.parse(await response.json());
    if (!body.ok) throw new Error("Expected a review.");
    expect(body.review.digest).toBe(digestOf(setDraft()));
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
  });

  it("answers an invalid draft with every precise diagnostic and writes nothing", async () => {
    const { origin, store } = await running();
    const draft = setDraft({
      packs: [],
      declarations: [{ symbol: "A", sort: "set-of-elements" }],
      goals: [{ format: "latex", latex: "A \\cup B = B \\cup A" }],
    });
    const response = await post(origin, "/problem-drafts/validate", { draft });
    expect(response.status).toBe(422);
    const body = problemDraftValidationResponseSchema.parse(await response.json());
    expect(body).toEqual({
      ok: false,
      diagnostics: [
        {
          code: "undeclared-symbol",
          message: "Hypothesis 1 uses p, which is not declared. Declare it with a sort.",
          path: ["hypotheses", 0, "expression"],
        },
        expect.objectContaining({ code: "undeclared-symbol", path: ["goals", 0, "latex"] }),
        expect.objectContaining({ code: "pack-not-selected", path: ["goals", 0, "latex"] }),
      ],
    });
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
  });

  it.each([
    ["a non-JSON body", "draft", "text/plain", 415],
    ["malformed JSON", "{", "application/json", 400],
    ["extra fields", { draft: setDraft(), trusted: true }, "application/json", 400],
  ])("rejects %s", async (_label, body, contentType, status) => {
    const { origin } = await running();
    expect((await post(origin, "/problem-drafts/validate", body, contentType)).status).toBe(status);
  });

  it("creates exactly one session and root node on approval, and replays a retry", async () => {
    const { origin, store } = await running();
    const draft = setDraft();
    const approval = { sessionId: "session:union", draft, reviewedDigest: digestOf(draft) };

    const created = await post(origin, "/proof-sessions", approval);
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      session: { id: string; rootNodeId: string; currentNodeId: string; operators: unknown[] };
      node: unknown;
      metadata: unknown;
      replayed: boolean;
    };
    expect(body.replayed).toBe(false);
    expect(body.session).toMatchObject({
      id: "session:union",
      rootNodeId: "node:root",
      currentNodeId: "node:root",
    });
    expect(body.metadata).toMatchObject({ problem: draft.problem });
    const node = createProofNodeSchema({ operators: body.session.operators as never }).parse(
      body.node,
    );
    expect(node.state.goals[0]?.sequent.conclusion.expression).toEqual([
      "Equal",
      ["Union", "A", "B"],
      ["Union", "B", "A"],
    ]);
    expect(counts(store)).toEqual({ sessions: 1, nodes: 1 });

    // The stored session is an ordinary session: it loads with its metadata.
    const loaded = await fetch(`${origin}/proof-sessions/session%3Aunion?include=metadata`);
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({
      node: { id: "node:root" },
      metadata: { libraryLayerIds: ["layer:global", "layer:initial-problem"] },
    });

    const retried = await post(origin, "/proof-sessions", approval);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ replayed: true, node: { id: "node:root" } });
    expect(counts(store)).toEqual({ sessions: 1, nodes: 1 });
  });

  it("replays a retry after the session has moved on from its root", async () => {
    const { origin, store } = await running();
    const draft = setDraft();
    const approval = { sessionId: "session:moved", draft, reviewedDigest: digestOf(draft) };
    expect((await post(origin, "/proof-sessions", approval)).status).toBe(201);

    const root = store.nodes.get(key("session:moved", "node:root")) as {
      state: { id: string };
    };
    const child = { ...root, id: "node:child", state: { ...root.state, id: "state:child" } };
    store.nodes.set(key("session:moved", "node:child"), child as never);
    const session = store.sessions.get("session:moved");
    store.sessions.set("session:moved", { ...session!, currentNodeId: "node:child" as never });

    const retried = await post(origin, "/proof-sessions", approval);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      replayed: true,
      session: { currentNodeId: "node:child" },
      node: { id: "node:root" },
    });
  });

  it("refuses other content under an existing session ID", async () => {
    const { origin, store } = await running();
    const draft = setDraft();
    await post(origin, "/proof-sessions", {
      sessionId: "session:taken",
      draft,
      reviewedDigest: digestOf(draft),
    });
    const other = setDraft({ problem: { title: "Another", statement: "Something else." } });
    const response = await post(origin, "/proof-sessions", {
      sessionId: "session:taken",
      draft: other,
      reviewedDigest: digestOf(other),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      diagnostics: [{ code: "session-conflict" }],
    });
    expect(store.sessions.get("session:taken")?.metadata?.problem.title).toBe("Union commutes");
    expect(counts(store)).toEqual({ sessions: 1, nodes: 1 });
  });

  it("writes nothing when the approval is rejected", async () => {
    const { origin, store } = await running();
    const draft = setDraft();
    const cases: Array<[unknown, number, string]> = [
      // The draft changed after review: the digest no longer matches.
      [
        {
          sessionId: "session:x",
          draft: setDraft({ packs: ["pack:sets", "pack:divisibility"] }),
          reviewedDigest: digestOf(draft),
        },
        409,
        "review-stale",
      ],
      [
        {
          sessionId: "session:x",
          draft: setDraft({ goals: [{ format: "latex", latex: "A \\cup" }] }),
          reviewedDigest: digestOf(draft),
        },
        422,
        "latex-parse-failed",
      ],
      [{ sessionId: "session:x", draft }, 400, "invalid-request"],
      [{ sessionId: "not an id", draft, reviewedDigest: digestOf(draft) }, 400, "invalid-request"],
    ];
    for (const [body, status, code] of cases) {
      const response = await post(origin, "/proof-sessions", body);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ diagnostics: [{ code }] });
    }
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
  });

  it("creates the session and root atomically", async () => {
    const store = new MemoryProofStore();
    store.failAt = "insertNode";
    const { origin } = await running(store);
    const draft = setDraft();
    const response = await post(origin, "/proof-sessions", {
      sessionId: "session:atomic",
      draft,
      reviewedDigest: digestOf(draft),
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(counts(store)).toEqual({ sessions: 0, nodes: 0 });
  });

  it("leaves the existing session routes alone", async () => {
    const { origin } = await running();
    expect((await fetch(`${origin}/proof-sessions/session%3Amissing`)).status).toBe(404);
    expect((await fetch(`${origin}/proof-sessions`)).status).toBe(404);
  });
});
