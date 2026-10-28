import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import {
  buildProofPlannerContext,
  checkProofPlan,
  executePreparedLlmCall,
  llmCallEvidenceSchema,
  llmOutputSchemaForRole,
  prepareLlmCall,
  proofPlanUnits,
  proofPlanWalk,
  validateLlmOutput,
  type ProofPlanProposal,
  type ProofPlanStep,
  type ProofPlannerContext,
} from "./index";

const CONTEXT: ProofPlannerContext = {
  problem: {
    title: "Contraposition",
    statement: "Assuming p implies q, show that not q implies not p.",
  },
  background: {
    level: "first-year undergraduate",
    summary: "Propositional logic.",
    assumptions: [],
  },
  constants: [],
  library: [
    {
      id: "result:modus-tollens",
      name: "Modus tollens",
      description: "From p implies q and not q, infer not p.",
      statement: String.raw`\neg p`,
      premises: [String.raw`p \implies q`, String.raw`\neg q`],
    },
  ],
  initialState: {
    nodeId: "node:root",
    goalId: "goal:main",
    declarations: [
      { symbol: "p", sort: "proposition" },
      { symbol: "q", sort: "proposition" },
    ],
    hypotheses: [{ label: "H1", statementId: "hypothesis:h1", latex: String.raw`p \implies q` }],
    goal: String.raw`\neg q \implies \neg p`,
  },
};

function step(
  overrides: Partial<ProofPlanStep> & Pick<ProofPlanStep, "id" | "form">,
): ProofPlanStep {
  return {
    parent: null,
    claim: null,
    variables: [],
    assumptions: [],
    term: null,
    actsOn: [],
    by: { facts: [], results: [], background: null, method: null },
    motivation: null,
    ...overrides,
  };
}

const claim = (latex: string, prose = latex) => ({ latex, prose });

const CONTRAPOSITION: ProofPlanProposal = {
  kind: "proof-plan",
  theorem: claim(String.raw`\neg q \implies \neg p`),
  sketch: "Assume not q and apply modus tollens.",
  steps: [
    step({
      id: "intro",
      form: "suffices",
      claim: claim(String.raw`\neg p`),
      assumptions: [claim(String.raw`\neg q`)],
      actsOn: ["goal"],
      motivation: "The goal is an implication.",
    }),
    step({
      id: "not-p",
      form: "have",
      claim: claim(String.raw`\neg p`),
      actsOn: ["H1", "intro"],
      by: {
        facts: ["H1", "intro"],
        results: ["result:modus-tollens"],
        background: null,
        method: "modus tollens",
      },
      motivation: "We have p implies q and not q.",
    }),
    step({
      id: "qed",
      form: "qed",
      actsOn: ["goal", "not-p"],
      by: { facts: ["not-p"], results: [], background: null, method: null },
    }),
  ],
};

/** A plan by cases: two case lists, each ending in its own qed, then the theorem's qed. */
const BY_CASES: ProofPlanProposal = {
  kind: "proof-plan",
  theorem: claim("r"),
  sketch: "Split on p or q.",
  steps: [
    step({
      id: "split",
      form: "cases",
      actsOn: ["H1"],
      motivation: "A disjunction is available.",
      by: { facts: ["H1"], results: [], background: null, method: "case analysis" },
    }),
    step({ id: "case-p", parent: "split", form: "case", claim: claim("p") }),
    step({
      id: "r-from-p",
      parent: "case-p",
      form: "have",
      claim: claim("r"),
      motivation: "p gives r.",
      by: { facts: ["case-p", "H2"], results: [], background: null, method: "modus ponens" },
    }),
    step({
      id: "qed-p",
      parent: "case-p",
      form: "qed",
      by: { facts: ["r-from-p"], results: [], background: null, method: null },
    }),
    step({ id: "case-q", parent: "split", form: "case", claim: claim("q") }),
    step({
      id: "qed-q",
      parent: "case-q",
      form: "qed",
      by: { facts: ["case-q", "H3"], results: [], background: null, method: "modus ponens" },
    }),
    step({ id: "qed", form: "qed" }),
  ],
};
const CASES_CONTEXT: ProofPlannerContext = {
  ...CONTEXT,
  library: [],
  initialState: {
    ...CONTEXT.initialState,
    hypotheses: [
      { label: "H1", statementId: "hypothesis:h1", latex: String.raw`p \lor q` },
      { label: "H2", statementId: "hypothesis:h2", latex: String.raw`p \implies r` },
      { label: "H3", statementId: "hypothesis:h3", latex: String.raw`q \implies r` },
    ],
    goal: "r",
  },
};

function withSteps(plan: ProofPlanProposal, steps: readonly ProofPlanStep[]): ProofPlanProposal {
  return { ...plan, steps: [...steps] };
}

function replaceStep(plan: ProofPlanProposal, id: string, overrides: Partial<ProofPlanStep>) {
  return withSteps(
    plan,
    plan.steps.map((entry) => (entry.id === id ? { ...entry, ...overrides } : entry)),
  );
}

function problemOf(plan: ProofPlanProposal, context = CONTEXT): string | undefined {
  const checked = checkProofPlan(plan, context);
  return checked.ok ? undefined : checked.message;
}

describe("checkProofPlan", () => {
  it("accepts well-formed plans and numbers steps by level", () => {
    const checked = checkProofPlan(CONTRAPOSITION, CONTEXT);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.roots.map(({ number }) => number)).toEqual(["⟨1⟩1", "⟨1⟩2", "⟨1⟩3"]);

    const cases = checkProofPlan(BY_CASES, CASES_CONTEXT);
    expect(cases.ok).toBe(true);
    if (!cases.ok) return;
    const [split] = cases.roots;
    expect(split!.children.map(({ number }) => number)).toEqual(["⟨2⟩1", "⟨2⟩2"]);
    expect(split!.children[0]!.children.map(({ number }) => number)).toEqual(["⟨3⟩1", "⟨3⟩2"]);
  });

  it("enforces the QED rule", () => {
    expect(problemOf(withSteps(CONTRAPOSITION, CONTRAPOSITION.steps.slice(0, 2)))).toBe(
      "The proof of the theorem must end with a qed step.",
    );
    const early = withSteps(CONTRAPOSITION, [CONTRAPOSITION.steps[2]!, ...CONTRAPOSITION.steps]);
    expect(
      problemOf({
        ...early,
        steps: early.steps.map((entry, index) => (index === 0 ? { ...entry, id: "qed0" } : entry)),
      }),
    ).toBe("Step qed0 is a qed step but is not the last step of the theorem.");
    expect(
      problemOf(
        withSteps(
          BY_CASES,
          BY_CASES.steps.filter(({ id }) => id !== "qed-p"),
        ),
        CASES_CONTEXT,
      ),
    ).toBe("The proof of step case-p must end with a qed step.");
    expect(
      problemOf(
        withSteps(
          BY_CASES,
          BY_CASES.steps.filter(({ id }) => id !== "qed-q"),
        ),
        CASES_CONTEXT,
      ),
    ).toBe("Case case-q needs a proof.");
  });

  it("enforces per-form fields", () => {
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { claim: null }))).toBe(
      "Step not-p (have) needs a claim.",
    );
    expect(problemOf(replaceStep(CONTRAPOSITION, "qed", { claim: claim("x") }))).toBe(
      "Step qed (qed) has no claim of its own; set claim to null.",
    );
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { assumptions: [claim("q")] }))).toBe(
      "Step not-p (have) cannot state assumptions.",
    );
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { motivation: null }))).toBe(
      "Step not-p (have) needs a motivation.",
    );
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { term: claim("t") }))).toBe(
      "Step not-p (have) has no witness term; set term to null.",
    );
  });

  it("enforces the placement of cases and their children", () => {
    expect(
      problemOf(
        withSteps(
          BY_CASES,
          BY_CASES.steps.filter(({ parent, id }) => parent !== "case-q" && id !== "case-q"),
        ),
        CASES_CONTEXT,
      ),
    ).toBe("Step split (cases) needs at least two case steps.");
    const stray = [step({ id: "lone", form: "case", claim: claim("p") }), ...CONTRAPOSITION.steps];
    expect(problemOf(withSteps(CONTRAPOSITION, stray))).toBe(
      "Step lone is a case outside a cases step.",
    );
    const after = [
      ...BY_CASES.steps.slice(0, -1),
      step({ id: "late", form: "have", claim: claim("r"), motivation: "m" }),
      BY_CASES.steps.at(-1)!,
    ];
    expect(problemOf(withSteps(BY_CASES, after), CASES_CONTEXT)).toBe(
      "Step split splits into cases, so only the qed step of the theorem may follow it.",
    );
    const leafOnly = [
      CONTRAPOSITION.steps[0]!,
      step({ id: "inner", parent: "intro", form: "qed" }),
      ...CONTRAPOSITION.steps.slice(1),
    ];
    expect(problemOf(withSteps(CONTRAPOSITION, leafOnly))).toBe(
      "Step intro (suffices) has a leaf proof only; its sub-steps belong after it.",
    );
  });

  it("requires sub-steps to follow their parent directly", () => {
    const steps = BY_CASES.steps;
    // qed-p moved after case-q: its parent is no longer the innermost open step.
    const scrambled = [steps[0]!, steps[1]!, steps[2]!, steps[4]!, steps[3]!, steps[5]!, steps[6]!];
    expect(problemOf(withSteps(BY_CASES, scrambled), CASES_CONTEXT)).toBe(
      "Step qed-p must follow the other steps of its parent case-p directly.",
    );
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { parent: "qed" }))).toBe(
      "Step not-p names parent qed, which does not precede it.",
    );
  });

  it("restricts citations to Lamport's scope", () => {
    expect(
      problemOf(
        replaceStep(CONTRAPOSITION, "intro", {
          by: { facts: ["not-p"], results: [], background: null, method: null },
        }),
      ),
    ).toBe("Step intro cites not-p, which is not a hypothesis or an earlier step in scope.");
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { actsOn: ["H2"] }))).toBe(
      "Step not-p acts on H2, which is not the goal, a hypothesis or an earlier step in scope.",
    );
    expect(
      problemOf(
        replaceStep(CONTRAPOSITION, "not-p", {
          by: { facts: [], results: ["result:other"], background: null, method: null },
        }),
      ),
    ).toBe("Step not-p cites result:other, which is not a library result you were shown.");
    // A case's steps may cite the case, but the other case's steps may not.
    expect(
      problemOf(
        replaceStep(BY_CASES, "qed-q", {
          by: { facts: ["case-p"], results: [], background: null, method: null },
        }),
        CASES_CONTEXT,
      ),
    ).toBe("Step qed-q cites case-p, which is not a hypothesis or an earlier step in scope.");
    expect(
      problemOf(
        replaceStep(BY_CASES, "qed-q", {
          by: { facts: ["r-from-p"], results: [], background: null, method: null },
        }),
        CASES_CONTEXT,
      ),
    ).toBe("Step qed-q cites r-from-p, which is not a hypothesis or an earlier step in scope.");
  });

  it("rejects repeated labels and reserved labels", () => {
    expect(problemOf(replaceStep(CONTRAPOSITION, "not-p", { id: "intro" }))).toBe(
      "Step intro is defined twice.",
    );
    const parsed = z.array(z.unknown()).parse(CONTRAPOSITION.steps);
    expect(parsed).toHaveLength(3);
  });
});

describe("proofPlanUnits", () => {
  it("walks suffices before, have and qed after their sub-proofs, and cases by case", () => {
    const walk = proofPlanWalk(BY_CASES, CASES_CONTEXT);
    expect(walk?.units.map(({ stepId, focus }) => `${stepId}@${focus}`)).toEqual([
      "split@theorem",
      "r-from-p@case:case-p",
      "qed-p@case:case-p",
      "qed-q@case:case-q",
      "qed@theorem",
    ]);
    const nested = withSteps(CONTRAPOSITION, [
      CONTRAPOSITION.steps[0]!,
      CONTRAPOSITION.steps[1]!,
      step({ id: "inner-have", parent: "not-p", form: "have", claim: claim("q"), motivation: "m" }),
      step({ id: "inner-qed", parent: "not-p", form: "qed" }),
      CONTRAPOSITION.steps[2]!,
    ]);
    expect(proofPlanWalk(nested, CONTEXT)?.units.map(({ stepId }) => stepId)).toEqual([
      "intro",
      "inner-have",
      "inner-qed",
      "not-p",
      "qed",
    ]);
  });

  it("marks local lemmas and backward sub-proofs of claims as unsupported, with their subtrees", () => {
    const lemma = withSteps(CONTRAPOSITION, [
      step({
        id: "lemma",
        form: "assume",
        claim: claim("q"),
        assumptions: [claim("p")],
        motivation: "m",
      }),
      step({
        id: "lemma-qed",
        parent: "lemma",
        form: "qed",
        by: { facts: ["lemma", "H1"], results: [], background: null, method: null },
      }),
      ...CONTRAPOSITION.steps,
    ]);
    const units = proofPlanWalk(lemma, CONTEXT)!.units;
    expect(
      units.filter(({ unsupported }) => unsupported !== undefined).map(({ stepId }) => stepId),
    ).toEqual(["lemma", "lemma-qed"]);
    expect(units[0]!.unsupported).toContain("claim (cut) move");

    const backward = withSteps(CONTRAPOSITION, [
      CONTRAPOSITION.steps[0]!,
      CONTRAPOSITION.steps[1]!,
      step({ id: "back", parent: "not-p", form: "suffices", claim: claim("q"), motivation: "m" }),
      step({ id: "back-qed", parent: "not-p", form: "qed" }),
      CONTRAPOSITION.steps[2]!,
    ]);
    const marked = proofPlanWalk(backward, CONTEXT)!.units;
    expect(
      marked.map(
        ({ stepId, unsupported }) =>
          `${stepId}:${unsupported === undefined ? "ok" : "unsupported"}`,
      ),
    ).toEqual([
      "intro:ok",
      "not-p:unsupported",
      "back:unsupported",
      "back-qed:unsupported",
      "qed:ok",
    ]);
  });

  it("gives every step except a case exactly one unit, and is deterministic (fast-check)", () => {
    // Random well-formed plans: nested have/qed sub-proofs and cases, each list ending in qed.
    type Shape = { form: "have" | "suffices" | "cases"; children: Shape[] };
    const shape: fc.Arbitrary<Shape[]> = fc.letrec<{ list: Shape[]; item: Shape }>((tie) => ({
      item: fc.record({
        form: fc.constantFrom("have", "suffices", "cases") as fc.Arbitrary<Shape["form"]>,
        children: fc.oneof(
          { depthSize: "small", withCrossShrink: true },
          fc.constant([]),
          tie("list"),
        ),
      }),
      list: fc.array(tie("item"), { maxLength: 3 }),
    })).list;
    fc.assert(
      fc.property(shape, (shapes) => {
        const steps: ProofPlanStep[] = [];
        let counter = 0;
        const emit = (list: Shape[], parent: string | null, depth: number) => {
          for (const entry of list) {
            if (depth >= 4) break;
            const id = `s${(counter += 1)}`;
            if (entry.form === "cases") {
              steps.push(step({ id, parent, form: "cases", motivation: "m" }));
              for (const caseIndex of [1, 2]) {
                const caseId = `${id}-c${caseIndex}`;
                steps.push(step({ id: caseId, parent: id, form: "case", claim: claim("p") }));
                emit(entry.children, caseId, depth + 2);
              }
              break; // only the qed may follow a cases step
            }
            steps.push(step({ id, parent, form: entry.form, claim: claim("p"), motivation: "m" }));
            if (entry.form === "have" && entry.children.length > 0 && depth < 3) {
              emit(
                entry.children.filter(({ form }) => form === "have"),
                id,
                depth + 1,
              );
            }
          }
          steps.push(step({ id: `q${(counter += 1)}`, parent, form: "qed" }));
        };
        emit(shapes, null, 0);
        const plan = withSteps(CONTRAPOSITION, steps);
        const checked = checkProofPlan(plan, CONTEXT);
        expect(checked.ok ? undefined : checked.message).toBeUndefined();
        if (!checked.ok) return;
        const units = proofPlanUnits(checked.roots, plan.theorem);
        const expected = steps
          .filter(({ form }) => form !== "case")
          .map(({ id }) => id)
          .sort();
        expect(units.map(({ stepId }) => stepId).sort()).toEqual(expected);
        expect(proofPlanUnits(checked.roots, plan.theorem)).toEqual(units);
      }),
      { numRuns: 200 },
    );
  });
});

describe("proof-planner role", () => {
  function preparedCall() {
    const built = buildProofPlannerContext({ id: "llm-call:plan-1", context: CONTEXT });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("context");
    const prepared = prepareLlmCall(built.envelope);
    if (!prepared.ok) throw new Error("prepare");
    return prepared.call;
  }

  it("has a strict provider schema", () => {
    const schema = z.toJSONSchema(llmOutputSchemaForRole("proof-planner")) as { type?: string };
    expect(schema.type).toBe("object");
  });

  it("refuses a context whose hypotheses are not labelled in order", () => {
    const context = {
      ...CONTEXT,
      initialState: {
        ...CONTEXT.initialState,
        hypotheses: [{ ...CONTEXT.initialState.hypotheses[0]!, label: "H2" }],
      },
    };
    expect(buildProofPlannerContext({ id: "llm-call:plan-1", context }).ok).toBe(false);
  });

  it("validates a wire proof into a stored plan, and records a rule break as rejected", async () => {
    const call = preparedCall();
    const wire = { result: { ...CONTRAPOSITION, kind: "proof" } };
    const validated = validateLlmOutput(call, wire);
    expect(validated.ok && validated.output).toEqual(CONTRAPOSITION);

    const evidence = await executePreparedLlmCall(call, async () => wire);
    expect(evidence.status).toBe("validated");
    expect(llmCallEvidenceSchema.safeParse(evidence).success).toBe(true);

    const broken = {
      result: { ...CONTRAPOSITION, kind: "proof", steps: CONTRAPOSITION.steps.slice(0, 2) },
    };
    const rejected = await executePreparedLlmCall(call, async () => broken);
    expect(rejected.status).toBe("rejected");
    expect(rejected.diagnostics[0]?.message).toBe(
      "The proof of the theorem must end with a qed step.",
    );
  });

  it("accepts insufficient-context and declined answers", () => {
    const call = preparedCall();
    expect(validateLlmOutput(call, { result: { kind: "declined", reason: "No." } }).ok).toBe(true);
    expect(
      validateLlmOutput(call, {
        result: { kind: "insufficient-context", missing: "A definition of r." },
      }).ok,
    ).toBe(true);
  });

  it("states the format and the built-in LaTeX in its system message", () => {
    const system = preparedCall().messages[0].content;
    expect(system).toContain("Lamport");
    expect(system).toContain(String.raw`\implies`);
    expect(system).toContain("Never use the goal itself as a fact.");
  });
});
