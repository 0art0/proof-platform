import { startProofWorker } from "./proof-worker-startup";

// Process entry point: `PROOF_STORE=memory tsx src/main.ts` runs without PostgreSQL.
try {
  const worker = await startProofWorker(process.env);
  console.log(`Proof worker (${worker.kind} store) listening on ${worker.origin}`);
  const shutdown = (): void => {
    void worker.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
