import { afterEach, describe, expect, it } from "vitest";
import { BENCHMARK_CORPUS, corpusRootState } from "@proof/library";
import { createProofNodeSchema, type ProofNode, type ProtocolEnvironment } from "@proof/protocol";
import { definitionHash } from "../approved-catalog";
import { MemoryLibraryStore } from "../memory-library-store";
import { initializeProofSession, proofSessionIdSchema } from "../proof-repository";
import { createProofHttpService, type ProofHttpService } from ".";

/** N35: authoring, review and retrieval of authored moves over HTTP on a corpus session. */

const services: ProofHttpService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

const HUMAN = { id: "actor:human-1", kind: "human" } as const;
const REVIEWER = { id: "actor:human-reviewer", kind: "human" } as const;
const AGENT = { id: "actor:agent-1", kind: "agent" } as const;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const TARGET_SLOT = {
  id: "target",
  role: "target-conclusion",
  semanticRole: "proposition",
  required: true,
};

function stateWith(conclusion: unknown): Record<string, unknown> {
  return {
    id: "state:example",
    goals: [
      {
        id: "goal:main",
        sequent: {
          context: {
            declarations: ["a", "b"].map((symbol) => ({
              id: `declaration:${symbol}`,
              symbol,
              sort: { kind: "proposition" },
              role: "universal-parameter",
            })),
            hypotheses: [],
          },
          conclusion: { expression: conclusion },
        },
      },
    ],
    obligations: [],
  };
}

const selection = {
  kind: "exact",
  anchor: { target: { kind: "goal", id: "goal:main" }, statement: { kind: "conclusion" } },
  path: [],
};

/** A narrowed introduce-implication for implications whose antecedent is a negation. */
function template(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const positive = (name: string, conclusion: unknown, goal: unknown) => ({
    id: `example:${name}`,
    description: name,
    state: stateWith(conclusion),
    selections: { target: selection },
    expected: {
      outcome: "applied",
      transitionClass: "equivalence",
      goals: [goal],
      obligations: [],
    },
  });
  return {
    id,
    name: "Introduce a negated antecedent",
    description: "Assume the negation that an implication goal starts with.",
    selectionContract: { slots: [TARGET_SLOT], allowAdditional: false },
    patterns: [
      { id: "pattern:neg", selectionSlotId: "target", expression: ["Implies", ["Not", "a"], "b"] },
    ],
    contextRequirements: [],
    sideConditions: [],
    parameters: [{ id: "hypothesisId", label: "Antecedent hypothesis ID", source: "generated-id" }],
    requiredArtifacts: [],
    plan: {
      kind: "deterministic-plan",
      steps: [
        {
          id: "step-1",
          moveId: "move:introduce-implication",
          operationKind: "introduce-implication",
        },
      ],
    },
    transitionClass: "equivalence",
    examples: [
      positive("one", ["Implies", ["Not", "a"], "b"], "b"),
      positive("two", ["Implies", ["Not", "a"], ["Not", "b"]], ["Not", "b"]),
      {
        id: "example:negative",
        description: "not an implication",
        state: stateWith("a"),
        selections: { target: selection },
        expected: { outcome: "rejected" },
      },
    ],
    ...overrides,
  };
}

async function start(readOnly = false) {
  const corpus = BENCHMARK_CORPUS.find(({ id }) => id === "corpus:contraposition");
  if (corpus === undefined) throw new Error("Missing corpus problem.");
  const store = new MemoryLibraryStore();
  const operators = corpus.operators as NonNullable<ProtocolEnvironment["operators"]>;
  const rootNode = createProofNodeSchema({ operators }).parse({
    id: "node:contraposition-root",
    state: corpusRootState(corpus, "state:contraposition-root"),
  });
  const sessionId = "session:contraposition";
  await initializeProofSession(store, { sessionId, rootNode, operators });
  if (readOnly) {
    await store.transaction(async (transaction) => {
      await transaction.markSessionReadOnly(proofSessionIdSchema.parse(sessionId) as never);
    });
  }
  const service = createProofHttpService(store, { library: store });
  services.push(service);
  const { origin } = await service.listen();
  const base = `${origin}/proof-sessions/${sessionId}`;
  let counter = 0;
  const command = async (actor: unknown, body: Json, basis?: Json) => {
    counter += 1;
    const response = await fetch(`${base}/protocol-commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `command:auth-${counter}`,
        actor,
        ...(basis === undefined ? {} : { basis }),
        command: body,
      }),
    });
    return { status: response.status, body: (await response.json()) as Json };
  };
  const get = async (path: string) => {
    const response = await fetch(`${base}/${path}`);
    return { status: response.status, body: (await response.json()) as Json };
  };
  const author = (t: unknown, actor: unknown = HUMAN, payloadSource = "reviewed-authoring") =>
    command(actor, { kind: "author-move-draft", template: t, payloadSource });
  const review = (
    draftArtifactId: string,
    decision: string,
    notes = "",
    actor: unknown = REVIEWER,
  ) =>
    command(actor, {
      kind: "review-move-draft",
      draftArtifactId,
      decision,
      notes,
      payloadSource: "reviewed-authoring",
    });
  /** Displayed suggestions for the root goal's conclusion. */
  const suggestions = async () => {
    const observed = (await get("observe?view=full")).body;
    const displayed = await command(
      AGENT,
      {
        kind: "request-suggestions",
        selections: [{ target: observed.targets[0].alias, statement: "conclusion", path: [] }],
      },
      { nodeId: observed.cursor.nodeId },
    );
    expect(displayed.status).toBe(201);
    return { observed, displayed: displayed.body.result.displayed as Json };
  };
  return { store, get, command, author, review, suggestions, base };
}

const authoredSuggestions = (displayed: Json): Json[] =>
  (displayed.suggestions as Json[]).filter(({ artifactId }) =>
    String(artifactId).startsWith("authored:"),
  );

describe("authored moves over HTTP", () => {
  it("keeps a draft out of retrieval, and makes an approved move retrievable and applicable", async () => {
    const client = await start();
    const drafted = await client.author(template("authored:intro-negation"));
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(201);
    expect(drafted.body.result).toMatchObject({
      moveId: "authored:intro-negation",
      revision: 1,
      status: "draft",
      validation: { ok: true, report: { retrievable: true } },
    });
    const draftId = drafted.body.result.artifactId as string;
    expect(drafted.body.result.definitionDigest).toBe(
      definitionHash(template("authored:intro-negation")),
    );

    // A draft is never retrievable.
    expect(authoredSuggestions((await client.suggestions()).displayed)).toEqual([]);
    const listed = (await client.get("authored-moves")).body;
    expect(listed.moves[0]).toMatchObject({
      moveId: "authored:intro-negation",
      retrievable: false,
      revisions: [{ status: "draft", draftArtifactId: draftId }],
    });

    // Agents cannot author or review.
    for (const actor of [AGENT]) {
      const refused = await client.author(template("authored:by-agent"), actor);
      expect(refused.status).toBe(422);
      expect(refused.body.diagnostics[0].code).toBe("payload-source-rejected");
      const reviewed = await client.review(draftId, "approved", "", actor);
      expect(reviewed.status).toBe(422);
    }
    const unsourced = await client.command(HUMAN, {
      kind: "author-move-draft",
      template: template("authored:x"),
    });
    expect(unsourced.status).toBe(422);
    expect(unsourced.body.diagnostics[0].code).toBe("payload-source-required");

    const approved = await client.review(draftId, "approved", "Looks right.");
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    expect(approved.body.result).toMatchObject({
      decision: "approved",
      retrievable: true,
      definitionDigest: drafted.body.result.definitionDigest,
      review: {
        decision: "approved",
        reviewerId: REVIEWER.id,
        notes: "Looks right.",
        reviewOf: draftId,
      },
    });
    expect(approved.body.result.review.reviewedAt).toMatch(/^\d{4}-/);

    const { observed, displayed } = await client.suggestions();
    const authored = authoredSuggestions(displayed);
    expect(authored).toHaveLength(1);
    expect(authored[0]).toMatchObject({ source: "move", artifactId: "authored:intro-negation" });

    const applied = await client.command(
      AGENT,
      { kind: "apply", suggestion: authored[0]?.alias },
      { nodeId: observed.cursor.nodeId, suggestionSetId: displayed.suggestionSetId },
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const history = (await client.get("history")).body;
    expect(
      (history.edges as Json[]).some(({ edge }) => edge.moveId === "authored:intro-negation"),
    ).toBe(true);
    const node = history.nodes.find(
      ({ id }: { id: string }) => id === applied.body.cursor.nodeId,
    ) as ProofNode;
    expect(node.state.goals[0]?.sequent.conclusion.expression).toEqual(["Not", "p"]);
    expect(node.state.goals[0]?.sequent.context.hypotheses.at(-1)?.statement.expression).toEqual([
      "Not",
      "q",
    ]);

    const after = (await client.get("authored-moves")).body;
    expect(after.moves[0]).toMatchObject({
      retrievable: true,
      activeArtifactId: approved.body.result.artifactId,
      revisions: [{ status: "approved" }],
    });
    // The library listing shows the reviewed artifact in the move-discovery-draft layer.
    const library = (await client.get("library")).body;
    expect(
      (library.entries as Json[]).filter(({ artifact }) => artifact.kind === "move"),
    ).toHaveLength(2);
  });

  it("records a rejected review and a change request without making the move retrievable", async () => {
    const client = await start();
    const drafted = await client.author(template("authored:rejected"));
    const draftId = drafted.body.result.artifactId as string;
    const noNotes = await client.review(draftId, "rejected", "  ");
    expect(noNotes.status).toBe(400);
    expect(noNotes.body.diagnostics[0].code).toBe("review-notes-required");

    const rejected = await client.review(draftId, "rejected", "Too narrow to be useful.");
    expect(rejected.status).toBe(201);
    expect(rejected.body.result).toMatchObject({
      decision: "rejected",
      retrievable: false,
      review: { decision: "rejected", notes: "Too narrow to be useful.", reviewerId: REVIEWER.id },
    });
    const again = await client.review(draftId, "approved");
    expect(again.status).toBe(409);
    expect(again.body.diagnostics[0].code).toBe("draft-already-reviewed");

    const changes = await client.author(template("authored:changes"));
    const requested = await client.review(
      changes.body.result.artifactId,
      "changes-requested",
      "Add an example.",
    );
    expect(requested.status).toBe(201);

    const listed = (await client.get("authored-moves")).body;
    expect(listed.moves.map((move: Json) => [move.moveId, move.retrievable])).toEqual([
      ["authored:rejected", false],
      ["authored:changes", false],
    ]);
    expect(listed.moves[0].revisions[0]).toMatchObject({
      status: "rejected",
      review: { notes: "Too narrow to be useful." },
    });
    expect(listed.moves[1].revisions[0].status).toBe("changes-requested");
    expect(authoredSuggestions((await client.suggestions()).displayed)).toEqual([]);

    const events = (await client.get("library/events")).body.events as Json[];
    expect(events.filter(({ artifact }) => artifact.kind === "move")).toHaveLength(4);
  });

  it("refuses to approve an invalid draft, recording nothing", async () => {
    const client = await start();
    const bad = template("authored:wrong-outcome");
    (bad.examples as Json[])[0]!.expected.goals = ["a"];
    const drafted = await client.author(bad);
    // A draft may be saved while failing; the advisory report says why.
    expect(drafted.status).toBe(201);
    expect(drafted.body.result.validation).toMatchObject({
      ok: false,
      diagnostics: [{ code: "example-mismatch" }],
    });

    const refused = await client.review(drafted.body.result.artifactId, "approved");
    expect(refused.status).toBe(422);
    expect(refused.body.diagnostics[0].code).toBe("move-validation-failed");
    expect(refused.body.validation[0]).toMatchObject({ code: "example-mismatch" });
    const listed = (await client.get("authored-moves")).body;
    expect(listed.moves[0]).toMatchObject({
      retrievable: false,
      revisions: [{ status: "draft" }],
    });
    expect(authoredSuggestions((await client.suggestions()).displayed)).toEqual([]);

    const malformed = await client.author({ id: "authored:broken" });
    expect(malformed.status).toBe(422);
    expect(malformed.body.diagnostics[0].code).toBe("invalid-template");
    const missing = await client.review("authored:none.draft.x", "approved");
    expect(missing.status).toBe(404);
  });

  it("validates a template without recording it", async () => {
    const client = await start();
    const url = `${client.base}/authored-moves/validate`;
    const post = async (body: unknown) => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Json };
    };
    const good = await post({ template: template("authored:dry-run") });
    expect(good).toMatchObject({ status: 200, body: { ok: true } });
    const bad = template("authored:dry-run", { transitionClass: "weakening" });
    expect(await post({ template: bad })).toMatchObject({
      status: 200,
      body: { ok: false, diagnostics: [{ code: "class-mismatch" }] },
    });
    expect((await post({})).status).toBe(400);
    expect((await client.get("authored-moves")).body.moves).toEqual([]);
  });

  it("does not accept move artifacts through add-library-result", async () => {
    const client = await start();
    const added = await client.command(HUMAN, {
      kind: "add-library-result",
      layer: "move-discovery-draft",
      artifact: { kind: "move", approval: { status: "approved", reviewerId: HUMAN.id } },
      payloadSource: "reviewed-authoring",
    });
    expect(added.status).toBe(400);
  });

  it("replays a retried authoring command", async () => {
    const client = await start();
    const send = () =>
      fetch(`${client.base}/protocol-commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: "command:author-retry",
          actor: HUMAN,
          command: {
            kind: "author-move-draft",
            template: template("authored:retry"),
            payloadSource: "reviewed-authoring",
          },
        }),
      });
    const first = await send();
    expect(first.status).toBe(201);
    const second = await send();
    expect(second.status).toBe(200);
    expect(((await second.json()) as Json).replayed).toBe(true);
    const listed = (await client.get("authored-moves")).body;
    expect(listed.moves[0].revisions).toHaveLength(1);
  });

  it("refuses authoring and review in a read-only session", async () => {
    const client = await start(true);
    const refused = await client.author(template("authored:read-only"));
    expect(refused.status).toBe(409);
    expect(refused.body.diagnostics[0].code).toBe("session-read-only");
  });
});
