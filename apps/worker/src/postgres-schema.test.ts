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
  });
});

describe("constant activations migration", () => {
  const sql = normalizedSql(
    readFileSync(new URL("../migrations/0018_constant_activations.sql", import.meta.url), "utf8"),
  );

  it("keys an activation by session and symbol, numbers them per session and mirrors the record", () => {
    expect(sql).toContain("create table proof_constant_activations");
    expect(sql).toContain("primary key (session_id, symbol)");
    expect(sql).toContain("unique (session_id, sequence)");
    expect(sql).toContain("(record ->> 'commandid') is not distinct from command_id".toLowerCase());
    expect(sql).toContain("(record -> 'sequence') is not distinct from to_jsonb(sequence)");
  });

  it("outlives the step: no foreign key to commands, edges or nodes, only to the session", () => {
    expect(sql).toContain(
      "foreign key (session_id) references proof_sessions (id) on delete cascade",
    );
    expect(sql).not.toMatch(/references proof_(commands|edges|nodes|events)/);
  });
});
