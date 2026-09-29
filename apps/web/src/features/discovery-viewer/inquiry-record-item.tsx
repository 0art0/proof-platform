"use client";

import { useMemo } from "react";
import { createInquiryExplainer } from "@proof/language";
import type { InquiryRecord, ProofArtifact } from "@proof/protocol";
import { NaturalLanguageText } from "../proof-workspace/presentation";
import { inquiryExplanationContext } from "./inquiry-context";

/** Render inquiry records with the template explainer, over the artifact's stored data only. */
export function useInquiryExplanations(artifact: ProofArtifact) {
  return useMemo(() => {
    const explainer = createInquiryExplainer({ operators: artifact.initialState.operators });
    const context = inquiryExplanationContext(artifact);
    return (record: InquiryRecord) => explainer.explain(record, context);
  }, [artifact]);
}

export function InquiryRecordExplanation({
  record,
  explain,
}: Readonly<{
  record: InquiryRecord;
  explain: ReturnType<typeof useInquiryExplanations>;
}>) {
  return (
    <p data-record-id={record.id} data-record-kind={record.kind}>
      <NaturalLanguageText text={explain(record).text} />
    </p>
  );
}
