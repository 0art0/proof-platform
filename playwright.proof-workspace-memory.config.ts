import { defineConfig } from "@playwright/test";

// Runs proof-workspace.spec.ts and problem-entry.spec.ts against a worker using the in-memory
// proof store, so no PostgreSQL is needed. Distinct ports keep it from reusing a PostgreSQL-backed worker or the
// Next server of playwright.proof-workspace.config.ts, and the worker is never reused so every
// run starts from a freshly seeded session:development.
const WORKER_PORT = 8788;
const WEB_PORT = 3101;

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: [
    "proof-workspace.spec.ts",
    "problem-entry.spec.ts",
    "toolbar-actions.spec.ts",
    "inquiry-panel.spec.ts",
    "mouse-only-flows.spec.ts",
    "gestures.spec.ts",
    "move-authoring.spec.ts",
    "macro-application.spec.ts",
  ],
  globalSetup: "./apps/web/e2e/global-warmup.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    // Next dev reports request URLs as localhost, and the API's same-origin check compares the
    // browser Origin with that URL, so the page must be served from localhost as well.
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `PROOF_STORE=memory PROOF_HTTP_PORT=${WORKER_PORT} npx tsx apps/worker/src/main.ts`,
      url: `http://127.0.0.1:${WORKER_PORT}/proof-sessions/session%3Adevelopment`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // A production build: `next dev` recompiles routes and client chunks on demand, which under
      // two parallel browsers stalled page loads for 5-27 s at a time (a single 100% CPU server
      // process holding gigabytes) and made the 60 s tests flaky. The build runs once here, so the
      // timeout covers it.
      command: `NEXT_TELEMETRY_DISABLED=1 PROOF_HTTP_ORIGIN=http://127.0.0.1:${WORKER_PORT} npx next build apps/web --webpack && NEXT_TELEMETRY_DISABLED=1 PROOF_HTTP_ORIGIN=http://127.0.0.1:${WORKER_PORT} npx next start apps/web --hostname 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: true,
      timeout: 300_000,
    },
  ],
});
