import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { ELEMENTARY_CORPUS, EXTENDED_CORPUS, type CorpusProblem } from "@proof/library";
import { resolveProofSelection, resolveProofSelectionQuery } from "@proof/selections";
import type { ProofHttpService } from ".";
import {
  corpusSlug,
  currentNode,
  previewStepChoice,
  requestStepSuggestions,
  runCorpusStep,
  selectionDescriptor,
  startCorpusSession,
} from "./corpus-harness.testing";

/**
 * N37 performance budgets for the interactive path (design plan §21.6), measured on benchmark
 * corpus states: at every scripted step of one problem per domain, before the step is applied.
 *
 * - Selection resolution (`resolveProofSelection` / `resolveProofSelectionQuery`, the
 *   deterministic selection feedback): the plan asks for "immediate"; the budget is 50 ms, half
 *   the usual 100 ms threshold for perceived-instant feedback.
 * - Suggestion retrieval (HTTP `POST suggestion-sets`: load the session, retrieve, record the
 *   displayed set): the plan's "roughly 150 milliseconds".
 * - Preview materialization (HTTP `POST move-previews`, with the scripted menu choices: materialize
 *   the displayed choice, run the kernel, record the preview): "a few hundred milliseconds",
 *   taken as 300 ms.
 *
 * Robustness: the machine is shared with other test workers, so each operation is warmed up
 * twice and then timed over seven runs, and the budget applies to the median. The budgets are the
 * design targets themselves, not inflated; the margin is that measured medians sit well below
 * them (on 2026-09-28, under parallel load: selection ≤ 0.5 ms, suggestions typically 24 ms and
 * at worst 42 ms, previews typically 23 ms and at worst 84 ms; see the logged summary). A budget
 * failure is a real regression.
 */

const SELECTION_BUDGET_MS = 50;
const SUGGESTION_BUDGET_MS = 150;
const PREVIEW_BUDGET_MS = 300;
const WARM_UP_RUNS = 2;
const TIMED_RUNS = 7;

const services: ProofHttpService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

/** The problem with the most steps in each domain of the extension, plus the longest elementary one. */
function representativeProblems(): readonly CorpusProblem[] {
  const byDomain = new Map<string, CorpusProblem>();
  for (const problem of EXTENDED_CORPUS) {
    const current = byDomain.get(problem.domain);
    if (current === undefined || problem.steps.length > current.steps.length) {
      byDomain.set(problem.domain, problem);
    }
  }
  const longestElementary = [...ELEMENTARY_CORPUS].sort(
    (left, right) => right.steps.length - left.steps.length,
  )[0]!;
  return [longestElementary, ...byDomain.values()];
}

async function medianMs(operation: (run: number) => Promise<unknown> | unknown): Promise<number> {
  for (let run = 0; run < WARM_UP_RUNS; run += 1) await operation(run);
  const samples: number[] = [];
  for (let run = WARM_UP_RUNS; run < WARM_UP_RUNS + TIMED_RUNS; run += 1) {
    const started = performance.now();
    await operation(run);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

type Measurement = Readonly<{
  state: string;
  selection: number;
  suggestions: number;
  preview: number;
}>;

const measurements: Measurement[] = [];

describe("interactive-path performance budgets on corpus states (§21.6)", () => {
  it.each(representativeProblems().map((problem) => [problem.id, problem] as const))(
    "keeps selection, suggestions and previews within budget on %s",
    async (_id, problem) => {
      const slug = corpusSlug(problem);
      const session = await startCorpusSession(problem, services);
      for (const [index, step] of problem.steps.entries()) {
        const node = await currentNode(session);
        const operators = problem.operators;
        const descriptors = step.selections.map((selection) =>
          selectionDescriptor(node, selection),
        );
        const selection = await medianMs(() => {
          const resolved =
            descriptors.length === 1
              ? resolveProofSelection(node.state, descriptors[0], { operators })
              : resolveProofSelectionQuery(
                  node.state,
                  {
                    kind: "selection-query",
                    selections: descriptors.map((descriptor, position) => ({
                      id: `selection:perf-${position + 1}`,
                      selection: descriptor,
                    })),
                  },
                  { operators },
                );
          if (!resolved.ok) throw new Error(`${problem.id}: selection failed.`);
        });

        let chosen: Awaited<ReturnType<typeof requestStepSuggestions>> | undefined;
        const suggestions = await medianMs(async (run) => {
          chosen = await requestStepSuggestions(
            session,
            problem,
            step,
            node,
            `suggestion-set:perf-${slug}-${index + 1}-${run}`,
          );
        });

        const choice = (run: number) => ({
          commandId: `command:perf-${slug}-${index + 1}-${run}`,
          suggestionSetId: chosen!.set.id,
          chosenSuggestionId: chosen!.chosen.id,
        });
        // Resolve the scripted menus once; each timed run then previews a fresh command.
        const { menuChoices } = await previewStepChoice(session, problem, step, choice(-1));
        const preview = await medianMs(async (run) => {
          const response = await session.post("move-previews", {
            ...choice(run),
            ...(Object.keys(menuChoices).length === 0 ? {} : { menuChoices }),
          });
          if (response.status !== 201) {
            throw new Error(`${problem.id}: preview returned ${response.status}.`);
          }
          await response.arrayBuffer();
        });

        const state = `${problem.id} step ${index + 1}`;
        measurements.push({ state, selection, suggestions, preview });
        expect(selection, `${state} selection median`).toBeLessThanOrEqual(SELECTION_BUDGET_MS);
        expect(suggestions, `${state} suggestion median`).toBeLessThanOrEqual(SUGGESTION_BUDGET_MS);
        expect(preview, `${state} preview median`).toBeLessThanOrEqual(PREVIEW_BUDGET_MS);

        await runCorpusStep(session, problem, step, index);
      }
    },
    120_000,
  );

  it("summarizes the measured medians", () => {
    expect(measurements.length).toBeGreaterThan(0);
    const worst = (key: "selection" | "suggestions" | "preview") =>
      Math.max(...measurements.map((measurement) => measurement[key])).toFixed(1);
    const typical = (key: "selection" | "suggestions" | "preview") => {
      const values = measurements.map((measurement) => measurement[key]).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)]!.toFixed(1);
    };
    console.info(
      `corpus performance over ${measurements.length} states (median of ${TIMED_RUNS} runs each): ` +
        `selection typical ${typical("selection")} ms, worst ${worst("selection")} ms ` +
        `(budget ${SELECTION_BUDGET_MS}); suggestions typical ${typical("suggestions")} ms, ` +
        `worst ${worst("suggestions")} ms (budget ${SUGGESTION_BUDGET_MS}); previews typical ` +
        `${typical("preview")} ms, worst ${worst("preview")} ms (budget ${PREVIEW_BUDGET_MS}).`,
    );
  });
});
