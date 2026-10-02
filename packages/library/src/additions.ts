/**
 * Library-addition events, background revisions, and the deterministic admission gate (design plan
 * §12.4, roadmap N12).
 *
 * Every addition to the active library is an explicit event that records the artifact, its layer,
 * origin, background classification, approval, and the gate's decision. A rejected artifact is
 * never silently added: the rejection is itself a recorded event with its diagnostics. A result
 * outside the session background can be admitted to the proof-time background layer only after the
 * profile is explicitly revised by a recorded `BackgroundRevisionEvent`.
 *
 * Schemas that depend on `./index` are wrapped in `z.lazy` because `./index` re-exports this module
 * and is still evaluating when this module first runs.
 */
import {
  operatorDeclarationSchema,
  operatorDeclarationsSchema,
  stableIdentifierSchema,
  type OperatorDeclaration,
} from "@proof/mathjson-model";
import { z } from "zod";
import {
  backgroundClassificationSchema,
  backgroundProfileSchema,
  checkBackgroundAdmission,
  type BackgroundAdmissionDiagnosticCode,
  type BackgroundProfile,
} from "./background";
import {
  createLibraryArtifactSchema,
  libraryApprovalSchema,
  libraryArtifactSchema,
  libraryLayerSchema,
  type LibraryArtifact,
  type LibraryEnvironment,
  type LibraryLayer,
} from "./index";

export const libraryAdditionEventIdSchema = stableIdentifierSchema.brand("LibraryAdditionEventId");
export type LibraryAdditionEventId = z.infer<typeof libraryAdditionEventIdSchema>;
export const backgroundRevisionEventIdSchema = stableIdentifierSchema.brand(
  "BackgroundRevisionEventId",
);
export type BackgroundRevisionEventId = z.infer<typeof backgroundRevisionEventIdSchema>;

export const libraryAdditionOriginKindSchema = z.enum([
  "setup",
  "user",
  "agent",
  "service",
  "derived",
]);
export type LibraryAdditionOriginKind = z.infer<typeof libraryAdditionOriginKindSchema>;

export const libraryAdditionOriginSchema = z
  .object({ kind: libraryAdditionOriginKindSchema, actorId: stableIdentifierSchema.optional() })
  .strict();
export type LibraryAdditionOrigin = z.infer<typeof libraryAdditionOriginSchema>;

export const LIBRARY_ADMISSION_DIAGNOSTIC_CODES = [
  "invalid-artifact",
  "layer-mismatch",
  "scope-mismatch",
  "approval-rejected",
  "approval-required",
  "draft-required",
  "background-profile-missing",
  "background-revision-invalid",
  "profile-domains-unspecified",
  "profile-level-unspecified",
  "domain-outside-background",
  "level-above-background",
  "derived-provenance-required",
  "derived-layer-required",
  "derived-session-mismatch",
  "derived-node-not-found",
  "move-layer-required",
] as const;
export const libraryAdmissionDiagnosticCodeSchema = z.enum(LIBRARY_ADMISSION_DIAGNOSTIC_CODES);
export type LibraryAdmissionDiagnosticCode = z.infer<typeof libraryAdmissionDiagnosticCodeSchema>;

export const libraryAdmissionDiagnosticSchema = z
  .object({ code: libraryAdmissionDiagnosticCodeSchema, message: z.string().min(1) })
  .strict();
export type LibraryAdmissionDiagnostic = z.infer<typeof libraryAdmissionDiagnosticSchema>;

export const libraryAdmissionRecordSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("admitted"), diagnostics: z.tuple([]) }).strict(),
  z
    .object({
      decision: z.literal("rejected"),
      diagnostics: z.array(libraryAdmissionDiagnosticSchema).min(1),
    })
    .strict(),
]);
export type LibraryAdmissionRecord = z.infer<typeof libraryAdmissionRecordSchema>;

const timestampSchema = z.string().datetime({ offset: true });

const additionEventShape = {
  id: libraryAdditionEventIdSchema,
  sessionId: stableIdentifierSchema.optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  layer: z.lazy(() => libraryLayerSchema),
  origin: libraryAdditionOriginSchema,
  classification: backgroundClassificationSchema,
  admission: libraryAdmissionRecordSchema,
  approval: z.lazy(() => libraryApprovalSchema),
};

export type LibraryAdditionEvent = Readonly<{
  id: LibraryAdditionEventId;
  sessionId?: string | undefined;
  sequence: number;
  occurredAt: string;
  artifact: LibraryArtifact;
  layer: LibraryLayer;
  origin: LibraryAdditionOrigin;
  classification: z.infer<typeof backgroundClassificationSchema>;
  admission: LibraryAdmissionRecord;
  approval: z.infer<typeof libraryApprovalSchema>;
}>;

/**
 * The addition-event schema for an operator environment. The artifact must be valid in that
 * environment, and the event's layer, classification and approval must restate the artifact's own.
 */
export function createLibraryAdditionEventSchema(
  environment: LibraryEnvironment = {},
): z.ZodType<LibraryAdditionEvent> {
  const artifactSchema = createLibraryArtifactSchema(environment);
  return z
    .object({ ...additionEventShape, artifact: artifactSchema })
    .strict()
    .superRefine((event, context) => {
      if (event.artifact.layer !== event.layer) {
        context.addIssue({
          code: "custom",
          message: "The event layer must be the artifact's layer.",
          path: ["layer"],
        });
      }
      if (!sameJson(event.artifact.classification, event.classification)) {
        context.addIssue({
          code: "custom",
          message: "The event classification must be the artifact's classification.",
          path: ["classification"],
        });
      }
      if (!sameJson(event.artifact.approval, event.approval)) {
        context.addIssue({
          code: "custom",
          message: "The event approval must be the artifact's approval.",
          path: ["approval"],
        });
      }
      if ((event.layer === "global") !== (event.sessionId === undefined)) {
        context.addIssue({
          code: "custom",
          message: "Only global-layer additions are outside a session.",
          path: ["sessionId"],
        });
      }
    }) as unknown as z.ZodType<LibraryAdditionEvent>;
}

export const libraryAdditionEventSchema: z.ZodType<LibraryAdditionEvent> = z.lazy(() =>
  createLibraryAdditionEventSchema(),
);

export const backgroundRevisionActorSchema = z
  .object({ kind: z.enum(["setup", "user", "agent", "service"]), id: stableIdentifierSchema })
  .strict();
export type BackgroundRevisionActor = z.infer<typeof backgroundRevisionActorSchema>;

export const backgroundRevisionEventSchema = z
  .object({
    id: backgroundRevisionEventIdSchema,
    sessionId: stableIdentifierSchema,
    sequence: z.number().int().nonnegative(),
    occurredAt: timestampSchema,
    previous: backgroundProfileSchema,
    revised: backgroundProfileSchema,
    reason: z.string().min(1).max(2_000),
    actor: backgroundRevisionActorSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (sameJson(event.previous, event.revised)) {
      context.addIssue({
        code: "custom",
        message: "A background revision must change the profile.",
        path: ["revised"],
      });
    }
  });
export type BackgroundRevisionEvent = z.infer<typeof backgroundRevisionEventSchema>;

/** An approved operator declaration persisted in the global operator registry. */
export const libraryOperatorRegistrationSchema = z
  .object({
    operator: operatorDeclarationSchema,
    reviewerId: stableIdentifierSchema,
    registeredAt: timestampSchema,
  })
  .strict();
export type LibraryOperatorRegistration = z.infer<typeof libraryOperatorRegistrationSchema>;

export type MergeLibraryOperatorsResult =
  | Readonly<{ ok: true; operators: readonly OperatorDeclaration[] }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Merge operator environments (for example the global registry and a session's operators).
 * Identical declarations of one symbol collapse to one; any other conflict, and any invalid
 * combined environment, is rejected.
 */
export function mergeLibraryOperators(
  groups: readonly (readonly unknown[])[],
): MergeLibraryOperatorsResult {
  const bySymbol = new Map<string, unknown>();
  for (const operator of groups.flat()) {
    const symbol =
      typeof operator === "object" && operator !== null && "symbol" in operator
        ? operator.symbol
        : undefined;
    if (typeof symbol !== "string") return { ok: false, message: "An operator is invalid." };
    const existing = bySymbol.get(symbol);
    if (existing === undefined) bySymbol.set(symbol, operator);
    else if (!sameJson(existing, operator)) {
      return { ok: false, message: `The operator ${symbol} is declared inconsistently.` };
    }
  }
  let parsed: ReturnType<typeof operatorDeclarationsSchema.safeParse>;
  try {
    parsed = operatorDeclarationsSchema.safeParse(structuredClone([...bySymbol.values()]));
  } catch {
    return { ok: false, message: "The combined operator environment is invalid." };
  }
  return parsed.success
    ? deepFreeze({ ok: true, operators: parsed.data })
    : { ok: false, message: "The combined operator environment is invalid." };
}

export type BackgroundRevisionResult =
  | Readonly<{ ok: true; profile: BackgroundProfile; diagnostics: readonly [] }>
  | Readonly<{ ok: false; diagnostics: readonly [LibraryAdmissionDiagnostic] }>;

/**
 * Replay recorded revisions over an initial profile. Revisions must have strictly increasing
 * sequence numbers, and each must revise exactly the profile produced by the ones before it.
 */
export function applyBackgroundRevisions(
  initial: BackgroundProfile,
  revisions: readonly BackgroundRevisionEvent[],
  sessionId?: string,
): BackgroundRevisionResult {
  const parsedInitial = backgroundProfileSchema.safeParse(initial);
  if (!parsedInitial.success) return revisionFailure("The initial background profile is invalid.");
  let profile: BackgroundProfile = parsedInitial.data;
  let previousSequence = -1;
  for (const input of revisions) {
    const parsed = backgroundRevisionEventSchema.safeParse(input);
    if (!parsed.success) return revisionFailure("A background revision event is invalid.");
    const revision = parsed.data;
    if (sessionId !== undefined && revision.sessionId !== sessionId) {
      return revisionFailure(`Revision ${revision.id} belongs to another session.`);
    }
    if (revision.sequence <= previousSequence) {
      return revisionFailure("Background revisions must be in strictly increasing sequence order.");
    }
    if (!sameJson(revision.previous, profile)) {
      return revisionFailure(`Revision ${revision.id} does not revise the current profile.`);
    }
    previousSequence = revision.sequence;
    profile = revision.revised;
  }
  return deepFreeze({ ok: true, profile, diagnostics: [] as const });
}

export type LibraryAdmissionInput = Readonly<{
  artifact: unknown;
  layer: LibraryLayer;
  /** The session the addition belongs to; absent only for global-layer additions. */
  sessionId?: string | undefined;
  /** The session's background profile before `revisions`. */
  profile?: BackgroundProfile | undefined;
  revisions?: readonly BackgroundRevisionEvent[] | undefined;
  /** When provided, a derived result's proof node must be one of these IDs. */
  proofNodeIds?: readonly string[] | undefined;
  environment?: LibraryEnvironment | undefined;
}>;

export type LibraryAdmissionResult =
  | Readonly<{
      ok: true;
      decision: "admitted";
      artifact: LibraryArtifact;
      profile: BackgroundProfile | undefined;
      diagnostics: readonly [];
    }>
  | Readonly<{
      ok: false;
      decision: "rejected";
      artifact: LibraryArtifact | undefined;
      profile: BackgroundProfile | undefined;
      diagnostics: readonly [LibraryAdmissionDiagnostic, ...LibraryAdmissionDiagnostic[]];
    }>;

/**
 * The deterministic library-admission gate.
 *
 * - Every layer: the artifact must be valid, carry the requested layer, and not be rejected;
 *   global additions are outside any session and every other layer belongs to one.
 * - `global` and `initial-problem`: curated layers; the artifact must be approved.
 * - `proof-time-background`: approved, and its classification must lie within the current profile
 *   (the initial profile after the recorded revisions).
 * - `derived`: derived provenance naming this session and a proof node (a known one, when
 *   `proofNodeIds` is given). Derived provenance is admitted only to this layer, so a result proved
 *   in the session is never treated as assumed background.
 * - `move-discovery-draft`: admitted as a draft only; the artifact's approval must be `draft`.
 */
export function admitLibraryArtifact(input: LibraryAdmissionInput): LibraryAdmissionResult {
  const diagnostics: LibraryAdmissionDiagnostic[] = [];
  const add = (code: LibraryAdmissionDiagnosticCode, message: string) =>
    diagnostics.push({ code, message });

  let artifact: LibraryArtifact | undefined;
  try {
    const parsed = (
      input.environment === undefined
        ? libraryArtifactSchema
        : createLibraryArtifactSchema(input.environment)
    ).safeParse(input.artifact);
    if (parsed.success) artifact = parsed.data;
  } catch {
    artifact = undefined;
  }

  let profile: BackgroundProfile | undefined;
  if (input.profile !== undefined) {
    const current = applyBackgroundRevisions(input.profile, input.revisions ?? [], input.sessionId);
    if (current.ok) profile = current.profile;
    else diagnostics.push(...current.diagnostics);
  } else if ((input.revisions ?? []).length > 0) {
    add("background-revision-invalid", "Background revisions require an initial profile.");
  }

  if (artifact === undefined) {
    add("invalid-artifact", "The artifact is not a valid library artifact in this environment.");
    return rejected(undefined, profile, diagnostics);
  }

  const { layer, sessionId } = input;
  if (artifact.layer !== layer) {
    add("layer-mismatch", `The artifact declares layer ${artifact.layer}, not ${layer}.`);
  }
  if ((layer === "global") !== (sessionId === undefined)) {
    add(
      "scope-mismatch",
      layer === "global"
        ? "Global-layer additions cannot belong to a session."
        : `The ${layer} layer belongs to a proof session.`,
    );
  }
  if (artifact.kind === "move" && layer !== "move-discovery-draft") {
    add("move-layer-required", "A move template belongs to the move-discovery-draft layer.");
  }
  // In the draft layer a move artifact may itself be a recorded rejection: the review is the record.
  if (
    artifact.approval.status === "rejected" &&
    !(artifact.kind === "move" && layer === "move-discovery-draft")
  ) {
    add("approval-rejected", "A rejected artifact cannot be added to the library.");
  }
  if (artifact.provenance.kind === "derived" && layer !== "derived") {
    add("derived-layer-required", "A result derived in a proof belongs to the derived layer.");
  }

  switch (layer) {
    case "global":
    case "initial-problem":
    case "proof-time-background":
      if (artifact.approval.status !== "approved") {
        add("approval-required", `The ${layer} layer admits only approved artifacts.`);
      }
      if (layer === "proof-time-background") {
        if (profile === undefined) {
          if (input.profile === undefined) {
            add("background-profile-missing", "The session has no background profile.");
          }
        } else {
          const background = checkBackgroundAdmission(artifact.classification, profile);
          if (!background.ok) {
            background.diagnostics.forEach((diagnostic) =>
              add(backgroundCode(diagnostic.code), diagnostic.message),
            );
          }
        }
      }
      break;
    case "derived": {
      const provenance = artifact.provenance;
      if (provenance.kind !== "derived") {
        add(
          "derived-provenance-required",
          "A derived result must carry derived provenance with its session and proof node.",
        );
      } else {
        if (provenance.sessionId !== sessionId) {
          add("derived-session-mismatch", "The derived result was proved in another session.");
        }
        // A derived result is approved only by a recorded human review (N44).
        if (
          artifact.approval.status === "approved" &&
          !(artifact.kind === "result" && artifact.review?.decision === "approved")
        ) {
          add("approval-required", "A derived result is approved only by a recorded review.");
        }
        if (
          input.proofNodeIds !== undefined &&
          !input.proofNodeIds.includes(provenance.proofNodeId)
        ) {
          add(
            "derived-node-not-found",
            `The proof node ${provenance.proofNodeId} is not in the session.`,
          );
        }
      }
      break;
    }
    case "move-discovery-draft":
      // A move template carries its own review record, which its schema checked against the
      // approval. Everything else in this layer is a draft.
      if (artifact.kind !== "move" && artifact.approval.status !== "draft") {
        add("draft-required", "Move-discovery additions are admitted as drafts only.");
      }
      break;
  }

  if (diagnostics.length > 0) return rejected(artifact, profile, diagnostics);
  return deepFreeze({
    ok: true,
    decision: "admitted",
    artifact: structuredClone(artifact),
    profile: profile === undefined ? undefined : structuredClone(profile),
    diagnostics: [] as const,
  });
}

/** The recorded admission part of an addition event. */
export function admissionRecord(result: LibraryAdmissionResult): LibraryAdmissionRecord {
  return deepFreeze(
    result.ok
      ? { decision: "admitted" as const, diagnostics: [] as [] }
      : { decision: "rejected" as const, diagnostics: structuredClone([...result.diagnostics]) },
  );
}

function backgroundCode(code: BackgroundAdmissionDiagnosticCode): LibraryAdmissionDiagnosticCode {
  return code;
}

function rejected(
  artifact: LibraryArtifact | undefined,
  profile: BackgroundProfile | undefined,
  diagnostics: readonly LibraryAdmissionDiagnostic[],
): LibraryAdmissionResult {
  const [first, ...rest] = diagnostics;
  if (first === undefined) throw new Error("A rejection requires a diagnostic.");
  return deepFreeze({
    ok: false,
    decision: "rejected",
    artifact: artifact === undefined ? undefined : structuredClone(artifact),
    profile: profile === undefined ? undefined : structuredClone(profile),
    diagnostics: structuredClone([first, ...rest] as const),
  });
}

function revisionFailure(message: string): BackgroundRevisionResult {
  return deepFreeze({
    ok: false,
    diagnostics: [{ code: "background-revision-invalid" as const, message }] as const,
  });
}

/** Key-order-insensitive JSON equality, so JSONB round trips compare equal. */
function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object> = new WeakSet()): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  Reflect.ownKeys(value).forEach((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value, seen);
  });
  return Object.freeze(value);
}
