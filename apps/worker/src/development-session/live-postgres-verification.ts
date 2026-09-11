import assert from "node:assert/strict";
import {
  createProofNodeSchema,
  displayedSuggestionSetSchema,
  type ProofNode,
} from "@proof/protocol";
import { Pool } from "pg";
import { z } from "zod";
import { createPostgresProofHttpService, type ProofHttpService } from "../proof-http";
import { postgresProofStore } from "../postgres-proof-store";
import { proofSessionSchema } from "../proof-repository";
import { DEVELOPMENT_PROOF_SESSION_ID, ensureDevelopmentProofSession } from ".";

const currentSessionResponseSchema = z
  .object({ session: proofSessionSchema, node: z.unknown() })
  .strict();
const suggestionSetResponseSchema = z
  .object({ suggestionSet: displayedSuggestionSetSchema, replayed: z.boolean().optional() })
  .strict();

type CurrentSessionResponse = Readonly<{
  session: z.infer<typeof proofSessionSchema>;
  node: ProofNode;
}>;

async function verifyLivePostgres(): Promise<void> {
  const connectionString = process.env.PROOF_DATABASE_URL ?? process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error("Set PROOF_DATABASE_URL (or DATABASE_URL) to a migrated PostgreSQL database.");
  }

  const firstPool = new Pool({ connectionString });
  let beforeRestart: CurrentSessionResponse;
  let firstService: ProofHttpService | undefined;
  try {
    const initialized = await ensureDevelopmentProofSession(postgresProofStore(firstPool));
    if (initialized.status !== "ready") throw new Error(initialized.diagnostics[0].message);
    firstService = createPostgresProofHttpService(firstPool);
    const firstOrigin = await firstService.listen();
    beforeRestart = await fetchCurrentSession(firstOrigin.origin);
  } finally {
    if (firstService === undefined) {
      await firstPool.end();
    } else {
      await closeServiceAndPool(firstService, firstPool);
    }
  }

  const secondPool = new Pool({ connectionString });
  const secondService = createPostgresProofHttpService(secondPool);
  try {
    const secondOrigin = await secondService.listen();
    const afterRestart = await fetchCurrentSession(secondOrigin.origin);
    assert.deepStrictEqual(afterRestart.session, beforeRestart.session);
    assert.deepStrictEqual(afterRestart.node, beforeRestart.node);

    const target = afterRestart.node.state.goals[0] ?? afterRestart.node.state.obligations[0];
    assert.ok(target, "The fixed development session must retain an open target.");
    const targetKind = afterRestart.node.state.goals.some(({ id }) => id === target.id)
      ? "goal"
      : "obligation";
    const suggestionSetId = `suggestion-set:live-${afterRestart.node.state.id}`;
    const collectionUrl = `${secondOrigin.origin}/proof-sessions/${encodeURIComponent(
      DEVELOPMENT_PROOF_SESSION_ID,
    )}/suggestion-sets`;
    const recordedResponse = await fetch(collectionUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: suggestionSetId,
        selections: [
          {
            kind: "exact",
            anchor: {
              stateId: afterRestart.node.state.id,
              target: { kind: targetKind, id: target.id },
              statement: { kind: "conclusion" },
            },
            path: [],
          },
        ],
      }),
    });
    const recorded = suggestionSetResponseSchema.parse(await successfulJson(recordedResponse));
    const readResponse = await fetch(`${collectionUrl}/${encodeURIComponent(suggestionSetId)}`);
    const read = suggestionSetResponseSchema
      .omit({ replayed: true })
      .parse(await successfulJson(readResponse));

    assert.deepStrictEqual(
      read.suggestionSet.suggestions.map(({ id, reasons }) => ({ id, reasons })),
      recorded.suggestionSet.suggestions.map(({ id, reasons }) => ({ id, reasons })),
    );
    assert.deepStrictEqual(read.suggestionSet, recorded.suggestionSet);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        sessionId: afterRestart.session.id,
        currentNodeId: afterRestart.node.id,
        suggestionSetId,
        suggestionCount: read.suggestionSet.suggestions.length,
      })}\n`,
    );
  } finally {
    await closeServiceAndPool(secondService, secondPool);
  }
}

async function fetchCurrentSession(origin: string): Promise<CurrentSessionResponse> {
  const response = await fetch(
    `${origin}/proof-sessions/${encodeURIComponent(DEVELOPMENT_PROOF_SESSION_ID)}`,
  );
  const parsed = currentSessionResponseSchema.parse(await successfulJson(response));
  return {
    session: parsed.session,
    node: createProofNodeSchema({ operators: parsed.session.operators }).parse(parsed.node),
  };
}

async function successfulJson(response: Response): Promise<unknown> {
  const value = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  }
  return value;
}

async function closeServiceAndPool(service: ProofHttpService, pool: Pool): Promise<void> {
  try {
    await service.close();
  } finally {
    await pool.end();
  }
}

await verifyLivePostgres();
