import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0003_proof_event_provenance.sql", import.meta.url),
  "utf8",
);

function normalizedSql(sql: string): string {
  return sql.replace(/--.*$/gm, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

describe("proof event provenance migration", () => {
  const sql = normalizedSql(migration);
  const generatedProvenanceKey =
    "provenance_key text[] generated always as " +
    "( array[suggestion_set_id, chosen_suggestion_id, preview_id] ) stored not null";

  it("stores the ordered null-safe provenance tuple on edges and events", () => {
    expect(sql).toContain(`alter table proof_edges add column ${generatedProvenanceKey};`);
    expect(sql).toContain(`alter table proof_events add column ${generatedProvenanceKey};`);
    expect(sql.split("generated always as")).toHaveLength(3);
  });

  it("keys edges and links events using the complete generated provenance tuple", () => {
    expect(sql).toContain(
      "alter table proof_edges " +
        "add constraint proof_edges_provenance_key_unique " +
        "unique (session_id, id, provenance_key);",
    );
    expect(sql).toContain(
      "alter table proof_events " +
        "add constraint proof_events_edge_provenance_key_fk " +
        "foreign key (session_id, edge_id, provenance_key) " +
        "references proof_edges (session_id, id, provenance_key);",
    );
  });

  it("validates atomically without nullable-key fallbacks or data repair", () => {
    expect(sql.startsWith("begin;")).toBe(true);
    expect(sql.endsWith("commit;")).toBe(true);
    expect(sql).not.toMatch(/\bnot valid\b/);
    expect(sql).not.toMatch(/\bmatch full\b/);
    expect(sql).not.toMatch(/\bcoalesce\s*\(/);
    expect(sql).not.toMatch(/\b(?:insert|update|delete)\b/);
  });
});
