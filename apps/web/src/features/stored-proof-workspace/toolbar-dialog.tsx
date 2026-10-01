"use client";

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import styles from "./toolbar-actions.module.css";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

export type ToolbarDialogProps = Readonly<{
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}>;

/**
 * A modal dialog for one toolbar action. Focus moves into it when it opens, Tab stays inside, and
 * Escape closes it; the Escape is consumed, so it never also clears the proof selection. Closing
 * returns focus to the control that opened it.
 */
export function ToolbarDialog({ title, description, onClose, children }: ToolbarDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The first control of the body (not the Close button), else the dialog itself.
    const first = body.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    // On a small screen the dialog may start below the fold: bring it into view.
    panel.current?.scrollIntoView?.({ block: "nearest" });
    // Capture phase: the dialog sees Escape before the workspace's selection shortcut does.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const trapTab = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || panel.current === null) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.backdrop}>
      <div
        ref={panel}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...(description === undefined ? {} : { "aria-describedby": descriptionId })}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <header className={styles.dialogHeader}>
          <h2 id={titleId}>{title}</h2>
          <button type="button" className={styles.closeButton} onClick={onClose}>
            Close <kbd aria-hidden="true">Esc</kbd>
          </button>
        </header>
        {description === undefined ? null : (
          <div id={descriptionId} className={styles.dialogDescription}>
            {description}
          </div>
        )}
        <div ref={body} className={styles.dialogBody}>
          {children}
        </div>
      </div>
    </div>
  );
}
