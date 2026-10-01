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
      <h2 id="recent-sessions">Recent proofs</h2>
      <ul>
        {sessions.map((session) => (
          <li key={session.id}>
            <Link
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
