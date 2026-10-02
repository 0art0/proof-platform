import { expect, test } from "@playwright/test";
import { createIsolatedSession, warmRoutes, type IsolatedDraft } from "./fixtures";
import { COMMAND, currentNodeId, previewAndApply, selectInAnyField } from "./mouse-helpers";

test.slow();

// Roadmap N44: a finished subtree is saved as a conditional lemma that keeps only the hypotheses
// it used, the saved draft is reviewed and approved from the library drawer, and only then is it
// offered as a suggestion, here on another branch (the root) of the same session. The corpus
// problem "conjunction swap" is closed with the mouse; the extra hypothesis r is never used.
const P_AND_Q = ["And", "p", "q"];
const Q_AND_P = ["And", "q", "p"];

const DRAFT: IsolatedDraft = {
  problem: { title: "Swap a conjunction", statement: "From p and q (and r), show q and p." },
  background: { level: "propositional logic", summary: "Natural deduction.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
    { symbol: "r", sort: "proposition" },
  ],
  hypotheses: [
    { format: "mathjson", expression: P_AND_Q },
    { format: "mathjson", expression: "r" },
  ],
  goals: [{ format: "mathjson", expression: Q_AND_P }],
};

test("a finished step is saved as a lemma keeping only used hypotheses, approved, and then offered", async ({
  page,
}) => {
  const sessionId = await createIsolatedSession(page, DRAFT);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 1 goal/, COMMAND);
  await warmRoutes(page, sessionId);
  const rootId = await currentNodeId(page);
  const goalField = page.locator('[aria-label$="conclusion"]');
  const hypothesisFields = page.locator('[aria-label*=" hypothesis "]');

  // Close the whole goal: expand the hypothesis, split the goal, close both halves.
  await selectInAnyField(goalField, Q_AND_P);
  await selectInAnyField(hypothesisFields, P_AND_Q, { modifier: true });
  await previewAndApply(page, "move:expand-hypothesis-conjunction");
  await expect(page.locator("[data-history-node-id]")).toHaveCount(2, COMMAND);
  await selectInAnyField(goalField, Q_AND_P);
  await previewAndApply(page, "move:split-goal-conjunction");
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
  for (const [remaining, conjunct] of [
    ["Open: 1 goal", "q"],
    ["No open goals", "p"],
  ] as const) {
    await selectInAnyField(goalField, conjunct);
    await selectInAnyField(hypothesisFields, conjunct, { modifier: true });
    await previewAndApply(page, "move:close-by-hypothesis");
    await expect(page.getByTestId("snapshot-status")).toHaveText(new RegExp(remaining), COMMAND);
  }

  // The panel says what a lemma is, and lists the finished steps only once it is opened.
  const panel = page.getByRole("region", { name: "Save a lemma" });
  await expect(panel).toContainText("A lemma is a result you proved here and keep for later.");
  await panel.getByText("Show the steps you could save").click();
  const step = panel.locator(`[data-lemma-node="${rootId}"]`);
  await expect(step).toHaveAttribute("data-lemma-status", "ready", COMMAND);
  await step.getByRole("button", { name: /Preview the lemma/ }).click();
  const preview = step.getByTestId("lemma-preview");
  await expect(preview.locator("[data-kept] [data-latex]")).toHaveCount(1);
  await expect(preview.locator("[data-kept] [data-latex]")).toHaveAttribute("data-latex", /land/);
  await expect(preview.locator("[data-unused] [data-latex]")).toHaveAttribute("data-latex", "r");
  await expect(preview).toContainText("It keeps 1 hypothesis the proof used.");
  await expect(preview).toContainText("1 unused hypothesis is left out.");

  // Saving records a draft; nothing is offered yet.
  await preview.getByRole("button", { name: "Save as a lemma" }).click();
  await expect(panel.getByText(/Saved as a draft lemma/)).toBeVisible(COMMAND);
  await expect(step).toContainText("Already saved as a draft", COMMAND);

  // The draft is reviewed in the library drawer.
  await page.getByRole("button", { name: "Library", exact: true }).click();
  const drawer = page.getByRole("complementary").filter({ hasText: "Browse the definitions" });
  await drawer.getByLabel("Layer").selectOption("derived");
  await drawer.getByRole("button", { name: /^Lemma:/ }).click();
  const review = drawer.getByRole("region", { name: "Lemma review" });
  await expect(review).toContainText("Review this lemma");
  await expect(review.getByRole("button", { name: "Reject lemma" })).toBeDisabled();
  await review.getByLabel(/Notes/).fill("Checked: a plain consequence.");
  await review.getByRole("button", { name: "Approve lemma" }).click();
  await expect(drawer.getByText(/You approved this lemma/)).toBeVisible(COMMAND);
  await drawer.getByRole("button", { name: /Close/ }).click();

  // On another branch (the root) the approved lemma is offered for the goal.
  await page.locator(`[data-history-node-id="${rootId}"]`).click();
  await expect(page.getByText(`Backtracked to ${rootId}.`, { exact: true })).toBeVisible(COMMAND);
  await selectInAnyField(goalField, Q_AND_P);
  const card = page.locator('[data-artifact-id^="result:lemma."]');
  await expect(card).toBeVisible(COMMAND);
  await expect(card).toContainText("Lemma:");
});
