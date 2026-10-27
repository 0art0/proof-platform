import type { SetupStep } from "./setup-progress";
import styles from "./problem-entry.module.css";

/**
 * The rail beside the form: where the setup stands, with a link to each step's section. It only
 * displays what `deriveSetupProgress` read from the form; following a link changes nothing.
 */
export function SetupProgressPanel({
  steps,
  onFollow,
}: Readonly<{
  steps: readonly SetupStep[];
  /** Called before the browser follows a step's link, so a collapsed section can open first. */
  onFollow?: (step: SetupStep) => void;
}>) {
  return (
    <nav className={styles.rail} aria-label="Setup progress">
      <h2 className={styles.railTitle}>Setup progress</h2>
      <ol className={styles.steps}>
        {steps.map((step, index) => (
          <li key={step.id} className={styles.step} data-state={step.state}>
            <div className={styles.stepTrack}>
              <span className={styles.marker} aria-hidden="true">
                {step.state === "done" ? "✓" : index + 1}
              </span>
              {index === steps.length - 1 ? null : (
                <span className={styles.stepLine} aria-hidden="true" />
              )}
            </div>
            <div className={styles.stepBody}>
              <a
                className={styles.stepLink}
                href={`#${step.target}`}
                aria-current={step.state === "current" ? "step" : undefined}
                onClick={() => onFollow?.(step)}
              >
                {step.label}
              </a>
              <span className={styles.stepStatus}>
                {step.state === "done" ? (
                  <span className="visually-hidden">Completed. </span>
                ) : null}
                {step.status}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}
