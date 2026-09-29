"use client";

import type { LibraryAdditionEventView } from "./api-contract";
import {
  admissionLabel,
  approvalStatusLabel,
  kindLabel,
  layerLabel,
  originLabel,
} from "./library-view-model";
import styles from "./library-drawer.module.css";

/**
 * The session's addition events in sequence order (design plan §12.4). Admitted and rejected
 * additions are both shown; a rejection lists the gate's diagnostics and added nothing.
 */
export function LibraryEvents({
  events,
}: Readonly<{ events: readonly LibraryAdditionEventView[] }>) {
  if (events.length === 0) return <p className={styles.muted}>No additions were recorded.</p>;
  return (
    <ol className={styles.events} aria-label="Addition events">
      {events.map((event) => (
        <li
          key={event.id}
          className={styles.event}
          data-event={event.id}
          data-decision={event.admission.decision}
        >
          <p className={styles.eventHead}>
            <span className={styles.badge} data-decision={event.admission.decision}>
              <span aria-hidden="true">{event.admission.decision === "admitted" ? "+" : "×"}</span>{" "}
              {admissionLabel(event)}
            </span>{" "}
            <strong>{event.artifact.name}</strong> <code>{event.artifact.id}</code>
          </p>
          <p className={styles.muted}>
            #{event.sequence} · {event.occurredAt} · {kindLabel(event.artifact.kind)} in{" "}
            {layerLabel(event.layer)} · by {originLabel(event.origin)} ·{" "}
            {approvalStatusLabel(event.approval)}
          </p>
          {event.admission.decision === "rejected" ? (
            <ul className={styles.diagnostics} aria-label="Rejection diagnostics">
              {event.admission.diagnostics.map((diagnostic, index) => (
                <li key={index}>
                  <code>{diagnostic.code}</code>: {diagnostic.message}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
