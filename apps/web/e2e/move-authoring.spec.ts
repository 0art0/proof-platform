import { expect, test } from "@playwright/test";
import { createIsolatedSession, type IsolatedDraft } from "./fixtures";
import { COMMAND, currentNodeId, previewAndApply, selectInAnyField } from "./mouse-helpers";

test.slow();

// Roadmap N35 (design plan §13.1): author a move without AI. A move is built from a step recorded
// in the stored history, patterns and negative examples are picked by clicking in stored
// snapshots, the proof service validates the examples, and the move becomes a suggestion only
// after a recorded approval.
const P_AND_Q = ["And", "p", "q"];
const Q_AND_P = ["And", "q", "p"];
const MOVE_ID = "authored:split-a-conjunction-goal";

const DRAFT: IsolatedDraft = {
  problem: { title: "Two conjunctions", statement: "From p and q, show p and q, and q and p." },
  background: { level: "propositional logic", summary: "Natural deduction.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
  ],
  hypotheses: [
    { format: "mathjson", expression: "p" },
    { format: "mathjson", expression: "q" },
  ],
  goals: [
    { format: "mathjson", expression: P_AND_Q },
    { format: "mathjson", expression: Q_AND_P },
  ],
};

test("a move authored from a recorded step is validated, approved, then offered as a suggestion", async ({
  page,
}) => {
  const sessionId = await createIsolatedSession(page, DRAFT);
  const workspace = `/sessions/${encodeURIComponent(sessionId)}`;
  await page.goto(workspace);
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
  const goalFields = page.locator('[aria-label$="conclusion"]');
  const nodes = page.locator("[data-history-node-id]");

  // Two recorded applications of the same primitive, on different goals: the move's positive
  // examples. The first one is also the step the move is made from.
  await selectInAnyField(goalFields, P_AND_Q);
  await previewAndApply(page, "move:split-goal-conjunction");
  await expect(nodes).toHaveCount(2, COMMAND);
  const firstSplit = await currentNodeId(page);
  await selectInAnyField(goalFields, Q_AND_P);
  await previewAndApply(page, "move:split-goal-conjunction");
  await expect(nodes).toHaveCount(3, COMMAND);
  const secondSplit = await currentNodeId(page);

  // The workspace links to the authoring page.
  await page.getByRole("link", { name: "Author moves" }).click();
  await expect(page.getByRole("heading", { name: "Author moves" })).toBeVisible(COMMAND);
  await expect(
    page.getByRole("heading", { name: "1. Start from something you already did" }),
  ).toBeVisible();

  // 1. Start from the first recorded step.
  await page.getByLabel("Path ending at").selectOption(firstSplit);
  await page.getByRole("button", { name: "Start a single-step move from this step" }).click();
  const template = page.getByRole("region", { name: "Move template" });
  await expect(template).toBeVisible();
  await expect(page.getByRole("region", { name: "Patterns" })).toContainText("And(p, q)");

  // 2. Name and describe it; the ID follows the name.
  await page.getByLabel("Name", { exact: true }).fill("Split a conjunction goal");
  await page
    .getByLabel("Description")
    .fill("Turn a goal “A and B” into one goal for A and one for B.");
  await expect(page.getByTestId("move-id")).toContainText(MOVE_ID);

  // 3. Two examples that should work: the two recorded splits.
  const examples = page.getByRole("region", { name: "Examples" });
  await expect(examples).toContainText(
    "No examples yet: add two that should work and one that shouldn't.",
  );
  await examples.getByRole("button", { name: "Add as a positive example" }).first().click();
  await examples.getByRole("button", { name: "Add as a positive example" }).first().click();
  await expect(page.getByTestId("example-counts")).toContainText("2 should work, 0 should fail");

  // ... and one that shouldn't: an atom is not a conjunction. The selection is clicked in the
  // stored snapshot after the second split, where every goal is an atom.
  const snapshot = page.getByRole("region", { name: "Stored snapshot" });
  await snapshot.getByLabel("Snapshot").selectOption(secondSplit);
  await expect(snapshot.getByLabel("Goal 1 conclusion")).toBeVisible();
  await selectInAnyField(snapshot.locator('[aria-label$="conclusion"]'), "p");
  await expect(page.getByTestId("snapshot-selection")).toHaveText("Selected: p");
  await snapshot.getByRole("button", { name: "Assign the selection to this slot" }).click();
  await snapshot.getByRole("button", { name: /Add as a negative example/ }).click();
  await expect(page.getByTestId("example-counts")).toContainText("2 should work, 1 should fail");

  // 4. Check the move: the proof service runs every example through the kernel.
  await page.getByRole("button", { name: "Validate by running the examples" }).click();
  await expect(page.getByText("The template passes validation.")).toBeVisible(COMMAND);
  await expect(page.getByTestId("validation-retrievable")).toContainText(
    "Once approved this move is offered as a suggestion",
  );

  // 5. Save it as a draft: not yet a suggestion.
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByTestId("authoring-notice")).toContainText(
    `Saved revision 1 of ${MOVE_ID} as a draft. It passes validation.`,
    COMMAND,
  );
  const authored = page.getByRole("article", { name: `Move ${MOVE_ID}` });
  await expect(authored.getByTestId(`retrievable-${MOVE_ID}`)).toContainText(
    "Not retrievable: no approved version",
    COMMAND,
  );

  // 6. Approve it with a recorded review.
  await authored.getByRole("radio", { name: "Approve" }).check();
  await authored.getByRole("textbox").fill("Reviewed against both recorded splits.");
  await authored.getByRole("button", { name: "Record: Approve" }).click();
  await expect(page.getByTestId("authoring-notice")).toContainText(
    `Approved revision 1 of ${MOVE_ID}; it is now offered as a suggestion.`,
    COMMAND,
  );
  await expect(authored.getByTestId(`retrievable-${MOVE_ID}`)).toContainText(
    "Retrievable: offered as a suggestion",
    COMMAND,
  );
  await expect(authored.getByTestId("recorded-review")).toContainText("Approve by actor:web");
  await expect(authored.getByTestId("recorded-review")).toContainText(
    "Reviewed against both recorded splits.",
  );

  // The approved move is offered in the workspace for a matching selection: return to the node
  // after the first split, where "q and p" is still an open goal.
  await page.goto(workspace);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 4 goals/, COMMAND);
  await page.locator(`[data-history-node-id="${firstSplit}"]`).click();
  await expect(page.getByText(`Backtracked to ${firstSplit}.`, { exact: true })).toBeVisible(
    COMMAND,
  );
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 3 goals/, COMMAND);
  await expect(page.getByLabel("Goal 3 conclusion")).toBeVisible();
  await selectInAnyField(page.locator('[aria-label$="conclusion"]'), Q_AND_P);
  const offered = page.locator(`[data-artifact-id="${MOVE_ID}"]`);
  await expect(offered).toBeVisible(COMMAND);
  await expect(offered).toContainText("Split a conjunction goal");

  // Applying it goes through the same kernel path as the built-in move.
  await offered.getByRole("button", { name: "Preview" }).click();
  await expect(offered.getByLabel("Move preview")).toBeVisible(COMMAND);
  await offered.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 4 goals/, COMMAND);
});
