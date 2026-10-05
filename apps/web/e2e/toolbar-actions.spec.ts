import { readFile } from "node:fs/promises";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createIsolatedSession, warmRoutes, type IsolatedDraft } from "./fixtures";

// Commands run against a dev server that may still be compiling for parallel specs; a committed
// command's notice gets more time than an ordinary assertion.
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

/** A fresh session per test: from `p ∧ q` show `q ∧ p`. */
async function openFreshSession(page: Page): Promise<string> {
  const sessionId = await createIsolatedSession(page, COMMUTE_DRAFT);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  await expect(page.getByLabel("Stored proof session")).toBeVisible();
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveText(
    /Open: 1 goal, 0 obligations/,
    COMMAND,
  );
  await warmRoutes(page, sessionId);
  await page.getByText("More proof actions").click();
  return sessionId;
}

async function currentNodeId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-history-node-id][data-current="true"]')
    .getAttribute("data-history-node-id");
  expect(id).toBeTruthy();
  return id!;
}

async function applySplitAtRoot(page: Page) {
  await selectExpression(page.getByLabel("Goal 1 conclusion"), ["And", "q", "p"]);
  const card = page.locator('[data-artifact-id="move:split-goal-conjunction"]');
  await card.getByRole("button", { name: "Preview changes" }).click();
  await expect(card.getByLabel("Move preview")).toBeVisible();
  await card.getByRole("button", { name: "Apply this step" }).click();
  await expect(page.getByText(/advanced to node:/)).toBeVisible(COMMAND);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
}

test("mark sorry acts on the selected goal", async ({ page }) => {
  await openFreshSession(page);
  const sorry = page.getByRole("button", { name: "Mark as sorry (assume)" });
  await expect(sorry).toBeDisabled();
  await expect(
    page.getByText("Select an occurrence in a goal or obligation first.").first(),
  ).toBeVisible();

  await selectExpression(page.getByLabel("Goal 1 conclusion"), ["And", "q", "p"]);
  await expect(sorry).toBeEnabled();
  await sorry.click();
  await expect(page.getByText(/Mark sorry committed; now at node:/)).toBeVisible(COMMAND);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/No open goals/, COMMAND);
  await expect(page.locator("[data-history-node-id]")).toHaveCount(2, COMMAND);
});

test("a move and its descendant are deleted only after confirmation", async ({ page }) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  await expect(page.getByRole("button", { name: "Delete previous move…" })).toBeDisabled();

  await applySplitAtRoot(page);
  const splitId = await currentNodeId(page);
  // A descendant of the split: mark its first goal sorry, then return to the split node.
  await selectExpression(page.getByLabel("Goal 1 conclusion"), "q");
  await page.getByRole("button", { name: "Mark as sorry (assume)" }).click();
  await expect(page.getByText(/Mark sorry committed/)).toBeVisible(COMMAND);
  await page.locator(`[data-history-node-id="${splitId}"]`).click();
  await expect(page.getByText(`Backtracked to ${splitId}.`, { exact: true })).toBeVisible(COMMAND);

  await page.getByRole("button", { name: "Delete previous move…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete previous move" });
  await expect(dialog.getByTestId("deletion-impact")).toContainText("2 nodes");
  await expect(dialog.getByTestId("deletion-impact")).toContainText("1 descendant node");
  const remove = dialog.getByRole("button", { name: "Delete move" });
  await expect(remove).toBeDisabled();

  // Escape closes the dialog; nothing is deleted.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0, COMMAND);
  await expect(page.locator("[data-history-node-id]")).toHaveCount(3, COMMAND);

  await page.getByRole("button", { name: "Delete previous move…" }).click();
  await dialog.getByRole("checkbox", { name: /Also delete the 1 descendant node/ }).check();
  await remove.click();
  await expect(page.getByText(`Delete previous move committed; now at ${rootId}.`)).toBeVisible(
    COMMAND,
  );
  await expect(page.locator("[data-history-node-id]")).toHaveCount(1, COMMAND);
  await expect(page.getByTestId("snapshot-status")).toHaveText(
    /Open: 1 goal, 0 obligations/,
    COMMAND,
  );
});

test("a leaf move is deleted from the dialog without a descendant confirmation", async ({
  page,
}) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  await applySplitAtRoot(page);
  await page.getByRole("button", { name: "Delete previous move…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete previous move" });
  await expect(dialog.getByTestId("deletion-impact")).toContainText("0 descendant nodes");
  await expect(dialog.getByRole("checkbox")).toHaveCount(0, COMMAND);
  await dialog.getByRole("button", { name: "Delete move" }).click();
  await expect(page.getByText(`Delete previous move committed; now at ${rootId}.`)).toBeVisible(
    COMMAND,
  );
  await expect(page.locator("[data-history-node-id]")).toHaveCount(1, COMMAND);
});

test("case split on a selected hypothesis creates both cases", async ({ page }) => {
  await openFreshSession(page);
  await selectExpression(page.getByLabel("Goal 1 hypothesis 1"), ["And", "p", "q"]);
  await page.getByRole("button", { name: "Case split on selection" }).click();
  await expect(page.getByText(/Case split committed; now at node:/)).toBeVisible(COMMAND);
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
});

test("backtracking with information splits at the chosen ancestor", async ({ page }) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  await applySplitAtRoot(page);
  const splitId = await currentNodeId(page);

  await selectExpression(page.getByLabel("Goal 1 hypothesis 1"), ["And", "p", "q"]);
  await page.getByRole("button", { name: "Backtrack with information…" }).click();
  const dialog = page.getByRole("dialog", { name: "Backtrack with information" });
  await expect(dialog.getByText("Symbols it mentions: p, q")).toBeVisible();
  const ancestor = dialog.getByRole("radio");
  await expect(ancestor).toHaveCount(1, COMMAND);
  await expect(ancestor).toHaveValue(rootId);
  await expect(ancestor).toBeChecked();
  await dialog.getByRole("button", { name: "Split here" }).click();
  await expect(page.getByText(/Backtrack with information committed; now at node:/)).toBeVisible(
    COMMAND,
  );

  const history = await page.evaluate(
    async (id) => {
      const response = await fetch(`/api/proof-sessions/${encodeURIComponent(id)}/history`, {
        cache: "no-store",
      });
      return response.json();
    },
    decodeURIComponent(new URL(page.url()).pathname.split("/").pop()!),
  );
  const current = history.data.session.currentNodeId as string;
  expect(current).not.toBe(splitId);
  const parents = history.data.edges.map(
    ({ edge }: { edge: { parentNodeId: string; childNodeId: string } }) => edge,
  );
  // The original split stays; the case split hangs off the root.
  expect(parents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ parentNodeId: rootId, childNodeId: splitId }),
    ]),
  );
  expect(
    parents.filter(({ parentNodeId }: { parentNodeId: string }) => parentNodeId === rootId),
  ).toHaveLength(2);
});

test("a sibling branch is reviewed and replayed at the current node", async ({ page }) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  await expect(page.getByRole("button", { name: "Replay a sequence here…" })).toBeDisabled();
  await applySplitAtRoot(page);
  const splitId = await currentNodeId(page);
  await page.locator(`[data-history-node-id="${rootId}"]`).click();
  await expect(page.getByText(`Backtracked to ${rootId}.`, { exact: true })).toBeVisible(COMMAND);

  await page.getByRole("button", { name: "Replay a sequence here…" }).click();
  const dialog = page.getByRole("dialog", { name: "Replay a sequence here" });
  await expect(dialog.getByLabel("Replay the path ending at")).toHaveValue(splitId);
  await expect(dialog.getByLabel("Starting after")).toHaveValue(rootId);
  await expect(dialog.getByRole("region", { name: "Steps to replay" })).toContainText(
    "Split conjunction goal",
  );
  // The dry run reports the step before anything is committed; the cursor has not moved yet.
  await expect(dialog.getByRole("region", { name: "Replay report" })).toContainText(
    "1 exact, 0 adapted; every step matches here.",
    COMMAND,
  );
  expect(await currentNodeId(page)).toBe(rootId);
  await dialog.getByRole("button", { name: "Replay 1 step here" }).click();
  await expect(page.getByText(/Replayed 1 step \(1 exact, 0 adapted\); now at node:/)).toBeVisible(
    COMMAND,
  );
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
  expect(await currentNodeId(page)).not.toBe(splitId);
});

test("export asks to confirm a private session, then downloads the artifact; the tree links to its viewer", async ({
  page,
}) => {
  const sessionId = await openFreshSession(page);
  const dialog = page.getByRole("dialog", { name: "Export a private session" });
  const exportButton = page.getByRole("button", { name: "Export proof" });
  await expect(exportButton).toHaveAttribute("data-hydrated", "true");
  await exportButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("This session is private. Export it anyway?")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Export anyway" }).click();
  const download = await downloading;
  expect(download.url()).toContain(
    `/api/proof-sessions/${encodeURIComponent(sessionId)}/export?confirmPrivateExport=true`,
  );
  const artifact = JSON.parse(await readFile((await download.path()) ?? "", "utf8")) as {
    kind?: string;
  };
  expect(artifact.kind).toBe("proof-artifact");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open full discovery tree" })).toHaveAttribute(
    "href",
    `/sessions/${encodeURIComponent(sessionId)}/tree`,
  );
});

test("the tree link opens the static viewers, which read the stored session", async ({ page }) => {
  const sessionId = await openFreshSession(page);
  await page.getByRole("link", { name: "Open full discovery tree" }).click();
  await expect(page).toHaveURL(`/sessions/${encodeURIComponent(sessionId)}/tree`);
  await expect(page.getByRole("heading", { name: "Commute a conjunction" })).toBeVisible(COMMAND);
  await expect(page.getByTestId("tree-outline").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("node-detail").getByTestId("state-snapshot")).toBeVisible();

  const views = page.getByRole("navigation", { name: "Stored views" });
  await views.getByRole("link", { name: "Playback" }).click();
  await expect(page.getByText("The stored history has nothing to play back.")).toBeVisible(COMMAND);
  await views.getByRole("link", { name: "Pruned proof" }).click();
  await expect(page.getByRole("heading", { name: "No pruned proof" })).toBeVisible(COMMAND);
  await expect(page.getByTestId("solved-status")).toHaveText(/Not solved/);
});

test("a branch made by backtracking with information is replayed as a backtracking step", async ({
  page,
}) => {
  await openFreshSession(page);
  const rootId = await currentNodeId(page);
  await applySplitAtRoot(page);
  await selectExpression(page.getByLabel("Goal 1 hypothesis 1"), ["And", "p", "q"]);
  await page.getByRole("button", { name: "Backtrack with information…" }).click();
  const backtrack = page.getByRole("dialog", { name: "Backtrack with information" });
  await expect(backtrack.getByRole("radio")).toHaveCount(1, COMMAND);
  await backtrack.getByRole("button", { name: "Split here" }).click();
  await expect(page.getByText(/Backtrack with information committed; now at node:/)).toBeVisible(
    COMMAND,
  );
  const splitId = await currentNodeId(page);

  // Back at the root, replay the case split the backtracking made: it has no displayed suggestion.
  await page.locator(`[data-history-node-id="${rootId}"]`).click();
  await expect(page.getByText(`Backtracked to ${rootId}.`, { exact: true })).toBeVisible(COMMAND);
  await page.getByRole("button", { name: "Replay a sequence here…" }).click();
  const dialog = page.getByRole("dialog", { name: "Replay a sequence here" });
  await dialog.getByLabel("Replay the path ending at").selectOption(splitId);
  await expect(dialog.getByLabel("Starting after")).toHaveValue(rootId);
  await expect(dialog.getByRole("region", { name: "Replay report" })).toContainText(
    "1 exact, 0 adapted; every step matches here.",
    COMMAND,
  );
  await expect(dialog.getByRole("region", { name: "Steps to replay" })).toContainText(
    "case split by backtracking",
  );
  await dialog.getByRole("button", { name: "Replay 1 step here" }).click();
  await expect(page.getByText(/Replayed 1 step \(1 exact, 0 adapted\); now at node:/)).toBeVisible(
    COMMAND,
  );
  await expect(page.getByTestId("snapshot-status")).toHaveText(/Open: 2 goals/, COMMAND);
  expect(await currentNodeId(page)).not.toBe(splitId);
});
