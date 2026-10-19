import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { composeTransitionClasses } from "@proof/kernel";
import { executorPlanOperations, type ExecutorPlanStep } from "@proof/llm";
import type { PlainMathJson } from "@proof/mathjson-model";
import { createProofNodeSchema, type ProofNode } from "@proof/protocol";
import { approvedResultEnvironment } from "./approved-catalog";
import { MemoryProofStore } from "./memory-proof-store";
import { runExecutorPlan } from "./move-executor";
import {
  executeProposalPlan,
  initializeProofSession,
  loadCurrentProofSession,
  loadProofHistory,
} from "./proof-repository";

/**
 * Architecture §5: the apply commits exactly what the preview showed. For random propositional
 * goals and random plans (valid, weakening, or rejected part-way), the kernel preview and the
 * committed sequence of ordinary commands agree on the final state, every step's class, and the
 * step at which a plan fails; a rejected plan commits nothing; a retry replays.
 */

const actor = { id: "actor:web", kind: "human" } as const;
const callId = "llm-call:property";
const approvedResults = approvedResultEnvironment([]);
const environment = {
  operators: [],
  ...(approvedResults === undefined ? {} : { results: approvedResults }),
};

const atom = fc.constantFrom("p", "q", "r");
type Formula = string | Formula[];
const { formula } = fc.letrec<{ formula: Formula }>((tie) => ({
  formula: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    atom,
    fc.tuple(tie("formula"), tie("formula")).map(([left, right]) => ["Implies", left, right]),
    fc.array(tie("formula"), { minLength: 2, maxLength: 3 }).map((xs) => ["And", ...xs]),
    fc.array(tie("formula"), { minLength: 2, maxLength: 3 }).map((xs) => ["Or", ...xs]),
    tie("formula").map((operand) => ["Not", operand]),
  ),
}));

function rootNode(conclusion: Formula, hypotheses: readonly Formula[]): ProofNode {
  return createProofNodeSchema().parse({
    id: "node:property-root",
    state: {
      id: "state:property-root",
      goals: [
        {
          id: "goal:main",
          sequent: {
            context: {
              declarations: ["p", "q", "r"].map((symbol) => ({
                id: `declaration:${symbol}`,
                symbol,
                sort: { kind: "proposition" },
                role: "universal-parameter",
              })),
              hypotheses: hypotheses.map((expression, index) => ({
                id: `hypothesis:${index}`,
                statement: { expression },
              })),
            },
            conclusion: { expression: conclusion },
          },
        },
      ],
      obligations: [],
    },
  });
}

/** An ID as the model would write it: labels it introduced lose the call's namespace. */
const label = (id: string) => (id.startsWith(`${callId}:`) ? id.slice(callId.length + 1) : id);

function operands(expression: PlainMathJson, head: string): readonly PlainMathJson[] | undefined {
  return Array.isArray(expression) && expression[0] === head
    ? (expression.slice(1) as PlainMathJson[])
    : undefined;
}

/** Every operation the model might try on the current state, including some that must fail. */
function candidates(state: ProofNode["state"], position: number): ExecutorPlanStep[] {
  const fresh = (name: string, count = 1) =>
    Array.from({ length: count }, (_unused, index) => `s${position}-${name}${index}`);
  const found: ExecutorPlanStep[] = [];
  for (const [kind, entries] of [
    ["goal", state.goals],
    ["obligation", state.obligations],
  ] as const) {
    for (const entry of entries) {
      const target = { kind, id: label(entry.id) };
      const conclusion = entry.sequent.conclusion.expression;
      const implies = operands(conclusion, "Implies");
      const ands = operands(conclusion, "And");
      const ors = operands(conclusion, "Or");
      if (implies?.length === 2) {
        found.push({ kind: "introduce-implication", target, hypothesisId: fresh("h")[0] });
      }
      if (operands(conclusion, "Not")?.length === 1) {
        found.push({ kind: "introduce-negation", target, hypothesisId: fresh("h")[0] });
      }
      if (ands !== undefined) {
        found.push({ kind: "split-goal-conjunction", target, childIds: fresh("c", ands.length) });
      }
      if (ors !== undefined) found.push({ kind: "choose-goal-disjunct", target, disjunctIndex: 0 });
      found.push(
        { kind: "assume-hypothesis", target, hypothesisId: fresh("a")[0], proposition: "p" },
        { kind: "replace-goal", target, proposition: "q" },
        {
          kind: "split-classical-cases",
          target,
          proposition: "r",
          childIds: fresh("k", 2),
          branchHypothesisIds: fresh("b", 2),
        },
        { kind: "close-by-hypothesis", target, hypothesisId: "hypothesis:missing" },
      );
      for (const hypothesis of entry.sequent.context.hypotheses) {
        const hypothesisId = label(hypothesis.id);
        found.push(
          { kind: "close-by-hypothesis", target, hypothesisId },
          { kind: "drop-hypothesis", target, hypothesisId },
        );
        const parts = operands(hypothesis.statement.expression, "And");
        if (parts !== undefined) {
          found.push({
            kind: "expand-hypothesis-conjunction",
            target,
            hypothesisId,
            expandedHypothesisIds: fresh("e", parts.length),
          });
        }
      }
    }
  }
  return found;
}

/** Follow the choices, extending the plan from the state the kernel reaches; stop at a failure. */
function buildPlan(root: ProofNode, choices: readonly number[]): ExecutorPlanStep[] {
  const steps: ExecutorPlanStep[] = [];
  let state = root.state;
  for (const [position, choice] of choices.entries()) {
    const options = candidates(state, position);
    const step = options[choice % Math.max(options.length, 1)];
    if (step === undefined) break;
    steps.push(step);
    const run = runExecutorPlan(root, steps, callId, environment);
    if (!run.ok) break;
    state = run.afterState;
  }
  return steps;
}

describe("a previewed move-executor plan and its application agree", () => {
  it("commits exactly the previewed state, classes and failing step", async () => {
    let applied = 0;
    let rejected = 0;
    let longest = 0;
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        formula,
        fc.array(formula, { maxLength: 2 }),
        fc.array(fc.nat(60), { minLength: 1, maxLength: 6 }),
        async (conclusion, hypotheses, choices) => {
          run += 1;
          const root = rootNode(conclusion, hypotheses);
          const steps = buildPlan(root, choices);
          const previewed = runExecutorPlan(root, steps, callId, environment);

          const store = new MemoryProofStore();
          const sessionId = `session:property-${run}`;
          await initializeProofSession(store, { sessionId, rootNode: root });
          const input = {
            commandIdPrefix: `command:${callId}`,
            expectedCurrentNodeId: root.id,
            operations: executorPlanOperations(steps, { stateId: root.state.id, callId }),
            proposal: { source: "user-proposal", callId } as const,
          };
          const result = await executeProposalPlan(store, sessionId, input, actor);

          if (previewed.ok) {
            applied += 1;
            longest = Math.max(longest, steps.length);
            if (result.status !== "committed") throw new Error(JSON.stringify(result));
            const loaded = await loadCurrentProofSession(store, sessionId);
            if (loaded.status !== "loaded") throw new Error(JSON.stringify(loaded));
            expect(loaded.node.state).toEqual(previewed.afterState);
            expect(result.results.map(({ receipt }) => receipt.transitionClass)).toEqual(
              previewed.steps.map(({ transitionClass }) => transitionClass),
            );
            expect(
              composeTransitionClasses(
                result.results.map(({ receipt }) => receipt.transitionClass),
              ),
            ).toBe(previewed.transitionClass);
            const history = await loadProofHistory(store, sessionId);
            if (history.status !== "loaded") throw new Error(JSON.stringify(history));
            expect(history.edges.map(({ edge }) => edge.operation)).toEqual(previewed.operations);
            expect(history.edges.map(({ edge }) => edge.proposal?.stepIndex)).toEqual(
              steps.map((_step, index) => index + 1),
            );
            // A retry replays the recorded commands and changes nothing.
            const retry = await executeProposalPlan(store, sessionId, input, actor);
            expect(retry).toMatchObject({ status: "committed", replayed: true });
            const after = await loadCurrentProofSession(store, sessionId);
            expect(after).toMatchObject({ status: "loaded", node: { id: loaded.node.id } });
          } else {
            rejected += 1;
            expect(result).toMatchObject({
              status: "rejected",
              diagnostics: [
                {
                  code: "plan-step-failed",
                  message: expect.stringContaining(
                    `Step ${previewed.stepIndex} of ${steps.length} was rejected`,
                  ),
                },
              ],
            });
            const loaded = await loadCurrentProofSession(store, sessionId);
            expect(loaded).toMatchObject({ status: "loaded", node: { id: root.id } });
            const history = await loadProofHistory(store, sessionId);
            expect(history).toMatchObject({ status: "loaded", edges: [] });
          }
        },
      ),
      { numRuns: 80, seed: 20_261_016 },
    );
    // The generator reaches both outcomes, and plans of several steps.
    expect(applied).toBeGreaterThan(10);
    expect(rejected).toBeGreaterThan(0);
    expect(longest).toBeGreaterThan(2);
  }, 120_000);
});
