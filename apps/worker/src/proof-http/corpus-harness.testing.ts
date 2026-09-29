import { isDeepStrictEqual } from "node:util";
import { expect } from "vitest";
import {
  corpusRootState,
  type CorpusProblem,
  type CorpusSelection,
  type CorpusStep,
} from "@proof/library";
import {
  createProofNodeSchema,
  type DisplayedSuggestionSet,
  type MoveRequiresInputResponse,
  type ProofNode,
  type ProtocolEnvironment,
} from "@proof/protocol";
import { initializeProofSession } from "../proof-repository";
import { InspectableMemoryProofStore as MemoryProofStore } from "../memory-proof-store.testing";
import { createProofHttpService, type ProofHttpService } from ".";

/**
 * A scripted protocol client for the benchmark corpus (roadmap N16, N37). Each step requests
 * suggestions for its selections, chooses a suggestion that was actually displayed, answers any
 * requested menus with the IDs of displayed menu items, previews, and applies, all through the
 * proof HTTP service over the in-memory store. Every interaction is counted, so a solved problem
 * also yields its deterministic interaction record.
 */

export type CorpusSession = Readonly<{
  sessionUrl: string;
  post(path: string, body: unknown): Promise<Response>;
  get(path?: string): Promise<Response>;
}>;

/** The interactions one scripted step needed. */
export type CorpusStepRecord = Readonly<{
  /** Occurrences selected for the suggestion request. */
  selections: number;
  suggestionRequests: number;
  /** Suggestions displayed for the request, and the 1-based position of the chosen one. */
  displayed: number;
  chosenRank: number;
  /** Preview requests, including those answered with menus (HTTP 422). */
  previewRequests: number;
  menuChoices: number;
  applies: number;
  /** The chosen suggestion's move or result, and for a result the pattern that matched. */
  suggestion: string;
  pattern?: string;
}>;

export async function json<Value = Record<string, unknown>>(response: Response): Promise<Value> {
  return (await response.json()) as Value;
}

export function corpusSlug(problem: CorpusProblem): string {
  return problem.id.replace(/^corpus:/, "");
}

/** Start a session for `problem` on a fresh memory store; the service joins `services`. */
export async function startCorpusSession(
  problem: CorpusProblem,
  services: ProofHttpService[],
): Promise<CorpusSession> {
  const store = new MemoryProofStore();
  const operators = problem.operators as NonNullable<ProtocolEnvironment["operators"]>;
  const slug = corpusSlug(problem);
  const rootNode = createProofNodeSchema({ operators }).parse({
    id: `node:${slug}-root`,
    state: corpusRootState(problem, `state:${slug}-root`),
  });
  const sessionId = `session:${slug}`;
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

export async function currentNode(session: CorpusSession): Promise<ProofNode> {
  return (await json<{ node: ProofNode }>(await session.get())).node;
}

/** Resolve a scripted selection against the current snapshot into an HTTP selection descriptor. */
export function selectionDescriptor(node: ProofNode, selection: CorpusSelection) {
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

/** Request suggestions for a step's selections and find its scripted choice among them. */
export async function requestStepSuggestions(
  session: CorpusSession,
  problem: CorpusProblem,
  step: CorpusStep,
  node: ProofNode,
  suggestionSetId: string,
): Promise<
  Readonly<{
    set: DisplayedSuggestionSet;
    chosen: DisplayedSuggestionSet["suggestions"][number];
    rank: number;
  }>
> {
  const suggested = await session.post("suggestion-sets", {
    id: suggestionSetId,
    selections: step.selections.map((selection) => selectionDescriptor(node, selection)),
  });
  if (suggested.status !== 201) {
    throw new Error(`Suggestions failed: ${JSON.stringify(await json(suggested))}`);
  }
  const set = (await json(suggested)).suggestionSet as DisplayedSuggestionSet;
  const index = set.suggestions.findIndex(
    (suggestion) =>
      suggestion.source === step.suggestion.source &&
      suggestion.artifactId === step.suggestion.artifactId &&
      (step.suggestion.patternId === undefined ||
        suggestion.patternId === step.suggestion.patternId),
  );
  if (index < 0) {
    throw new Error(
      `${problem.id} ${suggestionSetId}: ${step.suggestion.artifactId} was not displayed; got ${JSON.stringify(
        set.suggestions.map((suggestion) => `${suggestion.artifactId} ${suggestion.patternId}`),
      )}`,
    );
  }
  return { set, chosen: set.suggestions[index]!, rank: index + 1 };
}

/**
 * Preview a displayed choice, answering every requested menu with the scripted value's displayed
 * item. Returns the final (201) preview response, the menu choices and the preview request count.
 */
export async function previewStepChoice(
  session: CorpusSession,
  problem: CorpusProblem,
  step: CorpusStep,
  request: Readonly<{ commandId: string; suggestionSetId: string; chosenSuggestionId: string }>,
): Promise<
  Readonly<{
    menuChoices: Readonly<Record<string, string>>;
    previewRequests: number;
    body: (menuChoices: Readonly<Record<string, string>>) => unknown;
  }>
> {
  const menuChoices: Record<string, string> = {};
  const body = (choices: Readonly<Record<string, string>>) =>
    Object.keys(choices).length === 0 ? request : { ...request, menuChoices: choices };
  let previewRequests = 1;
  let preview = await session.post("move-previews", body(menuChoices));
  for (let round = 0; preview.status === 422 && round < 8; round += 1) {
    const pending = await json<MoveRequiresInputResponse>(preview);
    for (const parameterId of pending.missingParameters) {
      const value = step.menu?.[parameterId];
      const item = pending.menus
        .find((menu) => menu.parameterId === parameterId)
        ?.items.find((candidate) => isDeepStrictEqual(candidate.value, value));
      if (value === undefined || item === undefined) {
        throw new Error(
          `${problem.id} ${request.commandId}: no scripted item for ${parameterId} in ${JSON.stringify(
            pending.menus,
          )}`,
        );
      }
      menuChoices[parameterId] = item.id;
    }
    previewRequests += 1;
    preview = await session.post("move-previews", body(menuChoices));
  }
  if (preview.status !== 201) {
    throw new Error(
      `${problem.id} ${request.commandId}: preview failed ${preview.status} ${JSON.stringify(
        await json(preview),
      )}`,
    );
  }
  await preview.arrayBuffer();
  return { menuChoices, previewRequests, body };
}

/** Run one scripted step through suggestions, menus, preview and apply. */
export async function runCorpusStep(
  session: CorpusSession,
  problem: CorpusProblem,
  step: CorpusStep,
  index: number,
): Promise<CorpusStepRecord> {
  const slug = corpusSlug(problem);
  const node = await currentNode(session);
  const { set, chosen, rank } = await requestStepSuggestions(
    session,
    problem,
    step,
    node,
    `suggestion-set:${slug}-${index + 1}`,
  );
  const request = {
    commandId: `command:${slug}-${index + 1}`,
    suggestionSetId: set.id,
    chosenSuggestionId: chosen.id,
  };
  const { menuChoices, previewRequests, body } = await previewStepChoice(
    session,
    problem,
    step,
    request,
  );
  // Every scripted menu value was actually requested and chosen from a displayed menu.
  expect(Object.keys(menuChoices).sort()).toEqual(Object.keys(step.menu ?? {}).sort());

  const applied = await session.post("commands", body(menuChoices));
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
  return {
    selections: step.selections.length,
    suggestionRequests: 1,
    displayed: set.suggestions.length,
    chosenRank: rank,
    previewRequests,
    menuChoices: Object.keys(menuChoices).length,
    applies: 1,
    suggestion: chosen.artifactId,
    ...(chosen.source === "result" && chosen.patternId !== undefined
      ? { pattern: chosen.patternId }
      : {}),
  };
}
