"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readRecentSessions, recordRecentSession, type RecentSession } from "./recent-sessions";
import styles from "./problem-entry.module.css";

/** Sessions this browser created or opened lately; renders nothing when there are none. */
export function RecentSessionsList() {
  const [sessions, setSessions] = useState<readonly RecentSession[]>([]);
  useEffect(() => setSessions(readRecentSessions()), []);
  if (sessions.length === 0) return null;
  return (
    <section className={styles.recent} aria-labelledby="recent-sessions">
      <div className={styles.recentHeader}>
        <h2 id="recent-sessions">Recent proofs</h2>
        <span className={styles.count}>{sessions.length}</span>
      </div>
      <ul className={styles.recentList}>
        {sessions.map((session) => (
          <li key={session.id} className={styles.recentItem}>
            <Link
              className={
                session.title === undefined
                  ? `${styles.recentLink} ${styles.recentLinkId}`
                  : styles.recentLink
              }
              href={`/sessions/${encodeURIComponent(session.id)}`}
              title={session.id}
              onClick={() => recordRecentSession(session)}
            >
              {session.title ?? session.id}
            </Link>
            {session.title === undefined ? null : (
              <span className={styles.recentId}>{session.id}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
