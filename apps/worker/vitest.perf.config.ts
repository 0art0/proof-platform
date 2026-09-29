import { defineConfig } from "vitest/config";

// Timing budgets (N37): one file at a time in a single forked process, so the suite never
// competes with other test files of this package.
export default defineConfig({
  test: {
    include: ["src/**/corpus-performance.test.ts"],
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
  },
});
