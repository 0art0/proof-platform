import { defineConfig } from "@playwright/test";
import { productionWebCommand, WORKER_BACKED_SPECS } from "./playwright.shared";

// The worker-backed suite against a PostgreSQL store: real SQL, migrations and transactions.
// Requires PROOF_DATABASE_URL (or DATABASE_URL) pointing at a throwaway database; the worker
// applies pending migrations at startup (PROOF_AUTO_MIGRATE=true) and seeds session:development
// if absent. Each run adds its own isolated sessions to the database.
// Ports differ from playwright.proof-workspace-memory.config.ts so neither reuses the other's servers.
const WORKER_PORT = 8787;
const WEB_PORT = 3102;
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
      command: `PROOF_STORE=postgres PROOF_AUTO_MIGRATE=true PROOF_HTTP_PORT=${WORKER_PORT} npx tsx apps/worker/src/main.ts`,
      url: `${workerOrigin}/proof-sessions/session%3Adevelopment`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: productionWebCommand(WEB_PORT, workerOrigin),
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
