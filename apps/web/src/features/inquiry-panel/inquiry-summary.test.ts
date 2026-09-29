import { describe, expect, it } from "vitest";
import type { ProofState } from "@proof/mathjson-model";
import {
  createSummaryExplainer,
  describeInquiry,
  explanationContext,
  foldStatuses,
  summarizeInquiry,
} from "./inquiry-summary";
import {
  MAIN_TARGET,
  METHOD_ENCODED,
  PREMISE_TARGET,
  makeNode,
  makeTask,
  recordSeries,
  withConstructions,
} from "./inquiry-fixtures.testing";

const node = makeNode();
const state = node.state as ProofState;

const question = (id: string, target: { kind: "goal"; id: string } = MAIN_TARGET) => ({
  id,
  kind: "question",
  question: {
    form: "establish",
    proposition: { kind: "target", nodeId: "node:root", target },
  },
});

describe("summarizeInquiry", () => {
  it("has nothing to show without records, and lists only the open construction tasks", () => {
    const empty = summarizeInquiry({ records: [], state });
    expect(empty).toMatchObject({
      activeObjective: undefined,
      currentAttempt: undefined,
      blocker: undefined,
      laterInterpretations: [],
      unresolvedConstructions: [],
    });

    const open = makeTask();
    const resolved = makeTask({
      id: "construction-task:closed",
      status: "abandoned",
      abandonment: { attemptId: "attempt:9" },
    });
    const withTasks = withConstructions(node, [open, resolved]).state as ProofState;
    expect(
      summarizeInquiry({ records: [], state: withTasks }).unresolvedConstructions.map(
        ({ id }) => id,
      ),
    ).toEqual(["construction-task:delta"]);
  });

  it("picks the objective on an open target, then a required one, then the latest", () => {
    const record = recordSeries();
    const records = [
      record(question("question:a")),
      record({
        id: "objective:elective-open",
        kind: "objective",
        questionId: "question:a",
        necessity: "elective",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "objective:required-open",
        kind: "objective",
        questionId: "question:a",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "objective:required-closed-target",
        kind: "objective",
        questionId: "question:a",
        necessity: "required",
        focus: { nodeId: "node:root", target: { kind: "goal", id: "goal:gone" } },
      }),
      record({
        id: "objective:latest-unfocused",
        kind: "objective",
        questionId: "question:a",
        necessity: "elective",
      }),
    ];
    const summary = summarizeInquiry({ records, state });
    expect(summary.activeObjective?.record.id).toBe("objective:required-open");
    expect(summary.activeObjective).toMatchObject({ focusOpen: true, status: "active" });
    expect(summary.activeObjective?.question?.id).toBe("question:a");
  });

  it("folds explicit status changes: only active objectives, and attempts in progress or blocked", () => {
    const record = recordSeries();
    const base = [
      record(question("question:a")),
      record({
        id: "objective:one",
        kind: "objective",
        questionId: "question:a",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "objective:two",
        kind: "objective",
        questionId: "question:a",
        necessity: "elective",
      }),
      record({
        id: "attempt:old",
        kind: "attempt",
        objectiveId: "objective:one",
        method: { kind: "manual" },
      }),
      record({
        id: "attempt:new",
        kind: "attempt",
        objectiveId: "objective:one",
        method: { kind: "manual" },
      }),
    ];
    expect(summarizeInquiry({ records: base, state }).currentAttempt?.record.id).toBe(
      "attempt:new",
    );

    const withChanges = [
      ...base,
      record({
        id: "status:new-blocked",
        kind: "status-change",
        subjectId: "attempt:new",
        status: "abandoned",
      }),
      record({
        id: "status:old-blocked",
        kind: "status-change",
        subjectId: "attempt:old",
        status: "blocked",
      }),
    ];
    const summary = summarizeInquiry({ records: withChanges, state });
    expect(summary.currentAttempt).toMatchObject({ status: "blocked" });
    expect(summary.currentAttempt?.record.id).toBe("attempt:old");

    const abandoned = [
      ...withChanges,
      record({
        id: "status:objective",
        kind: "status-change",
        subjectId: "objective:one",
        status: "abandoned",
      }),
    ];
    const next = summarizeInquiry({ records: abandoned, state });
    expect(next.activeObjective?.record.id).toBe("objective:two");
    expect(next.currentAttempt).toBeUndefined();

    // A later status change reopens what an earlier one closed.
    const reactivated = [
      ...abandoned,
      record({
        id: "status:reactivated",
        kind: "status-change",
        subjectId: "objective:one",
        status: "active",
      }),
    ];
    expect(foldStatuses(reactivated).get("objective:one")).toBe("active");
    expect(summarizeInquiry({ records: reactivated, state }).activeObjective?.record.id).toBe(
      "objective:one",
    );
  });

  it("shows the obstruction the active objective addresses, then the attempt's own, then a requirement", () => {
    const record = recordSeries();
    const tried = [
      record(question("question:main")),
      record({
        id: "objective:main",
        kind: "objective",
        questionId: "question:main",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "attempt:try",
        kind: "attempt",
        objectiveId: "objective:main",
        method: { kind: "library-result", resultId: "result:continuity" },
      }),
      record({
        id: "requirement:premise",
        kind: "requirement",
        subjectId: "attempt:try",
        proposition: { kind: "target", nodeId: "node:root", target: PREMISE_TARGET },
        role: "sufficient",
        support: { kind: "informal", status: "plausible" },
      }),
    ];
    const asRequirement = summarizeInquiry({ records: tried, state });
    expect(asRequirement.blocker).toMatchObject({ kind: "requirement" });
    expect(asRequirement.blocker?.record.id).toBe("requirement:premise");

    const withObstruction = [
      ...tried,
      record({
        id: "observation:unmet",
        kind: "observation",
        diagnostic: { code: "unmet-condition" },
      }),
      record({
        id: "obstruction:unmet",
        kind: "obstruction",
        attemptId: "attempt:try",
        cause: { kind: "observation", observationId: "observation:unmet" },
      }),
    ];
    expect(summarizeInquiry({ records: withObstruction, state }).blocker?.record.id).toBe(
      "obstruction:unmet",
    );

    const addressed = [
      ...withObstruction,
      record({
        id: "obstruction:other",
        kind: "obstruction",
        attemptId: "attempt:elsewhere",
        cause: { kind: "observation", observationId: "observation:unmet" },
      }),
      record({
        id: "relationship:addresses",
        kind: "relationship",
        relation: "addresses",
        from: ["objective:main"],
        to: "obstruction:other",
        reason: METHOD_ENCODED,
      }),
    ];
    expect(summarizeInquiry({ records: addressed, state }).blocker?.record.id).toBe(
      "obstruction:other",
    );

    // A dealt-with obstruction is no longer shown.
    const dismissed = [
      ...addressed,
      record({
        id: "status:other",
        kind: "status-change",
        subjectId: "obstruction:other",
        status: "addressed",
      }),
      record({
        id: "status:unmet",
        kind: "status-change",
        subjectId: "obstruction:unmet",
        status: "dismissed",
      }),
    ];
    expect(summarizeInquiry({ records: dismissed, state }).blocker?.record.id).toBe(
      "requirement:premise",
    );
  });

  it("follows a Try-this-theorem application: the premise objective, its parent attempt and the addressed obstruction", () => {
    const record = recordSeries();
    const records = [
      record(question("question:main")),
      record({
        id: "objective:main",
        kind: "objective",
        questionId: "question:main",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "attempt:try",
        kind: "attempt",
        objectiveId: "objective:main",
        method: { kind: "library-result", resultId: "result:continuity" },
      }),
      record(question("question:premise", PREMISE_TARGET)),
      record({
        id: "objective:premise",
        kind: "objective",
        questionId: "question:premise",
        necessity: "required",
        focus: { nodeId: "node:root", target: PREMISE_TARGET },
        parentAttemptId: "attempt:try",
      }),
      record({
        id: "observation:unmet",
        kind: "observation",
        diagnostic: { code: "unmet-condition", detail: "premise 1" },
      }),
      record({
        id: "obstruction:unmet",
        kind: "obstruction",
        attemptId: "attempt:try",
        cause: { kind: "observation", observationId: "observation:unmet" },
      }),
      record({
        id: "relationship:addresses",
        kind: "relationship",
        relation: "addresses",
        from: ["objective:premise"],
        to: "obstruction:unmet",
        reason: METHOD_ENCODED,
      }),
    ];
    // Both required objectives are on open targets; the later one is the premise.
    const summary = summarizeInquiry({ records, state });
    expect(summary.activeObjective?.record.id).toBe("objective:premise");
    expect(summary.currentAttempt).toBeUndefined();
    expect(summary.proposingAttempt?.record.id).toBe("attempt:try");
    expect(summary.blocker?.record.id).toBe("obstruction:unmet");
  });

  it("never presents a later interpretation as a contemporaneous intention", () => {
    const record = recordSeries();
    const records = [
      record(question("question:main")),
      record({
        id: "objective:main",
        kind: "objective",
        questionId: "question:main",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "attempt:try",
        kind: "attempt",
        objectiveId: "objective:main",
        method: { kind: "manual" },
      }),
      record({
        id: "observation:x",
        kind: "observation",
        diagnostic: { code: "uncertain" },
      }),
      record({
        id: "obstruction:late",
        kind: "obstruction",
        attemptId: "attempt:elsewhere",
        cause: { kind: "observation", observationId: "observation:x" },
      }),
      record({
        id: "relationship:later",
        kind: "relationship",
        relation: "addresses",
        from: ["objective:main"],
        to: "obstruction:late",
        reason: { provenance: "later-interpretation", note: "In hindsight." },
      }),
    ];
    const summary = summarizeInquiry({ records, state });
    // The later reading does not make the obstruction the one the objective addresses.
    expect(summary.blocker).toBeUndefined();
    expect(summary.laterInterpretations.map(({ id }) => id)).toEqual(["relationship:later"]);

    const explainer = createSummaryExplainer([]);
    const context = explanationContext({
      records,
      nodes: new Map([[node.id, state]]),
    });
    const description = describeInquiry(summary, explainer, context);
    expect(description.blocker).toBeUndefined();
    expect(description.later).toHaveLength(1);
    expect(description.later[0]?.text).toMatch(/later interpretation/i);
    expect(description.objective?.text.length).toBeGreaterThan(0);
    expect(description.attempt?.text).toMatch(/manual|method/i);
  });
});

describe("describeInquiry", () => {
  it("phrases records with the deterministic templates and names the sufficiency claim", () => {
    const record = recordSeries();
    const records = [
      record(question("question:main")),
      record({
        id: "objective:main",
        kind: "objective",
        questionId: "question:main",
        necessity: "required",
        focus: { nodeId: "node:root", target: MAIN_TARGET },
      }),
      record({
        id: "attempt:try",
        kind: "attempt",
        objectiveId: "objective:main",
        method: { kind: "library-result", resultId: "result:continuity" },
      }),
      record({
        id: "requirement:premise",
        kind: "requirement",
        subjectId: "attempt:try",
        proposition: { kind: "target", nodeId: "node:root", target: PREMISE_TARGET },
        role: "sufficient",
        support: { kind: "informal", status: "conjectured" },
      }),
    ];
    const summary = summarizeInquiry({ records, state });
    const context = explanationContext({
      records,
      nodes: new Map([[node.id, state]]),
      suggestions: {
        setId: "suggestion-set:1",
        items: [
          {
            id: "suggestion:1",
            name: "Continuity of sums",
            source: "result",
            artifactId: "result:continuity",
          },
        ],
      },
    });
    const description = describeInquiry(summary, createSummaryExplainer([]), context);
    expect(description.objective).toMatchObject({ necessity: "required", status: "active" });
    expect(description.attempt?.text).toContain("Continuity of sums");
    expect(description.attempt?.proposedBy).toBe(false);
    expect(description.sufficiency).toMatch(/suffice/);
    expect(description.blocker).toMatchObject({ kind: "requirement" });
  });
});
