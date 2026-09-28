import { MemoryProofStore, memoryProofRecordKey } from "./memory-proof-store";
import type { ProofStoreTransaction } from "./proof-repository";

export { memoryProofRecordKey as key };

export type MemoryProofStoreFailurePoint =
  | "insertSession"
  | "insertNode"
  | "insertSuggestionSet"
  | "insertPreview"
  | "insertEdge"
  | "insertEvent"
  | "insertCommand"
  | "insertInteractionEvent"
  | "advance";

/**
 * Test-only view of the production memory store: exposes its committed tables for corruption
 * tests and injects failures or malformed records at named points. Not exported from the package.
 */
export class InspectableMemoryProofStore extends MemoryProofStore {
  failAt: MemoryProofStoreFailurePoint | undefined;
  nodeRecordOverride: unknown | undefined;
  suggestionSetRecordOverride: unknown | undefined;
  readonly log: string[] = [];

  get sessions() {
    return this.tables.sessions;
  }
  get nodes() {
    return this.tables.nodes;
  }
  get suggestionSets() {
    return this.tables.suggestionSets;
  }
  get previews() {
    return this.tables.previews;
  }
  get edges() {
    return this.tables.edges;
  }
  get events() {
    return this.tables.events;
  }
  get commands() {
    return this.tables.commands;
  }
  get deletions() {
    return this.tables.deletions;
  }
  get interactionEvents() {
    return this.tables.interactionEvents;
  }
  get inquiryRecords() {
    return this.tables.inquiryRecords;
  }

  protected override instrument(inner: ProofStoreTransaction): ProofStoreTransaction {
    const fail = (point: MemoryProofStoreFailurePoint): void => {
      if (this.failAt === point) throw new Error(`forced ${point} failure`);
    };
    return {
      ...inner,
      lockSession: async (sessionId) => {
        this.log.push("lockSession");
        return inner.lockSession(sessionId);
      },
      readNode: async (sessionId, nodeId) => {
        this.log.push("readNode");
        if (this.nodeRecordOverride !== undefined) return this.nodeRecordOverride;
        return inner.readNode(sessionId, nodeId);
      },
      readCommand: async (sessionId, commandId) => {
        this.log.push("readCommand");
        return inner.readCommand(sessionId, commandId);
      },
      readSuggestionSet: async (sessionId, suggestionSetId) => {
        this.log.push("readSuggestionSet");
        if (this.suggestionSetRecordOverride !== undefined) {
          return this.suggestionSetRecordOverride;
        }
        return inner.readSuggestionSet(sessionId, suggestionSetId);
      },
      readPreview: async (sessionId, previewId) => {
        this.log.push("readPreview");
        return inner.readPreview(sessionId, previewId);
      },
      insertSession: async (session) => {
        fail("insertSession");
        return inner.insertSession(session);
      },
      insertNode: async (sessionId, node) => {
        fail("insertNode");
        return inner.insertNode(sessionId, node);
      },
      insertSuggestionSet: async (sessionId, suggestionSet) => {
        fail("insertSuggestionSet");
        return inner.insertSuggestionSet(sessionId, suggestionSet);
      },
      insertPreview: async (sessionId, preview) => {
        fail("insertPreview");
        return inner.insertPreview(sessionId, preview);
      },
      insertEdge: async (sessionId, edge) => {
        fail("insertEdge");
        return inner.insertEdge(sessionId, edge);
      },
      insertEvent: async (sessionId, event) => {
        fail("insertEvent");
        return inner.insertEvent(sessionId, event);
      },
      insertCommand: async (sessionId, result) => {
        fail("insertCommand");
        return inner.insertCommand(sessionId, result);
      },
      insertInteractionEvent: async (sessionId, event) => {
        fail("insertInteractionEvent");
        return inner.insertInteractionEvent(sessionId, event);
      },
      advanceCurrentNode: async (sessionId, expectedNodeId, nextNodeId) => {
        this.log.push("advanceCurrentNode");
        if (this.failAt === "advance") return false;
        return inner.advanceCurrentNode(sessionId, expectedNodeId, nextNodeId);
      },
    };
  }
}
