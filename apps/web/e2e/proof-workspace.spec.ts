import { expect, test, type Locator, type Page } from "@playwright/test";

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

test("the stored session and each contextual sequent survive reload", async ({ page }) => {
  await page.goto("/");
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
  await page.goto("/");
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
  await page.goto("/");
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
  await page.goto("/");
  await waitForWorkspace(page);

  const stale = await page.evaluate(async () => {
    const response = await fetch("/api/proof-sessions/session%3Adevelopment/suggestion-sets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `suggestion-set:e2e-stale-${crypto.randomUUID()}`,
        selections: [
          {
            kind: "exact",
            anchor: {
              stateId: "state:stale",
              target: { kind: "goal", id: "goal:development-main" },
              statement: { kind: "conclusion" },
            },
            path: [],
          },
        ],
      }),
    });
    return { status: response.status, body: await response.json() };
  });
  expect(stale.status).toBe(400);
  expect(stale.body).toMatchObject({ ok: false, error: { code: "suggestion-set-rejected" } });

  expect(
    (await selectRange(page.getByLabel("Goal 1 conclusion"), ["And", "p", "p", "q"])).selected,
  ).toBeDefined();
  const suggestionSetId = await page.getByTestId("suggestion-set-id").textContent();
  expect(suggestionSetId).toBeTruthy();
  const displayed = await page.locator("[data-suggestion-id]").evaluateAll((cards) =>
    cards.map((card) => ({
      id: card.getAttribute("data-suggestion-id"),
      reasons: [...card.querySelectorAll("ul li")].map((reason) => reason.textContent),
    })),
  );
  const persisted = await page.evaluate(async (id) => {
    const response = await fetch(
      `/api/proof-sessions/session%3Adevelopment/suggestion-sets/${encodeURIComponent(id!)}`,
      { cache: "no-store" },
    );
    return response.json();
  }, suggestionSetId);
  expect(persisted).toMatchObject({ ok: true });
  expect(
    persisted.data.suggestionSet.suggestions.map(
      ({ id, reasons }: { id: string; reasons: string[] }) => ({ id, reasons }),
    ),
  ).toEqual(displayed);
});
