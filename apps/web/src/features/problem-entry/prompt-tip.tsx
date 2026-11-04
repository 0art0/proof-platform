"use client";

import { useId, useState } from "react";
import styles from "./problem-entry.module.css";

/**
 * An ⓘ beside an AI step that shows exactly what the model is told: the role's fixed system
 * message, published by the worker. It opens on hover and keyboard focus, and stays open when
 * clicked, so it also works on touch screens.
 */
export function PromptTip({
  label,
  prompt,
}: Readonly<{ label: string; prompt: string | undefined }>) {
  const [pinned, setPinned] = useState(false);
  const id = useId();
  if (prompt === undefined) return null;
  return (
    <span className={styles.promptTip} data-open={pinned}>
      <button
        type="button"
        className={styles.promptTipButton}
        aria-label={`What the model is told: ${label}`}
        aria-describedby={id}
        aria-expanded={pinned}
        onClick={() => setPinned((open) => !open)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setPinned(false);
        }}
      >
        i
      </button>
      <span role="tooltip" id={id} className={styles.promptTipBody}>
        <strong>{label}</strong>
        {prompt}
      </span>
    </span>
  );
}
