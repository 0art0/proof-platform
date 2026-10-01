import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { authoredMacroDefinition, authoredMoveTemplateSchema } from "@proof/moves/authoring";
import { createProofNodeSchema, type ProofArtifact } from "@proof/protocol";
import { artifactDigest, exportProofArtifact } from "./artifact-export";
import { importProofArtifact, validateProofArtifact } from "./artifact-import";
import { APPROVED_DEFINITIONS, definitionHash, type DefinitionCatalog } from "./approved-catalog";
import {
  MACRO_ID,
  macroState,
  macroTemplate,
  startMacroSession,
  type Json,
} from "./macro-move.testing";
import { MemoryLibraryStore } from "./memory-library-store";
import { MemoryProofStore } from "./memory-proof-store";
import { initializeProofSession } from "./proof-repository";
import type { ProofHttpService } from "./proof-http";
import { applyMoveChoice, previewMoveChoice, recordSuggestions } from "./proof-http/shared";

/**
 * N35: macro application at the repository level (alpha-renamed states) and its artifact round
 * trip (export, import revalidation with the artifact's own approved macro, tampering).
 */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const actor = { id: "actor:web", kind: "human" } as const;

function macroCatalog(): DefinitionCatalog {
  const parsed = authoredMoveTemplateSchema.parse(macroTemplate());
  const macro = authoredMacroDefinition(
    parsed,
    { status: "approved", reviewerId: "reviewer:test" },
    "test",
  );
  if (macro === undefined) throw new Error("The macro does not project.");
  return Object.freeze({
    moves: APPROVED_DEFINITIONS.moves,
    macros: [{ move: macro.definition, template: macro.template }],
    catalog: APPROVED_DEFINITIONS.catalog,
  });
}

describe("macro application on alpha-renamed states", () => {
  const names = ["u", "v", "w", "s", "t", "m", "n"];
  it("previews and applies the macro on any renaming of its recorded state", async () => {
    const definitions = macroCatalog();
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray(names, { minLength: 3, maxLength: 3 }),
        async (chosen) => {
          run += 1;
          const [a, b, c] = chosen as [string, string, string];
          const store = new MemoryProofStore();
          const sessionId = `session:alpha-${run}`;
          const rootNode = createProofNodeSchema().parse({
            id: "node:alpha-root",
            state: macroState([a, b, c], ["Implies", a, ["Implies", b, c]], "state:alpha-root"),
          });
          await initializeProofSession(store, { sessionId, rootNode });
          const context = { store, definitions, now: undefined, library: undefined };
          const suggested = await recordSuggestions(
            context,
            sessionId,
            `suggestion-set:alpha-${run}` as never,
            [
              {
                kind: "exact",
                anchor: {
                  stateId: "state:alpha-root",
                  target: { kind: "goal", id: "goal:main" },
                  statement: { kind: "conclusion" },
                },
                path: [],
              } as never,
            ],
          );
          if (suggested.status !== "recorded") throw new Error(JSON.stringify(suggested));
          const offered = suggested.suggestionSet.suggestions.find(
            ({ artifactId }) => artifactId === MACRO_ID,
          );
          expect(offered).toBeDefined();
          const choice = {
            commandId: `command:alpha-${run}`,
            suggestionSetId: suggested.suggestionSet.id,
            chosenSuggestionId: offered?.id,
          } as never;
          const previewed = await previewMoveChoice(context, sessionId, choice, actor as never);
          if (previewed.status !== "previewed") throw new Error(JSON.stringify(previewed));
          expect(previewed.preview.macro?.steps).toHaveLength(2);
          const applied = await applyMoveChoice(
            context,
            sessionId,
            choice,
            undefined,
            actor as never,
          );
          if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
          expect(applied.node.state).toEqual(previewed.preview.afterState);
          const goal = applied.node.state.goals[0];
          expect(goal?.sequent.conclusion.expression).toBe(c);
          expect(
            goal?.sequent.context.hypotheses.map(({ statement }) => statement.expression),
          ).toEqual([a, b]);
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);
});

async function exportWithAppliedMacro(): Promise<ProofArtifact> {
  const client = await startMacroSession(services);
  const approved = await client.approve(macroTemplate());
  expect((await approved.approve()).status).toBe(201);
  const { choice } = await client.macroChoice("command:artifact-macro");
  if (choice === undefined) throw new Error("The macro was not offered.");
  expect((await client.post("commands", choice)).status).toBe(201);
  const exported = await exportProofArtifact(client.store, "session:macro", {
    library: client.store,
  });
  if (exported.status !== "exported") throw new Error(JSON.stringify(exported));
  return exported.artifact;
}

function redigest(artifact: Json): Json {
  return { ...artifact, digest: artifactDigest(artifact) };
}

function approvedMacroEvents(artifact: Json): Json[] {
  return (artifact["library"].additionEvents as Json[]).filter(
    ({ artifact: a }) => a.kind === "move" && a.review !== undefined,
  );
}

function reapprove(event: Json): void {
  event["artifact"].definitionDigest = definitionHash(event["artifact"].template);
  event["artifact"].review.definitionDigest = event["artifact"].definitionDigest;
}

describe("artifact export and import of a macro application", () => {
  it("round-trips a session that applied an approved macro, using only its own library", async () => {
    const artifact = await exportWithAppliedMacro();
    const macroEdges = artifact.tree.edges.filter((edge) => edge.macro !== undefined);
    expect(macroEdges.map(({ macro }) => [macro?.moveId, macro?.stepIndex])).toEqual([
      [MACRO_ID, 1],
      [MACRO_ID, 2],
    ]);
    expect(artifact.tree.previews.some((preview) => preview.macro !== undefined)).toBe(true);
    // A fresh store knows no authored moves: only the artifact's own approved macro counts.
    const target = new MemoryLibraryStore();
    const imported = await importProofArtifact(target, artifact);
    expect(imported, JSON.stringify(imported)).toMatchObject({
      status: "imported",
      replayed: false,
    });
    const reexported = await exportProofArtifact(
      target,
      (imported as { sessionId: string }).sessionId,
      { library: target },
    );
    expect(reexported.status).toBe("exported");
    if (reexported.status === "exported") {
      expect(reexported.artifact.tree.edges.filter((edge) => edge.macro !== undefined)).toEqual(
        macroEdges,
      );
    }
  });

  it("rejects the artifact when its library no longer approves the applied macro", async () => {
    const forged = structuredClone(await exportWithAppliedMacro()) as Json;
    forged["library"].additionEvents = [];
    forged["library"].finalLibrary = [];
    expect(validateProofArtifact(redigest(forged)).ok).toBe(false);
  });

  it("rejects a macro whose approved template lost a step, even with recomputed digests", async () => {
    const forged = structuredClone(await exportWithAppliedMacro()) as Json;
    for (const event of approvedMacroEvents(forged)) {
      event["artifact"].template.plan.steps.pop();
      reapprove(event);
    }
    expect(validateProofArtifact(redigest(forged)).ok).toBe(false);
  });

  it("rejects a macro step whose plan identity was altered, even with recomputed digests", async () => {
    const forged = structuredClone(await exportWithAppliedMacro()) as Json;
    for (const event of approvedMacroEvents(forged)) {
      event["artifact"].template.plan.steps[1].id = "step-renamed";
      reapprove(event);
    }
    const validated = validateProofArtifact(redigest(forged));
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.diagnostics[0].code).toBe("macro-application-invalid");
  });

  it("rejects an application whose steps were relabelled as another macro step", async () => {
    const forged = structuredClone(await exportWithAppliedMacro()) as Json;
    const tree = forged["tree"];
    for (const edge of tree.edges as Json[]) edge.macro.stepCount = 3;
    for (const record of tree.commands as Json[]) {
      record.prepared.command.macro.stepCount = 3;
      record.prepared.edge.macro.stepCount = 3;
    }
    expect(validateProofArtifact(redigest(forged)).ok).toBe(false);
  });
});
