"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { Presentation } from "@proof/language";
import { z } from "zod";
import type { WorkspaceView } from "../proof-workspace";
import {
  LIBRARY_KINDS,
  LIBRARY_LAYERS,
  sessionLibraryEventsSchema,
  sessionLibrarySchema,
  type LibraryEntry,
  type SessionLibrary,
  type SessionLibraryEvents,
} from "./api-contract";
import { DragHandle } from "../gestures/gesture-ui";
import type { GestureBindings } from "../gestures/use-drag-gestures";
import { LibraryDetail } from "./library-detail";
import { LibraryEvents } from "./library-events";
import {
  EMPTY_FILTER,
  approvalStatusLabel,
  availableDomains,
  entryKey,
  filterEntries,
  groupByLayer,
  kindLabel,
  layerCounts,
  layerLabel,
  provenanceLabel,
  sourceLabel,
  type LibraryFilter,
} from "./library-view-model";
import styles from "./library-drawer.module.css";

type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; library: SessionLibrary; events: SessionLibraryEvents }>
  | Readonly<{ kind: "failed"; message: string }>;

type Tab = "artifacts" | "events";

export type LibraryDrawerProps = Readonly<{
  sessionId: string;
  presentation: Presentation;
  view: WorkspaceView;
  /** When present, result rows can be dragged onto an expression (design plan §8.3). */
  gestures?: GestureBindings | undefined;
}>;

/**
 * The library drawer (design plan §17.1, roadmap N32): a read-only, non-modal panel showing the
 * session's layers, searchable and filterable by kind, domain and layer, with artifact detail
 * views and the session's addition events. Escape closes it and returns focus to its toggle.
 * Adding artifacts is not offered here; the protocol envelope owns additions.
 */
export function LibraryDrawer({ sessionId, presentation, view, gestures }: LibraryDrawerProps) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    toggle.current?.focus();
  }, []);

  return (
    <div className={styles.drawerShell}>
      <button
        ref={toggle}
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Library
      </button>
      {open ? (
        <DrawerPanel
          id={panelId}
          sessionId={sessionId}
          presentation={presentation}
          view={view}
          gestures={gestures}
          onClose={close}
        />
      ) : null}
    </div>
  );
}

function DrawerPanel({
  id,
  sessionId,
  presentation,
  view,
  gestures,
  onClose,
}: LibraryDrawerProps & Readonly<{ id: string; onClose: () => void }>) {
  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("artifacts");
  const [filter, setFilter] = useState<LibraryFilter>(EMPTY_FILTER);
  const [selectedKey, setSelectedKey] = useState<string>();
  const [returnKey, setReturnKey] = useState<string>();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    void loadLibrary(sessionId, controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [sessionId]);

  // Focus enters the drawer: the search field once loaded, else the heading.
  const ready = state.kind === "ready";
  useEffect(() => {
    (panel.current?.querySelector<HTMLElement>('input[type="search"]') ?? heading.current)?.focus();
  }, [ready]);

  useEffect(() => {
    // Capture phase: Escape closes the drawer when focus is inside it and is consumed, so it
    // does not also clear the proof selection.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || panel.current === null) return;
      if (!panel.current.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  // Returning from a detail view restores focus to the artifact that was open.
  useEffect(() => {
    if (selectedKey !== undefined || returnKey === undefined) return;
    panel.current
      ?.querySelector<HTMLElement>(`[data-entry-key="${CSS.escape(returnKey)}"]`)
      ?.focus();
  }, [selectedKey, returnKey]);

  const entries = state.kind === "ready" ? state.library.entries : [];
  const domains = useMemo(() => availableDomains(entries), [entries]);
  const shown = useMemo(() => filterEntries(entries, filter), [entries, filter]);
  const selected =
    selectedKey === undefined
      ? undefined
      : entries.find((entry) => entryKey(entry) === selectedKey);

  const select = (entry: LibraryEntry) => {
    setSelectedKey(entryKey(entry));
    setReturnKey(entryKey(entry));
  };

  return (
    <aside ref={panel} id={id} className={styles.panel} aria-labelledby={`${id}-title`}>
      <header className={styles.panelHeader}>
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
          Library
        </h3>
        <button type="button" className={styles.closeButton} onClick={onClose}>
          Close <kbd aria-hidden="true">Esc</kbd>
        </button>
      </header>
      <p className={styles.muted}>
        Browse the definitions, results and moves available in this proof. Select an entry to see
        its statement and source.
        {gestures === undefined ? null : " Drag a result onto a statement to preview it."}
      </p>

      {state.kind === "loading" ? (
        <p role="status" className={styles.muted}>
          Loading the library…
        </p>
      ) : state.kind === "failed" ? (
        <p role="alert" className={styles.failure}>
          {state.message}
        </p>
      ) : (
        <>
          {state.library.readOnly ? (
            <p className={styles.muted} data-read-only>
              Read-only session: this is the artifact&apos;s stored library.
            </p>
          ) : null}
          <div role="group" aria-label="Library sections" className={styles.tabs}>
            <button
              type="button"
              aria-pressed={tab === "artifacts"}
              onClick={() => setTab("artifacts")}
            >
              Artifacts ({entries.length})
            </button>
            <button type="button" aria-pressed={tab === "events"} onClick={() => setTab("events")}>
              Addition events ({state.events.events.length})
            </button>
          </div>
          {tab === "events" ? (
            <LibraryEvents events={state.events.events} />
          ) : selected !== undefined ? (
            <div>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => setSelectedKey(undefined)}
              >
                ← Back to list
              </button>
              <LibraryDetail
                entry={selected}
                entries={entries}
                variantFamilies={state.library.variantFamilies}
                presentation={presentation}
                view={view}
                onSelect={select}
              />
            </div>
          ) : (
            <>
              <p className={styles.layerSummary} data-layer-summary>
                {layerCounts(entries)
                  .map(({ layer, count }) => `${layerLabel(layer)}: ${count}`)
                  .join(" · ")}
              </p>
              <FilterControls filter={filter} domains={domains} onChange={setFilter} />
              <p role="status" className={styles.muted}>
                {shown.length} of {entries.length} artifacts
              </p>
              {groupByLayer(shown).map((group) => (
                <section key={group.layer} aria-label={layerLabel(group.layer)}>
                  <h4 className={styles.layerHeading}>
                    {layerLabel(group.layer)} ({group.entries.length})
                  </h4>
                  <ul className={styles.list}>
                    {group.entries.map((entry) => (
                      <li key={entryKey(entry)}>
                        <button
                          type="button"
                          className={styles.item}
                          data-entry-key={entryKey(entry)}
                          onClick={() => select(entry)}
                        >
                          <span className={styles.itemName}>{entry.artifact.name}</span>
                          <span className={styles.itemMeta}>
                            {kindLabel(entry.artifact.kind)} ·{" "}
                            {entry.artifact.classification.domains.join(", ")} ·{" "}
                            {approvalStatusLabel(entry.artifact.approval)} ·{" "}
                            {sourceLabel(entry.source)}
                          </span>
                          <span className={styles.itemMeta}>
                            {provenanceLabel(entry.artifact.provenance)}
                          </span>
                        </button>
                        {gestures !== undefined && entry.artifact.kind === "result" ? (
                          <DragHandle
                            source={{
                              kind: "result",
                              artifactId: entry.artifact.id,
                              label: entry.artifact.name,
                            }}
                            label={`result ${entry.artifact.name}`}
                            bindings={gestures}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </>
      )}
    </aside>
  );
}

function FilterControls({
  filter,
  domains,
  onChange,
}: Readonly<{
  filter: LibraryFilter;
  domains: readonly string[];
  onChange: (filter: LibraryFilter) => void;
}>) {
  const id = useId();
  return (
    <div className={styles.filters} role="search" aria-label="Filter library">
      <label htmlFor={`${id}-q`}>Search</label>
      <input
        id={`${id}-q`}
        type="search"
        value={filter.query}
        placeholder="Name, statement, domain…"
        onChange={(event) => onChange({ ...filter, query: event.target.value })}
      />
      <label htmlFor={`${id}-kind`}>Kind</label>
      <select
        id={`${id}-kind`}
        value={filter.kind}
        onChange={(event) =>
          onChange({ ...filter, kind: event.target.value as LibraryFilter["kind"] })
        }
      >
        <option value="all">All kinds</option>
        {LIBRARY_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {kindLabel(kind)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-domain`}>Domain</label>
      <select
        id={`${id}-domain`}
        value={filter.domain}
        onChange={(event) => onChange({ ...filter, domain: event.target.value })}
      >
        <option value="all">All domains</option>
        {domains.map((domain) => (
          <option key={domain} value={domain}>
            {domain}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-layer`}>Layer</label>
      <select
        id={`${id}-layer`}
        value={filter.layer}
        onChange={(event) =>
          onChange({ ...filter, layer: event.target.value as LibraryFilter["layer"] })
        }
      >
        <option value="all">All layers</option>
        {LIBRARY_LAYERS.map((layer) => (
          <option key={layer} value={layer}>
            {layerLabel(layer)}
          </option>
        ))}
      </select>
    </div>
  );
}

const envelope = <Data extends z.ZodType>(data: Data) =>
  z.union([
    z.object({ ok: z.literal(true), data }).passthrough(),
    z
      .object({
        ok: z.literal(false),
        error: z.object({ message: z.string() }).passthrough(),
      })
      .passthrough(),
  ]);

async function loadLibrary(sessionId: string, signal: AbortSignal): Promise<LoadState> {
  const base = `/api/proof-sessions/${encodeURIComponent(sessionId)}/library`;
  try {
    const [libraryResponse, eventsResponse] = await Promise.all([
      fetch(base, { cache: "no-store", signal }),
      fetch(`${base}/events`, { cache: "no-store", signal }),
    ]);
    const library = envelope(sessionLibrarySchema).safeParse(await libraryResponse.json());
    const events = envelope(sessionLibraryEventsSchema).safeParse(await eventsResponse.json());
    if (!library.success || !events.success) {
      return { kind: "failed", message: "The library service returned an invalid response." };
    }
    if (!library.data.ok) return { kind: "failed", message: library.data.error.message };
    if (!events.data.ok) return { kind: "failed", message: events.data.error.message };
    return {
      kind: "ready",
      library: library.data.data as SessionLibrary,
      events: events.data.data as SessionLibraryEvents,
    };
  } catch {
    return { kind: "failed", message: "The library could not be reached." };
  }
}
