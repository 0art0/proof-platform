import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function fillPropositionalDraft(page: Page) {
  await page.getByLabel("Problem title", { exact: true }).fill("Disjunction introduction");
  await page.getByLabel("Problem statement", { exact: true }).fill("Assuming p, show p or q.");
  await page.getByLabel("Background level", { exact: true }).fill("elementary propositional logic");
  await page.getByLabel("Background summary", { exact: true }).fill("Natural deduction.");
  await page.getByLabel("Symbol 1", { exact: true }).fill("p");
  await page.getByRole("button", { name: "Add declaration" }).click();
  await page.getByLabel("Symbol 2", { exact: true }).fill("q");
  await page.getByLabel("Sort 2", { exact: true }).selectOption("proposition");
  await page.getByRole("button", { name: "Add hypothesis" }).click();
  await page.getByLabel("Hypothesis 1", { exact: true }).fill("p");
  await page.getByLabel("Goal 1", { exact: true }).fill("p \\lor q");
  await expect(page.getByText('["Or","p","q"]')).toBeVisible();
}

test("the landing page offers the three actions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "New problem" })).toBeVisible();
  await expect(page.getByLabel("Artifact file", { exact: true })).toBeEnabled();
  // Upload waits for a chosen file.
  await expect(page.getByRole("button", { name: "Upload artifact" })).toBeDisabled();

  await page.getByLabel("Session ID", { exact: true }).fill("session:development");
  await page.getByRole("button", { name: "Open session" }).click();
  await expect(page).toHaveURL(/\/sessions\/session(%3A|:)development$/);
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();
});

test("a reviewed and approved problem becomes a new session", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Enter a new problem" })).toHaveAttribute(
    "href",
    "/problems/new",
  );
  await page.goto("/problems/new");
  await expect(page.getByRole("heading", { name: "New problem", level: 1 })).toBeVisible();
  await fillPropositionalDraft(page);

  const approve = page.getByRole("button", { name: "Approve and create session" });
  await expect(approve).toHaveCount(0);
  await page.getByRole("button", { name: "Review draft" }).click();
  await expect(approve).toBeEnabled();

  // An edit after review withdraws the approval until the draft is reviewed again.
  await page.getByLabel("Goal 1", { exact: true }).fill("q \\lor p");
  await expect(approve).toHaveCount(0);
  await page.getByRole("button", { name: "Review draft" }).click();
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
  await page.getByRole("button", { name: "Review draft" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Goal 1 uses r, which is not declared" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and create session" })).toHaveCount(0);
});

test("an exported artifact uploads as a read-only session", async ({ page }) => {
  await page.goto("/");
  // A click before hydration submits the form natively and reloads the page, so retry it.
  await expect(async () => {
    await page.getByLabel("Session ID to download", { exact: true }).fill("session:development");
    await page.getByRole("button", { name: "Download artifact" }).click();
    await expect(page.getByText("This session is private. Export it anyway?")).toBeVisible({
      timeout: 4_000,
    });
  }).toPass({ timeout: 60_000 });
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
  await page.getByRole("button", { name: "Upload artifact" }).click();
  await expect(page).toHaveURL(/\/sessions\/session(%3A|:)artifact(%3A|:)[0-9a-f]{32}$/);
  await expect(page.getByLabel("Stored proof session", { exact: true })).toBeVisible();
});
