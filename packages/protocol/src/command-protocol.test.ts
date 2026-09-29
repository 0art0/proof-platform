import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  checkRawPayloadSource,
  compactMathText,
  deriveMenuAliases,
  deriveSnapshotAliases,
  deriveSuggestionAliases,
  isAliasReference,
  kernelOperationMathPayloads,
  observeQuerySchema,
  occursInSnapshot,
  protocolCommandEnvelopeSchema,
  readOccurrence,
  resolveHypothesisId,
  resolveMenuItemReference,
  resolveStatementReference,
  resolveTargetReference,
  snapshotDelta,
  summarizeSnapshot,
  type SnapshotView,
} from "./command-protocol";

const conclusion = (expression: unknown) => ({ expression: expression as never });

function target(id: string, goal: unknown, hypotheses: readonly [string, unknown][]) {
  return {
    id,
    sequent: {
      context: {
        hypotheses: hypotheses.map(([hypothesisId, statement]) => ({
          id: hypothesisId,
          statement: conclusion(statement),
        })),
      },
      conclusion: conclusion(goal),
    },
  };
}

const node: SnapshotView = {
  id: "node:a",
  state: {
    id: "state:a",
    goals: [
      target("goal:main", ["Implies", ["And", "P", "Q"], "P"], [["hyp:r", "R"]]),
      target("goal:second", "Q", [
        ["hyp:r", "R"],
        ["hyp:pq", ["And", "P", "Q"]],
      ]),
    ],
    obligations: [target("obligation:one", ["Or", "P", "R"], [["hyp:p", "P"]])],
  },
};

const human = { id: "actor:human", kind: "human" } as never;
const agent = { id: "actor:agent", kind: "agent" } as never;

describe("snapshot aliases", () => {
  it("numbers goals, obligations and hypotheses by first appearance", () => {
    expect(deriveSnapshotAliases(node)).toEqual({
      nodeId: "node:a",
      stateId: "state:a",
      goals: [
        { alias: "g1", id: "goal:main" },
        { alias: "g2", id: "goal:second" },
      ],
      obligations: [{ alias: "o1", id: "obligation:one" }],
      hypotheses: [
        { alias: "h1", id: "hyp:r" },
        { alias: "h2", id: "hyp:pq" },
        { alias: "h3", id: "hyp:p" },
      ],
    });
  });

  it("is a deterministic, injective function of the stored snapshot", () => {
    const identifier = fc.stringMatching(/^[a-z]{1,4}:[a-z0-9]{1,6}$/);
    const snapshot = fc
      .record({
        goals: fc.uniqueArray(identifier, { maxLength: 6 }),
        obligations: fc.uniqueArray(identifier, { maxLength: 4 }),
        hypotheses: fc.array(fc.uniqueArray(identifier, { maxLength: 5 }), {
          minLength: 10,
          maxLength: 10,
        }),
      })
      .filter(
        ({ goals, obligations }) =>
          new Set([...goals, ...obligations]).size === goals.length + obligations.length,
      )
      .map(({ goals, obligations, hypotheses }): SnapshotView => ({
        id: "node:x",
        state: {
          id: "state:x",
          goals: goals.map((id, index) =>
            target(
              id,
              "P",
              (hypotheses[index] ?? []).map((hypothesis) => [hypothesis, "H"] as [string, unknown]),
            ),
          ),
          obligations: obligations.map((id, index) =>
            target(
              id,
              "Q",
              (hypotheses[index + 6] ?? []).map(
                (hypothesis) => [hypothesis, "H"] as [string, unknown],
              ),
            ),
          ),
        },
      }));
    fc.assert(
      fc.property(snapshot, (view) => {
        const table = deriveSnapshotAliases(view);
        // Stable across repeated observation, including a JSON round trip of the stored record.
        expect(deriveSnapshotAliases(JSON.parse(JSON.stringify(view)) as SnapshotView)).toEqual(
          table,
        );
        const aliases = [...table.goals, ...table.obligations, ...table.hypotheses];
        expect(new Set(aliases.map(({ alias }) => alias)).size).toBe(aliases.length);
        expect(new Set(table.hypotheses.map(({ id }) => id)).size).toBe(table.hypotheses.length);
        for (const entry of [...table.goals, ...table.obligations]) {
          expect(resolveTargetReference(view, table, entry.alias)).toMatchObject({
            ok: true,
            value: { id: entry.id },
          });
        }
        for (const entry of table.hypotheses) {
          expect(resolveHypothesisId(table, entry.alias)).toEqual({ ok: true, value: entry.id });
        }
      }),
    );
  });

  it("resolves statements only within their target's context", () => {
    const table = deriveSnapshotAliases(node);
    expect(
      resolveStatementReference(node, table, { kind: "goal", id: "goal:second" }, "h2"),
    ).toEqual({
      ok: true,
      value: { kind: "hypothesis", id: "hyp:pq" },
    });
    expect(
      resolveStatementReference(node, table, { kind: "goal", id: "goal:main" }, "h2"),
    ).toMatchObject({ ok: false, diagnostic: { code: "unknown-reference" } });
  });

  it("rejects unknown and mistyped aliases with diagnostics", () => {
    const table = deriveSnapshotAliases(node);
    expect(resolveTargetReference(node, table, "g9")).toMatchObject({
      ok: false,
      diagnostic: { code: "unknown-alias" },
    });
    expect(resolveTargetReference(node, table, "h1")).toMatchObject({
      ok: false,
      diagnostic: { code: "unknown-alias" },
    });
    expect(resolveTargetReference(node, table, "goal:missing")).toMatchObject({
      ok: false,
      diagnostic: { code: "unknown-reference" },
    });
    expect(resolveTargetReference(node, table, "obligation:one")).toEqual({
      ok: true,
      value: { kind: "obligation", id: "obligation:one" },
    });
    expect(isAliasReference("g1")).toBe(true);
    expect(isAliasReference("goal:1")).toBe(false);
  });

  it("aliases suggestions in display order and menu items per parameter", () => {
    const set = { suggestions: [{ id: "a" }, { id: "b" }, { id: "c" }] } as never;
    expect(deriveSuggestionAliases(set)).toEqual([
      { alias: "s1", id: "a" },
      { alias: "s2", id: "b" },
      { alias: "s3", id: "c" },
    ]);
    expect(deriveSuggestionAliases(set, ["c", "a", "zzz"])).toEqual([
      { alias: "s1", id: "c" },
      { alias: "s2", id: "a" },
    ]);
    const menu = {
      parameterId: "disjunctIndex",
      items: [{ id: "menu-item:0000000000000001" }, { id: "menu-item:0000000000000002" }],
    } as never;
    expect(deriveMenuAliases([menu])[0]?.items.map(({ alias }) => alias)).toEqual(["m1", "m2"]);
    expect(resolveMenuItemReference(menu, "m2")).toEqual({
      ok: true,
      value: "menu-item:0000000000000002",
    });
    expect(resolveMenuItemReference(menu, "m3")).toMatchObject({
      ok: false,
      diagnostic: { code: "unknown-alias" },
    });
  });
});

describe("payload sources", () => {
  it("reads occurrences from a stored snapshot by alias and operand path", () => {
    const table = deriveSnapshotAliases(node);
    expect(readOccurrence(node, table, { target: "g1", path: [0] })).toEqual({
      ok: true,
      value: ["And", "P", "Q"],
    });
    expect(readOccurrence(node, table, { target: "g2", statement: "h2", path: [1] })).toEqual({
      ok: true,
      value: "Q",
    });
    expect(readOccurrence(node, table, { target: "g1", path: [7] })).toMatchObject({ ok: false });
  });

  it("accepts only snapshot occurrences as validated operations and humans as reviewers", () => {
    expect(occursInSnapshot(node, ["And", "P", "Q"])).toBe(true);
    expect(occursInSnapshot(node, ["And", "Q", "P"])).toBe(false);
    const check = (expression: unknown, source: never, actor: never) =>
      checkRawPayloadSource({ expression: expression as never, source, actor, node });
    expect(check("R", "validated-operation" as never, agent)).toMatchObject({ ok: true });
    expect(check("S", "validated-operation" as never, agent)).toMatchObject({
      ok: false,
      diagnostic: { code: "payload-source-rejected" },
    });
    expect(check("S", undefined as never, human)).toMatchObject({
      ok: false,
      diagnostic: { code: "payload-source-required" },
    });
    expect(check("S", "reviewed-authoring" as never, human)).toMatchObject({ ok: true });
    expect(check("S", "reviewed-authoring" as never, agent)).toMatchObject({
      ok: false,
      diagnostic: { code: "payload-source-rejected" },
    });
    for (const source of ["setup", "approved-generator"]) {
      expect(check("P", source as never, human)).toMatchObject({
        ok: false,
        diagnostic: { code: "payload-source-rejected" },
      });
    }
  });

  it("finds every MathJSON field of a kernel operation", () => {
    expect(
      kernelOperationMathPayloads({
        kind: "rewrite-with-equivalence",
        proposition: "P",
        source: { kind: "result", resultId: "r", instantiation: { x: "a" } },
        instantiation: { y: ["f", "b"] },
      }).map(([field]) => field),
    ).toEqual(["proposition", "instantiation.y", "source.instantiation.x"]);
    expect(kernelOperationMathPayloads({ kind: "mark-sorry", assumptionId: "a" })).toEqual([]);
  });
});

describe("envelope, summaries and deltas", () => {
  it("parses a strict envelope and rejects unknown authority", () => {
    const envelope = {
      commandId: "command:1",
      actor: { id: "actor:agent", kind: "agent" },
      basis: { nodeId: "node:a" },
      command: { kind: "sorry", target: "g1" },
    };
    expect(protocolCommandEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(protocolCommandEnvelopeSchema.safeParse({ ...envelope, trusted: true }).success).toBe(
      false,
    );
    expect(
      protocolCommandEnvelopeSchema.safeParse({
        ...envelope,
        command: { kind: "apply", suggestion: "s1", menuChoices: { p: "not-an-item" } },
      }).success,
    ).toBe(false);
  });

  it("summarizes without LaTeX and computes identity deltas", () => {
    const lines = summarizeSnapshot(node);
    expect(lines).toContain("g1 goal goal:main: Implies(And(P, Q), P) [h1]");
    expect(lines.join("\n")).not.toMatch(/\\/);
    expect(compactMathText({ num: "3" })).toBe("3");

    const after: SnapshotView = {
      id: "node:b",
      state: { ...node.state, id: "state:b", goals: [node.state.goals[1]!] },
    };
    const delta = snapshotDelta(node, after);
    expect(delta.goals.removed).toEqual(["goal:main"]);
    expect(delta.goals.added).toEqual([]);
    expect(delta.obligations).toEqual({ added: [], removed: [], updated: [] });
  });

  it("validates observe queries", () => {
    expect(observeQuerySchema.parse({})).toEqual({ view: "full" });
    expect(observeQuerySchema.safeParse({ view: "delta" }).success).toBe(false);
    expect(observeQuerySchema.safeParse({ view: "full", sinceNode: "node:a" }).success).toBe(false);
  });
});
