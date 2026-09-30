import { expect, test, type Page } from "@playwright/test";
import { createIsolatedSession, warmRoutes, type IsolatedDraft } from "./fixtures";
import { COMMAND, currentNodeId, selectInAnyField } from "./mouse-helpers";

test.slow();

// Roadmap N33 (design plan §8.3): dragging a hypothesis onto a goal shows a preview first, and
// only the existing Apply commits. Abstraction is not covered: the proof-session HTTP boundary
// does not accept an abstraction on suggestion requests yet.

const DRAFT: IsolatedDraft = {
  problem: { title: "Commute a conjunction", statement: "From p and q, show q and p." },
  background: { level: "propositional logic", summary: "Natural deduction.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
  ],
  hypotheses: [{ format: "mathjson", expression: ["And", "p", "q"] }],
  goals: [{ format: "mathjson", expression: ["And", "q", "p"] }],
};

const EXPAND = '[data-artifact-id="move:expand-hypothesis-conjunction"]';

async function openFreshSession(page: Page): Promise<string> {
  // Tall enough that dragging never scrolls the page under the pointer.
  await page.setViewportSize({ width: 1280, height: 2400 });
  const sessionId = await createIsolatedSession(page, DRAFT);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 1 goal/, COMMAND);
  await warmRoutes(page, sessionId);
  return sessionId;
}

test("dragging a hypothesis onto a goal previews a move and only Apply commits it", async ({
  page,
}) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  const handle = page.getByRole("button", { name: "hypothesis 1 of goal 1" });
  const goal = page.getByLabel("Goal 1 conclusion");

  await handle.dragTo(goal);

  // The drop produced a preview through the suggestion flow and nothing else.
  const card = page.locator(EXPAND);
  await expect(card.getByLabel("Move preview")).toBeVisible(COMMAND);
  await expect(page.getByTestId("drag-outcome")).toContainText("previewing", COMMAND);
  await expect(page.locator("[data-selection-key]")).toHaveCount(2);
  expect(await currentNodeId(page)).toBe(rootId);
  await expect(page.getByLabel("Goal 1 hypothesis 2")).toHaveCount(0);

  await card.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/advanced to node:/)).toBeVisible(COMMAND);
  expect(await currentNodeId(page)).not.toBe(rootId);
  // The hypothesis conjunction was expanded into its two conjuncts.
  await expect(page.getByLabel("Goal 1 hypothesis 2")).toBeVisible(COMMAND);
});

test("the keyboard can pick up a hypothesis and drop it on the selected goal", async ({ page }) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  const handle = page.getByRole("button", { name: "hypothesis 1 of goal 1" });

  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("carrying")).toContainText("Carrying hypothesis");
  const dropOnSelection = page.getByRole("button", { name: "Drop on selection" });
  await expect(dropOnSelection).toBeDisabled();

  await selectInAnyField(page.getByLabel("Goal 1 conclusion"), ["And", "q", "p"]);
  await expect(dropOnSelection).toBeEnabled(COMMAND);
  await dropOnSelection.click();

  await expect(page.locator(EXPAND).getByLabel("Move preview")).toBeVisible(COMMAND);
  expect(await currentNodeId(page)).toBe(rootId);

  // Picking up again and pressing Escape puts it down without touching the proof.
  await handle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("carrying")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("carrying")).toHaveCount(0);
  expect(await currentNodeId(page)).toBe(rootId);
});
