import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0007_interaction_events.sql", import.meta.url),
  "utf8",
);

function normalizedSql(sql: string): string {
  return sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

describe("interaction-event migration", () => {
  const sql = normalizedSql(migration);

  it("keys events by client ID and orders them by a unique per-session sequence", () => {
    expect(sql).toContain("create table proof_interaction_events (");
    expect(sql).toContain("primary key (session_id, id)");
    expect(sql).toContain("unique (session_id, sequence)");
    expect(sql).toContain("sequence integer not null check (sequence >= 1)");
  });

  it("anchors every event to an existing node snapshot and mirrors JSONB identities", () => {
    expect(sql).toContain(
      "foreign key (session_id, node_id, state_id) references proof_nodes (session_id, id, state_id)",
    );
    for (const [path, column] of [
      ["->> 'id'", "id"],
      ["->> 'nodeid'", "node_id"],
      ["->> 'stateid'", "state_id"],
      ["->> 'kind'", "kind"],
      ["->> 'previewid'", "preview_id"],
      ["->> 'stalepreviewid'", "stale_preview_id"],
    ]) {
      expect(sql).toContain(`check ((record ${path}) is not distinct from ${column})`);
    }
    expect(sql).toContain("check ((record -> 'sequence') is not distinct from to_jsonb(sequence))");
  });

  it("runs atomically without rewriting existing data", () => {
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/\b(?:insert into|update \w+ set|delete from)\b/);
  });
});
