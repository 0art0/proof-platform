import { expect, test, type Locator, type Page } from "@playwright/test";
import { createIsolatedSession, warmRoutes, type IsolatedDraft } from "./fixtures";

type MathfieldPort = HTMLElement & {
  lastOffset: number;
  position: number;
  selection: { ranges: Array<[number, number]> };
  selectionIsCollapsed: boolean;
  getValue: (range: [number, number], format: "math-json") => string;
  getElementInfo: (offset: number) => { data?: Record<string, string | undefined> } | undefined;
};

async function selectRange(
  field: Locator,
  target: unknown,
  options: Readonly<{ occurrence?: number; path?: string; modifier?: boolean }> = {},
) {
  return field.evaluate(
    (element, { serializedTarget, occurrence, path, modifier }) => {
      const mathfield = element as MathfieldPort;
      const matches: Array<[number, number]> = [];
      for (let start = 0; start < mathfield.lastOffset; start += 1) {
        for (let end = start + 1; end <= mathfield.lastOffset; end += 1) {
          try {
            if (
              JSON.stringify(JSON.parse(mathfield.getValue([start, end], "math-json"))) ===
              serializedTarget
            ) {
              matches.push([start, end]);
            }
          } catch {
            // Arbitrary display ranges are usually not complete MathJSON expressions.
          }
        }
      }
      const distinct = matches.filter(
        (range, index) =>
          index === 0 ||
          range[0] !== matches[index - 1]?.[0] ||
          range[1] !== matches[index - 1]?.[1],
      );
      const containsPath = (range: [number, number], expected: string) => {
        for (let offset = range[0]; offset <= range[1]; offset += 1) {
          if (Object.values(mathfield.getElementInfo(offset)?.data ?? {}).includes(expected)) {
            return true;
          }
        }
        return false;
      };
      const selected = path
        ? distinct.find((range) => containsPath(range, path))
        : distinct[occurrence];
      if (!selected) return { matches: distinct, selected: undefined };
      mathfield.selection = { ranges: [selected] };
      mathfield.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, ctrlKey: modifier, metaKey: modifier }),
      );
      return { matches: distinct, selected };
    },
    {
      serializedTarget: JSON.stringify(target),
      occurrence: options.occurrence ?? 0,
      path: options.path,
      modifier: options.modifier ?? false,
    },
  );
}

async function clickOccurrence(
  field: Locator,
  path: string,
  options: Readonly<{ modifier?: boolean }> = {},
) {
  return field.evaluate(
    (element, { path, modifier }) => {
      const mathfield = element as MathfieldPort;
      let selectedOffset: number | undefined;
      for (let offset = 0; offset <= mathfield.lastOffset; offset += 1) {
        if (Object.values(mathfield.getElementInfo(offset)?.data ?? {}).includes(path)) {
          selectedOffset = offset;
          break;
        }
      }
      if (selectedOffset === undefined) return false;
      mathfield.position = selectedOffset;
      mathfield.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, ctrlKey: modifier, metaKey: modifier }),
      );
      return true;
    },
    { path, modifier: options.modifier ?? false },
  );
}

async function waitForWorkspace(page: Page) {
  await expect(page.getByLabel("Stored proof session")).toBeVisible();
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByLabel("Obligation 1 conclusion")).toBeVisible();
}

// Tests that record suggestions or mutate proof state run in their own session, created through
// the approval API with the development fixture's goal and hypotheses (the draft API cannot
// express its obligation). The others only read session:development, which nothing mutates.
const DUPLICATED_CONJUNCTION_DRAFT: IsolatedDraft = {
  problem: { title: "Duplicated conjunction", statement: "Assuming p and q, and q, show p p q." },
  background: {
    level: "elementary propositional logic",
    summary: "Propositional connectives.",
    assumptions: [],
  },
  libraryLayerIds: ["layer:global"],
  packs: [],
  declarations: [
    { symbol: "p", sort: "proposition" },
    { symbol: "q", sort: "proposition" },
  ],
  hypotheses: [
    { format: "mathjson", expression: ["And", "p", "q"] },
    { format: "mathjson", expression: "q" },
  ],
  goals: [{ format: "mathjson", expression: ["And", "p", "p", "q"] }],
};

async function openIsolatedWorkspace(page: Page): Promise<string> {
  const sessionId = await createIsolatedSession(page, DUPLICATED_CONJUNCTION_DRAFT);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  await expect(page.getByLabel("Stored proof session")).toBeVisible();
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();
  await expect(page.getByLabel("Goal 1 hypothesis 1")).toBeVisible();
  await warmRoutes(page, sessionId);
  return sessionId;
}

test("the stored session and each contextual sequent survive reload", async ({ page }) => {
  await page.goto("/sessions/session%3Adevelopment");
  await waitForWorkspace(page);
  await expect(page.getByText("session:development", { exact: true })).toBeVisible();
  await expect(page.getByText("state:development-root", { exact: true })).toBeVisible();

  const goal = page.locator('[data-target-id="goal:development-main"]');
  const obligation = page.locator('[data-target-id="obligation:development-side-condition"]');
  await expect(goal.getByText("p", { exact: true }).first()).toBeVisible();
  await expect(goal.getByText("q", { exact: true }).first()).toBeVisible();
  await expect(goal.getByText("r", { exact: true })).toHaveCount(0);
  await expect(obligation.getByText("r", { exact: true }).first()).toBeVisible();
  await expect(obligation.getByText("s", { exact: true }).first()).toBeVisible();
  await expect(obligation.getByText("p", { exact: true })).toHaveCount(0);

  await page.reload();
  await waitForWorkspace(page);
  await expect(page.getByText("node:development-root", { exact: true }).first()).toBeVisible();
});

test("MathLive gestures retain occurrence identity, expand parents, and form associative lenses", async ({
  page,
}) => {
  await page.goto("/sessions/session%3Adevelopment");
  await waitForWorkspace(page);
  const goal = page.getByLabel("Goal 1 conclusion");

  expect(await clickOccurrence(goal, "0")).toBe(true);
  await expect(page.getByText("path 0", { exact: true })).toBeVisible();
  expect(await clickOccurrence(goal, "0")).toBe(true);
  await expect(page.getByText("path root", { exact: true })).toBeVisible();

  expect(await clickOccurrence(goal, "1")).toBe(true);
  await expect(page.getByText("path 1", { exact: true })).toBeVisible();
  expect(await clickOccurrence(goal, "0")).toBe(true);
  await expect(page.getByText("path 0", { exact: true })).toBeVisible();

  const range = await selectRange(goal, ["And", "p", "p"]);
  expect(range.selected).toBeDefined();
  await expect(page.getByText("lens root [0, 2)", { exact: true })).toBeVisible();
});

test("modifier multiselection controls two-selection applicability", async ({ page }) => {
  await page.goto("/sessions/session%3Adevelopment");
  await waitForWorkspace(page);
  const goal = page.getByLabel("Goal 1 conclusion");
  const conjunction = page.getByLabel("Goal 1 hypothesis 1");

  expect((await selectRange(goal, ["And", "p", "p", "q"])).selected).toBeDefined();
  const move = page.locator('[data-artifact-id="move:expand-hypothesis-conjunction"]');
  await expect(move).toBeVisible();
  await expect(move.locator('[data-applicability="requires-input"]')).toBeVisible();

  expect(
    (await selectRange(conjunction, ["And", "p", "q"], { modifier: true })).selected,
  ).toBeDefined();
  await expect(page.locator("[data-selection-key]")).toHaveCount(2);
  await expect(move.locator('[data-applicability="applicable"]')).toBeVisible();

  await selectRange(conjunction, ["And", "p", "q"], { modifier: true });
  await expect(page.locator("[data-selection-key]")).toHaveCount(1);
  await expect(move.locator('[data-applicability="requires-input"]')).toBeVisible();

  await selectRange(conjunction, ["And", "p", "q"], { modifier: true });
  await expect(move.locator('[data-applicability="applicable"]')).toBeVisible();
  await selectRange(goal, ["And", "p", "p", "q"], { modifier: true });
  await expect(page.locator("[data-selection-key]")).toHaveCount(1);
  await expect(move.locator('[data-applicability="requires-input"]')).toBeVisible();
});

test("stale anchors are rejected and the persisted order and reasons are read back unchanged", async ({
  page,
}) => {
  const sessionId = await openIsolatedWorkspace(page);
  const apiBase = `/api/proof-sessions/${encodeURIComponent(sessionId)}`;

  const goalTargetId = await page.getByLabel("Goal 1 conclusion").evaluate((element) => {
    return element.closest("[data-target-id]")?.getAttribute("data-target-id") ?? null;
  });
  expect(goalTargetId).toBeTruthy();
  const stale = await page.evaluate(
    async ({ apiBase, goalTargetId }) => {
      const response = await fetch(`${apiBase}/suggestion-sets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: `suggestion-set:e2e-stale-${crypto.randomUUID()}`,
          selections: [
            {
              kind: "exact",
              anchor: {
                stateId: "state:stale",
                target: { kind: "goal", id: goalTargetId! },
                statement: { kind: "conclusion" },
              },
              path: [],
            },
          ],
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { apiBase, goalTargetId },
  );
  expect(stale.status).toBe(400);
  expect(stale.body).toMatchObject({ ok: false, error: { code: "suggestion-set-rejected" } });

  expect(
    (await selectRange(page.getByLabel("Goal 1 conclusion"), ["And", "p", "p", "q"])).selected,
  ).toBeDefined();
  const suggestionSetId = await page.getByTestId("suggestion-set-id").textContent();
  expect(suggestionSetId).toBeTruthy();
  // Each card shows two stored lists: the reasons and the matched selections. Both must be read
  // back exactly as persisted, so they are compared separately.
  const displayed = await page.locator("[data-suggestion-id]").evaluateAll((cards) =>
    cards.map((card) => ({
      id: card.getAttribute("data-suggestion-id"),
      reasons: [...card.querySelectorAll('ul[aria-label^="Reasons for"] li')].map(
        (reason) => reason.textContent,
      ),
      matches: [...card.querySelectorAll('ul[aria-label^="Matched selections for"] li')].map(
        (match) => match.textContent,
      ),
    })),
  );
  const persisted = await page.evaluate(
    async ({ id, apiBase }) => {
      const response = await fetch(`${apiBase}/suggestion-sets/${encodeURIComponent(id!)}`, {
        cache: "no-store",
      });
      return response.json();
    },
    { id: suggestionSetId, apiBase },
  );
  expect(persisted).toMatchObject({ ok: true });
  expect(
    persisted.data.suggestionSet.suggestions.map(
      ({
        id,
        reasons,
        selectionMatches,
      }: {
        id: string;
        reasons: string[];
        selectionMatches: { selectionId: string; selectionSlotId?: string; patternId: string }[];
      }) => ({
        id,
        reasons,
        matches: selectionMatches.map(
          (match) => `${match.selectionId} → ${match.selectionSlotId ?? match.patternId}`,
        ),
      }),
    ),
  ).toEqual(displayed);
});

test("preview, apply, rejection, backtracking, and a second child preserve the discovery tree", async ({
  page,
}) => {
  const sessionId = await openIsolatedWorkspace(page);
  const apiBase = `/api/proof-sessions/${encodeURIComponent(sessionId)}`;

  const initialHistory = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/history`, {
      cache: "no-store",
    });
    return response.json();
  }, apiBase);
  expect(initialHistory).toMatchObject({ ok: true });
  const rootNodeId = initialHistory.data.session.rootNodeId as string;
  const initialEdgeCount = initialHistory.data.edges.length as number;

  const goal = page.getByLabel("Goal 1 conclusion");
  expect((await selectRange(goal, ["And", "p", "p", "q"])).selected).toBeDefined();
  const splitCard = page.locator('[data-artifact-id="move:split-goal-conjunction"]');
  await expect(splitCard).toBeVisible();
  await expect(splitCard.locator('[data-applicability="applicable"]')).toBeVisible();
  await expect(splitCard.locator('[data-transition-class="equivalence"]')).toBeVisible();
  expect(
    await splitCard.getByLabel("Reasons for Split conjunction goal").locator("li").count(),
  ).toBeGreaterThan(0);
  await expect(splitCard.getByText("selection:primary → target", { exact: true })).toBeVisible();

  const splitSuggestionSetId = await page.getByTestId("suggestion-set-id").textContent();
  const splitSuggestionId = await splitCard.getAttribute("data-suggestion-id");
  expect(splitSuggestionSetId).toBeTruthy();
  expect(splitSuggestionId).toBeTruthy();

  await splitCard.getByRole("button", { name: "Preview" }).click();
  const preview = splitCard.getByLabel("Move preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Expected proof-state difference")).toBeVisible();
  await expect(preview.getByText("None.", { exact: true })).toBeVisible();
  await expect(page.getByText(`Current node ${rootNodeId}`, { exact: true })).toBeVisible();

  const afterPreview = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/history`, {
      cache: "no-store",
    });
    return response.json();
  }, apiBase);
  expect(afterPreview.data.session.currentNodeId).toBe(rootNodeId);
  expect(afterPreview.data.edges).toHaveLength(initialEdgeCount);

  await splitCard.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/advanced to node:/)).toBeVisible();
  const firstChildId = await page
    .locator('[data-history-node-id][data-current="true"]')
    .getAttribute("data-history-node-id");
  expect(firstChildId).toBeTruthy();
  expect(firstChildId).not.toBe(rootNodeId);
  await expect(
    page.getByText("Select one or more anchored occurrences to retrieve suggestions."),
  ).toBeVisible();

  const staleApply = await page.evaluate(
    async ({ apiBase, suggestionSetId, suggestionId }) => {
      const response = await fetch(`${apiBase}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: `command:e2e-stale-${crypto.randomUUID()}`,
          suggestionSetId,
          chosenSuggestionId: suggestionId,
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { apiBase, suggestionSetId: splitSuggestionSetId!, suggestionId: splitSuggestionId! },
  );
  expect(staleApply.status).toBeGreaterThanOrEqual(400);
  expect(staleApply.body).toMatchObject({ ok: false });
  await expect(page.getByText(`Current node ${firstChildId}`, { exact: true })).toBeVisible();

  await page.locator(`[data-history-node-id="${rootNodeId}"]`).click();
  await expect(page.getByText(`Backtracked to ${rootNodeId}.`, { exact: true })).toBeVisible();
  await expect(page.getByText(`Current node ${rootNodeId}`, { exact: true })).toBeVisible();

  const restoredGoal = page.getByLabel("Goal 1 conclusion");
  const conjunction = page.getByLabel("Goal 1 hypothesis 1");
  expect((await selectRange(restoredGoal, ["And", "p", "p", "q"])).selected).toBeDefined();
  expect(
    (await selectRange(conjunction, ["And", "p", "q"], { modifier: true })).selected,
  ).toBeDefined();
  const expandCard = page.locator('[data-artifact-id="move:expand-hypothesis-conjunction"]');
  await expect(expandCard.locator('[data-applicability="applicable"]')).toBeVisible();
  await expandCard.getByRole("button", { name: "Preview" }).click();
  await expect(expandCard.getByLabel("Move preview")).toBeVisible();
  await expandCard.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(/advanced to node:/)).toBeVisible();

  const branched = await page.evaluate(async (apiBase) => {
    const response = await fetch(`${apiBase}/history`, {
      cache: "no-store",
    });
    return response.json();
  }, apiBase);
  expect(branched).toMatchObject({ ok: true });
  const children = branched.data.edges.filter(
    ({ edge }: { edge: { parentNodeId: string } }) => edge.parentNodeId === rootNodeId,
  );
  expect(
    new Set(children.map(({ edge }: { edge: { childNodeId: string } }) => edge.childNodeId)).size,
  ).toBeGreaterThanOrEqual(2);
  expect(children.map(({ name }: { name: string }) => name)).toEqual(
    expect.arrayContaining(["Split conjunction goal", "Expand conjunction hypothesis"]),
  );
});

test("workspace chrome: header, branch breadcrumb, Escape, view toggle, and raw state", async ({
  page,
}) => {
  // It exercises several render paths; cold webpack compilation dominates its runtime.
  test.slow();
  await page.goto("/sessions/session%3Adevelopment");
  await waitForWorkspace(page);

  await expect(page.getByRole("heading", { level: 1, name: "session:development" })).toBeVisible();
  await expect(page.getByTestId("snapshot-status")).toHaveText(
    /Snapshot targets:\s*Open: 1 goal, 1 obligation/,
  );
  const branch = page.getByRole("navigation", { name: "Current branch" });
  await expect(branch.getByRole("listitem")).toHaveText(["Root"]);

  const goal = page.getByLabel("Goal 1 conclusion");
  expect(await clickOccurrence(goal, "0")).toBe(true);
  await expect(page.locator("[data-selection-key]")).toHaveCount(1);
  await expect(page.getByTestId("selection-feedback")).toHaveText(
    /Click it again to expand to its parent/,
  );
  expect(await clickOccurrence(goal, "0")).toBe(true);
  await expect(page.getByTestId("selection-feedback")).toHaveText("Expanded to parent.");
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-selection-key]")).toHaveCount(0);
  await expect(page.getByTestId("selection-feedback")).toHaveText("Selections cleared.");

  await page.getByRole("button", { name: "Natural language" }).click();
  await expect(page.locator("math-field")).toHaveCount(0);
  await expect(page.getByLabel("Goal 1 conclusion")).toContainText("and");
  await page.getByRole("button", { name: "Formal (LaTeX)" }).click();
  await expect(page.getByLabel("Goal 1 conclusion")).toBeVisible();

  await page.getByText("View raw MathJSON").click();
  const raw = JSON.parse((await page.getByTestId("raw-proof-state").textContent()) ?? "{}");
  expect(raw.state.id).toBe("state:development-root");
});
