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

const NESTED_IMPLICATION_DRAFT: IsolatedDraft = {
  problem: { title: "Nested implication", statement: "Assuming p implies q, show the nesting." },
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
    { symbol: "r", sort: "proposition" },
    { symbol: "x", sort: "real" },
  ],
  hypotheses: [
    { format: "mathjson", expression: ["Implies", "p", "q"] },
    { format: "mathjson", expression: ["Greater", "x", 0] },
    { format: "mathjson", expression: ["And", "r", ["Implies", ["Implies", "p", "q"], "r"]] },
  ],
  goals: [{ format: "mathjson", expression: ["Implies", ["Implies", "p", "q"], "r"] }],
};

/**
 * Moves the real mouse onto the nth drawn glyph of a statement. The glyph is measured in the DOM:
 * `getElementInfo` keeps bounds from before the last scroll.
 */
async function hoverGlyph(page: Page, field: Locator, glyph: string, occurrence = 0) {
  await field.scrollIntoViewIfNeeded();
  const point = await field.evaluate(
    (element, { glyph, occurrence }) => {
      const atoms = element.shadowRoot?.querySelectorAll("[data-atom-id]") ?? [];
      const matches = [...atoms].filter(
        (atom) => atom.textContent === glyph && !atom.querySelector("[data-atom-id]"),
      );
      const bounds = matches[occurrence]?.getBoundingClientRect();
      if (!bounds) throw new Error(`No glyph ${glyph} at ${occurrence}`);
      return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    },
    { glyph, occurrence },
  );
  await page.mouse.move(point.x, point.y);
  return point;
}

async function expectHoverPosition(
  page: Page,
  field: Locator,
  glyph: string,
  position: RegExp,
  occurrence = 0,
) {
  await hoverGlyph(page, field, glyph, occurrence);
  await expect(page.getByRole("tooltip")).toHaveText(position);
}

test("hovering names the logical position of each part of a statement", async ({ page }) => {
  const sessionId = await createIsolatedSession(page, NESTED_IMPLICATION_DRAFT);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  const goal = page.getByLabel("Goal 1 conclusion");
  const implication = page.getByLabel("Goal 1 hypothesis 1");
  const relation = page.getByLabel("Goal 1 hypothesis 2");
  await expect(goal).toBeVisible();
  await expect(relation).toBeVisible();

  // In `(p ⇒ q) ⇒ r` the inner antecedent flips twice and the inner consequent once.
  await expectHoverPosition(page, goal, "p", /Positive position/);
  await expectHoverPosition(page, goal, "q", /Negative position/);
  await expectHoverPosition(page, goal, "r", /Positive position/);

  // The same `p ⇒ q` as a hypothesis starts negative, so its antecedent is positive.
  await expectHoverPosition(page, implication, "p", /Positive position/);
  await expectHoverPosition(page, implication, "q", /Negative position/);

  // An operator speaks for the connective it belongs to: the inner one is in negative position.
  await expectHoverPosition(page, goal, "⟹", /Negative position/, 0);
  await expectHoverPosition(page, goal, "⟹", /Positive position/, 1);

  // A bracket speaks for what it encloses, whatever is next to it.
  await expectHoverPosition(page, goal, "(", /Negative position/);
  await expectHoverPosition(page, goal, ")", /Negative position/);
  const nested = page.getByLabel("Goal 1 hypothesis 3");
  await expectHoverPosition(page, nested, "(", /Negative position/, 0);
  await expectHoverPosition(page, nested, "(", /Positive position/, 1);
  await expectHoverPosition(page, nested, ")", /Positive position/, 0);
  await expectHoverPosition(page, nested, ")", /Negative position/, 1);

  // A term has no polarity of its own, so the proposition governing it is reported.
  await expectHoverPosition(page, relation, "x", /Negative position/);
  await expectHoverPosition(page, relation, ">", /Negative position/);

  await page.mouse.move(0, 0);
  await expect(page.getByRole("tooltip")).toHaveCount(0);

  // Scrolling must not leave hover reading where the statement used to be.
  await hoverGlyph(page, goal, "q");
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.scrollBy(0, 120));
  const point = await hoverGlyph(page, goal, "q");
  await expect(page.getByRole("tooltip")).toHaveText(/Negative position/);
  const mark = await page.locator('[class*="hoverOccurrence"]').boundingBox();
  expect(mark).not.toBeNull();
  expect(point.y).toBeGreaterThanOrEqual(mark!.y);
  expect(point.y).toBeLessThanOrEqual(mark!.y + mark!.height);
});

test("the stored session and each contextual sequent survive reload", async ({ page }) => {
  await page.goto("/sessions/session%3Adevelopment");
  await waitForWorkspace(page);
  await expect(page.getByText("session:development", { exact: true })).toBeVisible();
  await page.getByText("Snapshot IDs", { exact: true }).click();
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
  await page.getByText("Snapshot IDs", { exact: true }).click();
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
  await expect(move).toHaveAttribute("data-applicability", "requires-input");

  expect(
    (await selectRange(conjunction, ["And", "p", "q"], { modifier: true })).selected,
  ).toBeDefined();
  await expect(page.locator("[data-selection-key]")).toHaveCount(2);
  await expect(move).toHaveAttribute("data-applicability", "applicable");

  await selectRange(conjunction, ["And", "p", "q"], { modifier: true });
  await expect(page.locator("[data-selection-key]")).toHaveCount(1);
  await expect(move).toHaveAttribute("data-applicability", "requires-input");

  await selectRange(conjunction, ["And", "p", "q"], { modifier: true });
  await expect(move).toHaveAttribute("data-applicability", "applicable");
  await selectRange(goal, ["And", "p", "p", "q"], { modifier: true });
  await expect(page.locator("[data-selection-key]")).toHaveCount(1);
  await expect(move).toHaveAttribute("data-applicability", "requires-input");
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
  // Each card preserves the stored reasons and matched selections, including the details
  // shown on demand. Both are compared with the persisted suggestion.
  const displayed = await page.locator("[data-suggestion-id]").evaluateAll((cards) =>
    cards.map((card) => ({
      id: card.getAttribute("data-suggestion-id"),
      reasons: [...card.querySelectorAll("[data-suggestion-reason]")].map(
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
  await expect(splitCard).toHaveAttribute("data-applicability", "applicable");
  await expect(splitCard.locator('[data-transition-class="equivalence"]')).toBeVisible();
  expect(await splitCard.locator("[data-suggestion-reason]").count()).toBeGreaterThan(0);
  await splitCard.getByText("Why this was suggested").click();
  await expect(splitCard.getByText("selection:primary → target", { exact: true })).toBeVisible();

  const splitSuggestionSetId = await page.getByTestId("suggestion-set-id").textContent();
  const splitSuggestionId = await splitCard.getAttribute("data-suggestion-id");
  expect(splitSuggestionSetId).toBeTruthy();
  expect(splitSuggestionId).toBeTruthy();

  await splitCard.getByRole("button", { name: "Preview changes" }).click();
  const preview = splitCard.getByLabel("Move preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Review the changes before applying")).toBeVisible();
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

  await splitCard.getByRole("button", { name: "Apply this step" }).click();
  await expect(page.getByText(/advanced to node:/)).toBeVisible();
  const firstChildId = await page
    .locator('[data-history-node-id][data-current="true"]')
    .getAttribute("data-history-node-id");
  expect(firstChildId).toBeTruthy();
  expect(firstChildId).not.toBe(rootNodeId);
  await expect(
    page.getByText(
      "Click a goal, an assumption, or part of a formula to see what you can do next.",
    ),
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
  await expect(expandCard).toHaveAttribute("data-applicability", "applicable");
  await expandCard.getByRole("button", { name: "Preview changes" }).click();
  await expect(expandCard.getByLabel("Move preview")).toBeVisible();
  await expandCard.getByRole("button", { name: "Apply this step" }).click();
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

  // The header names the problem (the stored title) and keeps the session ID as its eyebrow.
  await expect(
    page.getByRole("heading", { level: 1, name: "Duplicated conjunction" }),
  ).toBeVisible();
  await expect(page.getByText("session:development", { exact: true })).toBeVisible();
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

  await page.getByText("More tools").click();
  await page.getByText("View raw MathJSON").click();
  const raw = JSON.parse((await page.getByTestId("raw-proof-state").textContent()) ?? "{}");
  expect(raw.state.id).toBe("state:development-root");
});

test("the workspace omits AI tools when the service has no provider", async ({ page }) => {
  await page.goto("/sessions/session%3Adevelopment");
  await waitForWorkspace(page);
  await expect(page.getByRole("region", { name: "Move instructions" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Proof plan" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Available suggestions" })).toBeVisible();
});

test("inspect and apply an order rewrite with a sign obligation", async ({ page }) => {
  const draft: IsolatedDraft = {
    problem: { title: "Bound a product", statement: "Use x ≤ y to bound x times c." },
    background: { level: "real arithmetic", summary: "Order on the reals.", assumptions: [] },
    libraryLayerIds: ["layer:global"],
    packs: ["pack:order", "pack:arithmetic"],
    declarations: ["x", "y", "c", "z"].map((symbol) => ({ symbol, sort: "real" })),
    hypotheses: [{ format: "mathjson", expression: ["LessEqual", "x", "y"] }],
    goals: [{ format: "mathjson", expression: ["LessEqual", ["Multiply", "x", "c"], "z"] }],
  };
  const sessionId = await createIsolatedSession(page, draft);
  await page.goto(`/sessions/${encodeURIComponent(sessionId)}`);
  const goal = page.getByLabel("Goal 1 conclusion");
  const point = await hoverGlyph(page, goal, "x");
  await expect(page.getByRole("tooltip")).toContainText("Context ·");
  await page.mouse.click(point.x, point.y);
  await page.getByLabel("Relation focus").selectOption("LessEqual");
  const rewrite = page.locator('li[data-rewrite-relation="LessEqual"][data-source="move"]').first();
  await rewrite.getByRole("button", { name: "Preview changes" }).click();
  await expect(
    rewrite.getByRole("list", { name: "New obligations" }).getByRole("listitem"),
  ).toHaveCount(1);
  await expect(page.getByLabel("Obligation 1 conclusion")).toHaveCount(0);
  await rewrite.getByRole("button", { name: "Apply this step" }).click();
  await expect(page.getByLabel("Obligation 1 conclusion")).toBeVisible();
});
