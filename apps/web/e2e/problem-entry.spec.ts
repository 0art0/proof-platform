import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function fillPropositionalDraft(page: Page) {
  await page.getByLabel("Problem title", { exact: true }).fill("Disjunction introduction");
  await page.getByLabel("Problem statement", { exact: true }).fill("Assuming p, show p or q.");
  await page.getByText("More setup choices (optional)").click();
  await page.getByLabel("Assumed level", { exact: true }).fill("elementary propositional logic");
  await page
    .getByLabel("What the reader is expected to know", { exact: true })
    .fill("Natural deduction.");
  await page.getByLabel("Variable or object 1", { exact: true }).fill("p");
  await page.getByRole("button", { name: "Add variable or object" }).click();
  await page.getByLabel("Variable or object 2", { exact: true }).fill("q");
  await page.getByLabel("Kind of symbol 2", { exact: true }).selectOption("proposition");
  await page.getByRole("button", { name: "Add hypothesis" }).click();
  await page.getByLabel("Hypothesis 1", { exact: true }).fill("p");
  await page.getByLabel("Goal 1", { exact: true }).fill("p \\lor q");
  await expect(page.getByText("Notation recognized.").first()).toBeVisible();
}

test("the landing page offers the three ways to begin", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "New problem" })).toBeVisible();
  await expect(page.getByLabel("Artifact file", { exact: true })).toBeEnabled();
  // Upload waits for a chosen file.
  await expect(page.getByRole("button", { name: "Open proof file" })).toBeDisabled();

  await page.getByLabel("Saved proof ID", { exact: true }).fill("session:development");
  await page.getByRole("button", { name: "Resume proof" }).click();
  await expect(page).toHaveURL(/\/sessions\/session(%3A|:)development$/);
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();
});

test("a reviewed and approved problem becomes a new session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Start a new problem" })).toHaveAttribute(
    "href",
    "/problems/new",
  );
  await page.goto("/problems/new");
  await expect(page.getByRole("heading", { name: "New problem", level: 1 })).toBeVisible();
  await fillPropositionalDraft(page);

  const approve = page.getByRole("button", { name: "Start exploring" });
  await expect(approve).toHaveCount(0);
  await page.getByRole("button", { name: "Check setup" }).click();
  await expect(approve).toBeEnabled();

  // An edit after review withdraws the approval until the draft is reviewed again.
  await page.getByLabel("Goal 1", { exact: true }).fill("q \\lor p");
  await expect(approve).toHaveCount(0);
  await page.getByRole("button", { name: "Check setup" }).click();
  await expect(page.getByRole("region", { name: "Review" })).toContainText("q \\lor p");

  await approve.click();
  await expect(page).toHaveURL(/\/sessions\/session(%3A|:)[0-9a-f-]{36}$/);
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Goal 1 conclusion", { exact: true })).toBeVisible();
});

test("the worker's diagnostics explain a rejected draft", async ({ page }) => {
  await page.goto("/problems/new");
  await fillPropositionalDraft(page);
  await page.getByLabel("Goal 1", { exact: true }).fill("p \\lor r");
  await page.getByRole("button", { name: "Check setup" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Goal 1 uses r, which is not declared" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Start exploring" })).toHaveCount(0);
});

test("an exported artifact uploads as a read-only session", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Download a saved proof").click();
  const downloadButton = page.getByRole("button", { name: "Download artifact" });
  await expect(downloadButton).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("Saved proof ID to download", { exact: true }).fill("session:development");
  await downloadButton.click();
  await expect(page.getByText("This session is private. Export it anyway?")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export anyway" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("session-development.proof-artifact.json");
  const exportedBody = await readFile((await download.path()) ?? "");

  await page.getByLabel("Artifact file", { exact: true }).setInputFiles({
    name: "session-development.proof-artifact.json",
    mimeType: "application/json",
    buffer: exportedBody,
  });
  await page.getByRole("button", { name: "Open proof file" }).click();
  await expect(page).toHaveURL(/\/sessions\/session(%3A|:)artifact(%3A|:)[0-9a-f]{32}$/);
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();
});

test("a created proof is listed under recent proofs on the home page", async ({ page }) => {
  await page.goto("/problems/new");
  await fillPropositionalDraft(page);
  await page.getByRole("button", { name: "Check setup" }).click();
  await page.getByRole("button", { name: "Start exploring" }).click();
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();

  await page.goto("/");
  const recent = page.getByRole("region", { name: "Recent proofs" });
  await expect(recent.getByRole("link", { name: "Disjunction introduction" })).toBeVisible();
});

test("an empty check lists every missing required field", async ({ page }) => {
  await page.goto("/problems/new");
  await page.getByRole("button", { name: "Check setup" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "cannot be checked yet" });
  await expect(alert).toContainText("Problem title: This is required.");
  await expect(alert).toContainText("Assumed level");
  await expect(alert).toContainText("Goal 1");
});

test("an unknown proof shows a page with a way back", async ({ page }) => {
  await page.goto("/sessions/session%3Adoes-not-exist");
  await expect(page.getByRole("heading", { name: "Proof not found" })).toBeVisible();
  await page.getByRole("link", { name: "Back to the start" }).click();
  await expect(page).toHaveURL(/\/$/);
});
