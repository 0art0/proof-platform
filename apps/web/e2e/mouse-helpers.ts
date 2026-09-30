import { expect, type Locator, type Page } from "@playwright/test";

// The mouse-only flows act on the page through pointer interactions only. Choosing an expression
// in a MathLive field is the established stand-in for dragging a pointer across it: the field's
// selection is set to the display range of the expression and the same `pointerup` the real
// gesture ends with is dispatched, which is what the workspace listens to.

// Committed commands run against a freshly built server that other parallel specs load.
export const COMMAND = { timeout: 45_000 } as const;

type MathfieldPort = HTMLElement & {
  lastOffset: number;
  selection: { ranges: Array<[number, number]> };
  getValue: (range: [number, number], format: "math-json") => string;
};

/** Select `target` (a MathJSON value) in the first field of `fields` that displays it. */
export async function selectInAnyField(
  fields: Locator,
  target: unknown,
  options: Readonly<{ modifier?: boolean }> = {},
) {
  const count = await fields.count();
  for (let index = 0; index < count; index += 1) {
    const selected = await fields.nth(index).evaluate(
      (element, { serializedTarget, modifier }) => {
        const mathfield = element as MathfieldPort;
        for (let start = 0; start < mathfield.lastOffset; start += 1) {
          for (let end = start + 1; end <= mathfield.lastOffset; end += 1) {
            try {
              if (
                JSON.stringify(JSON.parse(mathfield.getValue([start, end], "math-json"))) ===
                serializedTarget
              ) {
                mathfield.selection = { ranges: [[start, end]] };
                mathfield.dispatchEvent(
                  new PointerEvent("pointerup", {
                    bubbles: true,
                    ctrlKey: modifier,
                    metaKey: modifier,
                  }),
                );
                return true;
              }
            } catch {
              // Arbitrary display ranges are usually not complete MathJSON expressions.
            }
          }
        }
        return false;
      },
      { serializedTarget: JSON.stringify(target), modifier: options.modifier ?? false },
    );
    if (selected) return;
  }
  expect.soft(false, `no displayed field contains ${JSON.stringify(target)}`).toBe(true);
}

/** Preview, then apply, the displayed suggestion card for `artifactId`. */
export async function previewAndApply(page: Page, artifactId: string) {
  const card = page.locator(`[data-artifact-id="${artifactId}"]`);
  await card.getByRole("button", { name: "Preview" }).click();
  await expect(card.getByLabel("Move preview")).toBeVisible();
  await card.getByRole("button", { name: "Apply" }).click();
}

export async function currentNodeId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-history-node-id][data-current="true"]')
    .getAttribute("data-history-node-id");
  expect(id).toBeTruthy();
  return id!;
}
