import { defineConfig } from "@playwright/test";

// Separate from playwright.config.ts because this spec is the only one that needs a
// PostgreSQL-backed worker service; keeping it out of the default config means the
// rest of the e2e suite (e.g. mathjson-spike.spec.ts) still runs without a database.
export default defineConfig({
  testDir: "./apps/web/e2e",
  testMatch: ["proof-workspace.spec.ts"],
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        './scripts/pnpmw exec tsx -e \'import { Pool } from "pg"; import { createPostgresProofHttpService, ensureDevelopmentProofSession, postgresProofStore } from "./apps/worker/src/index.ts"; void (async () => { const connectionString = process.env.PROOF_DATABASE_URL ?? process.env.DATABASE_URL; if (!connectionString) throw new Error("Set PROOF_DATABASE_URL (or DATABASE_URL) for proof-workspace e2e."); const pool = new Pool({ connectionString }); const ready = await ensureDevelopmentProofSession(postgresProofStore(pool)); if (ready.status !== "ready") throw new Error(ready.diagnostics[0].message); await createPostgresProofHttpService(pool).listen({ host: "127.0.0.1", port: 8787 }); })();\'',
      url: "http://127.0.0.1:8787/proof-sessions/session%3Adevelopment",
      reuseExistingServer: true,
      timeout: 120_000,
    },
    {
      command:
        "PROOF_HTTP_ORIGIN=http://127.0.0.1:8787 .tools/node-v24.20.0-linux-x64/bin/node apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
