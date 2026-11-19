import type { Presentation } from "@proof/language";
import { canonicalJsonEquals } from "@proof/mathjson-model";
import type { ProblemSetupOptions, ProofNode } from "@proof/protocol";
import { NaturalLanguageText } from "../proof-workspace/presentation";
import { Formula } from "./typeset";
import styles from "./problem-entry.module.css";

export function SetupStatements({
  node,
  presentation,
  sorts,
}: Readonly<{ node: ProofNode; presentation: Presentation; sorts: ProblemSetupOptions["sorts"] }>) {
  const context = node.state.goals[0]?.sequent.context;
  return (
    <>
      <dt>Variables and objects</dt>
      <dd>
        {context === undefined || context.declarations.length === 0
          ? "None"
          : context.declarations.map((declaration) => (
              <code key={declaration.id} className={styles.token}>
                {declaration.symbol}: {sortLabel(sorts, declaration.sort)}
              </code>
            ))}
      </dd>
      <dt>Hypotheses</dt>
      <dd>
        {context === undefined || context.hypotheses.length === 0 ? (
          "None"
        ) : (
          <ol>
            {context.hypotheses.map((hypothesis) => (
              <li key={hypothesis.id}>
                <Rendered
                  presentation={presentation}
                  expression={hypothesis.statement.expression}
                />
              </li>
            ))}
          </ol>
        )}
      </dd>
      <dt>Goals</dt>
      <dd>
        <ol>
          {node.state.goals.map((target) => (
            <li key={target.id}>
              <Rendered
                presentation={presentation}
                expression={target.sequent.conclusion.expression}
              />
            </li>
          ))}
        </ol>
      </dd>
    </>
  );
}

export function Rendered({
  presentation,
  expression,
}: Readonly<{
  presentation: Presentation;
  expression: Parameters<Presentation["latex"]>[0];
}>) {
  return (
    <span className={styles.rendered}>
      <Formula latex={presentation.latex(expression)} />
      <span className={styles.prose}>
        <NaturalLanguageText text={presentation.naturalLanguage(expression)} />
      </span>
    </span>
  );
}

function sortLabel(sorts: ProblemSetupOptions["sorts"], sort: unknown): string {
  return (
    sorts.find((choice) => canonicalJsonEquals(choice.sort, sort))?.label ?? JSON.stringify(sort)
  );
}
