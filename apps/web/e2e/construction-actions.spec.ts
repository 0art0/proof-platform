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

// The only candidate the menu can offer for delta is eps, which is what the goal asks for.
const WITNESS_DRAFT: IsolatedDraft = {
  problem: { title: "A number equal to eps", statement: "Given eps > 0, find delta = eps." },
  background: { level: "real analysis", summary: "Elementary equalities.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "eps", sort: "real" },
    { symbol: "delta", sort: "real" },
  ],
  hypotheses: [{ format: "mathjson", expression: ["Greater", "eps", 0] }],
  goals: [{ format: "mathjson", expression: ["Exists", "delta", ["Equal", "delta", "eps"]] }],
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

test("constructing a witness: introduce, add a requirement and a candidate, then use it", async ({
  page,
}) => {
  await openSession(page, WITNESS_DRAFT);
  const panel = page.getByRole("region", { name: "Inquiry" });
  await panel.getByText("Show inquiry details").click();

  // 1. Construct an object for the existential goal.
  await selectExpression(page.getByLabel("Goal 1 conclusion"), "eps");
  await panel.getByRole("button", { name: "Construct an object" }).click();
  const entry = panel.getByTestId("construction-entry");
  await expect(entry).toContainText(/delta · unresolved · 0 requirements/, COMMAND);
  await entry.locator("summary").first().click();
  const task = entry.getByTestId("construction-task");
  // The placeholder reads as its task's name in the formulas, not as a raw application.
  await expect(task).toContainText("the existential goal");
  const actions = entry.getByRole("group", { name: "Actions for delta" });

  // Nothing is offered until it can apply, and every disabled action says why.
  await expect(actions.getByRole("button", { name: "Use this candidate" })).toBeDisabled();
  await expect(actions).toContainText("Add a candidate for delta first.");
  await expect(actions.getByRole("button", { name: "Abandon" })).toBeDisabled();
  await expect(actions).toContainText(/still occurs in the proof state/);
  await expect(entry.getByTestId("construction-choice")).toHaveCount(0);

  // 2. Add the requirement the proof already demands, chosen from the menu.
  await actions.getByRole("button", { name: "Add requirement" }).click();
  const requirementChoice = entry.getByTestId("construction-choice");
  await expect(requirementChoice).toContainText(/Sufficient: the proof already needs this/);
  await requirementChoice.getByRole("radio").first().check();
  await requirementChoice.getByRole("button", { name: "Record requirement" }).click();
  await expect(entry).toContainText(/delta · partially specified · 1 requirement/, COMMAND);
  const sufficient = task.getByRole("region", { name: "Sufficient requirements" });
  await expect(sufficient).toContainText("the proof state already requires it");
  // The requirement shows the placeholder by its name.
  await expect(sufficient.locator('[data-latex*="boxed"]').first()).toBeVisible();

  // 3. Add a candidate: eps, a term the construction may depend on.
  await actions.getByRole("button", { name: "Add candidate" }).click();
  const candidateChoice = entry.getByTestId("construction-choice");
  await candidateChoice.getByRole("radio").first().check();
  await candidateChoice.getByRole("button", { name: "Record candidate" }).click();
  await expect(task.getByRole("region", { name: "Candidates" })).toContainText(/Attempt/, COMMAND);

  // 4. Use it: the choice is substituted, and what remains to prove stays visible.
  await actions.getByRole("button", { name: "Use this candidate" }).click();
  const useChoice = entry.getByTestId("construction-choice");
  await expect(useChoice).toContainText(/substituted for delta in every goal and obligation/);
  await useChoice.getByRole("radio").first().check();
  await useChoice.getByRole("button", { name: "Use this candidate" }).click();

  await expect(panel.getByText("Unresolved constructions (0)")).toBeVisible(COMMAND);
  await panel.getByText(/Closed constructions \(1\)/).click();
  await expect(panel.getByTestId("construction-task")).toContainText(
    /Resolved by candidate/,
    COMMAND,
  );
  // Resolution never closes a target: the substituted goal is still open to prove.
  await expect(page.getByTestId("snapshot-status")).toHaveText(
    /Open: 1 goal, 0 obligations/,
    COMMAND,
  );
});
