/**
 * From a move author's proposal to a template of the existing authored-move language (design plan
 * section 13.1, refinement section 7.1). The compilation is deterministic and adds no mathematics:
 * every expression in the template is one the proposal states, and the example situation of the
 * step that motivated the move is the platform's own abstracted before and after.
 *
 * The result is a draft in the template language, not a promise: `validateMoveTemplate` still runs
 * every example through the kernel and compares the class, and a person still reviews it. A
 * template compiled here has no examples when `withExamples` is false, which is enough to check
 * that its structure is well formed. This module imports nothing from `./index`.
 */
import type { KernelEnvironment } from "@proof/kernel";
import { HAND_AUTHORED_MOVES, metavariablesOf, type MenuValue } from "@proof/moves";
import {
  authoredMoveTemplateSchema,
  resolveExampleChoices,
  type AuthoredMoveTemplate,
} from "@proof/moves/authoring";
import {
  createProofNodeSchema,
  problemSetupSort,
  type OperatorDeclaration,
  type PlainMathJson,
  type Sort,
} from "@proof/protocol";
import { SITUATION_TARGET_ID, situationNode, type Situation } from "./move-author-situation";
import type { MoveAuthorExample, MoveAuthorParameter, MoveAuthorProposal } from "./move-author";

export type CompileInput = Readonly<{
  proposal: MoveAuthorProposal;
  context: Readonly<{
    executorCallId: string;
    situation: Situation;
    operators: readonly OperatorDeclaration[];
  }>;
  /** Compile the examples too (the worker does); the structural check does not need them. */
  withExamples: boolean;
  /** The environment the examples' menus are read in; the context's operators by default. */
  environment?: KernelEnvironment;
}>;

const MAX_SLUG_LENGTH = 40;

/** A readable slug of a move name: lowercase words joined by hyphens. */
function slug(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return words.length === 0 ? "move" : words;
}

/** FNV-1a, as eight hex digits; it only has to tell calls apart, not resist anything. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The authored move ID of a proposal: its name, and the executed step it came from. */
export function proposedMoveId(name: string, executorCallId: string): string {
  return `authored:${slug(name)}-${shortHash(executorCallId)}`;
}

function primitiveFor(operationKind: string) {
  return HAND_AUTHORED_MOVES.find(
    ({ implementation }) => implementation.operationKind === operationKind,
  );
}

const hypothesisId = (label: string) =>
  label.startsWith("hypothesis:") ? label : `hypothesis:${label}`;

/**
 * Compile a proposal into template-shaped JSON. It is not validated here (the caller parses it with
 * `authoredMoveTemplateSchema` and runs `validateMoveTemplate`), so a proposal that breaks a rule
 * still compiles and the rule's diagnostic reaches the person who reads it.
 */
export function compileMoveAuthorProposal(input: CompileInput): Record<string, unknown> {
  const { proposal, context } = input;
  const operators = context.operators;
  const sorts = new Map<string, Sort>(
    proposal.metavariables.map(({ name, sort }) => [name, problemSetupSort(sort)]),
  );
  /** The declared metavariables an expression uses, with their sorts. */
  const variablesOf = (expression: PlainMathJson) =>
    metavariablesOf(expression, operators).flatMap((symbol) => {
      const sort = sorts.get(symbol);
      return sort === undefined ? [] : [{ symbol, sort }];
    });

  const first = proposal.steps[0];
  const firstPrimitive = first === undefined ? undefined : primitiveFor(first.operationKind);
  const constructed = (parameter: MoveAuthorParameter) =>
    parameter.kind === "term" || parameter.kind === "proposition";

  const steps = proposal.steps.map((step, index) => {
    const primitive = primitiveFor(step.operationKind);
    const selections = step.selections.map((selection) => {
      const statement =
        selection.statement.kind === "conclusion"
          ? { role: "conclusion" as const }
          : { role: "hypothesis" as const, id: selection.statement.label };
      return {
        slotId: selection.slot,
        target: { kind: "goal" as const, id: selection.target },
        statement,
        occurrence: { kind: "exact" as const, path: selection.path },
        fragment: selection.fragment,
        variables: variablesOf(selection.fragment),
      };
    });
    // The user drives the first step, so only its constructions are part of the template.
    const parameters = step.parameters
      .filter((parameter) => index > 0 || constructed(parameter))
      .map((parameter) => recordedParameter(parameter, variablesOf));
    return {
      id: step.id,
      moveId: primitive?.id ?? `move:${step.operationKind}`,
      operationKind: step.operationKind,
      ...(selections.length === 0 ? {} : { selections }),
      ...(parameters.length === 0 ? {} : { parameters }),
    };
  });

  const constructedIds = new Set(
    (first?.parameters ?? []).filter(constructed).map(({ parameter }) => parameter),
  );
  const perSlot = new Map<string, number>();
  const patterns = proposal.patterns.map((pattern) => {
    const count = (perSlot.get(pattern.slot) ?? 0) + 1;
    perSlot.set(pattern.slot, count);
    return {
      id: count === 1 ? `pattern:${pattern.slot}` : `pattern:${pattern.slot}-${count}`,
      selectionSlotId: pattern.slot,
      expression: pattern.expression,
    };
  });

  const template: Record<string, unknown> = {
    id: proposedMoveId(proposal.name, context.executorCallId),
    name: proposal.name,
    description: proposal.description,
    selectionContract: {
      slots: structuredClone(firstPrimitive?.selectionContract.slots ?? []),
      allowAdditional: false,
    },
    patterns,
    contextRequirements: proposal.contextRequirements,
    sideConditions: proposal.sideConditions,
    parameters: structuredClone(
      (firstPrimitive?.parameters ?? []).filter(({ id }) => !constructedIds.has(id)),
    ),
    requiredArtifacts: proposal.requiredResultIds.map((id) => ({ kind: "result", id })),
    plan: { kind: "deterministic-plan", steps },
    transitionClass: proposal.transitionClass,
    examples: [],
    discoveryContext: proposal.motivation,
  };
  if (!input.withExamples) return template;

  // The examples need the first step's menus (to find the items a choice names), so the template
  // without examples is read first.
  const shell = authoredMoveTemplateSchema.safeParse(template);
  const environment: KernelEnvironment = input.environment ?? { operators };
  const stateSchema = createProofNodeSchema({ operators });
  template["examples"] = proposal.examples.map((example) =>
    compileExample(example, {
      situation: context.situation,
      shell: shell.success ? shell.data : undefined,
      environment,
      parseState: (state) => {
        const node = stateSchema.safeParse({ id: "node:example", state });
        return node.success ? node.data.state : undefined;
      },
    }),
  );
  return template;
}

function recordedParameter(
  parameter: MoveAuthorParameter,
  variablesOf: (expression: PlainMathJson) => readonly { symbol: string; sort: Sort }[],
): Record<string, unknown> {
  switch (parameter.kind) {
    case "index":
      return {
        parameterId: parameter.parameter,
        origin: { kind: "subterm-of", statement: { kind: "conclusion" }, path: [parameter.index] },
        value: { kind: "index", index: parameter.index },
        variables: [],
      };
    case "direction":
      return {
        parameterId: parameter.parameter,
        origin: { kind: "rule" },
        value: { kind: "direction", direction: parameter.direction },
        variables: [],
      };
    case "term":
    case "proposition":
      // A construction: the template's own rule builds the value from the metavariables.
      return {
        parameterId: parameter.parameter,
        origin: { kind: "rule" },
        value: { kind: parameter.kind, expression: parameter.expression },
        variables: variablesOf(parameter.expression),
      };
    case "result":
      return {
        parameterId: parameter.parameter,
        origin: { kind: "result", resultId: parameter.resultId },
        value: { kind: "result", resultId: parameter.resultId },
        variables: [],
      };
    case "source-hypothesis":
      return {
        parameterId: parameter.parameter,
        origin: { kind: "hypothesis", hypothesisId: parameter.hypothesis },
        value: {
          kind: "rewrite-source",
          source: { kind: "hypothesis", hypothesisId: parameter.hypothesis },
        },
        variables: [],
      };
  }
}

type ExampleEnvironment = Readonly<{
  situation: Situation;
  shell: AuthoredMoveTemplate | undefined;
  environment: KernelEnvironment;
  parseState: (state: unknown) => unknown;
}>;

function compileExample(
  example: MoveAuthorExample,
  { situation, shell, environment, parseState }: ExampleEnvironment,
): Record<string, unknown> {
  const stateId = `state:example-${example.id}`;
  let goalId: string = SITUATION_TARGET_ID;
  let state: Record<string, unknown>;
  if (example.source || example.state === undefined) {
    const node = situationNode(situation.before) as { state: Record<string, unknown> };
    state = { ...node.state, id: stateId };
  } else {
    goalId = "goal:main";
    state = {
      id: stateId,
      goals: [
        {
          id: goalId,
          sequent: {
            context: {
              declarations: example.state.declarations.map(({ symbol, sort }) => ({
                id: `declaration:${symbol}`,
                symbol,
                sort: problemSetupSort(sort),
                role: "universal-parameter",
              })),
              hypotheses: example.state.hypotheses.map(({ label, expression }) => ({
                id: hypothesisId(label),
                statement: { expression },
              })),
            },
            conclusion: { expression: example.state.conclusion },
          },
        },
      ],
      obligations: [],
    };
  }
  const selections = Object.fromEntries(
    example.selections.map((selection) => [
      selection.slot,
      {
        kind: "exact",
        anchor: {
          target: { kind: "goal", id: goalId },
          statement:
            selection.statement.kind === "conclusion"
              ? { kind: "conclusion" }
              : { kind: "hypothesis", id: hypothesisId(selection.statement.label) },
        },
        path: selection.path,
      },
    ]),
  );
  const parsed = shell === undefined ? undefined : parseState(state);
  const resolved =
    shell === undefined || parsed === undefined || example.choices.length === 0
      ? undefined
      : resolveExampleChoices({
          template: shell,
          state: parsed as Parameters<typeof resolveExampleChoices>[0]["state"],
          selections: selections as unknown as Parameters<
            typeof resolveExampleChoices
          >[0]["selections"],
          choices: example.choices.map((choice) => ({
            parameterId: choice.parameter,
            value: choiceValue(choice),
          })),
          environment,
        });
  const expected =
    example.outcome === "rejected"
      ? { outcome: "rejected" }
      : example.source || example.expected === undefined
        ? {
            outcome: "applied",
            transitionClass: situation.after.transitionClass,
            goals: situation.after.goals.map(({ conclusion }) => conclusion),
            obligations: situation.after.obligations.map(({ conclusion }) => conclusion),
          }
        : { outcome: "applied", ...example.expected };
  return {
    id: `example:${example.id}`,
    description: example.description,
    state,
    selections,
    ...(resolved === undefined || Object.keys(resolved.menuChoices).length === 0
      ? {}
      : { menuChoices: resolved.menuChoices }),
    expected,
  };
}

function choiceValue(choice: MoveAuthorParameter): MenuValue {
  switch (choice.kind) {
    case "index":
      return { kind: "index", index: choice.index };
    case "direction":
      return { kind: "direction", direction: choice.direction };
    case "term":
      return { kind: "term", expression: choice.expression };
    case "proposition":
      return { kind: "proposition", expression: choice.expression };
    case "result":
      return { kind: "result", resultId: choice.resultId };
    case "source-hypothesis":
      return {
        kind: "rewrite-source",
        source: { kind: "hypothesis", hypothesisId: hypothesisId(choice.hypothesis) as never },
      };
  }
}
