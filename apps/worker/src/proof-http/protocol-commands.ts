/**
 * The command envelope and observations over HTTP (design plan §18, §20.3; roadmap N25).
 *
 * `POST /proof-sessions/:id/protocol-commands` accepts one `protocolCommandEnvelopeSchema`
 * envelope. Aliases resolve against the stored snapshot of `basis.nodeId` (the current node when
 * there is no basis), then the command is dispatched to the same repository function its resource
 * route uses. Staleness is decided by the repository's own expected-cursor checks; when a command
 * fails that way and its basis is not the current node, the answer is `stale-alias`.
 *
 * `GET /proof-sessions/:id/observe?view=full|summary|delta` reads stored records only.
 */
import {
  aliasMenus,
  checkRawPayloadSource,
  compactSuggestions,
  compactTargets,
  createMovePreviewSchema,
  createProofNodeSchema,
  CURSOR_BOUND_COMMAND_KINDS,
  deriveSnapshotAliases,
  deriveSuggestionAliases,
  isAliasReference,
  kernelOperationMathPayloads,
  observeDeltaResponseSchema,
  observeFullResponseSchema,
  observeSummaryResponseSchema,
  previewRegeneratedResponseSchema,
  protocolCommandResponseSchema,
  protocolRequiresInputResponseSchema,
  readOccurrence,
  resolveHypothesisId,
  resolveMenuItemReference,
  resolveStatementReference,
  resolveSuggestionReference,
  resolveTargetReference,
  snapshotDelta,
  summarizeSnapshot,
  type CommandProtocolDiagnostic,
  type DisplayedSuggestionSet,
  type InteractionEvent,
  type MathPayload,
  type ObserveQuery,
  type ParameterMenuRecord,
  type PlainMathJson,
  type ProofNode,
  type ProtocolActor,
  type ProtocolCommand,
  type ProtocolCommandEnvelope,
  type ProtocolCursor,
  type Resolution,
  type SnapshotAliasTable,
  type TargetIdentity,
  type TargetReference,
} from "@proof/protocol";
import type { z } from "zod";
import { extractConditionalLemma, investigateHypothesis } from "../inquiry-methods";
import { listInquiryRecords, recordInquiryCommand } from "../inquiry-repository";
import { addLibraryArtifact } from "../library-repository";
import { reviewConditionalLemma } from "../conditional-lemmas";
import { authorMoveDraft, reviewMoveDraft } from "../move-authoring";
import type { MoveTemplateValidationOptions } from "@proof/moves/authoring";
import {
  backtrackProofSession,
  backtrackWithInformation,
  commitSemanticReplay,
  deletePreviousMove,
  derivedMoveRecordIds,
  executeProofCommand,
  listInteractionEvents,
  loadCurrentProofSession,
  loadProofHistory,
  materializeMoveChoice,
  readDisplayedSuggestionSet,
  recordInteractionEvent,
  type ProofSession,
} from "../proof-repository";
import {
  applyMoveChoice,
  previewMoveChoice,
  recordSuggestions,
  repositoryFailureStatus,
  transitionClassesFor,
  type MoveChoice,
  type ProofHttpSelectionDescriptor,
  type ServiceContext,
} from "./shared";

/** A rendered HTTP answer; bodies are validated before they are returned. */
export type ProtocolHttpOutcome = Readonly<{ status: number; body: unknown }>;

type Failure = Readonly<{ ok: false; outcome: ProtocolHttpOutcome }>;
type Step<Value> = Readonly<{ ok: true; value: Value }> | Failure;

const EVENT_PAGE = 1000;
const INQUIRY_PAGE = 500;

function diagnostics(status: number, code: string, message: string): Failure {
  return { ok: false, outcome: { status, body: { diagnostics: [{ code, message }] } } };
}

function repositoryFailed(
  failure: Readonly<{
    status: "rejected" | "uncertain";
    diagnostics: readonly [{ code: string; message: string }];
    /** Move-template validation diagnostics, for a refused authoring request (N35). */
    validation?: readonly unknown[];
  }>,
): Failure {
  return {
    ok: false,
    outcome: {
      status: repositoryFailureStatus(failure),
      body: {
        diagnostics: failure.diagnostics,
        ...(failure.validation === undefined ? {} : { validation: failure.validation }),
      },
    },
  };
}

function fromResolution<Value>(resolution: Resolution<Value>): Step<Value> {
  return resolution.ok ? resolution : protocolFailure(resolution.diagnostic);
}

function protocolFailure(diagnostic: CommandProtocolDiagnostic): Failure {
  const status =
    diagnostic.code === "stale-alias"
      ? 409
      : diagnostic.code === "basis-required" || diagnostic.code === "invalid-envelope"
        ? 400
        : 422;
  return diagnostics(status, diagnostic.code, diagnostic.message);
}

function validated<Output>(
  status: number,
  schema: z.ZodType<Output>,
  body: unknown,
): ProtocolHttpOutcome {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { status, body: parsed.data }
    : {
        status: 500,
        body: {
          diagnostics: [
            { code: "invalid-response", message: "The response failed runtime validation." },
          ],
        },
      };
}

// ---------------------------------------------------------------------------------------------
// Stored reads
// ---------------------------------------------------------------------------------------------

/** Snapshots by node ID; the full history is read at most once per request. */
class Snapshots {
  private history: Map<string, ProofNode> | undefined;

  constructor(
    private readonly context: ServiceContext,
    private readonly sessionId: string,
    readonly current: ProofNode,
  ) {}

  async node(nodeId: string | undefined): Promise<Step<ProofNode>> {
    if (nodeId === undefined || nodeId === this.current.id)
      return { ok: true, value: this.current };
    if (this.history === undefined) {
      const loaded = await loadProofHistory(this.context.store, this.sessionId);
      if (loaded.status !== "loaded") return repositoryFailed(loaded);
      this.history = new Map(loaded.nodes.map((node) => [node.id as string, node]));
    }
    const node = this.history.get(nodeId);
    return node === undefined
      ? diagnostics(404, "unknown-reference", `The node ${nodeId} is not in the discovery tree.`)
      : { ok: true, value: node };
  }
}

async function allInteractionEvents(
  context: ServiceContext,
  sessionId: string,
  query: Readonly<{ nodeId?: string; afterSequence?: number }> = {},
): Promise<Step<readonly InteractionEvent[]>> {
  const events: InteractionEvent[] = [];
  let after = query.afterSequence ?? 0;
  for (;;) {
    const listed = await listInteractionEvents(context.store, sessionId, {
      ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId }),
      afterSequence: after,
      limit: EVENT_PAGE,
    });
    if (listed.status !== "loaded") return repositoryFailed(listed);
    events.push(...listed.events);
    const last = listed.events.at(-1);
    if (listed.events.length < EVENT_PAGE || last === undefined) return { ok: true, value: events };
    after = last.sequence;
  }
}

async function allInquiryRecords(
  context: ServiceContext,
  sessionId: string,
  afterSequence: number,
): Promise<
  Step<
    readonly Readonly<{
      sequence: number;
      id: string;
      kind: string;
      nodeId: string;
      actor: ProtocolActor;
    }>[]
  >
> {
  const records: {
    sequence: number;
    id: string;
    kind: string;
    nodeId: string;
    actor: ProtocolActor;
  }[] = [];
  let after = afterSequence;
  for (;;) {
    const listed = await listInquiryRecords(context.store, sessionId, {
      afterSequence: after,
      limit: INQUIRY_PAGE,
    });
    if (listed.status !== "loaded") return repositoryFailed(listed);
    records.push(
      ...listed.records.map(({ sequence, id, kind, nodeId, actor }) => ({
        sequence,
        id,
        kind,
        nodeId,
        actor,
      })),
    );
    const last = listed.records.at(-1);
    if (listed.records.length < INQUIRY_PAGE || last === undefined) {
      return { ok: true, value: records };
    }
    after = last.sequence;
  }
}

async function cursorFor(
  context: ServiceContext,
  sessionId: string,
  node: ProofNode,
): Promise<Step<ProtocolCursor>> {
  const events = await allInteractionEvents(context, sessionId);
  if (!events.ok) return events;
  const records = await allInquiryRecords(context, sessionId, 0);
  if (!records.ok) return records;
  return {
    ok: true,
    value: {
      nodeId: node.id,
      stateId: node.state.id,
      eventSequence: events.value.at(-1)?.sequence ?? 0,
      inquirySequence: records.value.at(-1)?.sequence ?? 0,
    },
  };
}

type Displayed = Readonly<{
  suggestionSet: DisplayedSuggestionSet;
  displayedIds?: readonly string[];
  eventSequence?: number;
}>;

/**
 * A displayed suggestion set: the one named, else the latest `suggestions-displayed` set at the
 * node. The display order comes from the latest event that displayed the set.
 */
async function displayedSet(
  context: ServiceContext,
  sessionId: string,
  nodeId: string,
  suggestionSetId: string | undefined,
): Promise<Step<Displayed | undefined>> {
  const events = await allInteractionEvents(context, sessionId, { nodeId });
  if (!events.ok) return events;
  const displayedEvents = events.value.filter(
    (event): event is Extract<InteractionEvent, { kind: "suggestions-displayed" }> =>
      event.kind === "suggestions-displayed" &&
      (suggestionSetId === undefined || event.suggestionSetId === suggestionSetId),
  );
  const event = displayedEvents.at(-1);
  const id = suggestionSetId ?? event?.suggestionSetId;
  if (id === undefined) return { ok: true, value: undefined };
  const loaded = await readDisplayedSuggestionSet(context.store, sessionId, id);
  if (loaded.status !== "loaded") return repositoryFailed(loaded);
  return {
    ok: true,
    value: {
      suggestionSet: loaded.suggestionSet,
      ...(event === undefined
        ? {}
        : { displayedIds: event.suggestionIds, eventSequence: event.sequence }),
    },
  };
}

function compactDisplayed(context: ServiceContext, displayed: Displayed) {
  const classes = new Map(
    transitionClassesFor(context.definitions, displayed.suggestionSet).map(
      ({ suggestionId, transitionClass }) => [suggestionId as string, transitionClass],
    ),
  );
  return compactSuggestions(displayed.suggestionSet, {
    ...(displayed.displayedIds === undefined ? {} : { displayedIds: displayed.displayedIds }),
    ...(displayed.eventSequence === undefined ? {} : { eventSequence: displayed.eventSequence }),
    transitionClasses: classes,
  });
}

// ---------------------------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------------------------

type Scope = Readonly<{ node: ProofNode; table: SnapshotAliasTable }>;

function scopeOf(node: ProofNode): Scope {
  return { node, table: deriveSnapshotAliases(node) };
}

function target(scope: Scope, reference: TargetReference): Step<TargetIdentity> {
  return fromResolution(resolveTargetReference(scope.node, scope.table, reference));
}

async function mathPayload(
  snapshots: Snapshots,
  payload: MathPayload,
  actor: ProtocolActor,
  defaultNode: ProofNode,
): Promise<Step<PlainMathJson>> {
  if ("occurrence" in payload) {
    const { nodeId, ...occurrence } = payload.occurrence;
    const node =
      nodeId === undefined
        ? { ok: true as const, value: defaultNode }
        : await snapshots.node(nodeId);
    if (!node.ok) return node;
    return fromResolution(
      readOccurrence(node.value, deriveSnapshotAliases(node.value), occurrence),
    );
  }
  return fromResolution(
    checkRawPayloadSource({
      expression: payload.expression,
      source: payload.source,
      actor,
      node: defaultNode,
    }),
  );
}

const HYPOTHESIS_FIELDS = [
  "hypothesisId",
  "negationHypothesisId",
  "equalityHypothesisId",
  "implicationHypothesisId",
  "antecedentHypothesisId",
] as const;

/** Resolve aliases in a kernel operation and fill its snapshot IDs. */
function resolveOperation(
  scope: Scope,
  operation: Readonly<Record<string, unknown>>,
  commandId: string,
): Step<Record<string, unknown>> {
  const resolvedOperation: Record<string, unknown> = {
    ...operation,
    expectedStateId: operation.expectedStateId ?? scope.node.state.id,
    resultStateId:
      operation.resultStateId ?? derivedMoveRecordIds(commandId as never).resultStateId,
  };
  let resolvedTarget: TargetIdentity | undefined;
  if (typeof operation.target === "string" || isTargetObject(operation.target)) {
    const found = target(scope, operation.target as TargetReference);
    if (!found.ok) return found;
    resolvedTarget = found.value;
    resolvedOperation.target = found.value;
  }
  for (const field of HYPOTHESIS_FIELDS) {
    const value = operation[field];
    if (typeof value === "string" && isAliasReference(value)) {
      const id = fromResolution(resolveHypothesisId(scope.table, value));
      if (!id.ok) return id;
      resolvedOperation[field] = id.value;
    }
  }
  if (Array.isArray(operation.premiseHypothesisIds)) {
    const ids: unknown[] = [];
    for (const value of operation.premiseHypothesisIds as unknown[]) {
      if (typeof value === "string" && isAliasReference(value)) {
        const id = fromResolution(resolveHypothesisId(scope.table, value));
        if (!id.ok) return id;
        ids.push(id.value);
      } else ids.push(value);
    }
    resolvedOperation.premiseHypothesisIds = ids;
  }
  if (typeof operation.statement === "string") {
    if (resolvedTarget === undefined) {
      return diagnostics(422, "unknown-reference", "A statement reference needs a target.");
    }
    const statement = fromResolution(
      resolveStatementReference(scope.node, scope.table, resolvedTarget, operation.statement),
    );
    if (!statement.ok) return statement;
    resolvedOperation.statement = statement.value;
  }
  return { ok: true, value: resolvedOperation };
}

function isTargetObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "id" in value &&
    Object.keys(value).length === 2
  );
}

async function resolveMenuChoices(
  context: ServiceContext,
  sessionId: string,
  choice: Omit<MoveChoice, "menuChoices">,
  references: Readonly<Record<string, string>>,
): Promise<Step<Record<string, string>>> {
  const choices: Record<string, string> = {};
  const pending = new Map<string, string>();
  for (const [parameterId, reference] of Object.entries(references)) {
    if (isAliasReference(reference)) pending.set(parameterId, reference);
    else choices[parameterId] = reference;
  }
  for (let round = 0; pending.size > 0 && round < 16; round += 1) {
    const materialized = await materializeMoveChoice(
      context.store,
      sessionId,
      { ...choice, ...(Object.keys(choices).length === 0 ? {} : { menuChoices: choices }) },
      context.definitions,
    );
    let menus: readonly ParameterMenuRecord[];
    if (materialized.status === "requires-input") menus = materialized.menus;
    else if (materialized.status === "materialized") {
      menus = materialized.request.menuSelection?.menus ?? [];
    } else return repositoryFailed(materialized);
    let progressed = false;
    for (const [parameterId, alias] of [...pending]) {
      const menu = menus.find((candidate) => candidate.parameterId === parameterId);
      if (menu === undefined) continue;
      const item = fromResolution(resolveMenuItemReference(menu, alias));
      if (!item.ok) return item;
      choices[parameterId] = item.value;
      pending.delete(parameterId);
      progressed = true;
    }
    if (!progressed) break;
  }
  const [parameterId] = [...pending.keys()];
  return parameterId === undefined
    ? { ok: true, value: choices }
    : diagnostics(
        422,
        "unknown-alias",
        `No menu for the parameter ${parameterId} is displayed for this choice.`,
      );
}

// ---------------------------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------------------------

type Dispatched = Readonly<{ replayed: boolean; result: Record<string, unknown> }>;

/** Execute one envelope command. */
export async function handleProtocolCommand(
  context: ServiceContext,
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
): Promise<ProtocolHttpOutcome> {
  const before = await loadCurrentProofSession(context.store, sessionId);
  if (before.status !== "loaded") return repositoryFailed(before).outcome;
  const { command, basis } = envelope;
  if (basis === undefined && CURSOR_BOUND_COMMAND_KINDS.includes(command.kind)) {
    return protocolFailure({
      code: "basis-required",
      message: `A ${command.kind} command names the node it acts on in basis.nodeId.`,
    }).outcome;
  }
  const snapshots = new Snapshots(context, sessionId, before.node);
  const basisNode = await snapshots.node(basis?.nodeId);
  if (!basisNode.ok) return basisNode.outcome;

  const dispatched = await dispatch(
    context,
    sessionId,
    envelope,
    snapshots,
    scopeOf(basisNode.value),
  );
  if (!dispatched.ok) {
    const code = (dispatched.outcome.body as { diagnostics?: [{ code: string; message: string }] })
      .diagnostics?.[0];
    if (
      basis !== undefined &&
      basis.nodeId !== before.node.id &&
      code !== undefined &&
      dispatched.outcome.status !== 422 &&
      dispatched.outcome.status >= 400 &&
      dispatched.outcome.status < 500
    ) {
      return diagnostics(
        409,
        "stale-alias",
        `The command was based on node ${basis.nodeId}, but the session is at ${before.node.id}; observe again. (${code.message})`,
      ).outcome;
    }
    return dispatched.outcome;
  }
  if ("outcome" in dispatched.value) return dispatched.value.outcome;

  const after = await loadCurrentProofSession(context.store, sessionId);
  if (after.status !== "loaded") return repositoryFailed(after).outcome;
  const cursor = await cursorFor(context, sessionId, after.node);
  if (!cursor.ok) return cursor.outcome;
  const { replayed, result } = dispatched.value;
  return validated(replayed ? 200 : 201, protocolCommandResponseSchema, {
    commandId: envelope.commandId,
    kind: command.kind,
    actor: envelope.actor,
    replayed,
    cursor: cursor.value,
    aliases: deriveSnapshotAliases(after.node),
    delta: snapshotDelta(before.node, after.node),
    result,
  });
}

async function dispatch(
  context: ServiceContext,
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
  snapshots: Snapshots,
  scope: Scope,
): Promise<Step<Dispatched | Readonly<{ outcome: ProtocolHttpOutcome }>>> {
  const { commandId, actor, basis, command } = envelope;
  const options = {
    definitions: context.definitions,
    ...(context.now === undefined ? {} : { now: context.now }),
  };
  const now = () => (context.now ?? (() => new Date()))();
  const expectedCurrentNodeId = basis?.nodeId ?? snapshots.current.id;

  switch (command.kind) {
    case "request-suggestions": {
      const selections: ProofHttpSelectionDescriptor[] = [];
      for (const selection of command.selections) {
        const found = target(scope, selection.target);
        if (!found.ok) return found;
        const statement = fromResolution(
          resolveStatementReference(scope.node, scope.table, found.value, selection.statement),
        );
        if (!statement.ok) return statement;
        const anchor = {
          stateId: scope.node.state.id,
          target: found.value,
          statement: statement.value,
        };
        selections.push(
          "containerPath" in selection
            ? {
                kind: "associative",
                anchor,
                containerPath: selection.containerPath,
                startOperand: selection.startOperand,
                endOperand: selection.endOperand,
              }
            : { kind: "exact", anchor, path: selection.path ?? [] },
        );
      }
      const suggestionSetId = `suggestion-set:${commandId}` as never;
      const recorded = await recordSuggestions(context, sessionId, suggestionSetId, selections);
      if (recorded.status === "invalid-catalog") {
        return diagnostics(500, "invalid-catalog", recorded.message);
      }
      if (recorded.status === "failed") return repositoryFailed(recorded.failure);
      const { suggestionSet } = recorded;
      const suggestionIds = suggestionSet.suggestions.slice(0, 64).map(({ id }) => id);
      const event = await recordInteractionEvent(
        context.store,
        sessionId,
        {
          id: `interaction:${commandId}:displayed`,
          nodeId: suggestionSet.nodeId,
          kind: "suggestions-displayed",
          suggestionSetId: suggestionSet.id,
          suggestionIds,
        },
        actor,
        context.now === undefined ? {} : { now: context.now },
      );
      if (event.status !== "committed") return repositoryFailed(event);
      return {
        ok: true,
        value: {
          replayed: recorded.replayed && event.replayed,
          result: {
            displayed: compactDisplayed(context, {
              suggestionSet,
              displayedIds:
                event.event.kind === "suggestions-displayed"
                  ? event.event.suggestionIds
                  : suggestionIds,
              eventSequence: event.event.sequence,
            }),
          },
        },
      };
    }

    case "preview":
    case "apply": {
      const displayed = await displayedSet(
        context,
        sessionId,
        scope.node.id,
        command.suggestionSetId ?? basis?.suggestionSetId,
      );
      if (!displayed.ok) return displayed;
      if (displayed.value === undefined) {
        return diagnostics(
          422,
          "unknown-alias",
          `No suggestion set is displayed at node ${scope.node.id}; request suggestions first.`,
        );
      }
      const { suggestionSet } = displayed.value;
      const suggestionId = fromResolution(
        resolveSuggestionReference(
          suggestionSet,
          deriveSuggestionAliases(suggestionSet, displayed.value.displayedIds),
          command.suggestion,
        ),
      );
      if (!suggestionId.ok) return suggestionId;
      const base = {
        commandId,
        suggestionSetId: suggestionSet.id,
        chosenSuggestionId: suggestionId.value,
      } as Omit<MoveChoice, "menuChoices">;
      const menuChoices = await resolveMenuChoices(
        context,
        sessionId,
        base,
        command.menuChoices ?? {},
      );
      if (!menuChoices.ok) return menuChoices;
      const choice: MoveChoice = {
        ...base,
        ...(Object.keys(menuChoices.value).length === 0
          ? {}
          : { menuChoices: menuChoices.value as MoveChoice["menuChoices"] }),
      };
      const requiresInput = (
        input: Readonly<{
          suggestionSetId: string;
          chosenSuggestionId: string;
          menus: readonly ParameterMenuRecord[];
          missingParameters: readonly string[];
          diagnostics: readonly [{ code: "requires-input"; message: string }];
        }>,
      ) => ({
        ok: true as const,
        value: {
          outcome: validated(422, protocolRequiresInputResponseSchema, {
            status: "requires-input",
            commandId,
            suggestionSetId: input.suggestionSetId,
            chosenSuggestionId: input.chosenSuggestionId,
            menus: aliasMenus(input.menus),
            missingParameters: input.missingParameters,
            diagnostics: input.diagnostics,
          }),
        },
      });
      if (command.kind === "preview") {
        const previewed = await previewMoveChoice(context, sessionId, choice, actor);
        if (previewed.status === "requires-input") return requiresInput(previewed.input);
        if (previewed.status === "failed") return repositoryFailed(previewed.failure);
        if (previewed.status === "stale-preview") {
          return diagnostics(
            409,
            "preview-rejected",
            "The stored preview is stale for the current node.",
          );
        }
        const { preview } = previewed;
        return {
          ok: true,
          value: {
            replayed: previewed.replayed,
            result: {
              previewId: preview.id,
              moveId: preview.moveId,
              transitionClass: preview.transitionClass,
              operation: preview.operation,
              predicted: snapshotDelta(
                { id: preview.nodeId, state: preview.beforeState },
                { id: `node:${commandId}`, state: preview.afterState },
              ),
              ...(previewed.regeneratedFrom === undefined
                ? {}
                : { regeneratedFrom: previewed.regeneratedFrom }),
            },
          },
        };
      }
      const applied = await applyMoveChoice(
        context,
        sessionId,
        choice,
        command.inquiryMethod,
        actor,
      );
      if (applied.status === "requires-input") return requiresInput(applied.input);
      if (applied.status === "failed") return repositoryFailed(applied.failure);
      if (applied.status === "preview-regenerated") {
        return {
          ok: true,
          value: {
            outcome: validated(
              409,
              previewRegeneratedResponseSchema.extend({
                preview: createMovePreviewSchema({ operators: applied.operators }),
              }),
              {
                status: "preview-regenerated",
                stalePreviewId: applied.stalePreviewId,
                preview: applied.preview,
                diagnostics: [
                  {
                    code: "preview-regenerated",
                    message:
                      "The approved definitions behind the preview changed; preview again before applying.",
                  },
                ],
              },
            ),
          },
        };
      }
      return {
        ok: true,
        value: {
          replayed: applied.executed.replayed,
          result: {
            receipt: applied.executed.result.receipt,
            ...(applied.executed.records === undefined
              ? {}
              : { inquiryRecords: applied.executed.records }),
          },
        },
      };
    }

    case "kernel-operation": {
      const operation = resolveOperation(scope, command.operation, commandId);
      if (!operation.ok) return operation;
      for (const [field, expression] of kernelOperationMathPayloads(operation.value)) {
        const checked = checkRawPayloadSource({
          expression,
          source: command.payloadSource,
          actor,
          node: scope.node,
        });
        if (!checked.ok) {
          return protocolFailure({
            code: checked.diagnostic.code,
            message: `${field}: ${checked.diagnostic.message}`,
          });
        }
      }
      return executeKernel(context, sessionId, envelope, scope, operation.value);
    }

    case "case-split": {
      const found = target(scope, command.target);
      if (!found.ok) return found;
      const proposition = await mathPayload(snapshots, command.proposition, actor, scope.node);
      if (!proposition.ok) return proposition;
      const statementId = (label: string, index: number) =>
        `statement:${commandId}:${label}:${index}`;
      return executeKernel(context, sessionId, envelope, scope, {
        kind: "split-classical-cases",
        expectedStateId: scope.node.state.id,
        resultStateId: derivedMoveRecordIds(commandId).resultStateId,
        target: found.value,
        proposition: proposition.value,
        childIds: [statementId("case", 0), statementId("case", 1)],
        branchHypothesisIds: [statementId("case-hypothesis", 0), statementId("case-hypothesis", 1)],
      });
    }

    case "sorry": {
      const found = target(scope, command.target);
      if (!found.ok) return found;
      return executeKernel(context, sessionId, envelope, scope, {
        kind: "mark-sorry",
        expectedStateId: scope.node.state.id,
        resultStateId: derivedMoveRecordIds(commandId).resultStateId,
        target: found.value,
        assumptionId: `assumption:${commandId}:sorry:0`,
      });
    }

    case "delete-previous-move": {
      const deleted = await deletePreviousMove(
        context.store,
        sessionId,
        {
          commandId,
          actor,
          expectedCurrentNodeId,
          ...(command.confirmDescendants === undefined
            ? {}
            : { confirmDescendants: command.confirmDescendants }),
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        },
        actor,
        context.now === undefined ? {} : { now: context.now },
      );
      if (deleted.status !== "committed") return repositoryFailed(deleted);
      return {
        ok: true,
        value: { replayed: deleted.replayed, result: { receipt: deleted.receipt } },
      };
    }

    case "backtrack": {
      const moved = await backtrackProofSession(context.store, sessionId, {
        expectedCurrentNodeId,
        targetNodeId: command.targetNodeId,
      });
      if (moved.status !== "committed") return repositoryFailed(moved);
      return { ok: true, value: { replayed: moved.replayed, result: { nodeId: moved.node.id } } };
    }

    case "backtrack-with-information": {
      const source = await snapshots.node(command.sourceNodeId ?? scope.node.id);
      if (!source.ok) return source;
      const sourceScope = scopeOf(source.value);
      let sourceTarget: TargetIdentity | undefined;
      if (command.sourceTarget !== undefined) {
        const found = target(sourceScope, command.sourceTarget);
        if (!found.ok) return found;
        sourceTarget = found.value;
      }
      const proposition = await mathPayload(snapshots, command.proposition, actor, source.value);
      if (!proposition.ok) return proposition;
      const backtracked = await backtrackWithInformation(
        context.store,
        sessionId,
        {
          commandId,
          actor,
          expectedCurrentNodeId,
          sourceNodeId: source.value.id,
          ...(sourceTarget === undefined ? {} : { sourceTarget }),
          proposition: proposition.value,
          ...(command.ancestorNodeId === undefined
            ? {}
            : { ancestorNodeId: command.ancestorNodeId }),
        },
        actor,
        options,
      );
      if (backtracked.status !== "committed") return repositoryFailed(backtracked);
      return {
        ok: true,
        value: {
          replayed: backtracked.replayed,
          result: { receipts: backtracked.receipts, backtrack: backtracked.backtrack },
        },
      };
    }

    case "replay": {
      let focus: TargetIdentity | undefined;
      if (command.focus !== undefined) {
        const targetNode = await snapshots.node(command.targetNodeId ?? scope.node.id);
        if (!targetNode.ok) return targetNode;
        const found = target(scopeOf(targetNode.value), command.focus);
        if (!found.ok) return found;
        focus = found.value;
      }
      const committed = await commitSemanticReplay(
        context.store,
        sessionId,
        {
          commandId,
          actor,
          expectedCurrentNodeId,
          source: command.source,
          ...(command.targetNodeId === undefined ? {} : { targetNodeId: command.targetNodeId }),
          ...(focus === undefined ? {} : { focus }),
          ...(command.overrides === undefined ? {} : { overrides: command.overrides }),
        },
        actor,
        options,
      );
      if (committed.status === "replay-failed") {
        return {
          ok: false,
          outcome: {
            status: 422,
            body: {
              status: "replay-failed",
              report: committed.report,
              diagnostics: [
                {
                  code: "replay-failed",
                  message:
                    committed.report.firstFailure?.diagnostic.message ?? "A replayed step failed.",
                },
              ],
            },
          },
        };
      }
      if (committed.status !== "committed") return repositoryFailed(committed);
      return {
        ok: true,
        value: {
          replayed: committed.replayed,
          result: { receipts: committed.receipts, report: committed.report },
        },
      };
    }

    case "record-inquiry": {
      const recorded = await recordInquiryCommand(
        context.store,
        sessionId,
        { commandId, nodeId: command.nodeId ?? scope.node.id, records: command.records },
        actor,
        options,
      );
      if (recorded.status !== "committed") return repositoryFailed(recorded);
      return {
        ok: true,
        value: { replayed: recorded.replayed, result: { records: recorded.records } },
      };
    }

    case "investigate-hypothesis": {
      const node = await snapshots.node(command.nodeId ?? scope.node.id);
      if (!node.ok) return node;
      const nodeScope = scopeOf(node.value);
      const found = target(nodeScope, command.target);
      if (!found.ok) return found;
      const hypothesis = fromResolution(
        resolveStatementReference(nodeScope.node, nodeScope.table, found.value, command.hypothesis),
      );
      if (!hypothesis.ok) return hypothesis;
      if (hypothesis.value.kind !== "hypothesis") {
        return diagnostics(
          422,
          "unknown-reference",
          "Investigate a hypothesis, not the conclusion.",
        );
      }
      const recorded = await investigateHypothesis(
        context.store,
        sessionId,
        {
          commandId,
          nodeId: node.value.id,
          target: found.value,
          hypothesisId: hypothesis.value.id,
        },
        actor,
        options,
      );
      if (recorded.status !== "committed") return repositoryFailed(recorded);
      return {
        ok: true,
        value: { replayed: recorded.replayed, result: { records: recorded.records } },
      };
    }

    case "extract-conditional-lemma": {
      if (context.library === undefined) return libraryUnavailable();
      const node = await snapshots.node(command.nodeId ?? scope.node.id);
      if (!node.ok) return node;
      const found = target(scopeOf(node.value), command.target);
      if (!found.ok) return found;
      const extracted = await extractConditionalLemma(
        context.store,
        context.library,
        sessionId,
        {
          commandId,
          additionEventId: `library-addition:${commandId}`,
          occurredAt: now().toISOString(),
          nodeId: node.value.id,
          target: found.value,
          ...(command.lemma?.name === undefined ? {} : { name: command.lemma.name }),
        },
        actor,
        options,
      );
      if (extracted.status !== "committed") return repositoryFailed(extracted);
      return {
        ok: true,
        value: {
          replayed: extracted.replayed,
          result: {
            lemma: extracted.lemma,
            event: extracted.event,
            records: extracted.records,
            keptHypothesisIds: extracted.keptHypothesisIds,
            unusedHypothesisIds: extracted.unusedHypothesisIds,
          },
        },
      };
    }

    case "review-conditional-lemma": {
      if (context.library === undefined) return libraryUnavailable();
      if (actor.kind !== "human") {
        return protocolFailure({
          code: "payload-source-rejected",
          message: "A conditional lemma is approved only by a human reviewer.",
        });
      }
      const reviewed = await reviewConditionalLemma(context.library, {
        commandId,
        sessionId,
        reviewerId: actor.id,
        occurredAt: now().toISOString(),
        draftArtifactId: command.draftArtifactId,
        decision: command.decision,
        notes: command.notes,
      });
      if (reviewed.status !== "recorded") return repositoryFailed(reviewed);
      return {
        ok: true,
        value: {
          replayed: reviewed.replayed,
          result: {
            artifactId: reviewed.artifact.id,
            draftArtifactId: reviewed.draftArtifactId,
            decision: reviewed.decision,
            review: reviewed.artifact.review,
            retrievable: reviewed.retrievable,
          },
        },
      };
    }

    case "author-move-draft": {
      if (context.library === undefined) return libraryUnavailable();
      const source = authoringSource(actor, command.payloadSource);
      if (!source.ok) return source;
      const environment = await authoringEnvironment(context, sessionId);
      if (!environment.ok) return environment;
      const authored = await authorMoveDraft(context.library, {
        commandId,
        sessionId,
        authorId: actor.id,
        occurredAt: now().toISOString(),
        template: command.template,
        validation: environment.value,
      });
      if (authored.status !== "recorded") return repositoryFailed(authored);
      return {
        ok: true,
        value: {
          replayed: authored.replayed,
          result: {
            artifactId: authored.artifact.id,
            moveId: authored.artifact.template["id"],
            revision: authored.revision,
            definitionDigest: authored.artifact.definitionDigest,
            status: "draft",
            validation: authored.validation.ok
              ? { ok: true, report: authored.validation.report }
              : { ok: false, diagnostics: authored.validation.diagnostics },
          },
        },
      };
    }

    case "review-move-draft": {
      if (context.library === undefined) return libraryUnavailable();
      const source = authoringSource(actor, command.payloadSource);
      if (!source.ok) return source;
      const environment = await authoringEnvironment(context, sessionId);
      if (!environment.ok) return environment;
      const reviewed = await reviewMoveDraft(context.library, {
        commandId,
        sessionId,
        reviewerId: actor.id,
        occurredAt: now().toISOString(),
        draftArtifactId: command.draftArtifactId,
        decision: command.decision,
        notes: command.notes,
        validation: environment.value,
      });
      if (reviewed.status !== "recorded") return repositoryFailed(reviewed);
      return {
        ok: true,
        value: {
          replayed: reviewed.replayed,
          result: {
            artifactId: reviewed.artifact.id,
            draftArtifactId: command.draftArtifactId,
            moveId: reviewed.artifact.template["id"],
            decision: reviewed.decision,
            definitionDigest: reviewed.definitionDigest,
            review: reviewed.artifact.review,
            retrievable: reviewed.retrievable,
          },
        },
      };
    }

    case "add-library-result": {
      if (context.library === undefined) return libraryUnavailable();
      const source = libraryPayloadSource(command, actor);
      if (!source.ok) return source;
      if (command.layer === "global") {
        return diagnostics(
          400,
          "invalid-request",
          "A session command adds to the session's library layers, never the global layer.",
        );
      }
      if (command.artifact["kind"] === "move") {
        return diagnostics(
          400,
          "invalid-request",
          "Move templates are added with author-move-draft and review-move-draft.",
        );
      }
      const added = await addLibraryArtifact(context.library, {
        id: `library-addition:${commandId}`,
        sessionId,
        occurredAt: now().toISOString(),
        layer: command.layer,
        origin: { kind: "user", actorId: actor.id },
        artifact: command.artifact,
      });
      if (added.status !== "recorded") return repositoryFailed(added);
      return {
        ok: true,
        value: {
          replayed: added.replayed,
          result: { admitted: added.admitted, event: added.event },
        },
      };
    }
  }
}

/** Authored moves are new mathematics: a human actor, acting as reviewed authoring. */
function authoringSource(actor: ProtocolActor, payloadSource: string | undefined): Step<true> {
  if (payloadSource !== "reviewed-authoring") {
    return protocolFailure({
      code: payloadSource === undefined ? "payload-source-required" : "payload-source-rejected",
      message: "Move authoring names its payload source: reviewed-authoring.",
    });
  }
  if (actor.kind !== "human") {
    return protocolFailure({
      code: "payload-source-rejected",
      message: "Reviewed authoring is accepted only from a human actor.",
    });
  }
  return { ok: true, value: true };
}

async function authoringEnvironment(
  context: ServiceContext,
  sessionId: string,
): Promise<Step<MoveTemplateValidationOptions>> {
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") return repositoryFailed(loaded);
  const operators = loaded.session.operators;
  const results = context.definitions.catalog(operators).kernelResults;
  return {
    ok: true,
    value: {
      operators,
      ...(results === undefined ? {} : { results }),
      artifactExists: (reference) =>
        reference.kind === "result" &&
        context.definitions.catalog(operators).results.some(({ id }) => id === reference.id),
    },
  };
}

function libraryUnavailable(): Failure {
  return diagnostics(503, "library-unavailable", "This proof service has no library store.");
}

/**
 * Library content is new mathematics: through the envelope it is accepted only as reviewed
 * authoring by the human who approved it. Derived results use `extract-conditional-lemma`.
 */
function libraryPayloadSource(
  command: Extract<ProtocolCommand, { kind: "add-library-result" }>,
  actor: ProtocolActor,
): Step<true> {
  const reject = (message: string) => protocolFailure({ code: "payload-source-rejected", message });
  switch (command.payloadSource) {
    case undefined:
      return protocolFailure({
        code: "payload-source-required",
        message: "A library addition names its payload source (reviewed-authoring).",
      });
    case "setup":
      return reject("Setup libraries are chosen when a session is initialized.");
    case "approved-generator":
      return reject("Generated variants are derived by the library, not sent through a command.");
    case "validated-operation":
      return reject("A result proved in this session is added with extract-conditional-lemma.");
    case "reviewed-authoring": {
      const approval = command.artifact.approval as
        { status?: unknown; reviewerId?: unknown } | undefined;
      if (actor.kind !== "human") {
        return reject("Reviewed authoring is accepted only from a human actor.");
      }
      if (approval?.status !== "approved" || approval.reviewerId !== actor.id) {
        return reject("A reviewed artifact must be approved by the human actor adding it.");
      }
      return { ok: true, value: true };
    }
  }
}

async function executeKernel(
  context: ServiceContext,
  sessionId: string,
  envelope: ProtocolCommandEnvelope,
  scope: Scope,
  operation: Readonly<Record<string, unknown>>,
): Promise<Step<Dispatched>> {
  const ids = derivedMoveRecordIds(envelope.commandId);
  const executed = await executeProofCommand(
    context.store,
    sessionId,
    {
      commandId: envelope.commandId,
      kind: "apply-kernel-operation",
      actor: envelope.actor,
      parentNodeId: scope.node.id,
      resultNodeId: ids.resultNodeId,
      edgeId: ids.edgeId,
      eventId: ids.eventId,
      operation,
    },
    envelope.actor,
    context.definitions,
  );
  if (executed.status !== "committed") return repositoryFailed(executed);
  return {
    ok: true,
    value: { replayed: executed.replayed, result: { receipt: executed.result.receipt } },
  };
}

// ---------------------------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------------------------

function observedSession(session: ProofSession) {
  return { id: session.id, rootNodeId: session.rootNodeId, currentNodeId: session.currentNodeId };
}

/** Observe the session: full snapshot, compact summary, or delta since a cursor. */
export async function handleObserve(
  context: ServiceContext,
  sessionId: string,
  query: ObserveQuery,
): Promise<ProtocolHttpOutcome> {
  const loaded = await loadCurrentProofSession(context.store, sessionId);
  if (loaded.status !== "loaded") return repositoryFailed(loaded).outcome;
  const { session, node } = loaded;
  const cursor = await cursorFor(context, sessionId, node);
  if (!cursor.ok) return cursor.outcome;

  if (query.view === "full" || query.view === "summary") {
    const displayed = await displayedSet(context, sessionId, node.id, undefined);
    if (!displayed.ok) return displayed.outcome;
    const view =
      displayed.value === undefined ? undefined : compactDisplayed(context, displayed.value);
    if (query.view === "summary") {
      return validated(200, observeSummaryResponseSchema, {
        view: "summary",
        session: observedSession(session),
        lines: summarizeSnapshot(node, view),
        cursor: cursor.value,
      });
    }
    const table = deriveSnapshotAliases(node);
    const { targets, hypotheses } = compactTargets(node, table);
    return validated(
      200,
      observeFullResponseSchema.extend({
        node: createProofNodeSchema({ operators: session.operators }),
      }),
      {
        view: "full",
        session: observedSession(session),
        node,
        aliases: table,
        targets,
        hypotheses,
        ...(view === undefined ? {} : { displayed: view }),
        cursor: cursor.value,
      },
    );
  }

  const history = await loadProofHistory(context.store, sessionId);
  if (history.status !== "loaded") return repositoryFailed(history).outcome;
  const nodes = new Map(history.nodes.map((entry) => [entry.id as string, entry]));
  const since = nodes.get(query.sinceNode ?? "");
  if (since === undefined) {
    return diagnostics(404, "unknown-reference", `The node ${query.sinceNode} is not in the tree.`)
      .outcome;
  }
  const parentEdge = new Map(history.edges.map(({ edge }) => [edge.childNodeId as string, edge]));
  const ancestry = (start: string) => {
    const path = [];
    let edge = parentEdge.get(start);
    while (edge !== undefined) {
      path.push(edge);
      edge = parentEdge.get(edge.parentNodeId);
    }
    return path;
  };
  const upFromCurrent = ancestry(node.id);
  let relation: "same" | "descendant" | "ancestor" | "other" = "other";
  let path: typeof upFromCurrent = [];
  if (since.id === node.id) relation = "same";
  else {
    const index = upFromCurrent.findIndex((edge) => edge.parentNodeId === since.id);
    if (index >= 0) {
      relation = "descendant";
      path = upFromCurrent.slice(0, index + 1).reverse();
    } else if (ancestry(since.id).some((edge) => edge.parentNodeId === node.id)) {
      relation = "ancestor";
    }
  }
  const events = await allInteractionEvents(context, sessionId, {
    afterSequence: query.afterEvent ?? cursor.value.eventSequence,
  });
  if (!events.ok) return events.outcome;
  const records = await allInquiryRecords(
    context,
    sessionId,
    query.afterInquiry ?? cursor.value.inquirySequence,
  );
  if (!records.ok) return records.outcome;
  return validated(200, observeDeltaResponseSchema, {
    view: "delta",
    session: observedSession(session),
    relation,
    path: path.map((edge) => ({
      edgeId: edge.id,
      commandId: edge.commandId,
      childNodeId: edge.childNodeId,
      ...(edge.moveId === undefined ? {} : { moveId: edge.moveId }),
      transitionClass: edge.transitionClass,
    })),
    delta: snapshotDelta(since, node),
    aliases: deriveSnapshotAliases(node),
    interactionEvents: events.value.map(({ sequence, id, kind, nodeId, actor }) => ({
      sequence,
      id,
      kind,
      nodeId,
      actor,
    })),
    inquiryRecords: records.value,
    cursor: cursor.value,
  });
}
