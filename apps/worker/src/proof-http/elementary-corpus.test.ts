import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  ELEMENTARY_CORPUS,
  LIBRARY_PACK_IDS,
  corpusRootState,
  libraryPacksForOperators,
  type CorpusProblem,
  type CorpusSelection,
  type CorpusStep,
} from "@proof/library";
import {
  analyzeDiscoveryTree,
  createProofNodeSchema,
  prunedProof,
  type DisplayedSuggestionSet,
  type MoveRequiresInputResponse,
  type ProofEdge,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * N16 acceptance: every problem of the elementary corpus is solved through the proof HTTP
 * service by its scripted sequence of displayed suggestions. Each step requests suggestions for
 * its selections, chooses a suggestion that was actually displayed, answers any requested menus
 * with the IDs of displayed menu items, previews, and applies. The finished discovery tree must
 * be solved (N17) without sorries or background inferences.
 */

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

type Session = Readonly<{
  sessionUrl: string;
  post(path: string, body: unknown): Promise<Response>;
  get(path?: string): Promise<Response>;
}>;

async function json<Value = Record<string, unknown>>(response: Response): Promise<Value> {
  return (await response.json()) as Value;
}

function slug(problem: CorpusProblem): string {
  return problem.id.replace(/^corpus:/, "");
}

async function startSession(problem: CorpusProblem): Promise<Session> {
  const store = new MemoryProofStore();
  const operators = problem.operators as NonNullable<ProtocolEnvironment["operators"]>;
  const rootNode = createProofNodeSchema({ operators }).parse({
    id: `node:${slug(problem)}-root`,
    state: corpusRootState(problem, `state:${slug(problem)}-root`),
  });
  const sessionId = `session:${slug(problem)}`;
  expect(await initializeProofSession(store, { sessionId, rootNode, operators })).toMatchObject({
    status: "committed",
  });
  const service = createProofHttpService(store);
  services.push(service);
  const { origin } = await service.listen();
  const sessionUrl = `${origin}/proof-sessions/${sessionId}`;
  return {
    sessionUrl,
    post: (path, body) =>
      fetch(`${sessionUrl}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    get: (path) => fetch(path === undefined ? sessionUrl : `${sessionUrl}/${path}`),
  };
}

/** Resolve a scripted selection against the current snapshot into an HTTP selection descriptor. */
function descriptor(node: ProofNode, selection: CorpusSelection) {
  const entries = selection.target.kind === "goal" ? node.state.goals : node.state.obligations;
  const target = entries.find((entry) =>
    isDeepStrictEqual(entry.sequent.conclusion.expression, selection.target.conclusion),
  );
  if (target === undefined) {
    throw new Error(
      `No ${selection.target.kind} ${JSON.stringify(selection.target.conclusion)} in ${JSON.stringify(
        [...node.state.goals, ...node.state.obligations].map(
          (entry) => entry.sequent.conclusion.expression,
        ),
      )}`,
    );
  }
  let statement: { kind: "conclusion" } | { kind: "hypothesis"; id: string };
  if (selection.statement === "conclusion") {
    statement = { kind: "conclusion" };
  } else {
    const wanted = selection.statement.hypothesis;
    const found = target.sequent.context.hypotheses.find((hypothesis) =>
      isDeepStrictEqual(hypothesis.statement.expression, wanted),
    );
    if (found === undefined) throw new Error(`No hypothesis ${JSON.stringify(wanted)}.`);
    statement = { kind: "hypothesis", id: found.id };
  }
  return {
    kind: "exact",
    anchor: {
      stateId: node.state.id,
      target: { kind: selection.target.kind, id: target.id },
      statement,
    },
    path: selection.path ?? [],
  } as const;
}

/** Run one scripted step through suggestions, menus, preview and apply. */
async function runStep(
  session: Session,
  problem: CorpusProblem,
  step: CorpusStep,
  index: number,
): Promise<void> {
  const current = await json<{ node: ProofNode }>(await session.get());
  const suggested = await session.post("suggestion-sets", {
    id: `suggestion-set:${slug(problem)}-${index + 1}`,
    selections: step.selections.map((selection) => descriptor(current.node, selection)),
  });
  if (suggested.status !== 201) {
    throw new Error(`Suggestions failed: ${JSON.stringify(await json(suggested))}`);
  }
  const set = (await json(suggested)).suggestionSet as DisplayedSuggestionSet;
  const chosen = set.suggestions.find(
    (suggestion) =>
      suggestion.source === step.suggestion.source &&
      suggestion.artifactId === step.suggestion.artifactId &&
      (step.suggestion.patternId === undefined ||
        suggestion.patternId === step.suggestion.patternId),
  );
  if (chosen === undefined) {
    throw new Error(
      `${problem.id} step ${index + 1}: ${step.suggestion.artifactId} was not displayed; got ${JSON.stringify(
        set.suggestions.map((suggestion) => `${suggestion.artifactId} ${suggestion.patternId}`),
      )}`,
    );
  }

  const request = {
    commandId: `command:${slug(problem)}-${index + 1}`,
    suggestionSetId: set.id,
    chosenSuggestionId: chosen.id,
  };
  const menuChoices: Record<string, string> = {};
  const withChoices = () =>
    Object.keys(menuChoices).length === 0 ? request : { ...request, menuChoices };
  let preview = await session.post("move-previews", withChoices());
  for (let round = 0; preview.status === 422 && round < 8; round += 1) {
    const pending = await json<MoveRequiresInputResponse>(preview);
    for (const parameterId of pending.missingParameters) {
      const value = step.menu?.[parameterId];
      const item = pending.menus
        .find((menu) => menu.parameterId === parameterId)
        ?.items.find((candidate) => isDeepStrictEqual(candidate.value, value));
      if (value === undefined || item === undefined) {
        throw new Error(
          `${problem.id} step ${index + 1}: no scripted item for ${parameterId} in ${JSON.stringify(
            pending.menus,
          )}`,
        );
      }
      menuChoices[parameterId] = item.id;
    }
    preview = await session.post("move-previews", withChoices());
  }
  if (preview.status !== 201) {
    throw new Error(
      `${problem.id} step ${index + 1}: preview failed ${preview.status} ${JSON.stringify(
        await json(preview),
      )}`,
    );
  }
  // Every scripted menu value was actually requested and chosen from a displayed menu.
  expect(Object.keys(menuChoices).sort()).toEqual(Object.keys(step.menu ?? {}).sort());

  const applied = await session.post("commands", withChoices());
  if (applied.status !== 201) {
    throw new Error(
      `${problem.id} step ${index + 1}: apply failed ${applied.status} ${JSON.stringify(
        await json(applied),
      )}`,
    );
  }
  expect(await json(applied)).toMatchObject({
    session: { currentNodeId: `node:${request.commandId}` },
    receipt: { commandId: request.commandId },
  });
}

describe("elementary corpus through the proof HTTP service", () => {
  it("has at least eight problems covering every starter pack", () => {
    expect(ELEMENTARY_CORPUS.length).toBeGreaterThanOrEqual(8);
    expect(new Set(ELEMENTARY_CORPUS.map((problem) => problem.id)).size).toBe(
      ELEMENTARY_CORPUS.length,
    );
    expect(new Set(ELEMENTARY_CORPUS.flatMap((problem) => problem.packs))).toEqual(
      new Set(LIBRARY_PACK_IDS),
    );
  });

  it.each(ELEMENTARY_CORPUS.map((problem) => [problem.id, problem] as const))(
    "solves %s with displayed suggestions only",
    async (_id, problem) => {
      const active = libraryPacksForOperators(problem.operators).map((pack) => pack.id);
      problem.packs.forEach((pack) => expect(active).toContain(pack));

      const session = await startSession(problem);
      for (const [index, step] of problem.steps.entries()) {
        await runStep(session, problem, step, index);
      }

      const final = await json<{ node: ProofNode }>(await session.get());
      expect(final.node.state.goals).toEqual([]);
      expect(final.node.state.obligations).toEqual([]);

      const history = await json<{
        session: { rootNodeId: string };
        nodes: ProofNode[];
        edges: { edge: ProofEdge }[];
      }>(await session.get("history"));
      expect(history.edges).toHaveLength(problem.steps.length);
      const analysis = analyzeDiscoveryTree({
        nodes: history.nodes,
        edges: history.edges,
        rootId: history.session.rootNodeId as ProofNode["id"],
      });
      expect(analysis).toMatchObject({
        ok: true,
        solved: true,
        solvedRelativeTo: { backgroundInferences: [], sorries: [] },
        assumptions: [],
      });
      if (!analysis.ok) throw new Error("The discovery tree could not be analyzed.");
      expect(analysis.route.steps).toHaveLength(problem.steps.length);
      expect(analysis.route.steps.every((step) => step.transitionClass !== "weakening")).toBe(true);
      expect(prunedProof(analysis)).toMatchObject({ ok: true });
    },
  );
});
