import { defineConfig } from "@playwright/test";
import { productionWebCommand } from "./playwright.shared";

// `npm run test:e2e`: the specs that need no proof worker. Worker-backed specs run under
// playwright.proof-workspace-memory.config.ts (in-memory store) or
// playwright.proof-workspace.config.ts (PostgreSQL). A port of its own keeps this config from
// reusing either of their servers.
const WEB_PORT = 3100;

export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: ["mathjson-spike.spec.ts"],
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: productionWebCommand(WEB_PORT),
    url: `http://127.0.0.1:${WEB_PORT}/spike`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
