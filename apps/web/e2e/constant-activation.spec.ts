import { expect, test } from "@playwright/test";
import { createIsolatedSession, type IsolatedDraft } from "./fixtures";
import { COMMAND, currentNodeId, selectInAnyField } from "./mouse-helpers";

test.slow();

// Applying a library result that uses a constant the proof does not have yet records a constant
// activation in the step's own transaction (migration 0018). On the PostgreSQL config this is the
// suite's only write to proof_constant_activations, and the reload, export, import and deletion
// below read the stored rows back.
const GOAL = ["Divides", "p", ["Multiply", "p", "q"]];
const RESULT_ID = "result:e2e-coprime-multiples";
const RESULT_NAME = "Multiples, given coprimality";

const DRAFT: IsolatedDraft = {
  problem: { title: "A number divides its multiples", statement: "Show that p divides pq." },
  background: { level: "undergraduate", summary: "Elementary number theory.", assumptions: [] },
  libraryLayerIds: ["layer:global", "layer:initial-problem"],
  packs: ["pack:divisibility"],
  declarations: [
    { symbol: "p", sort: "integer" },
    { symbol: "q", sort: "integer" },
  ],
  hypotheses: [],
  goals: [{ format: "mathjson", expression: GOAL }],
};

/** The library-artifact encoding of the integer sort (draft declarations use the choice ID). */
const INTEGER = { kind: "named", id: "sort:integer" };

const GCD = {
  id: "operator:gcd",
  symbol: "Gcd",
  signature: { parameters: [INTEGER, INTEGER], result: INTEGER },
  presentation: {
    displayName: "greatest common divisor",
    latex: {
      template: String.raw`\operatorname{gcd}\left(#1, #2\right)`,
      precedence: "atom",
      parse: { trigger: String.raw`\operatorname{gcd}`, notation: "function" },
    },
    naturalLanguage: [{ template: "the gcd of #1 and #2", proposition: false }],
  },
};

/** An approved result whose premise needs Gcd, which the session's setup does not declare. */
const RESULT = {
  kind: "result",
  id: RESULT_ID,
  name: RESULT_NAME,
  description: "A number divides its multiples (stated with a coprimality premise).",
  renderings: { latex: String.raw`a \mid ab`, naturalLanguage: "a divides a times b." },
  classification: { domains: ["number theory"], level: "foundational" },
  provenance: { kind: "curated", source: "e2e" },
  approval: { status: "approved", reviewerId: "actor:web" },
  layer: "initial-problem",
  related: [],
  priority: 50,
  parameters: ["a", "b"].map((symbol) => ({
    id: `declaration:result-${symbol}`,
    symbol,
    sort: INTEGER,
    role: "universal-parameter",
  })),
  statement: { expression: ["Divides", "a", ["Multiply", "a", "b"]] },
  premises: [{ expression: ["Equal", ["Gcd", "a", "b"], 1] }],
  sideConditions: [],
  applicationDirections: ["backward"],
  patterns: [
    {
      id: "pattern:e2e-coprime-multiples",
      expression: ["Divides", "a", ["Multiply", "a", "b"]],
      direction: "backward",
      requirement: { section: "goal", polarity: "positive", role: "proposition" },
    },
  ],
  operators: [GCD],
};

type Constants = {
  active: { symbol: string; origin: string }[];
  activated: { symbol: string; resultId: string; sequence: number }[];
  available: { symbol: string }[];
  readOnly: boolean;
};

test("applying a result that needs a new constant activates it, and the activation is stored", async ({
  page,
}) => {
  const sessionId = await createIsolatedSession(page, DRAFT);
  const workspace = `/sessions/${encodeURIComponent(sessionId)}`;
  const constantsOf = (id: string) =>
    page.evaluate(async (id) => {
      const response = await fetch(
        `/api/proof-sessions/${encodeURIComponent(id)}/library/constants`,
        { cache: "no-store" },
      );
      return (await response.json()).data as Constants;
    }, id);

  const added = await page.evaluate(
    async ({ id, artifact }) => {
      const response = await fetch(
        `/api/proof-sessions/${encodeURIComponent(id)}/protocol-commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: `command:e2e-${crypto.randomUUID()}`,
            actor: { id: "actor:web", kind: "human" },
            command: {
              kind: "add-library-result",
              layer: "initial-problem",
              artifact,
              payloadSource: "reviewed-authoring",
            },
          }),
        },
      );
      return { status: response.status, body: await response.json() };
    },
    { id: sessionId, artifact: RESULT },
  );
  expect(added, JSON.stringify(added)).toMatchObject({ status: 201 });
  expect(added.body.data.result.admitted).toBe(true);

  // Before the step: Gcd is only available from the library.
  const before = await constantsOf(sessionId);
  expect(before.activated).toEqual([]);
  expect(before.available.map(({ symbol }) => symbol)).toEqual(["Gcd"]);

  await page.goto(workspace);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 1 goal/, COMMAND);
  const rootId = await currentNodeId(page);
  // Under load the field can be in the page before MathLive has rendered its content.
  const conclusion = page.getByLabel("Goal 1 conclusion");
  await expect
    .poll(
      () => conclusion.evaluate((field) => (field as { lastOffset?: number }).lastOffset ?? 0),
      COMMAND,
    )
    .toBeGreaterThan(0);
  await selectInAnyField(conclusion, GOAL);
  const card = page.locator(`[data-artifact-id="${RESULT_ID}"]`);
  await expect(card).toBeVisible(COMMAND);

  // The preview says which constant applying it adds; previewing activates nothing.
  await card.getByRole("button", { name: "Preview changes" }).click();
  await expect(card.getByTestId("preview-constants")).toContainText(
    "Applying this adds the constant ‘greatest common divisor’",
    COMMAND,
  );
  expect((await constantsOf(sessionId)).activated).toEqual([]);

  await card.getByRole("button", { name: "Apply this step" }).click();
  await expect(page.getByTestId("constants-added")).toContainText(
    `‘greatest common divisor’, by applying ‘${RESULT_NAME}’`,
    COMMAND,
  );
  const stepId = await currentNodeId(page);
  expect(stepId).not.toBe(rootId);

  // After a reload the panel is read back from the store.
  await page.reload();
  const panel = page.getByTestId("constants-panel");
  await expect(panel).toBeVisible(COMMAND);
  await panel.locator("summary").click();
  await expect(panel.locator('[data-constant="Gcd"]')).toHaveAttribute("data-origin", "activated");
  await expect(panel.locator('[data-constant="Gcd"]')).toContainText(
    `added when ‘${RESULT_NAME}’ was applied`,
  );
  const after = await constantsOf(sessionId);
  expect(after.active.map(({ symbol, origin }) => [symbol, origin])).toContainEqual([
    "Gcd",
    "activated",
  ]);
  expect(after.activated).toMatchObject([{ symbol: "Gcd", resultId: RESULT_ID, sequence: 1 }]);
  expect(after.available).toEqual([]);

  // Export carries the activation; importing it reproduces it in a read-only session.
  const imported = await page.evaluate(async (id) => {
    const exported = await fetch(
      `/api/proof-sessions/${encodeURIComponent(id)}/export?confirmPrivateExport=true`,
      { cache: "no-store" },
    );
    const artifact = await exported.json();
    const uploaded = await fetch("/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(artifact),
    });
    return {
      activations: artifact.constantActivations as { symbol: string; resultId: string }[],
      status: uploaded.status,
      body: await uploaded.json(),
    };
  }, sessionId);
  expect(imported.activations).toMatchObject([{ symbol: "Gcd", resultId: RESULT_ID }]);
  expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  const copy = await constantsOf(imported.body.data.sessionId);
  expect(copy.readOnly).toBe(true);
  expect(copy.activated).toMatchObject([{ symbol: "Gcd", resultId: RESULT_ID, sequence: 1 }]);

  // Deleting the step keeps the constant: it stays part of the proof's notation.
  await page.getByText("More proof actions").click();
  await page.getByRole("button", { name: "Delete previous move…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete move" }).click();
  await expect(page.locator("[data-history-node-id]")).toHaveCount(1, COMMAND);
  expect(await currentNodeId(page)).toBe(rootId);
  expect((await constantsOf(sessionId)).activated).toMatchObject([{ symbol: "Gcd" }]);
});
