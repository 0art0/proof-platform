import { defineConfig } from "@playwright/test";
import { productionWebCommand, WORKER_BACKED_SPECS } from "./playwright.shared";

// `npm run test:e2e:workspace`: the worker-backed suite against a worker using the in-memory
// proof store, so no PostgreSQL is needed. Distinct ports keep it from reusing the servers of
// playwright.proof-workspace.config.ts, and the worker is never reused so every run starts from a
// freshly seeded session:development.
const WORKER_PORT = 8788;
const WEB_PORT = 3101;
const workerOrigin = `http://127.0.0.1:${WORKER_PORT}`;

// Read by apps/web/e2e/global-warmup.ts, which runs in this process.
process.env.PROOF_E2E_WEB_PORT = String(WEB_PORT);

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: WORKER_BACKED_SPECS,
  globalSetup: "./apps/web/e2e/global-warmup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // The API's same-origin check compares the browser Origin with the request URL Next reports
    // (localhost), so the page must be served from localhost as well.
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `PROOF_STORE=memory PROOF_HTTP_PORT=${WORKER_PORT} npx tsx apps/worker/src/main.ts`,
      url: `${workerOrigin}/proof-sessions/session%3Adevelopment`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: productionWebCommand(WEB_PORT, workerOrigin),
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
