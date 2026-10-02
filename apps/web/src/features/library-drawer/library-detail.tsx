"use client";

import type { Presentation } from "@proof/language";
import { LemmaReviewSection, type LemmaReviewHandler } from "../conditional-lemma";
import type { WorkspaceView } from "../proof-workspace";
import { StatementView } from "../proof-workspace/presentation";
import type { LibraryArtifactView, LibraryEntry, VariantFamilyView } from "./api-contract";
import {
  approvalLabel,
  kindLabel,
  layerLabel,
  provenanceLabel,
  sourceLabel,
  variantFamilyDetail,
} from "./library-view-model";
import styles from "./library-drawer.module.css";

type Declarations = Parameters<typeof StatementView>[0]["declarations"];

export type LibraryDetailProps = Readonly<{
  entry: LibraryEntry;
  entries: readonly LibraryEntry[];
  variantFamilies: readonly VariantFamilyView[];
  presentation: Presentation;
  view: WorkspaceView;
  onSelect: (entry: LibraryEntry) => void;
  /** Reviewing saved lemma drafts (N44); absent when reviewing is not offered. */
  lemmaReview?: Readonly<{ readOnly: boolean; onReview: LemmaReviewHandler }> | undefined;
}>;

/**
 * One artifact, as stored: statement, premises, application directions, variant family,
 * provenance and approval. Statements are rendered read-only from the stored MathJSON.
 */
export function LibraryDetail({
  entry,
  entries,
  variantFamilies,
  presentation,
  view,
  onSelect,
  lemmaReview,
}: LibraryDetailProps) {
  const { artifact } = entry;
  const declarations = artifact.parameters as unknown as Declarations;
  const family = variantFamilyDetail(artifact, variantFamilies, entries);
  return (
    <article className={styles.detail} aria-label={`${artifact.name} details`} data-detail>
      <h4 className={styles.detailTitle}>{artifact.name}</h4>
      <dl className={styles.facts}>
        <Fact label="ID">
          <code>{artifact.id}</code>
        </Fact>
        <Fact label="Kind">{kindLabel(artifact.kind)}</Fact>
        <Fact label="Layer">{layerLabel(artifact.layer)}</Fact>
        <Fact label="Source">{sourceLabel(entry.source)}</Fact>
        <Fact label="Domains">{artifact.classification.domains.join(", ")}</Fact>
        <Fact label="Level">{artifact.classification.level}</Fact>
        <Fact label="Origin">{provenanceLabel(artifact.provenance)}</Fact>
        <Fact label="Approval">
          <span data-approval={artifact.approval.status}>{approvalLabel(artifact.approval)}</span>
        </Fact>
      </dl>
      <p className={styles.description}>{artifact.description}</p>
      {lemmaReview === undefined ? null : (
        <LemmaReviewSection
          artifact={artifact}
          entries={entries}
          readOnly={lemmaReview.readOnly}
          onReview={lemmaReview.onReview}
        />
      )}

      {artifact.statement === undefined ? null : (
        <section aria-label="Statement">
          <h5>Statement</h5>
          <p className={styles.statement} data-statement>
            <StatementView
              expression={artifact.statement.expression}
              declarations={declarations}
              presentation={presentation}
              view={view}
            />
          </p>
        </section>
      )}
      {artifact.premises === undefined ? null : (
        <section aria-label="Premises">
          <h5>Premises</h5>
          {artifact.premises.length === 0 ? (
            <p className={styles.muted}>No premises.</p>
          ) : (
            <ol className={styles.premises}>
              {artifact.premises.map((premise, index) => (
                <li key={index} data-premise>
                  <StatementView
                    expression={premise.expression}
                    declarations={declarations}
                    presentation={presentation}
                    view={view}
                  />
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {artifact.sideConditions === undefined || artifact.sideConditions.length === 0 ? null : (
        <section aria-label="Side conditions">
          <h5>Side conditions</h5>
          <ul>
            {artifact.sideConditions.map((condition) => (
              <li key={condition.id}>{condition.description}</li>
            ))}
          </ul>
        </section>
      )}
      {artifact.applicationDirections === undefined ? null : (
        <section aria-label="Application directions">
          <h5>Directions</h5>
          <p data-directions>
            {artifact.applicationDirections.length === 0
              ? "None"
              : artifact.applicationDirections.join(", ")}
          </p>
        </section>
      )}
      {artifact.steps === undefined ? null : (
        <section aria-label="Technique steps">
          <h5>Steps</h5>
          <ol>
            {artifact.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </section>
      )}
      <VariantSection
        artifact={artifact}
        family={family}
        onSelect={onSelect}
        entryId={entry.artifact.id}
      />
      {artifact.related.length === 0 ? null : (
        <section aria-label="Related artifacts">
          <h5>Related</h5>
          <ul>
            {artifact.related.map((reference) => (
              <li key={`${reference.kind}:${reference.id}`}>
                {reference.kind} <code>{reference.id}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

function VariantSection({
  artifact,
  family,
  onSelect,
  entryId,
}: Readonly<{
  artifact: LibraryArtifactView;
  family: ReturnType<typeof variantFamilyDetail>;
  onSelect: (entry: LibraryEntry) => void;
  entryId: string;
}>) {
  const isVariant = artifact.provenance.kind === "derived-variant";
  if (family === undefined && !isVariant) return null;
  return (
    <section aria-label="Variants">
      <h5>Variants</h5>
      {isVariant ? <p>{provenanceLabel(artifact.provenance)}</p> : null}
      {family === undefined ? null : (
        <>
          <p>
            Family: {family.family.name} (<code>{family.family.id}</code>)
          </p>
          <ul>
            {family.members.map(({ id, entry }) => (
              <li key={id}>
                {id === entryId ? (
                  <span>
                    <code>{id}</code> (this artifact)
                  </span>
                ) : entry === undefined ? (
                  <span>
                    <code>{id}</code> (not in this library)
                  </span>
                ) : (
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => onSelect(entry)}
                  >
                    {entry.artifact.name} <code>{id}</code>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Fact({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
