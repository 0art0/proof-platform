import { expect, test } from "@playwright/test";
import { createIsolatedSession, type IsolatedDraft } from "./fixtures";
import { MACRO_MOVE_ID, MACRO_NAME, macroTemplate } from "./macro-template";
import { COMMAND, currentNodeId, selectInAnyField } from "./mouse-helpers";

test.slow();

// Roadmap N35: an approved multi-step macro is offered as one suggestion ("N-step move"), the
// preview shows each step, applying it records the steps as one labelled application in the
// history, and deleting the previous move removes the whole application. The macro is created
// through the same author/review envelopes the editor sends (the editor itself is covered by
// move-authoring.spec.ts).
const GOAL = ["Implies", "p", ["Implies", "q", "r"]];

const DRAFT: IsolatedDraft = {
  problem: { title: "Two nested implications", statement: "Show that p implies q implies r." },
  background: { level: "propositional logic", summary: "Natural deduction.", assumptions: [] },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
    { symbol: "r", sort: "proposition" },
  ],
  hypotheses: [],
  goals: [{ format: "mathjson", expression: GOAL }],
};

test("an approved two-step macro is offered, previewed step by step, applied and deleted as one", async ({
  page,
}) => {
  const sessionId = await createIsolatedSession(page, DRAFT);
  const workspace = `/sessions/${encodeURIComponent(sessionId)}`;

  // Author and approve the macro through the recorded envelopes.
  const approved = await page.evaluate(
    async ({ id, template }) => {
      const send = async (command: Record<string, unknown>) => {
        const response = await fetch(
          `/api/proof-sessions/${encodeURIComponent(id)}/protocol-commands`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              commandId: `command:e2e-${crypto.randomUUID()}`,
              actor: { id: "actor:web", kind: "human" },
              command,
            }),
          },
        );
        return { status: response.status, body: await response.json() };
      };
      const drafted = await send({
        kind: "author-move-draft",
        template,
        payloadSource: "reviewed-authoring",
      });
      if (drafted.status !== 201) return { step: "draft", ...drafted };
      const reviewed = await send({
        kind: "review-move-draft",
        draftArtifactId: drafted.body.data.result.artifactId,
        decision: "approved",
        notes: "Recorded for the macro e2e.",
        payloadSource: "reviewed-authoring",
      });
      return { step: "review", ...reviewed };
    },
    { id: sessionId, template: macroTemplate() },
  );
  expect(approved, JSON.stringify(approved)).toMatchObject({ step: "review", status: 201 });

  await page.goto(workspace);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 1 goal/, COMMAND);
  const rootId = await currentNodeId(page);
  await selectInAnyField(page.locator('[aria-label$="conclusion"]'), GOAL);

  // The card says it is a 2-step move, with the class of the whole.
  const card = page.locator(`[data-artifact-id="${MACRO_MOVE_ID}"]`);
  await expect(card).toBeVisible(COMMAND);
  await expect(card).toContainText(MACRO_NAME);
  await expect(card.locator('[data-badge="macro"]')).toContainText("2-step move", COMMAND);
  await expect(card).toContainText("Applies 2 steps in a row; as a whole it is an equivalence.");

  // Preview: each step's outcome, the first open and the rest collapsed. Nothing is applied yet.
  await card.getByRole("button", { name: "Preview changes" }).click();
  const steps = card.getByRole("list", { name: "Steps of this move" });
  await expect(steps).toBeVisible(COMMAND);
  await expect(steps.getByRole("listitem")).toHaveCount(2);
  await expect(steps.locator("details").nth(0)).toHaveJSProperty("open", true);
  await expect(steps.locator("details").nth(1)).toHaveJSProperty("open", false);
  await expect(steps.getByRole("listitem").nth(0)).toContainText(
    "Step 1 of 2: Introduce implication",
  );
  expect(await currentNodeId(page)).toBe(rootId);

  // Apply: the history shows one labelled application with both steps.
  await card.getByRole("button", { name: "Apply this step" }).click();
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 1 goal/, COMMAND);
  const history = page.getByRole("region", { name: "Proof-discovery tree" });
  const application = history.locator("[data-macro-application]");
  await expect(application).toHaveCount(1, COMMAND);
  await expect(application).toContainText(`Macro: ${MACRO_NAME}`);
  await expect(application).toContainText("2 steps applied as one move");
  const stepButtons = history.locator("li[data-macro-step] button");
  await expect(stepButtons).toHaveCount(2);
  await expect(stepButtons.nth(0)).toContainText(`Macro ${MACRO_NAME}, step 1 of 2`);
  await expect(stepButtons.nth(1)).toContainText(`Macro ${MACRO_NAME}, step 2 of 2`);
  expect(await currentNodeId(page)).not.toBe(rootId);

  // The stored viewers name the steps too.
  await page.goto(`${workspace}/tree`);
  const outline = page.getByTestId("tree-outline");
  await expect(outline.locator("[data-macro-application]")).toHaveCount(1, COMMAND);
  await expect(outline).toContainText("Macro Introduce two implications, step 2 of 2");

  // Deleting the previous move removes the whole application.
  await page.goto(workspace);
  await expect(history.locator("[data-macro-application]")).toHaveCount(1, COMMAND);
  await page.getByText("More proof actions").click();
  await page.getByRole("button", { name: "Delete previous move…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("delete-macro-note")).toContainText(
    "Deleting it removes the whole macro application, all 2 steps",
  );
  await dialog.getByRole("button", { name: "Delete move" }).click();
  await expect(page.locator("[data-history-node-id]")).toHaveCount(1, COMMAND);
  expect(await currentNodeId(page)).toBe(rootId);
});
