import { expect, test, type Locator, type Page } from "@playwright/test";

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

async function enterProblem(
  page: Page,
  problem: {
    statement: string;
    background: string;
    pack?: RegExp;
    sort: string;
    variables: string[];
    hypotheses: string[];
    conclusion: string;
  },
) {
  await page.goto("/");
  await page.getByLabel("New problem statement").fill(problem.statement);
  await page.getByRole("button", { name: "Start a new problem" }).click();
  await page.getByLabel("Assumed level").fill("First-year undergraduate");
  await page.getByLabel("What the reader is expected to know").fill(problem.background);
  if (problem.pack) {
    await page.getByText("Choose notation and results", { exact: true }).click();
    await page.getByRole("checkbox", { name: problem.pack }).check();
  }
  for (const [index, symbol] of problem.variables.entries()) {
    if (index > 0) await page.getByRole("button", { name: "Add variable or object" }).click();
    await page.getByLabel(`Variable or object ${index + 1}`, { exact: true }).fill(symbol);
    const sort = page.getByLabel(`Kind of symbol ${index + 1}`);
    if (index === 0) await sort.selectOption(problem.sort);
    await expect(sort).toHaveValue(problem.sort);
  }
  for (const [index, text] of problem.hypotheses.entries()) {
    await page.getByRole("button", { name: "Add hypothesis" }).click();
    await page.getByLabel(`Hypothesis ${index + 1}`, { exact: true }).fill(text);
  }
  await page.getByLabel("Goal 1", { exact: true }).fill(problem.conclusion);
  await page.getByRole("button", { name: "Check setup" }).click();
  await page.getByRole("button", { name: "Start exploring" }).click();
}

async function closeByHypothesis(page: Page, number: number) {
  await goal(page).click();
  await page.getByRole("button", { name: "Select another" }).click();
  await hypothesis(page, number).click();
  await apply(suggestion(page, /^Close by hypothesis/));
}

test("enter and prove a divisibility result from the landing page", async ({ page }) => {
  await enterProblem(page, {
    statement: "For integers a, b, c with a dividing b, show that a divides bc + b.",
    background: "Divisibility of integers.",
    pack: /^Divisibility/,
    sort: "integer",
    variables: ["a", "b", "c"],
    hypotheses: ["a ∣ b"],
    conclusion: "a ∣ bc+b",
  });
  await goal(page).click();
  await apply(suggestion(page, /^Divisibility of a sum \(apply result\)$/));
  await expect(page.getByRole("link", { name: "View proof", exact: true })).toHaveCount(0);
  await expect(page.getByTestId("snapshot-status")).toContainText("2 goals");
  await goal(page).click();
  await apply(suggestion(page, /^Divisibility of a multiple(?: \(apply result\))?$/));

  for (let remaining = 2; remaining > 0; remaining -= 1) {
    await closeByHypothesis(page, 1);
  }
  await readFinishedProof(page, 4);
});

test("chain inequalities and pick an addend from the proof context", async ({ page }) => {
  await enterProblem(page, {
    statement: "Given a ≤ b and b ≤ c, prove a + d ≤ c + d.",
    background: "Order on the reals.",
    pack: /^Order/,
    sort: "real",
    variables: ["a", "b", "c", "d"],
    hypotheses: ["a ≤ b", "b ≤ c"],
    conclusion: "a+d ≤ c+d",
  });
  await hypothesis(page, 1).click();
  await apply(suggestion(page, /^Transitivity of ≤ \(rewrite\)$/));
  await hypothesis(page, 1).click();
  const add = suggestion(page, /^Monotonicity of addition for ≤(?: \(apply result\))?$/);
  await add.getByRole("button", { name: "Choose values" }).click();
  await add.getByRole("radio", { name: /^d\b/ }).check();
  await add.getByRole("button", { name: "Preview with these inputs" }).click();
  await expect(add.getByRole("region", { name: "Move preview" })).toContainText(/a\+d≤c\+d/);
  await apply(add, false);

  await closeByHypothesis(page, 3);
  await readFinishedProof(page, 3);
});

test("rewrite a factor by clicking the occurrence inside a product", async ({ page }) => {
  await enterProblem(page, {
    statement: "For reals a, b, c with a = b, show ac = bc.",
    background: "Equality and products.",
    sort: "real",
    variables: ["a", "b", "c"],
    hypotheses: ["a=b"],
    conclusion: "ac=bc",
  });
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

test("prove set inclusion through an intermediate set", async ({ page }) => {
  await enterProblem(page, {
    statement: "For sets A, B, C with A ⊆ B and B ⊆ C, show A ⊆ C.",
    background: "Inclusion of sets.",
    pack: /^Sets/,
    sort: "set-of-elements",
    variables: ["A", "B", "C"],
    hypotheses: ["A ⊆ B", "B ⊆ C"],
    conclusion: "A ⊆ C",
  });
  await goal(page).click();
  const transitivity = suggestion(page, /transitivity of (⊆|inclusion)|subset transitivity/i);
  await transitivity.getByRole("button", { name: "Choose values" }).click();
  await transitivity.getByRole("radio", { name: /^B\b/ }).check();
  await transitivity.getByRole("button", { name: "Preview with these inputs" }).click();
  await apply(transitivity, false);
  await closeByHypothesis(page, 1);
  await closeByHypothesis(page, 2);
  await readFinishedProof(page, 3);
});
