import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { BENCHMARK_CORPUS } from "@proof/library";
import { createIsolatedSession, warmRoutes, type IsolatedDraft } from "./fixtures";
import { COMMAND, currentNodeId, previewAndApply, selectInAnyField } from "./mouse-helpers";

test.slow();

// Roadmap N38 (design plan §21.4): solve a corpus problem using only pointer interactions.
const problem = BENCHMARK_CORPUS.find(({ id }) => id === "corpus:conjunction-swap")!;
const P_AND_Q = ["And", "p", "q"];
const Q_AND_P = ["And", "q", "p"];

const DRAFT: IsolatedDraft = {
  problem: { title: problem.title, statement: problem.statement },
  background: { level: "propositional logic", summary: "Natural deduction.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
  ],
  hypotheses: problem.hypotheses.map((expression) => ({ format: "mathjson", expression })),
  goals: [{ format: "mathjson", expression: problem.goal }],
};

test("a corpus problem is solved, repaired, exported, reimported and viewed with the mouse alone", async ({
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
  const nodes = page.locator("[data-history-node-id]");

  // An accidental move: splitting the goal before the hypothesis is expanded.
  await selectInAnyField(goalField, Q_AND_P);
  await previewAndApply(page, "move:split-goal-conjunction");
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
  await expect(nodes).toHaveCount(2, COMMAND);

  // Delete it from the toolbar, after the confirmation dialog states its impact.
  await page.getByRole("button", { name: "Delete previous move…" }).click();
  const deletion = page.getByRole("dialog", { name: "Delete previous move" });
  await expect(deletion.getByTestId("deletion-impact")).toContainText("0 descendant nodes");
  await deletion.getByRole("button", { name: "Delete move" }).click();
  await expect(page.getByText(`Delete previous move committed; now at ${rootId}.`)).toBeVisible(
    COMMAND,
  );
  await expect(nodes).toHaveCount(1, COMMAND);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 1 goal/, COMMAND);

  // The corpus solution: expand the hypothesis, then split the goal.
  await selectInAnyField(goalField, Q_AND_P);
  await selectInAnyField(hypothesisFields, P_AND_Q, { modifier: true });
  await previewAndApply(page, "move:expand-hypothesis-conjunction");
  await expect(nodes).toHaveCount(2, COMMAND);
  const expandedId = await currentNodeId(page);
  await selectInAnyField(goalField, Q_AND_P);
  await previewAndApply(page, "move:split-goal-conjunction");
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
  await expect(nodes).toHaveCount(3, COMMAND);
  const splitId = await currentNodeId(page);

  // Backtrack with information on q, then return to the abandoned branch by clicking its node.
  await selectInAnyField(goalField, "q");
  await page.getByRole("button", { name: "Backtrack with information…" }).click();
  const backtrack = page.getByRole("dialog", { name: "Backtrack with information" });
  await expect(backtrack.getByText("Free symbols: q")).toBeVisible();
  await backtrack.getByRole("button", { name: /^Split on P here/ }).click();
  await expect(page.getByText(/Backtrack with information committed; now at node:/)).toBeVisible(
    COMMAND,
  );
  expect(await currentNodeId(page)).not.toBe(splitId);
  await page.locator(`[data-history-node-id="${splitId}"]`).click();
  await expect(page.getByText(`Backtracked to ${splitId}.`, { exact: true })).toBeVisible(COMMAND);
  expect(expandedId).not.toBe(rootId);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);

  // Finish the original branch: each remaining goal is closed by its matching hypothesis.
  for (const [remaining, conjunct] of [
    ["Open: 1 goal", "q"],
    ["No open goals", "p"],
  ] as const) {
    await selectInAnyField(goalField, conjunct);
    await selectInAnyField(hypothesisFields, conjunct, { modifier: true });
    await previewAndApply(page, "move:close-by-hypothesis");
    await expect(page.getByTestId("snapshot-status")).toHaveText(new RegExp(remaining), COMMAND);
  }

  // Export from the toolbar, acknowledging that the session is private.
  const exportButton = page.getByRole("button", { name: "Export proof" });
  await expect(exportButton).toHaveAttribute("data-hydrated", "true");
  await exportButton.click();
  const exporting = page.getByRole("dialog", { name: "Export a private session" });
  const downloading = page.waitForEvent("download");
  await exporting.getByRole("button", { name: "Export anyway" }).click();
  const artifactBody = await readFile((await (await downloading).path()) ?? "");

  // Reimport it from the landing page by choosing the file in the file chooser.
  await page.goto("/");
  const upload = page.getByRole("button", { name: "Upload artifact" });
  await expect(upload).toBeDisabled();
  const choosing = page.waitForEvent("filechooser");
  await page.getByLabel("Artifact file", { exact: true }).click();
  await (
    await choosing
  ).setFiles({
    name: "swap.proof-artifact.json",
    mimeType: "application/json",
    buffer: artifactBody,
  });
  await expect(upload).toBeEnabled();
  await upload.click();
  await expect(page).toHaveURL(/\/sessions\/session(%3A|:)artifact(%3A|:)[0-9a-f]{32}$/);
  const importedBase = new URL(page.url()).pathname;
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();

  // The imported session is read-only; its pruned proof omits the abandoned branch.
  await page.goto(`${importedBase}/proof`);
  await expect(page.getByTestId("read-only-note")).toBeVisible(COMMAND);
  await expect(page.getByTestId("solved-status")).toHaveText(/Solved/);
  const steps = page.getByTestId("proof-steps").getByRole("listitem");
  await expect(steps.filter({ has: page.getByRole("heading") })).toHaveCount(4, COMMAND);
  await expect(page.getByTestId("proof-steps")).toContainText("Split conjunction goal");
  await expect(page.getByTestId("proof-steps")).not.toContainText("Backtrack");
  await expect(page.getByTestId("no-sorry-dependency")).toBeVisible();

  // The tree viewer keeps the case split that backtracking with information inserted, marked as
  // the abandoned branch, beside the solved route.
  await page
    .getByRole("navigation", { name: "Stored views" })
    .getByRole("link", { name: "Tree" })
    .click();
  const outline = page.getByTestId("tree-outline").getByRole("listitem");
  await expect(outline).toHaveCount(6, COMMAND);
  await expect(page.getByText("6 nodes · 5 edges · 1 abandoned")).toBeVisible();
  const abandoned = outline.filter({ hasText: "Abandoned" });
  await expect(abandoned).toHaveCount(1);
  await expect(abandoned).toContainText("Split classical cases");
  await expect(outline.filter({ hasText: "On the solved route" })).toHaveCount(5);
  await abandoned.getByRole("button").click();
  await expect(page.getByTestId("node-detail")).toContainText("Split classical cases");
});
