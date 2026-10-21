import { afterEach, describe, expect, it } from "vitest";
import { artifactDigest } from "../artifact-export";
import { importProofArtifact, validateProofArtifact } from "../artifact-import";
import { MemoryLibraryStore } from "../memory-library-store";
import type { ProofHttpService } from ".";
import { createAiLimiter } from "./ai-rate-limit";
import {
  AGENT,
  AUTHOR_CALL_ID,
  EXECUTOR_CALL_ID,
  SESSION_ID,
  contrapositive,
  counting,
  startAuthorScenario,
  wireProposal,
  type AuthorScenarioOptions,
  type Json,
} from "./ai-move-author.testing";

/** Slice M: "Save as reusable move" over HTTP, from the described step to a reviewed, reused move. */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const proposalOutput = (edit?: (proposal: Json) => void) => ({ result: wireProposal(edit) });

async function start(options: AuthorScenarioOptions = {}, apply = true) {
  const scenario = await startAuthorScenario(services, options);
  const described = await scenario.describe(apply);
  expect(described.status, JSON.stringify(described.body)).toBe(apply ? 201 : 200);
  return scenario;
}

/** A scenario whose model answers with the standard contrapositive proposal. */
async function proposed(edit?: (proposal: Json) => void) {
  const model = counting(proposalOutput(edit));
  const scenario = await start({ author: model.transport });
  const answer = await scenario.propose();
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return { scenario, model, answer };
}

const proposalLink = (overrides: Json = {}) => ({
  role: "move-author",
  callId: AUTHOR_CALL_ID,
  executorCallId: EXECUTOR_CALL_ID,
  ...overrides,
});

describe("POST /proof-sessions/:id/ai/move-author", () => {
  it("proposes a general move from the applied step and validates it in the session", async () => {
    const { answer, scenario, model } = await proposed();
    expect(answer.body).toMatchObject({
      status: "proposed",
      provenance: { kind: "minimal-context-llm", role: "move-author" },
      callId: AUTHOR_CALL_ID,
      replayed: false,
      executorCallId: EXECUTOR_CALL_ID,
      motivation: "The user replaced the goal A implies B by its contrapositive.",
      classification: { kind: "macro" },
      validation: {
        ok: true,
        report: { transitionClass: "strengthening", stepCount: 1, retrievable: true },
      },
      generality: [],
      diagnostics: [],
    });
    const { template } = answer.body;
    expect(template.id).toMatch(/^authored:prove-the-contrapositive-[0-9a-f]{8}$/);
    expect(template.patterns).toEqual([
      { id: "pattern:target", selectionSlotId: "target", expression: ["Implies", "A", "B"] },
    ]);
    // The first step constructs its proposition from the selected parts: it is a template, not a
    // constant of the problem the step was applied to.
    expect(template.plan.steps[0].parameters[0]).toMatchObject({
      parameterId: "proposition",
      origin: { kind: "rule" },
      value: { kind: "proposition", expression: contrapositive("A", "B") },
    });
    expect(template.examples.map(({ id }: Json) => id)).toEqual([
      "example:source",
      "example:compound",
      "example:not-an-implication",
    ]);
    expect(model.calls).toHaveLength(1);

    // Nothing was recorded as a draft; the call is session-owned evidence.
    expect((await scenario.get("/authored-moves")).body.moves).toEqual([]);
    const evidence = await scenario.get("/llm-calls");
    expect(evidence.body.records.map(({ id, role }: Json) => [id, role]).sort()).toEqual([
      [AUTHOR_CALL_ID, "move-author"],
      [EXECUTOR_CALL_ID, "move-executor"],
    ]);
  });

  it("shows the model only the abstracted step, never the problem, the history or other goals", async () => {
    const { model } = await proposed();
    const [call] = model.calls;
    expect(call?.role).toBe("move-author");
    const serialized = JSON.stringify(call?.envelope);
    for (const hidden of [
      "remote-secret",
      "goal:elsewhere",
      "goal:other",
      "Secret problem title",
      "secretly",
      "node:",
      "session:",
    ]) {
      expect(serialized, hidden).not.toContain(hidden);
    }
    const { context } = call?.envelope as { context: Json };
    // The situation names the problem's symbols neutrally (a library result's own parameters,
    // elsewhere in the context, are its own).
    expect(JSON.stringify(context.situation)).not.toMatch(/"[pqrst]"/);
    expect(context.instruction).toBe("prove the contrapositive instead");
    expect(context.executorCallId).toBe(EXECUTOR_CALL_ID);
    expect(context.situation.before.conclusion).toEqual(["Implies", "P", "Q"]);
    expect(context.situation.plan[0].proposition).toEqual(contrapositive("P", "Q"));
  });

  it("makes the approved move retrievable and applicable on a different situation", async () => {
    const { scenario, answer } = await proposed();
    const { template } = answer.body;

    // The user submits the proposal through the ordinary command, with its provenance.
    const drafted = await scenario.author(template, proposalLink());
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.result).toMatchObject({
      moveId: template.id,
      status: "draft",
      provenance: {
        kind: "generated",
        role: "move-author",
        contextId: AUTHOR_CALL_ID,
        sourceContextId: EXECUTOR_CALL_ID,
      },
      validation: { ok: true },
    });
    const draftId = drafted.body.result.artifactId as string;

    // A draft is never retrievable, and approval is a separate, human decision.
    const observedDraft = (await scenario.get("/observe?view=full")).body;
    const beforeReview = await scenario.command(
      AGENT,
      {
        kind: "request-suggestions",
        selections: [
          { target: { kind: "goal", id: "goal:other" }, statement: "conclusion", path: [] },
        ],
      },
      { nodeId: observedDraft.cursor.nodeId },
    );
    expect(
      (beforeReview.body.result.displayed.suggestions as Json[]).some(
        ({ artifactId }) => artifactId === template.id,
      ),
    ).toBe(false);

    const approved = await scenario.review(draftId, "approved", "A general contrapositive move.");
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.result).toMatchObject({ decision: "approved", retrievable: true });
    const listed = (await scenario.get("/authored-moves")).body;
    expect(listed.moves[0]).toMatchObject({
      moveId: template.id,
      retrievable: true,
      revisions: [
        {
          status: "approved",
          provenance: { kind: "generated", contextId: AUTHOR_CALL_ID },
        },
      ],
    });

    // It is offered on a situation of another shape, with other symbols, in the same session.
    const observed = (await scenario.get("/observe?view=full")).body;
    const displayed = await scenario.command(
      AGENT,
      {
        kind: "request-suggestions",
        selections: [
          { target: { kind: "goal", id: "goal:other" }, statement: "conclusion", path: [] },
        ],
      },
      { nodeId: observed.cursor.nodeId },
    );
    expect(displayed.status, JSON.stringify(displayed.body)).toBe(201);
    const set = displayed.body.result.displayed as Json;
    const suggestion = (set.suggestions as Json[]).find(
      ({ artifactId }) => artifactId === template.id,
    );
    expect(suggestion).toBeDefined();
    expect(suggestion?.applicability).toBe("applicable");

    const applied = await scenario.command(
      AGENT,
      { kind: "apply", suggestion: suggestion?.alias },
      { nodeId: observed.cursor.nodeId, suggestionSetId: set.suggestionSetId },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const current = (await scenario.current()).node.state as Json;
    const other = current.goals.find(({ id }: Json) => id === "goal:other");
    expect(other.sequent.conclusion.expression).toEqual(
      contrapositive(["And", "r", "s"], ["Or", "t", "r"]),
    );
    expect(current.obligations.map(({ sequent }: Json) => sequent.conclusion.expression)).toEqual(
      expect.arrayContaining([
        [
          "Implies",
          contrapositive(["And", "r", "s"], ["Or", "t", "r"]),
          ["Implies", ["And", "r", "s"], ["Or", "t", "r"]],
        ],
      ]),
    );
    // The edge names the authored move: history shows which approved move was used.
    const edges = (await scenario.history()).edges;
    const used = edges.find(({ edge }) => edge.moveId === template.id);
    expect(used?.name).toBe("Prove the contrapositive");
  });

  it("reports validation failures as part of the proposal, not as an error", async () => {
    const { answer } = await proposed((proposal) => {
      proposal["examples"][1].expected.goals = [["Implies", "p", "q"]];
    });
    expect(answer.status).toBe(200);
    expect(answer.body.validation.ok).toBe(false);
    expect(answer.body.validation.diagnostics[0]).toMatchObject({
      code: "example-mismatch",
      exampleId: "example:compound",
    });
    expect(answer.body.template.examples).toHaveLength(3);
  });

  it("flags a template that bakes in a symbol of the original situation, and approval refuses it", async () => {
    // Q is the neutral name of the original q; the model wrote it instead of the metavariable B.
    const { scenario, answer } = await proposed((proposal) => {
      proposal["steps"][0].parameters[0].expression = ["Implies", ["Not", "Q"], ["Not", "A"]];
    });
    expect(answer.body.validation.ok).toBe(false);
    expect(answer.body.validation.diagnostics.map(({ code }: Json) => code)).toContain(
      "problem-specific-symbol",
    );
    // The author may still save it as a draft, but it can never be approved.
    const drafted = await scenario.author(answer.body.template, proposalLink());
    expect(drafted.status).toBe(201);
    expect(drafted.body.result.validation.ok).toBe(false);
    const approved = await scenario.review(drafted.body.result.artifactId, "approved", "no");
    expect(approved.status).toBeGreaterThanOrEqual(400);
    expect(approved.body.diagnostics[0].code).toBe("move-validation-failed");
  });

  it("flags examples that only differ by renaming", async () => {
    const { answer } = await proposed((proposal) => {
      const alike = structuredClone(proposal["examples"][1]);
      alike.state.declarations = [
        { symbol: "u", sort: "proposition" },
        { symbol: "v", sort: "proposition" },
      ];
      alike.state.conclusion = ["Implies", "u", "v"];
      alike.expected.goals = [contrapositive("u", "v")];
      alike.expected.obligations = [["Implies", contrapositive("u", "v"), ["Implies", "u", "v"]]];
      proposal["examples"][1] = alike;
    });
    expect(answer.body.validation.ok).toBe(true);
    // The source situation has the same shape too, so the positives are one situation.
    expect(answer.body.generality.map(({ code }: Json) => code)).toEqual(["examples-alike"]);
  });

  it("marks a proposal its own author classes as a new principle as blocked", async () => {
    const { answer, scenario } = await proposed((proposal) => {
      proposal["classification"] = { kind: "principle", rationale: "It needs a new lemma." };
    });
    expect(answer.body.classification.kind).toBe("principle");
    expect(answer.body.blocked).toMatchObject({ code: "principle-not-a-move" });
    const refused = await scenario.author(answer.body.template, proposalLink());
    expect(refused.status).toBe(409);
    expect(refused.body.diagnostics[0].code).toBe("principle-not-a-move");
  });

  it("answers a context request or a refusal as such", async () => {
    const insufficient = await start({
      author: counting({
        result: {
          kind: "insufficient-context",
          requestedCategories: ["situation-detail"],
          rationale: "Which hypothesis was used?",
        },
      }).transport,
    });
    expect((await insufficient.propose()).body).toMatchObject({
      status: "insufficient-context",
      result: { rationale: "Which hypothesis was used?" },
    });
    const declined = await start({
      author: counting({ result: { kind: "declined", reason: "No general method." } }).transport,
    });
    const answer = await declined.propose();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      status: "declined",
      result: { reason: "No general method." },
    });
  });

  it("records and rejects an output that breaks the proposal rules", async () => {
    const scenario = await start({
      author: counting(proposalOutput((proposal) => proposal["examples"].splice(1, 1))).transport,
    });
    const answer = await scenario.propose();
    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({
      status: "rejected",
      diagnostics: [{ code: "invalid-output" }],
    });
    const evidence = await scenario.get("/llm-calls");
    expect(
      evidence.body.records.find(({ id }: Json) => id === AUTHOR_CALL_ID).evidence.status,
    ).toBe("rejected");
  });

  describe("which executor calls can be authored from", () => {
    it("refuses a step that was previewed but never applied", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport }, false);
      const answer = await scenario.propose();
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ diagnostics: [{ code: "plan-not-applied" }] });
      expect(model.calls).toHaveLength(0);
    });

    it("refuses a call the session does not have, another role's call, and a technique", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport });
      const missing = await scenario.propose({ executorCallId: "llm-call:never-made" });
      expect(missing.status).toBe(409);
      expect(missing.body).toMatchObject({ diagnostics: [{ code: "executor-call-unavailable" }] });
      // A move-author call is not a step to author from.
      expect((await scenario.propose()).status).toBe(200);
      const foreign = await scenario.propose({
        id: "llm-call:author-2",
        executorCallId: AUTHOR_CALL_ID,
      });
      expect(foreign.status).toBe(409);
      expect(model.calls).toHaveLength(1);

      const technique = await startAuthorScenario(services, { author: model.transport });
      await technique.describe(true, { source: "shortlisted-technique" });
      const refused = await technique.propose();
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ diagnostics: [{ code: "not-a-user-instruction" }] });
      expect(model.calls).toHaveLength(1);
    });

    it("refuses a step of another session", async () => {
      const model = counting(proposalOutput());
      const first = await start({ author: model.transport });
      const other = await startAuthorScenario(services, { author: model.transport });
      // The other session has not run the step; the call exists only in the first session.
      expect(first.origin).not.toBe(other.origin);
      const answer = await other.propose();
      expect(answer.status).toBe(409);
      expect(model.calls).toHaveLength(0);
    });

    it("refuses a step whose moves were deleted since", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport });
      const observed = (await scenario.get("/observe?view=full")).body;
      const deleted = await scenario.command(
        { id: "actor:human-1", kind: "human" },
        { kind: "delete-previous-move", confirmDescendants: true },
        { nodeId: observed.cursor.nodeId },
      );
      expect(deleted.status, JSON.stringify(deleted.body)).toBeLessThan(300);
      expect((await scenario.propose()).status).toBe(409);
      expect(model.calls).toHaveLength(0);
    });
  });

  describe("replay, configuration and the cost guard", () => {
    it("replays by call ID without dispatching again, and a changed request conflicts", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport });
      expect((await scenario.propose()).body).toMatchObject({ replayed: false });
      const replay = await scenario.propose();
      expect(replay.body).toMatchObject({ status: "proposed", replayed: true });
      expect(replay.body.validation.ok).toBe(true);
      expect(model.calls).toHaveLength(1);
      const changed = await scenario.propose({
        revision: { previousCallId: AUTHOR_CALL_ID, feedback: "different" },
      });
      expect(changed.status).toBe(409);
      expect(model.calls).toHaveLength(1);
    });

    it("answers 503 ai-disabled without a configured provider, and reports the role", async () => {
      const scenario = await start();
      const answer = await scenario.propose();
      expect(answer.status).toBe(503);
      expect(answer.body).toMatchObject({
        status: "disabled",
        diagnostics: [{ code: "ai-disabled" }],
      });
      expect(
        (await (await fetch(`${scenario.origin}/ai/capabilities`)).json()).roles["move-author"],
      ).toBe(false);
      const configured = await start({ author: counting(proposalOutput()).transport });
      expect(
        (await (await fetch(`${configured.origin}/ai/capabilities`)).json()).roles["move-author"],
      ).toBe(true);
    });

    it("applies the cost guard with 429 and Retry-After, before dispatching", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({
        author: model.transport,
        // The executor call already spent the one call this limiter allows.
        aiLimiter: createAiLimiter({ ratePerMinute: 2, maxConcurrent: 4 }),
      });
      expect((await scenario.propose()).status).toBe(200);
      const limited = await scenario.propose({ id: "llm-call:author-2" });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
      expect(limited.body).toMatchObject({
        status: "rate-limited",
        diagnostics: [{ code: "ai-rate-limited" }],
      });
      expect(model.calls).toHaveLength(1);
      // A replay of the stored call costs nothing.
      expect((await scenario.propose()).body).toMatchObject({ replayed: true });
      expect(model.calls).toHaveLength(1);
    });

    it("refuses a read-only session without dispatching", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport });
      await scenario.store.transaction(async (transaction) => {
        await transaction.markSessionReadOnly(SESSION_ID as never);
      });
      const answer = await scenario.propose();
      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ diagnostics: [{ code: "session-read-only" }] });
      expect(model.calls).toHaveLength(0);
    });

    it.each([
      ["extra fields", { steps: [] }],
      ["an empty revision", { revision: { previousCallId: AUTHOR_CALL_ID, feedback: "  " } }],
      ["a missing executor call", { executorCallId: undefined }],
    ])("rejects %s without dispatching", async (_name, overrides) => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport });
      expect((await scenario.propose(overrides)).status).toBe(400);
      expect(model.calls).toHaveLength(0);
    });
  });

  describe("revisions", () => {
    it("reads the previous proposal from storage and sends it with the feedback and findings", async () => {
      const model = counting((call: unknown) => {
        const { context } = (call as { envelope: { context: Json } }).envelope;
        // The first call fails an example's expectation; the revision repairs it.
        return context.revision === undefined
          ? proposalOutput((proposal) => {
              proposal["examples"][1].expected.goals = [["Implies", "p", "q"]];
            })
          : proposalOutput();
      });
      const scenario = await start({ author: model.transport });
      const first = await scenario.propose();
      expect(first.body.validation.ok).toBe(false);

      const revised = await scenario.propose({
        id: "llm-call:author-2",
        revision: {
          previousCallId: AUTHOR_CALL_ID,
          feedback: "  The compound example is wrong.  ",
        },
      });
      expect(revised.status, JSON.stringify(revised.body)).toBe(200);
      expect(revised.body).toMatchObject({
        status: "proposed",
        callId: "llm-call:author-2",
        revisedCallId: AUTHOR_CALL_ID,
        validation: { ok: true },
      });
      const sent = (model.calls[1]?.envelope as { context: Json }).context.revision;
      expect(sent.previousCallId).toBe(AUTHOR_CALL_ID);
      expect(sent.feedback).toBe("The compound example is wrong.");
      expect(sent.previousProposal.examples[1].expected.goals).toEqual([["Implies", "p", "q"]]);
      expect(sent.previousFindings[0]).toMatchObject({
        code: "example-mismatch",
        exampleId: "example:compound",
      });
      // The revision has the same move ID: both proposals come from the same executed step.
      expect(revised.body.template.id).toBe(first.body.template.id);
    });

    it("refuses a revision of a call that is missing, rejected, or from another step", async () => {
      const model = counting(proposalOutput());
      const scenario = await start({ author: model.transport });
      expect(
        (
          await scenario.propose({
            id: "llm-call:author-2",
            revision: { previousCallId: "llm-call:never-made", feedback: "again" },
          })
        ).status,
      ).toBe(404);
      // A call that is not a move proposal (the executor's) cannot be revised.
      const notProposal = await scenario.propose({
        id: "llm-call:author-3",
        revision: { previousCallId: EXECUTOR_CALL_ID, feedback: "again" },
      });
      expect(notProposal.status).toBe(409);
      expect(notProposal.body).toMatchObject({ diagnostics: [{ code: "proposal-not-revisable" }] });
      expect(model.calls).toHaveLength(0);
    });
  });
});

describe("submitting a proposal through author-move-draft", () => {
  it("refuses a link to calls the session does not have, or to another step", async () => {
    const { scenario, answer } = await proposed();
    const { template } = answer.body;
    const cases: [string, Json][] = [
      ["a move-author call that does not exist", proposalLink({ callId: "llm-call:nothing" })],
      ["a call that is not a proposal", proposalLink({ callId: EXECUTOR_CALL_ID })],
      ["another step", proposalLink({ executorCallId: "llm-call:execute-9" })],
    ];
    for (const [label, link] of cases) {
      const refused = await scenario.author(template, link);
      expect(refused.status, label).toBe(409);
      expect(["proposal-not-found", "proposal-mismatch"], label).toContain(
        refused.body.diagnostics[0].code,
      );
    }
    // Nothing was recorded by a refused submission.
    expect((await scenario.get("/authored-moves")).body.moves).toEqual([]);
  });

  it("accepts the link only from a human, and malformed links are invalid", async () => {
    const { scenario, answer } = await proposed();
    const byAgent = await scenario.author(answer.body.template, proposalLink(), AGENT);
    expect(byAgent.status).toBe(422);
    const malformed = await scenario.author(answer.body.template, { callId: AUTHOR_CALL_ID });
    expect(malformed.status).toBe(400);
  });

  it("accepts an edited template with the same link, and keeps a hand-written draft unlinked", async () => {
    const { scenario, answer } = await proposed();
    const edited = { ...answer.body.template, name: "Contrapositive (edited by hand)" };
    const drafted = await scenario.author(edited, proposalLink());
    expect(drafted.status).toBe(201);
    expect(drafted.body.result.provenance).toMatchObject({ contextId: AUTHOR_CALL_ID });
    const plain = await scenario.author({ ...answer.body.template, id: "authored:by-hand" });
    expect(plain.status).toBe(201);
    expect(plain.body.result.provenance).toEqual({
      kind: "curated",
      source: "authored:actor:human-1",
    });
  });

  it("is never approved by the link: review is a separate human decision", async () => {
    const { scenario, answer } = await proposed();
    const drafted = await scenario.author(answer.body.template, proposalLink());
    const byAgent = await scenario.review(drafted.body.result.artifactId, "approved", "", AGENT);
    expect(byAgent.status).toBe(422);
    const rejected = await scenario.review(
      drafted.body.result.artifactId,
      "rejected",
      "Too specific to be reused.",
    );
    expect(rejected.status).toBe(201);
    expect((await scenario.get("/authored-moves")).body.moves[0]).toMatchObject({
      retrievable: false,
      revisions: [{ status: "rejected", provenance: { contextId: AUTHOR_CALL_ID } }],
    });
  });
});

describe("export and import of a reviewed proposal", () => {
  async function approvedAndExported() {
    const { scenario, answer } = await proposed();
    const drafted = await scenario.author(answer.body.template, proposalLink());
    await scenario.review(drafted.body.result.artifactId, "approved", "General.");
    const exported = await fetch(
      `${scenario.origin}/proof-sessions/${SESSION_ID}/export?confirmPrivateExport=true`,
    );
    expect(exported.status).toBe(200);
    return (await exported.json()) as Json;
  }

  it("keeps the move's provenance and both calls, and imports", async () => {
    const artifact = await approvedAndExported();
    expect(artifact.llmCalls.map(({ role }: Json) => role).sort()).toEqual([
      "move-author",
      "move-executor",
    ]);
    const moves = (artifact.library.additionEvents as Json[]).filter(
      ({ artifact: stored }) => stored.kind === "move",
    );
    expect(moves.length).toBe(2);
    for (const { artifact: stored } of moves) {
      expect(stored.provenance).toEqual({
        kind: "generated",
        role: "move-author",
        contextId: AUTHOR_CALL_ID,
        sourceContextId: EXECUTOR_CALL_ID,
      });
    }
    const imported = await importProofArtifact(new MemoryLibraryStore(), artifact as never);
    expect(imported, JSON.stringify(imported)).toMatchObject({ status: "imported" });
  });

  it("rejects an artifact whose move names a proposal call it does not contain", async () => {
    const artifact = await approvedAndExported();
    const forged = structuredClone(artifact);
    forged["llmCalls"] = forged["llmCalls"].filter(({ role }: Json) => role !== "move-author");
    forged["digest"] = artifactDigest(forged as never);
    const rejected = validateProofArtifact(forged);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.diagnostics[0].code).toBe("llm-call-invalid");
  });
});

describe("a proposal of several steps", () => {
  /** "Prove the contrapositive, and assume its antecedent": the construction, then a replayed step. */
  const twoSteps = {
    result: {
      kind: "plan",
      steps: [
        {
          kind: "suffices",
          target: { kind: "goal", id: "goal:main" },
          proposition: ["Implies", ["Not", "q"], ["Not", "p"]],
          obligationId: "contra",
        },
        {
          kind: "introduce-implication",
          target: { kind: "goal", id: "goal:main" },
          hypothesisId: "not-q",
        },
      ],
      explanation: "Reduce to the contrapositive and assume not q.",
    },
  };

  const addAssumeStep = (proposalJson: Json) => {
    proposalJson["name"] = "Contrapositive, then assume the negation";
    proposalJson["steps"].push({
      id: "assume",
      operation: "introduce-implication",
      selections: [
        {
          slot: "target",
          target: "goal",
          statementKind: "conclusion",
          statementLabel: null,
          path: [],
          fragment: contrapositive("A", "B"),
        },
      ],
      parameters: [],
    });
    proposalJson["examples"][1].expected.goals = [["Not", ["And", "p", "r"]]];
  };

  it("proposes, is reviewed, applies as one macro on another goal, and survives export and import", async () => {
    const model = counting(proposalOutput(addAssumeStep));
    const scenario = await startAuthorScenario(services, {
      author: model.transport,
      executor: counting(twoSteps).transport,
    });
    expect((await scenario.describe(true)).status).toBe(201);
    const answer = await scenario.propose();
    expect(answer.body.validation, JSON.stringify(answer.body)).toMatchObject({
      ok: true,
      report: { stepCount: 2, retrievable: true },
    });
    const drafted = await scenario.author(answer.body.template, proposalLink());
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    const approved = await scenario.review(drafted.body.result.artifactId, "approved", "General.");
    expect(approved.body.result.retrievable).toBe(true);

    const observed = (await scenario.get("/observe?view=full")).body;
    const displayed = await scenario.command(
      AGENT,
      {
        kind: "request-suggestions",
        selections: [
          { target: { kind: "goal", id: "goal:other" }, statement: "conclusion", path: [] },
        ],
      },
      { nodeId: observed.cursor.nodeId },
    );
    const set = displayed.body.result.displayed as Json;
    const suggestion = (set.suggestions as Json[]).find(
      ({ artifactId }) => artifactId === answer.body.template.id,
    );
    expect(suggestion).toBeDefined();
    const applied = await scenario.command(
      AGENT,
      { kind: "apply", suggestion: suggestion?.alias },
      { nodeId: observed.cursor.nodeId, suggestionSetId: set.suggestionSetId },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const state = (await scenario.current()).node.state as Json;
    const other = state.goals.find(({ id }: Json) => id === "goal:other");
    expect(other.sequent.conclusion.expression).toEqual(["Not", ["And", "r", "s"]]);
    expect(
      other.sequent.context.hypotheses.map(({ statement }: Json) => statement.expression),
    ).toEqual([["Not", ["Or", "t", "r"]]]);

    const exported = await fetch(
      `${scenario.origin}/proof-sessions/${SESSION_ID}/export?confirmPrivateExport=true`,
    );
    const artifact = (await exported.json()) as Json;
    const imported = await importProofArtifact(new MemoryLibraryStore(), artifact as never);
    expect(imported, JSON.stringify(imported)).toMatchObject({ status: "imported" });
  });
});
