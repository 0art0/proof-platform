import { expect, test, type Locator, type Page } from "@playwright/test";
import { createIsolatedSession } from "./fixtures";

function goal(page: Page, number = 1) {
  return page.getByRole("button", { name: `Select goal ${number}`, exact: true });
}

function hypothesis(page: Page, number: number) {
  return page.getByRole("button", { name: `Select hypothesis ${number} of goal 1` });
}

function suggestion(page: Page, name: RegExp) {
  return page
    .getByTestId("suggestion-list")
    .locator("li[data-suggestion-id]")
    .filter({ has: page.getByRole("heading", { name }) });
}

async function apply(card: Locator, preview = true) {
  if (preview) await card.getByRole("button", { name: "Preview changes" }).click();
  const changes = card.getByRole("region", { name: "Move preview" });
  await expect(changes).toBeVisible();
  await card.getByRole("button", { name: "Apply this step" }).click();
  await expect(card).toHaveCount(0);
}

async function readFinishedProof(page: Page, steps: number) {
  await expect(page.getByTestId("snapshot-status")).toHaveText("No open goals");
  await page.getByRole("link", { name: "View proof", exact: true }).click();
  await expect(page.getByTestId("solved-status")).toContainText("Solved");
  await expect(page.getByTestId("no-sorry-dependency")).toBeVisible();
  await expect(page.getByText("Background inference is used at:")).toHaveCount(0);
  await expect(page.getByTestId("proof-steps").locator(":scope > li")).toHaveCount(steps);
}

test("enter and prove a divisibility result from the landing page", async ({ page }) => {
  const statement = "For integers a, b, c with a dividing b, show that a divides bc + b.";
  await page.goto("/");
  await page.getByLabel("New problem statement").fill(statement);
  await page.getByRole("button", { name: "Start a new problem" }).click();
  await page.getByLabel("Assumed level").fill("Elementary number theory");
  await page.getByLabel("What the reader is expected to know").fill("Divisibility of integers.");
  await page.getByText("Choose notation and results", { exact: true }).click();
  await page.getByRole("checkbox", { name: /^Divisibility/ }).check();
  await page.getByText("Choose notation and results", { exact: true }).click();

  for (const [index, symbol] of ["a", "b", "c"].entries()) {
    if (index > 0) await page.getByRole("button", { name: "Add variable or object" }).click();
    await page.getByLabel(`Variable or object ${index + 1}`, { exact: true }).fill(symbol);
    await page.getByLabel(`Kind of symbol ${index + 1}`).selectOption({ label: "Integer" });
  }
  await page.getByRole("button", { name: "Add hypothesis" }).click();
  await page.getByLabel("Hypothesis 1", { exact: true }).fill(String.raw`a\mid b`);
  await page.getByLabel("Goal 1", { exact: true }).fill(String.raw`a\mid bc+b`);
  await page.getByRole("button", { name: "Check setup" }).click();
  await page.getByRole("button", { name: "Start exploring" }).click();

  await goal(page).click();
  await apply(suggestion(page, /^Divisibility of a sum \(apply result\)$/));
  await expect(page.getByRole("link", { name: "View proof", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("snapshot-status")).toContainText("2 goals");
  await goal(page).click();
  await apply(suggestion(page, /^Divisibility of a multiple(?: \(apply result\))?$/));

  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await goal(page).click();
    await hypothesis(page, 1).click({ modifiers: ["ControlOrMeta"] });
    await apply(suggestion(page, /^Close by hypothesis/));
  }
  await readFinishedProof(page, 4);
});

test("chain inequalities and pick an addend from the proof context", async ({ page }) => {
  const session = await createIsolatedSession(page, {
    problem: {
      title: "A shifted chain of inequalities",
      statement: "Given a ≤ b and b ≤ c, prove a + d ≤ c + d.",
    },
    background: { level: "Real arithmetic", summary: "Order on the reals", assumptions: [] },
    libraryLayerIds: ["layer:global"],
    packs: ["pack:order"],
    declarations: ["a", "b", "c", "d"].map((symbol) => ({ symbol, sort: "real" })),
    hypotheses: [
      { format: "mathjson", expression: ["LessEqual", "a", "b"] },
      { format: "mathjson", expression: ["LessEqual", "b", "c"] },
    ],
    goals: [
      { format: "mathjson", expression: ["LessEqual", ["Add", "a", "d"], ["Add", "c", "d"]] },
    ],
  });
  await page.goto(`/sessions/${encodeURIComponent(session)}`);
  await hypothesis(page, 1).click();
  await apply(suggestion(page, /^Transitivity of ≤ \(rewrite\)$/));
  await hypothesis(page, 1).click();
  const add = suggestion(page, /^Monotonicity of addition for ≤(?: \(apply result\))?$/);
  await add.getByRole("button", { name: "Choose values" }).click();
  await add.getByRole("radio", { name: /^d\b/ }).check();
  await add.getByRole("button", { name: "Preview with these inputs" }).click();
  await expect(add.getByRole("region", { name: "Move preview" })).toContainText(/a\+d≤c\+d/);
  await apply(add, false);

  await goal(page).click();
  await hypothesis(page, 3).click({ modifiers: ["ControlOrMeta"] });
  await apply(suggestion(page, /^Close by hypothesis/));
  await readFinishedProof(page, 3);
});

test("rewrite a factor by clicking the occurrence inside a product", async ({ page }) => {
  const session = await createIsolatedSession(page, {
    problem: {
      title: "Multiplying an equation",
      statement: "For reals a, b, c with a = b, show a · c = b · c.",
    },
    background: { level: "Real arithmetic", summary: "Equality and products", assumptions: [] },
    libraryLayerIds: ["layer:global"],
    packs: [],
    declarations: ["a", "b", "c"].map((symbol) => ({ symbol, sort: "real" })),
    hypotheses: [{ format: "mathjson", expression: ["Equal", "a", "b"] }],
    goals: [
      { format: "mathjson", expression: ["Equal", ["Multiply", "a", "c"], ["Multiply", "b", "c"]] },
    ],
  });
  await page.goto(`/sessions/${encodeURIComponent(session)}`);
  const field = page.getByLabel("Goal 1 conclusion", { exact: true });
  await field.locator("[data-atom-id]").getByText("a", { exact: true }).click();
  const rewrite = suggestion(page, /^Rewrite with hypothesis 1/);
  await rewrite.getByRole("button", { name: "Preview changes" }).click();
  await expect(rewrite.getByRole("region", { name: "Move preview" })).toContainText("b⋅c=b⋅c");
  await apply(rewrite, false);

  await goal(page).focus();
  await page.keyboard.press("Enter");
  await expect(goal(page)).toHaveAttribute("aria-pressed", "true");
  await apply(suggestion(page, /^Close by reflexivity/));
  await readFinishedProof(page, 2);
});
