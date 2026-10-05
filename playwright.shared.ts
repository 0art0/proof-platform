// Shared by the Playwright configs so the worker-backed suite and the production web server are
// defined once.

/** Specs that need a proof worker (memory or PostgreSQL store) behind the web app. */
export const WORKER_BACKED_SPECS = [
  "proof-workspace.spec.ts",
  "problem-entry.spec.ts",
  "toolbar-actions.spec.ts",
  "inquiry-panel.spec.ts",
  "construction-actions.spec.ts",
  "mouse-only-flows.spec.ts",
  "gestures.spec.ts",
  "move-authoring.spec.ts",
  "macro-application.spec.ts",
  "conditional-lemma.spec.ts",
];

/**
 * A production build of the web app. `next dev` recompiles routes and client chunks on demand,
 * which under two parallel browsers stalled page loads for 5-27 s at a time (a single 100% CPU
 * server process holding gigabytes) and made the tests flaky. The build runs once per server
 * start, so the caller's timeout must cover it. Configs that build must not run concurrently:
 * they share `apps/web/.next`.
 */
export function productionWebCommand(port: number, workerOrigin?: string): string {
  const env = [
    "NEXT_TELEMETRY_DISABLED=1",
    ...(workerOrigin === undefined ? [] : [`PROOF_HTTP_ORIGIN=${workerOrigin}`]),
  ].join(" ");
  return (
    `${env} npx next build apps/web --webpack && ` +
    `${env} npx next start apps/web --hostname 127.0.0.1 --port ${port}`
  );
}
