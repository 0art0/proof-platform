// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { useHydrated } from "./use-hydrated";

afterEach(cleanup);

function Probe() {
  return <span data-hydrated={useHydrated()} />;
}

describe("useHydrated", () => {
  it("is false in server markup and true once mounted", () => {
    expect(renderToString(<Probe />)).toContain('data-hydrated="false"');
    const { container } = render(<Probe />);
    expect(container.querySelector("span")?.getAttribute("data-hydrated")).toBe("true");
  });
});
