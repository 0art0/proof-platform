import { expect, type Page } from "@playwright/test";

/** A problem draft in the shape `POST /api/problem-drafts/validate` accepts. */
export type IsolatedDraft = Readonly<{
  problem: { title: string; statement: string };
  background: { level: string; summary: string; assumptions: string[] };
  libraryLayerIds: string[];
  packs: unknown[];
  declarations: { symbol: string; sort: string }[];
  hypotheses: { format: "mathjson"; expression: unknown }[];
  goals: { format: "mathjson"; expression: unknown }[];
}>;

/**
 * Create a session that only the calling test knows about, through the reviewed-approval API
 * (validate, then approve with the reviewed digest). Tests that mutate proof state use this so
 * they never race other specs over the shared seeded session:development.
 */
export async function createIsolatedSession(page: Page, draft: IsolatedDraft): Promise<string> {
  await page.goto("/");
  return page.evaluate(async (draft) => {
    const post = async (url: string, body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.json();
    };
    const validated = await post("/api/problem-drafts/validate", { draft });
    if (!validated.ok || !validated.data.ok) throw new Error(JSON.stringify(validated));
    const id = `session:${crypto.randomUUID()}`;
    const approved = await post("/api/proof-sessions", {
      sessionId: id,
      draft,
      reviewedDigest: validated.data.review.digest,
    });
    if (!approved.ok) throw new Error(JSON.stringify(approved));
    return id;
  }, draft);
}

/**
 * Webpack dev compiles each API route on its first request, which can outlast an assertion
 * timeout while other specs load the machine. Touch every route these tests use once (malformed
 * bodies are refused before reaching the worker, so nothing is recorded) and wait for them.
 */
export async function warmRoutes(page: Page, sessionId: string) {
  const statuses = await page.evaluate(async (id) => {
    const base = `/api/proof-sessions/${encodeURIComponent(id)}`;
    const post = (path: string) =>
      fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }).then((response) => response.status);
    return Promise.all([
      post("protocol-commands"),
      post("commands"),
      post("move-previews"),
      post("backtrack"),
      fetch(base, { cache: "no-store" }).then((response) => response.status),
    ]);
  }, sessionId);
  expect(statuses).toEqual([400, 400, 400, 400, 200]);
}
