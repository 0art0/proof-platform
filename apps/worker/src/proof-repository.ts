// The public surface of the proof repository. The implementation lives in the sibling
// `proof-repository-*` modules; importers use this file.

export {
  proofSessionIdSchema,
  type ProofSessionId,
  type ProofSession,
  type SessionVisibility,
  sessionVisibility,
  proofSessionSchema,
  type StoredProofNodeRecord,
  type StoredDisplayedSuggestionSetRecord,
  type StoredProofEdgeRecord,
  type ProofRecordDeletionRequest,
  type ProofRecordDeletionResult,
  type ProofStoreTransaction,
  type InquiryRecordQuery,
  type InteractionEventQuery,
  type ProofStore,
  ProofStoreTransactionError,
  ReadOnlySessionError,
  isReadOnlySessionRecord,
  guardReadOnlySessions,
} from "./proof-repository-store";
export {
  type RepositoryDiagnosticCode,
  type RepositoryDiagnostic,
  type RepositoryFailure,
  transactionFailure,
  freezeDetached,
  repositoryFailure,
  safeParse,
  isStrictDataRecord,
  jsonEquals,
} from "./proof-repository-core";
export {
  type ProofHistoryEdge,
  type LoadProofHistoryResult,
  derivedMoveRecordIds,
  parseEdgeRecord,
  loadSession,
  loadNode,
  loadSuggestionSet,
} from "./proof-repository-records";
export {
  type InitializeProofSessionResult,
  type LoadCurrentProofSessionResult,
  initializeProofSession,
  loadCurrentProofSession,
  loadProofHistory,
} from "./proof-repository-session";
export {
  type RecordDisplayedSuggestionSetResult,
  type ReadDisplayedSuggestionSetResult,
  type RecordMovePreviewResult,
  type RecordMovePreviewOptions,
  readDisplayedSuggestionSet,
  recordDisplayedSuggestionSet,
  recordMovePreview,
} from "./proof-repository-suggestions";
export {
  type MoveRequiresInput,
  type MaterializeMoveChoiceResult,
  moveChoiceSchema,
  type MaterializedMovePreviewRequest,
  materializeMoveChoice,
  displayedMoveSelections,
} from "./proof-repository-materialize";
export {
  type RecordInteractionEventResult,
  type ListInteractionEventsResult,
  recordInteractionEvent,
  listInteractionEvents,
  interactionEventQuerySchema,
} from "./proof-repository-interaction";
export {
  type BacktrackProofSessionResult,
  type DeletePreviousMoveResult,
  type DeletePreviousMoveOptions,
  type AnalyzeBacktrackResult,
  type BacktrackedInteractionEvent,
  type BacktrackWithInformationResult,
  type BacktrackWithInformationOptions,
  backtrackProofSessionSchema,
  backtrackProofSession,
  deletePreviousMove,
  backtrackEventId,
  analyzeBacktrackWithInformation,
  backtrackWithInformation,
} from "./proof-repository-backtrack";
export {
  type SemanticReplayPreviewResult,
  type SemanticReplayCommitResult,
  type SemanticReplayOptions,
  previewSemanticReplay,
  commitSemanticReplay,
} from "./proof-repository-replay";
export {
  type ExecuteProofCommandResult,
  executeProofCommand,
  executeProofCommandWithin,
  type StepOptions,
} from "./proof-repository-commands";
export {
  macroStepCommandId,
  type ExecuteMacroResult,
  executeMacroPreview,
  proposalStepCommandId,
  proposalPlanApplied,
  type ExecuteProposalPlanInput,
  executeProposalPlan,
} from "./proof-repository-macros";
