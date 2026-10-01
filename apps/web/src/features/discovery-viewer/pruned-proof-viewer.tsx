"use client";

import { useMemo, useState } from "react";
import type { ProofArtifact } from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { usePresentation } from "../proof-workspace/presentation";
import { indexArtifact } from "./artifact-data";
import styles from "./discovery-viewer.module.css";
import { InquiryRecordExplanation, useInquiryExplanations } from "./inquiry-record-item";
import {
  buildPrunedProofView,
  type MotivationRelation,
  type PrunedStepView,
} from "./pruned-proof-view";
import { AssumptionList, SequentView, ViewToggle } from "./statement-views";
import { ViewerShell } from "./viewer-shell";

const RELATION_LABELS: Readonly<Record<MotivationRelation, string>> = Object.freeze({
  "chose-this-suggestion": "chose this suggestion",
  "same-move-at-node": "tried this move here",
  "motivating-context": "motivating context",
});

export function inquiryAnchor(recordId: string): string {
  return `inquiry-${recordId}`;
}

/** The pruned proof, its sorry assumptions, and the inquiry records that motivated its steps. */
export function PrunedProofViewer({ artifact }: Readonly<{ artifact: ProofArtifact }>) {
  const proof = useMemo(() => buildPrunedProofView(artifact), [artifact]);
  const index = useMemo(() => indexArtifact(artifact), [artifact]);
  const presentation = usePresentation(artifact.initialState.operators);
  const explain = useInquiryExplanations(artifact);
  const [view, setView] = useState<WorkspaceView>("formal");
  const recordsById = new Map(artifact.inquiryRecords.map((record) => [record.id, record]));

  const stepTarget = (step: PrunedStepView) => {
    const state = index.nodes.get(step.parentNodeId)?.state;
    const entries = step.target.kind === "goal" ? state?.goals : state?.obligations;
    return entries?.find(({ id }) => id === step.target.id);
  };

  return (
    <ViewerShell artifact={artifact} active="proof">
      <div className={styles.toolbarRow}>
        <ViewToggle view={view} onChange={setView} />
      </div>
      {proof.solved ? (
        <>
          <section aria-label="Pruned proof steps">
            <h2>Pruned proof</h2>
            <p className={styles.muted}>
              {proof.steps.length} {proof.steps.length === 1 ? "step" : "steps"} from{" "}
              <code>{proof.rootNodeId}</code> to <code>{proof.leafNodeId}</code>
              {proof.removedSteps.length > 0
                ? `; ${proof.removedSteps.length} hypothesis-only ${
                    proof.removedSteps.length === 1 ? "step was" : "steps were"
                  } pruned`
                : ""}
              .
            </p>
            <ol className={styles.proofSteps} data-testid="proof-steps">
              {proof.steps.map((step) => {
                const target = stepTarget(step);
                return (
                  <li key={step.edgeId} data-edge-id={step.edgeId}>
                    <h3>
                      Step {step.number}: {step.label}
                    </h3>
                    <p>
                      <span className={styles.chip}>{step.transitionClass}</span>{" "}
                      <span className={styles.chip}>{step.evidence}</span>{" "}
                      <span className={styles.muted}>
                        acts on {step.target.kind} <code>{step.target.id}</code>
                      </span>
                    </p>
                    {target === undefined ? null : (
                      <SequentView
                        sequent={target.sequent}
                        presentation={presentation}
                        view={view}
                      />
                    )}
                    {step.motivatingRecords.length === 0 ? null : (
                      <p>
                        Motivated by:{" "}
                        {step.motivatingRecords.map((link, position) => (
                          <span key={link.recordId}>
                            {position > 0 ? ", " : ""}
                            <a href={`#${inquiryAnchor(link.recordId)}`}>
                              {link.kind} <code>{link.recordId}</code>
                            </a>{" "}
                            <span className={styles.muted}>({RELATION_LABELS[link.relation]})</span>
                          </span>
                        ))}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-label="Sorry assumptions">
            <h2>Sorry assumptions</h2>
            {proof.assumptions.length === 0 ? (
              <p data-testid="no-sorry-dependency">
                <span aria-hidden="true">✓ </span>This proof depends on no sorry assumption.
              </p>
            ) : (
              <>
                <p>This proof is stated relative to these assumptions, taken without proof.</p>
                <AssumptionList
                  assumptions={proof.assumptions}
                  presentation={presentation}
                  view={view}
                  label="Assumptions this proof depends on"
                />
                <ul aria-label="Sorry steps">
                  {proof.sorryDependencies.map((dependency) => (
                    <li key={dependency.edgeId}>
                      Edge <code>{dependency.edgeId}</code> assumed {dependency.target.kind}{" "}
                      <code>{dependency.target.id}</code> ({dependency.assumptionIds.join(", ")})
                    </li>
                  ))}
                </ul>
              </>
            )}
            {proof.backgroundInferenceEdgeIds.length > 0 ? (
              <p>
                Background inference is used at:{" "}
                {proof.backgroundInferenceEdgeIds.map((id) => (
                  <code key={id}>{id} </code>
                ))}
              </p>
            ) : null}
            {proof.unusedSorryAssumptions.length > 0 ? (
              <>
                <h3>Sorry assumptions on abandoned branches</h3>
                <AssumptionList
                  assumptions={proof.unusedSorryAssumptions}
                  presentation={presentation}
                  view={view}
                  label="Assumptions this proof does not depend on"
                />
              </>
            ) : null}
          </section>
        </>
      ) : (
        <section aria-label="Unsolved">
          <h2>No pruned proof</h2>
          <p className={styles.muted}>
            A pruned proof is the successful route only: the steps that lead from the starting point
            to a finished proof, without the branches that were set aside.
          </p>
          <p data-testid="not-solved">
            The stored discovery tree is not solved, so there is no pruned proof to show.
          </p>
          {proof.openTargets.length > 0 ? (
            <ul aria-label="Open targets">
              {proof.openTargets.map((target) => (
                <li key={target.id}>
                  Open {target.kind} <code>{target.id}</code>
                </li>
              ))}
            </ul>
          ) : null}
          {proof.sorryAssumptions.length > 0 ? (
            <AssumptionList
              assumptions={proof.sorryAssumptions}
              presentation={presentation}
              view={view}
              label="Sorry assumptions in the retained tree"
            />
          ) : null}
        </section>
      )}
      <section aria-label="Inquiry records">
        <h2>Inquiry records</h2>
        {artifact.inquiryRecords.length === 0 ? (
          <p>No inquiry records were stored for this session.</p>
        ) : (
          <ol className={styles.records}>
            {artifact.inquiryRecords.map((record) => (
              <li key={record.id} id={inquiryAnchor(record.id)}>
                <span className={styles.chip}>{record.kind}</span> <code>{record.id}</code>
                <InquiryRecordExplanation
                  record={recordsById.get(record.id) ?? record}
                  explain={explain}
                />
              </li>
            ))}
          </ol>
        )}
      </section>
    </ViewerShell>
  );
}
