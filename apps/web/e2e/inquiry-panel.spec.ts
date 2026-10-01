import { expect, test, type Locator, type Page } from "@playwright/test";
import { createIsolatedSession, warmRoutes, type IsolatedDraft } from "./fixtures";

// Commands and first-use routes compile on a dev server that may be loaded by parallel specs.
const COMMAND = { timeout: 45_000 } as const;

test.slow();

type MathfieldPort = HTMLElement & {
  lastOffset: number;
  selection: { ranges: Array<[number, number]> };
  getValue: (range: [number, number], format: "math-json") => string;
};

/** Select the first display range of a MathLive field whose MathJSON is `target`. */
async function selectExpression(field: Locator, target: unknown) {
  const selected = await field.evaluate((element, serializedTarget) => {
    const mathfield = element as MathfieldPort;
    for (let start = 0; start < mathfield.lastOffset; start += 1) {
      for (let end = start + 1; end <= mathfield.lastOffset; end += 1) {
        try {
          if (
            JSON.stringify(JSON.parse(mathfield.getValue([start, end], "math-json"))) ===
            serializedTarget
          ) {
            mathfield.selection = { ranges: [[start, end]] };
            mathfield.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
            return true;
          }
        } catch {
          // Arbitrary display ranges are usually not complete MathJSON expressions.
        }
      }
    }
    return false;
  }, JSON.stringify(target));
  expect(selected).toBe(true);
}

const COMMUTE_DRAFT: IsolatedDraft = {
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

const EXISTENTIAL_GOAL = [
  "Exists",
  "delta",
  ["And", ["Greater", "delta", 0], ["Less", "delta", "eps"]],
];

const EXISTENTIAL_DRAFT: IsolatedDraft = {
  problem: {
    title: "A small positive number",
    statement: "Given eps > 0, find delta in (0, eps).",
  },
  background: { level: "real analysis", summary: "Elementary inequalities.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "eps", sort: "real" },
    { symbol: "delta", sort: "real" },
  ],
  hypotheses: [{ format: "mathjson", expression: ["Greater", "eps", 0] }],
  goals: [{ format: "mathjson", expression: EXISTENTIAL_GOAL }],
};

async function openSession(page: Page, draft: IsolatedDraft): Promise<void> {
  const sessionId = await createIsolatedSession(page, draft);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  await expect(page.getByLabel("Stored proof session")).toBeVisible();
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveText(
    /Open: 1 goal, 0 obligations/,
    COMMAND,
  );
  await warmRoutes(page, sessionId);
  await expect(page.getByRole("region", { name: "Inquiry" })).toBeVisible();
}

test("investigating a hypothesis records a Determine question shown in the inquiry panel", async ({
  page,
}) => {
  await openSession(page, COMMUTE_DRAFT);
  const panel = page.getByRole("region", { name: "Inquiry" });
  // The panel starts collapsed until there is an objective or a selection.
  await panel.getByText("Show inquiry details").click();
  const investigate = panel.getByRole("button", { name: "Investigate this hypothesis" });
  await expect(investigate).toBeDisabled();
  await expect(panel.getByText("Select an occurrence in a hypothesis first.")).toBeVisible();
  await expect(panel.getByTestId("inquiry-objective")).toContainText("None yet.", COMMAND);

  await selectExpression(page.getByLabel("Goal 1 hypothesis 1"), ["And", "p", "q"]);
  await expect(investigate).toBeEnabled();
  await investigate.click();
  await expect(panel.getByTestId("inquiry-feedback")).toHaveText(
    "Recorded in this inquiry: Investigate this hypothesis.",
    COMMAND,
  );

  // The Determine question over the goal without that hypothesis, with its elective objective.
  const objective = panel.getByTestId("inquiry-objective");
  await expect(objective).toContainText("Elective · active", COMMAND);
  await expect(objective).toContainText(/determine|whether/i);
  await expect(objective).not.toContainText("None yet.");
});

test("constructing an object on an existential goal shows its construction task", async ({
  page,
}) => {
  await openSession(page, EXISTENTIAL_DRAFT);
  const panel = page.getByRole("region", { name: "Inquiry" });
  await panel.getByText("Show inquiry details").click();
  const construct = panel.getByRole("button", { name: "Construct an object" });
  await expect(construct).toBeDisabled();
  await expect(
    panel.getByText(/Select an occurrence in a goal or obligation first/).first(),
  ).toBeVisible();

  // Any occurrence inside the target selects the target; a bare symbol is the surest to locate.
  await selectExpression(page.getByLabel("Goal 1 conclusion"), "eps");
  await expect(construct).toBeEnabled();
  await construct.click();
  await expect(page.getByText(/Construct an object committed; now at node:/).first()).toBeVisible(
    COMMAND,
  );

  const entry = panel.getByTestId("construction-entry");
  await expect(entry).toContainText(/delta · unresolved · 0 requirements/, COMMAND);
  await entry.locator("summary").click();
  const task = entry.getByTestId("construction-task");
  await expect(task).toContainText("the existential goal");
  await expect(task.getByTestId("construction-dependencies")).toHaveText("eps");
  for (const role of ["Necessary", "Sufficient", "Heuristic"]) {
    await expect(task.getByRole("region", { name: `${role} requirements` })).toContainText(
      "None recorded.",
    );
  }
  // The goal now concerns the placeholder, so it is no longer an existential to construct for.
  await expect(construct).toBeDisabled();
});
