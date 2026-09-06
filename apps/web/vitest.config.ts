import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
