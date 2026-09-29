"use client";

import { useId, useState } from "react";
import type { Presentation } from "@proof/language";
import type {
  MenuChoices,
  ParameterMenuItemRecord,
  ProtocolRequiresInputResponse,
} from "@proof/protocol";
import type { WorkspaceView } from "../proof-workspace";
import { InlineLatex, StatementView } from "../proof-workspace/presentation";
import styles from "./suggestion-panel.module.css";

export type DisplayedParameterMenu = ProtocolRequiresInputResponse["menus"][number];
type ViewProps = Readonly<{ presentation: Presentation; view: WorkspaceView }>;

/** A menu item's stored label: prose, a proposition, or a term, in the selected view. */
export function MenuItemLabel({
  item,
  presentation,
  view,
}: ViewProps & Readonly<{ item: ParameterMenuItemRecord }>) {
  if (item.label.kind === "text") return <span>{item.label.text}</span>;
  return item.value.kind === "proposition" ? (
    <StatementView expression={item.label.expression} presentation={presentation} view={view} />
  ) : (
    <InlineLatex latex={presentation.latex(item.label.expression)} />
  );
}

const ORIGINS: Readonly<Record<ParameterMenuItemRecord["origin"]["kind"], string>> = {
  selection: "from the selection",
  declaration: "declared variable",
  "subterm-of": "term of the statement",
  conclusion: "from the conclusion",
  hypothesis: "from a hypothesis",
  assumption: "additional assumption",
  result: "library result",
  attestation: "attestation",
  rule: "rule option",
  generated: "generated",
};

export type ParameterMenuProps = ViewProps &
  Readonly<{
    suggestionName: string;
    menus: readonly DisplayedParameterMenu[];
    missingParameters: readonly string[];
    /** Choices already submitted in an earlier round; they stay selected. */
    choices: MenuChoices;
    pending: boolean;
    onSubmit: (choices: MenuChoices) => void;
    onCancel: () => void;
  }>;

/**
 * The input menus the proof service returned for a move that needs input. The user can only
 * pick among the listed items: the submitted choices are menu item IDs, never expressions.
 */
export function ParameterMenu({
  suggestionName,
  menus,
  missingParameters,
  choices: submitted,
  pending,
  onSubmit,
  onCancel,
  presentation,
  view,
}: ParameterMenuProps) {
  const [choices, setChoices] = useState<MenuChoices>(() => ({ ...submitted }));
  const groupId = useId();
  const missing = new Set(missingParameters);
  const complete = missingParameters.every((parameterId) => choices[parameterId] !== undefined);
  const submit = () => {
    // Keep only choices that name an item of a displayed menu.
    const valid: MenuChoices = {};
    for (const menu of menus) {
      const itemId = choices[menu.parameterId];
      if (itemId !== undefined && menu.items.some(({ id }) => id === itemId)) {
        valid[menu.parameterId] = itemId;
      }
    }
    onSubmit(valid);
  };
  return (
    <form
      className={styles.parameterMenu}
      aria-label={`Parameter menus for ${suggestionName}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !pending) submit();
      }}
    >
      <strong>Choose inputs from the menus</strong>
      {menus.map((menu, menuIndex) => {
        const legendId = `${groupId}-${menuIndex}`;
        if (menu.automatic && !missing.has(menu.parameterId)) {
          return (
            <div
              key={menu.parameterId}
              className={styles.menuGroup}
              data-parameter-id={menu.parameterId}
            >
              <span id={legendId} className={styles.menuLegend}>
                {menu.label} <small>(chosen automatically)</small>
              </span>
              <ul aria-labelledby={legendId}>
                {menu.items.map((item) => (
                  <li key={item.id}>
                    <MenuItemLabel item={item} presentation={presentation} view={view} />
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        return (
          <fieldset
            key={menu.parameterId}
            className={styles.menuGroup}
            data-parameter-id={menu.parameterId}
          >
            <legend className={styles.menuLegend}>
              {menu.label}
              {missing.has(menu.parameterId) ? <small> (required)</small> : null}
            </legend>
            {menu.items.length === 0 ? (
              <p>The proof service offered no items for this input.</p>
            ) : (
              menu.items.map((item) => (
                <label key={item.id} className={styles.menuItem} data-menu-item-id={item.id}>
                  <input
                    type="radio"
                    name={`${groupId}:${menu.parameterId}`}
                    value={item.id}
                    checked={choices[menu.parameterId] === item.id}
                    disabled={pending}
                    onChange={() =>
                      setChoices((current) => ({ ...current, [menu.parameterId]: item.id }))
                    }
                  />
                  <span className={styles.menuAlias} aria-hidden="true">
                    {item.alias}
                  </span>
                  <MenuItemLabel item={item} presentation={presentation} view={view} />
                  <small className={styles.menuOrigin}>{ORIGINS[item.origin.kind]}</small>
                </label>
              ))
            )}
          </fieldset>
        );
      })}
      <div className={styles.menuActions}>
        <button type="submit" disabled={!complete || pending}>
          {pending ? "Previewing…" : "Preview with these inputs"}
        </button>
        <button type="button" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
