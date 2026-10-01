/**
 * A per-browser list of recently created or opened sessions, so a newcomer does not have to
 * remember `session:<uuid>`. It is a convenience only: every access is guarded, and the landing
 * page works the same without storage.
 */
export type RecentSession = Readonly<{ id: string; title?: string | undefined }>;

export const RECENT_SESSIONS_KEY = "proof-platform.recent-sessions.v1";
const MAX_RECENT = 8;

export function readRecentSessions(): readonly RecentSession[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_SESSIONS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((entry: unknown): RecentSession[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const { id, title } = entry as Readonly<{ id?: unknown; title?: unknown }>;
        if (typeof id !== "string" || id.length === 0) return [];
        return [typeof title === "string" && title.length > 0 ? { id, title } : { id }];
      })
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Move `session` to the front, keeping a known title when the new record has none. */
export function recordRecentSession(session: RecentSession): void {
  try {
    const previous = readRecentSessions();
    const title = session.title ?? previous.find(({ id }) => id === session.id)?.title;
    const next: RecentSession[] = [
      title === undefined ? { id: session.id } : { id: session.id, title },
      ...previous.filter(({ id }) => id !== session.id),
    ].slice(0, MAX_RECENT);
    window.localStorage.setItem(RECENT_SESSIONS_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable or full; the list is only a convenience.
  }
}
