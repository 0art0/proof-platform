import { defineConfig } from "vitest/config";

// The default run is file-parallel and excludes the timing-budget suite: budgets measured while
// sibling test files compete for the CPU are noise. `npm run test:perf` runs that suite alone,
// serially (see vitest.perf.config.ts), and `npm run verify` includes it.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "src/**/corpus-performance.test.ts"],
  },
});
