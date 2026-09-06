import { expect, test, type Locator } from "@playwright/test";

async function selectMathJsonRange(
  field: Locator,
  target: unknown,
  occurrence = 0,
  expectedPath?: string,
) {
  return field.evaluate(
    (element, { serializedTarget, requestedOccurrence, requestedPath }) => {
      const mathfield = element as HTMLElement & {
        lastOffset: number;
        selection: { ranges: Array<[number, number]> };
        getValue: (range: [number, number], format: "math-json") => string;
        getElementInfo: (
          offset: number,
        ) => { data?: Record<string, string | undefined> } | undefined;
      };
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
            // Most arbitrary display ranges do not form MathJSON expressions.
          }
        }
      }
      const distinct = matches.filter(
        (range, index) =>
          index === 0 ||
          range[0] !== matches[index - 1]?.[0] ||
          range[1] !== matches[index - 1]?.[1],
      );
      const containsPath = (range: [number, number], path: string) => {
        for (let offset = range[0]; offset <= range[1]; offset += 1) {
          if (Object.values(mathfield.getElementInfo(offset)?.data ?? {}).includes(path))
            return true;
        }
        return false;
      };
      const selected = requestedPath
        ? distinct.find((range) => containsPath(range, requestedPath))
        : distinct[requestedOccurrence];
      if (!selected) return { matches: distinct, selected: undefined };
      mathfield.selection = { ranges: [selected] };
      mathfield.dispatchEvent(new Event("selection-change"));
      return { matches: distinct, selected };
    },
    {
      serializedTarget: JSON.stringify(target),
      requestedOccurrence: occurrence,
      requestedPath: expectedPath,
    },
  );
}

test("real MathLive ranges recover exact, duplicate, and associative selections", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("MathLive ready")).toBeVisible();
  const field = page.locator("math-field");

  const power = await selectMathJsonRange(field, ["Power", "x", 2]);
  expect(power.selected).toBeDefined();
  await expect(page.getByTestId("selection-path")).toHaveText("0.0");

  const yRanges = await selectMathJsonRange(field, "y", 0, "0.3");
  expect(yRanges.matches.length).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("selection-path")).toHaveText("0.3");

  const virtual = await selectMathJsonRange(field, ["Add", ["Multiply", 3, "y"], "z"]);
  expect(virtual.selected).toBeDefined();
  await expect(page.getByText("Associative virtual selection")).toBeVisible();
  await expect(page.getByText("0.1, 0.2")).toBeVisible();
});

test("replacement changes plain MathJSON and the MathLive projection", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("MathLive ready")).toBeVisible();
  await page.getByRole("button", { name: "Select 3y + z" }).click();
  await page.getByRole("button", { name: "Replace selection" }).click();

  await expect(page.getByTestId("authoritative-mathjson")).not.toContainText("Multiply");
  await expect(page.locator("math-field")).toHaveAttribute(
    "aria-label",
    "Interactive MathJSON statement",
  );
  await expect(page.getByText(/MathLive rerendered the new projection/)).toBeVisible();
});
