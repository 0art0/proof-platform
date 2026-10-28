/**
 * The proof planner (`docs/motivated-proof-plans.md`): a stateful proof agent that writes one
 * motivated, structured proof of the problem before any move is made.
 *
 * The format follows Lamport's hierarchical proofs: numbered steps, each an assertion with its own
 * proof, a closed set of step forms with a fixed effect on the current goal, a QED step ending
 * every proof, and explicit citations restricted to the facts in scope. Every step that makes a
 * choice also carries a motivation, kept apart from its justification.
 *
 * Steps arrive as a flat list in reading order with parent labels. This module checks the rules
 * deterministically, numbers the steps (`⟨level⟩index`) and linearizes them into the units the
 * platform walks. The plan is evidence only: nothing here touches proof state.
 *
 * This module is self-contained on purpose: `index.ts` composes these schemas into the role's
 * envelope, output validation and evidence, and nothing here depends on `index.ts`.
 */
import {
  backgroundProfileSchema,
  operatorDeclarationSchema,
  stableIdentifierSchema,
} from "@proof/protocol";
import { z } from "zod";

export const MAX_PROOF_PLAN_STEPS = 64;
export const MAX_PROOF_PLAN_DEPTH = 6;
export const MAX_PROOF_PLAN_LIBRARY_RESULTS = 64;
export const MAX_PROOF_PLAN_HYPOTHESES = 32;

const proseSchema = z.string().min(1).max(2_000);
const latexSchema = z.string().min(1).max(2_000);
const methodSchema = z.string().min(1).max(200);
const labelPattern = /^[A-Za-z][A-Za-z0-9._-]{0,47}$/;
const hypothesisLabelPattern = /^H[1-9][0-9]*$/;
/** A step label the model chooses. Hypothesis labels (`H1`, ...) and `goal` are reserved. */
const stepLabelSchema = z
  .string()
  .regex(labelPattern)
  .refine((label) => label !== "goal" && !hypothesisLabelPattern.test(label), {
    message: "Step labels cannot be `goal` or a hypothesis label.",
  });
/** `goal`, a problem hypothesis label or a step label. */
const referenceSchema = z.string().regex(labelPattern);

/** Lamport's step forms, plus `case` for the children of a `cases` step. */
export const PROOF_PLAN_STEP_FORMS = [
  "suffices",
  "have",
  "cases",
  "case",
  "pick",
  "witness",
  "assume",
  "qed",
] as const;
export const proofPlanStepFormSchema = z.enum(PROOF_PLAN_STEP_FORMS);
export type ProofPlanStepForm = z.infer<typeof proofPlanStepFormSchema>;

/** A semi-formal statement: prose always, LaTeX in the session's notation when it can be written. */
export const proofPlanClaimSchema = z
  .object({ latex: latexSchema.nullable(), prose: proseSchema })
  .strict();
export type ProofPlanClaim = z.infer<typeof proofPlanClaimSchema>;

const variableSchema = z
  .object({ name: z.string().min(1).max(100), sort: z.string().min(1).max(200) })
  .strict();

/** Lamport's `BY`: what the step's leaf proof rests on. */
const justificationSchema = z
  .object({
    facts: z.array(referenceSchema).max(16),
    results: z.array(stableIdentifierSchema).max(8),
    background: z.string().min(1).max(1_000).nullable(),
    method: methodSchema.nullable(),
  })
  .strict();

export const proofPlanStepSchema = z
  .object({
    id: stepLabelSchema,
    parent: stepLabelSchema.nullable(),
    form: proofPlanStepFormSchema,
    claim: proofPlanClaimSchema.nullable(),
    variables: z.array(variableSchema).max(8),
    assumptions: z.array(proofPlanClaimSchema).max(8),
    term: proofPlanClaimSchema.nullable(),
    actsOn: z.array(referenceSchema).max(8),
    by: justificationSchema,
    motivation: proseSchema.nullable(),
  })
  .strict();
export type ProofPlanStep = z.infer<typeof proofPlanStepSchema>;

export const proofPlanProposalSchema = z
  .object({
    kind: z.literal("proof-plan"),
    theorem: proofPlanClaimSchema,
    sketch: z.string().min(1).max(4_000),
    steps: z.array(proofPlanStepSchema).min(1).max(MAX_PROOF_PLAN_STEPS),
  })
  .strict();
export type ProofPlanProposal = z.infer<typeof proofPlanProposalSchema>;

const plannerInsufficientContextSchema = z
  .object({ kind: z.literal("insufficient-context"), missing: z.string().min(1).max(2_000) })
  .strict();
const plannerDeclinedSchema = z
  .object({ kind: z.literal("declined"), reason: z.string().min(1).max(500) })
  .strict();

export const proofPlannerOutputSchema = z.union([
  proofPlanProposalSchema,
  plannerInsufficientContextSchema,
  plannerDeclinedSchema,
]);
export type ProofPlannerOutput = z.infer<typeof proofPlannerOutputSchema>;

/** The wire form uses `kind: "proof"`; every other field is the stored form. */
export const proofPlannerWireResultSchema = z.union([
  proofPlanProposalSchema.extend({ kind: z.literal("proof") }).strict(),
  plannerInsufficientContextSchema,
  plannerDeclinedSchema,
]);
export type ProofPlannerWireResult = z.infer<typeof proofPlannerWireResultSchema>;

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

const plannerHypothesisSchema = z
  .object({
    label: z.string().regex(hypothesisLabelPattern),
    statementId: stableIdentifierSchema,
    latex: latexSchema,
  })
  .strict();

const plannerLibraryResultSchema = z
  .object({
    id: stableIdentifierSchema,
    name: z.string().min(1).max(500),
    description: z.string().min(1).max(20_000),
    statement: latexSchema,
    premises: z.array(latexSchema).max(32),
  })
  .strict();

/**
 * The planner is the one role that sees the original problem (design plan section 15.1). It also
 * sees the background, the session's active constants, its library and the initial goal with its
 * hypotheses, labelled `H1`, `H2`, ... in order.
 */
export const proofPlannerContextSchema = z
  .object({
    problem: z
      .object({ title: z.string().min(1).max(500), statement: z.string().min(1).max(20_000) })
      .strict(),
    background: backgroundProfileSchema,
    constants: z.array(operatorDeclarationSchema).max(128),
    library: z.array(plannerLibraryResultSchema).max(MAX_PROOF_PLAN_LIBRARY_RESULTS),
    initialState: z
      .object({
        nodeId: stableIdentifierSchema,
        goalId: stableIdentifierSchema,
        declarations: z
          .array(z.object({ symbol: z.string().min(1).max(100), sort: z.string().min(1) }).strict())
          .max(256),
        hypotheses: z.array(plannerHypothesisSchema).max(MAX_PROOF_PLAN_HYPOTHESES),
        goal: latexSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((context, refinement) => {
    const labels = context.initialState.hypotheses.map(({ label }) => label);
    if (labels.some((label, index) => label !== `H${index + 1}`)) {
      refinement.addIssue({
        code: "custom",
        path: ["initialState", "hypotheses"],
        message: "Hypotheses are labelled H1, H2, ... in order.",
      });
    }
    const ids = context.library.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      refinement.addIssue({ code: "custom", path: ["library"], message: "Repeated result IDs." });
    }
  });
export type ProofPlannerContext = z.infer<typeof proofPlannerContextSchema>;

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

/** Forms whose claim is required; every other form has none. */
const CLAIM_FORMS: ReadonlySet<ProofPlanStepForm> = new Set([
  "suffices",
  "have",
  "case",
  "pick",
  "witness",
  "assume",
]);
const ASSUMPTION_FORMS: ReadonlySet<ProofPlanStepForm> = new Set(["suffices", "assume"]);
const VARIABLE_FORMS: ReadonlySet<ProofPlanStepForm> = new Set(["suffices", "pick", "assume"]);
/** Forms that may have a sub-proof of ordinary steps (a `cases` step has `case` children). */
const SUB_PROOF_FORMS: ReadonlySet<ProofPlanStepForm> = new Set(["have", "assume", "case", "qed"]);

export type ProofPlanTreeNode = Readonly<{
  step: ProofPlanStep;
  /** Lamport's number, `⟨level⟩index`. */
  number: string;
  level: number;
  children: readonly ProofPlanTreeNode[];
}>;

type MutableNode = { step: ProofPlanStep; number: string; level: number; children: MutableNode[] };

/** Rebuild the tree from the flat list, or say why it is not one. */
function buildTree(
  steps: readonly ProofPlanStep[],
): Readonly<{ ok: true; roots: MutableNode[] }> | Readonly<{ ok: false; message: string }> {
  const roots: MutableNode[] = [];
  const seen = new Set<string>();
  // The ancestors of the step being read: a pre-order list puts every subtree in one run.
  const stack: MutableNode[] = [];
  for (const step of steps) {
    if (seen.has(step.id)) return { ok: false, message: `Step ${step.id} is defined twice.` };
    seen.add(step.id);
    if (step.parent !== null && !seen.has(step.parent)) {
      return {
        ok: false,
        message: `Step ${step.id} names parent ${step.parent}, which does not precede it.`,
      };
    }
    while (stack.length > 0 && stack.at(-1)!.step.id !== step.parent) stack.pop();
    if (step.parent !== null && stack.length === 0) {
      return {
        ok: false,
        message: `Step ${step.id} must follow the other steps of its parent ${step.parent} directly.`,
      };
    }
    const parent = stack.at(-1);
    const siblings = parent === undefined ? roots : parent.children;
    const level = stack.length + 1;
    if (level > MAX_PROOF_PLAN_DEPTH) {
      return {
        ok: false,
        message: `Step ${step.id} is nested deeper than ${MAX_PROOF_PLAN_DEPTH} levels.`,
      };
    }
    const node: MutableNode = {
      step,
      number: `⟨${level}⟩${siblings.length + 1}`,
      level,
      children: [],
    };
    siblings.push(node);
    stack.push(node);
  }
  return { ok: true, roots };
}

function formProblem(step: ProofPlanStep): string | undefined {
  const { id, form } = step;
  if (CLAIM_FORMS.has(form) !== (step.claim !== null)) {
    return CLAIM_FORMS.has(form)
      ? `Step ${id} (${form}) needs a claim.`
      : `Step ${id} (${form}) has no claim of its own; set claim to null.`;
  }
  if (!ASSUMPTION_FORMS.has(form) && step.assumptions.length > 0) {
    return `Step ${id} (${form}) cannot state assumptions.`;
  }
  if (form === "assume" && step.assumptions.length === 0) {
    return `Step ${id} (assume) needs at least one assumption.`;
  }
  if (!VARIABLE_FORMS.has(form) && step.variables.length > 0) {
    return `Step ${id} (${form}) cannot introduce variables.`;
  }
  if (form === "pick" && step.variables.length === 0) {
    return `Step ${id} (pick) needs the variables it picks.`;
  }
  if ((form === "witness") !== (step.term !== null)) {
    return form === "witness"
      ? `Step ${id} (witness) needs its witness term.`
      : `Step ${id} (${form}) has no witness term; set term to null.`;
  }
  if (form !== "qed" && form !== "case" && step.motivation === null) {
    return `Step ${id} (${form}) needs a motivation.`;
  }
  return undefined;
}

/** The QED rule and the placement rules of `docs/motivated-proof-plans.md` section 2.3. */
function listProblem(owner: string, list: readonly MutableNode[]): string | undefined {
  const last = list.at(-1);
  if (last === undefined || last.step.form !== "qed") {
    return `The proof of ${owner} must end with a qed step.`;
  }
  for (const [index, node] of list.entries()) {
    const { step } = node;
    if (step.form === "qed" && index !== list.length - 1) {
      return `Step ${step.id} is a qed step but is not the last step of ${owner}.`;
    }
    if (step.form === "case") return `Step ${step.id} is a case outside a cases step.`;
    if (step.form === "cases" && index < list.length - 2) {
      return `Step ${step.id} splits into cases, so only the qed step of ${owner} may follow it.`;
    }
  }
  return undefined;
}

function childrenProblem(node: MutableNode): string | undefined {
  const { step, children } = node;
  if (step.form === "cases") {
    if (children.length < 2) return `Step ${step.id} (cases) needs at least two case steps.`;
    const other = children.find(({ step: child }) => child.form !== "case");
    return other === undefined
      ? undefined
      : `Step ${other.step.id} is under cases step ${step.id} but is not a case.`;
  }
  if (step.form === "case" && children.length === 0) {
    return `Case ${step.id} needs a proof.`;
  }
  if (children.length === 0) return undefined;
  if (!SUB_PROOF_FORMS.has(step.form)) {
    return `Step ${step.id} (${step.form}) has a leaf proof only; its sub-steps belong after it.`;
  }
  return listProblem(`step ${step.id}`, children);
}

/** The labels a step may cite: Lamport's lexical scope (section 2.1, item 5). */
function scopeOf(
  path: readonly MutableNode[],
  siblingLists: readonly (readonly MutableNode[])[],
): Set<string> {
  const scope = new Set<string>();
  path.forEach((node, depth) => {
    const list = siblingLists[depth]!;
    for (const sibling of list) {
      if (sibling === node) break;
      // Another case is a different branch, not a fact.
      if (sibling.step.form !== "case") scope.add(sibling.step.id);
    }
    // The assumptions of an enclosing case or local lemma hold inside its proof.
    if (depth < path.length - 1 && (node.step.form === "case" || node.step.form === "assume")) {
      scope.add(node.step.id);
    }
  });
  return scope;
}

function citationProblem(
  roots: readonly MutableNode[],
  hypothesisLabels: ReadonlySet<string>,
  resultIds: ReadonlySet<string>,
): string | undefined {
  const visit = (
    list: readonly MutableNode[],
    path: MutableNode[],
    lists: (readonly MutableNode[])[],
  ): string | undefined => {
    for (const node of list) {
      const nodePath = [...path, node];
      const nodeLists = [...lists, list];
      const scope = scopeOf(nodePath, nodeLists);
      const { step } = node;
      const inScope = (reference: string) =>
        hypothesisLabels.has(reference) || scope.has(reference);
      const fact = step.by.facts.find((reference) => !inScope(reference));
      if (fact !== undefined) {
        return `Step ${step.id} cites ${fact}, which is not a hypothesis or an earlier step in scope.`;
      }
      const target = step.actsOn.find((reference) => reference !== "goal" && !inScope(reference));
      if (target !== undefined) {
        return `Step ${step.id} acts on ${target}, which is not the goal, a hypothesis or an earlier step in scope.`;
      }
      const result = step.by.results.find((id) => !resultIds.has(id));
      if (result !== undefined) {
        return `Step ${step.id} cites ${result}, which is not a library result you were shown.`;
      }
      const nested = visit(node.children, nodePath, nodeLists);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };
  return visit(roots, [], []);
}

export type ProofPlanCheck =
  | Readonly<{ ok: true; roots: readonly ProofPlanTreeNode[] }>
  | Readonly<{ ok: false; message: string }>;

/** Check every structural and scoping rule; the first problem names the step and the field. */
export function checkProofPlan(
  plan: ProofPlanProposal,
  context: ProofPlannerContext,
): ProofPlanCheck {
  const tree = buildTree(plan.steps);
  if (!tree.ok) return tree;
  for (const step of plan.steps) {
    const problem = formProblem(step);
    if (problem !== undefined) return { ok: false, message: problem };
  }
  const listed = listProblem("the theorem", tree.roots);
  if (listed !== undefined) return { ok: false, message: listed };
  const nodes: MutableNode[] = [];
  const collect = (list: readonly MutableNode[]) =>
    list.forEach((node) => {
      nodes.push(node);
      collect(node.children);
    });
  collect(tree.roots);
  for (const node of nodes) {
    const problem = childrenProblem(node);
    if (problem !== undefined) return { ok: false, message: problem };
  }
  const cited = citationProblem(
    tree.roots,
    new Set(context.initialState.hypotheses.map(({ label }) => label)),
    new Set(context.library.map(({ id }) => id)),
  );
  return cited === undefined ? { ok: true, roots: tree.roots } : { ok: false, message: cited };
}

export type ProofPlanNormalization =
  Readonly<{ ok: true; output: ProofPlannerOutput }> | Readonly<{ ok: false; message: string }>;

export function normalizeProofPlannerWireResult(
  wire: ProofPlannerWireResult,
  context: ProofPlannerContext,
): ProofPlanNormalization {
  if (wire.kind !== "proof") return { ok: true, output: wire };
  const plan: ProofPlanProposal = { ...wire, kind: "proof-plan" };
  const checked = checkProofPlan(plan, context);
  return checked.ok ? { ok: true, output: plan } : { ok: false, message: checked.message };
}

// ---------------------------------------------------------------------------------------------
// Walking the plan
// ---------------------------------------------------------------------------------------------

/**
 * Which goal a step list proves. `theorem` is the problem's goal; `case:<label>` the goal of that
 * case. A `suffices` step transforms its focus in place, so later siblings keep the same key; the
 * platform tracks which goal ID the key currently names.
 */
export type ProofPlanFocusKey = "theorem" | `case:${string}`;

export type ProofPlanUnit = Readonly<{
  stepId: string;
  number: string;
  form: ProofPlanStepForm;
  focus: ProofPlanFocusKey;
  /** The claim the step list containing this step proves (the enclosing step's, or the theorem). */
  enclosingClaim: ProofPlanClaim;
  /** Set when the step cannot be realized on the platform; the reason names the missing capability. */
  unsupported?: string | undefined;
}>;

const BACKWARD_FORMS: ReadonlySet<ProofPlanStepForm> = new Set(["suffices", "cases", "witness"]);

function containsBackwardStep(node: ProofPlanTreeNode): ProofPlanTreeNode | undefined {
  for (const child of node.children) {
    if (BACKWARD_FORMS.has(child.step.form)) return child;
    const nested = containsBackwardStep(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * The units of a checked plan in walking order (`docs/motivated-proof-plans.md` section 3.1).
 * `suffices`, `cases`, `pick` and `witness` come before their children; a `have` or `qed` with a
 * sub-proof comes after it; a `case` has no unit of its own. A local `assume` lemma, and a `have`
 * whose sub-proof reasons backward, need a claim move the platform does not have: they and their
 * subtrees are units marked unsupported.
 */
export function proofPlanUnits(
  roots: readonly ProofPlanTreeNode[],
  theorem: ProofPlanClaim,
): readonly ProofPlanUnit[] {
  const units: ProofPlanUnit[] = [];
  const unit = (
    node: ProofPlanTreeNode,
    focus: ProofPlanFocusKey,
    enclosingClaim: ProofPlanClaim,
    unsupported?: string,
  ): ProofPlanUnit => ({
    stepId: node.step.id,
    number: node.number,
    form: node.step.form,
    focus,
    enclosingClaim,
    ...(unsupported === undefined ? {} : { unsupported }),
  });
  const markSubtree = (
    node: ProofPlanTreeNode,
    focus: ProofPlanFocusKey,
    claim: ProofPlanClaim,
    reason: string,
  ) => {
    units.push(unit(node, focus, claim, reason));
    for (const child of node.children) markSubtree(child, focus, node.step.claim ?? claim, reason);
  };
  const walk = (
    list: readonly ProofPlanTreeNode[],
    focus: ProofPlanFocusKey,
    claim: ProofPlanClaim,
  ) => {
    for (const node of list) {
      const { step } = node;
      if (step.form === "assume") {
        markSubtree(
          node,
          focus,
          claim,
          `${node.number} is a local ASSUME/PROVE lemma; carrying it out needs a claim (cut) move, which the platform does not have.`,
        );
        continue;
      }
      if (step.form === "have" && containsBackwardStep(node) !== undefined) {
        markSubtree(
          node,
          focus,
          claim,
          `${node.number} proves an intermediate claim by reasoning backward towards it; that needs a claim (cut) move, which the platform does not have.`,
        );
        continue;
      }
      if (step.form === "cases") {
        units.push(unit(node, focus, claim));
        for (const child of node.children) {
          walk(child.children, `case:${child.step.id}`, claim);
        }
        continue;
      }
      if (step.form === "have" || step.form === "qed") {
        walk(node.children, focus, step.claim ?? claim);
        units.push(unit(node, focus, claim));
        continue;
      }
      units.push(unit(node, focus, claim));
    }
  };
  walk(roots, "theorem", theorem);
  return units;
}

/** The tree and units of a stored plan; a stored plan always passed `checkProofPlan`. */
export function proofPlanWalk(
  plan: ProofPlanProposal,
  context: ProofPlannerContext,
): Readonly<{ roots: readonly ProofPlanTreeNode[]; units: readonly ProofPlanUnit[] }> | undefined {
  const checked = checkProofPlan(plan, context);
  return checked.ok
    ? { roots: checked.roots, units: proofPlanUnits(checked.roots, plan.theorem) }
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// System message
// ---------------------------------------------------------------------------------------------

/** The planner's system message, given the built-in symbols and the LaTeX the parser reads for them. */
export function proofPlannerSystemMessage(
  builtinLatex: readonly (readonly [symbol: string, latex: string])[],
): string {
  return [
    "Write one motivated, structured proof of the supplied problem in the style of Leslie Lamport's hierarchical proofs, or return an insufficient-context request or a refusal.",
    "The proof is a list of steps in reading order. Each step has a short unique label (id) of letters, digits, dots, underscores and hyphens, and the label of its parent step (null at the top level); the steps of a sub-proof follow their parent directly. The platform numbers the steps; never number them yourself.",
    "Each step list proves one goal: the top-level list proves the theorem, the list under a case proves the enclosing goal under the case condition, and the list under any other step proves that step's claim. Every list ends with exactly one qed step, which proves its goal from the steps before it.",
    "Step forms. suffices: SUFFICES [ASSUME NEW variables, assumptions] PROVE claim; the current goal becomes the claim under those variables and assumptions, and later steps of the same list prove it; use it to introduce an implication or universal goal, to reason backward with a result, or to rewrite the goal. have: assert the claim as a new fact for later steps, derived forward. cases: split the current goal into cases; its children are case steps (at least two), each with the case condition as its claim and its own proof; only the qed of the list may follow a cases step. pick: PICK variables such that the claim holds, from an existential hypothesis. witness: WITNESS term for an existential goal; the claim is the goal instantiated with the term. assume: ASSUME assumptions PROVE claim as a local lemma proved by its sub-steps. qed: closes the goal.",
    "suffices, pick and witness have no sub-steps. Give a have or qed sub-steps only when its proof needs more than one inference. Prefer small steps, each a single recognizable inference.",
    "claim, assumptions and term are semi-formal statements: prose, always, and latex when the statement can be written with the listed constants and the built-in symbols. Set latex to null otherwise; never invent notation. claim is null for qed and cases; term is set only for witness; assumptions only for suffices and assume; variables only for suffices, pick and assume.",
    `Write the built-in symbols with exactly this LaTeX: ${builtinLatex.map(([symbol, latex]) => `${symbol} ${latex}`).join("; ")}. Write implication as \\implies, never \\to.`,
    "actsOn names what the step works on: goal (the current goal), a hypothesis label (H1, H2, ... as supplied) or the label of an earlier step whose fact it uses.",
    "by is the step's justification, as in Lamport's BY: facts cites hypothesis labels and earlier steps in scope (earlier steps of the same list and of every enclosing list, and the enclosing case or assume step); results cites supplied library result IDs; background names any fact the step uses that is neither in scope nor in the library, and must be set whenever such a fact is used; method names the inference in a few words. Never write that something is obvious: cite what it follows from.",
    "motivation says, for every step except qed and case, why this step is a natural thing to try at this point, from what is visible in the goal and the facts so far. It is not a justification and is never cited as one.",
    "sketch is a few sentences giving the idea of the whole proof. theorem restates the goal.",
    "Prove exactly the supplied goal from the supplied hypotheses, the library and the stated background. Never use the goal itself as a fact.",
  ].join(" ");
}
