import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MemoryLibraryStore } from "./memory-library-store";
import { DEFAULT_MIGRATIONS_DIRECTORY, loadMigrations } from "./migrations/runner";
import { SESSION_TABLES_IN_DELETION_ORDER } from "./postgres-proof-store";

/**
 * N36: schema coverage. The PostgreSQL stores' SQL is checked against the tables and columns the
 * migrations create, and every entity the memory store holds must have a migration counterpart,
 * so a new entity cannot ship without a migration (or the reverse).
 */

type Schema = Map<string, { columns: Set<string>; references: Set<string> }>;

const migrations = await loadMigrations(DEFAULT_MIGRATIONS_DIRECTORY);
const schema = migrationSchema(migrations.map((migration) => migration.sql));

const STORE_SOURCES = [
  "postgres-proof-store.ts",
  "postgres-library-store.ts",
  "postgres-llm-call-store.ts",
].map((file) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));

/** Memory-store table name to the SQL table it mirrors. */
const MEMORY_PROOF_TABLES: Readonly<Record<string, string>> = {
  sessions: "proof_sessions",
  nodes: "proof_nodes",
  suggestionSets: "proof_suggestion_sets",
  previews: "proof_previews",
  edges: "proof_edges",
  events: "proof_events",
  commands: "proof_commands",
  deletions: "proof_deletions",
  interactionEvents: "proof_interaction_events",
  replaySteps: "proof_replay_steps",
  inquiryRecords: "proof_inquiry_records",
  artifactImports: "proof_artifact_imports",
};

const MEMORY_LIBRARY_TABLES: Readonly<Record<string, string>> = {
  events: "library_addition_events",
  artifacts: "library_artifacts",
  revisions: "library_background_revisions",
  operators: "library_operators",
};

/** Columns that carry entity state the memory store keeps as fields of another entity. */
const MEMORY_SESSION_FIELDS: Readonly<Record<string, string>> = {
  metadata: "metadata",
  readOnly: "read_only",
  visibility: "visibility",
};

describe("migration schema", () => {
  it("defines the columns and tables used by 0004, 0011 and 0012 additions", () => {
    const sessions = schema.get("proof_sessions")?.columns;
    for (const column of ["metadata", "read_only", "visibility"]) {
      expect(sessions, column).toContain(column);
    }
    expect(schema.get("proof_edges")?.columns).toContain("provenance_key");
    expect(schema.get("proof_events")?.columns).toContain("provenance_key");
  });

  it("defines the stored transition evidence and sequence columns (0013)", () => {
    for (const table of ["proof_edges", "proof_events"]) {
      const columns = schema.get(table)?.columns;
      expect(columns, table).toContain("evidence");
      expect(columns, table).toContain("transition_sequence");
    }
    const sql = migrations.find((m) => m.name.startsWith("0013_"))?.sql ?? "";
    // Per-session uniqueness of the sequence, the event-to-edge link, and the record mirror.
    expect(sql).toContain("UNIQUE (session_id, transition_sequence)");
    expect(sql).toContain("proof_events_edge_evidence_key_fk");
    expect(sql).toContain(
      "(record -> 'sequence') IS NOT DISTINCT FROM to_jsonb(transition_sequence)",
    );
    expect(sql).toContain("(record ->> 'evidence') IS NOT DISTINCT FROM evidence");
    // It adds columns only: existing rows are neither inferred nor rewritten.
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it("keeps the event provenance constraint (0003) and the discarding client release", () => {
    const provenance = migrations.find((m) => m.name.startsWith("0003_"))?.sql ?? "";
    expect(provenance).toContain("proof_events_edge_provenance_key_fk");
    expect(STORE_SOURCES[0]).toContain("client.release(true)");
  });
});

describe("PostgreSQL store SQL against the migrations", () => {
  const statements = STORE_SOURCES.flatMap(sqlStatements);

  it("finds the stores' statements", () => {
    expect(statements.length).toBeGreaterThan(60);
  });

  it("only touches tables and columns that the migrations create", () => {
    const problems: string[] = [];
    for (const statement of statements) {
      for (const { table, columns } of statementUsage(statement)) {
        const known = schema.get(table);
        if (known === undefined) {
          problems.push(`unknown table ${table}: ${statement.slice(0, 80)}`);
          continue;
        }
        for (const column of columns) {
          if (!known.columns.has(column)) problems.push(`unknown column ${table}.${column}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("uses every table the migrations create", () => {
    const text = STORE_SOURCES.join("\n");
    const unused = [...schema.keys()].filter((table) => !text.includes(table));
    expect(unused).toEqual([]);
  });
});

describe("memory store entities have migration counterparts", () => {
  const store = new MemoryLibraryStore() as unknown as {
    tables: Record<string, unknown>;
    library: Record<string, unknown>;
  };

  it("maps every proof table of the memory store to a migrated table", () => {
    expect(Object.keys(store.tables).sort()).toEqual(Object.keys(MEMORY_PROOF_TABLES).sort());
    for (const table of Object.values(MEMORY_PROOF_TABLES)) expect(schema.has(table)).toBe(true);
  });

  it("maps every library table of the memory store to a migrated table", () => {
    const tables = Object.keys(store.library).filter((name) => name !== "sessionMetadata");
    expect(tables.sort()).toEqual(Object.keys(MEMORY_LIBRARY_TABLES).sort());
    for (const table of Object.values(MEMORY_LIBRARY_TABLES)) expect(schema.has(table)).toBe(true);
  });

  it("maps the session fields the memory store keeps to migrated columns", () => {
    const sessions = schema.get("proof_sessions")?.columns;
    for (const column of Object.values(MEMORY_SESSION_FIELDS)) expect(sessions).toContain(column);
  });
});

describe("session deletion covers the schema", () => {
  it("lists every table with a session_id column, dependents first", () => {
    const withSession = [...schema]
      .filter(([, table]) => table.columns.has("session_id"))
      .map(([name]) => name);
    expect([...SESSION_TABLES_IN_DELETION_ORDER].sort()).toEqual(withSession.sort());

    const order = new Map<string, number>(
      SESSION_TABLES_IN_DELETION_ORDER.map((name, index) => [name, index]),
    );
    for (const [name, index] of order) {
      for (const [other, table] of schema) {
        const otherIndex = order.get(other);
        if (other !== name && otherIndex !== undefined && table.references.has(name)) {
          // `other` references `name`, so `other`'s rows must be deleted first.
          expect(otherIndex, `${other} references ${name}`).toBeLessThan(index);
        }
      }
    }
  });

  it("deletes owner-scoped LLM call records of proof sessions", () => {
    const owned = [...schema]
      .filter(([, table]) => table.columns.has("owner_id"))
      .map(([name]) => name);
    expect(owned.sort()).toEqual(["llm_calls", "llm_topic_decisions"]);
    expect(STORE_SOURCES[0]).toContain("llm_topic_decisions");
  });
});

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Tables, columns and referenced tables of every CREATE TABLE and ALTER TABLE. */
function migrationSchema(files: readonly string[]): Schema {
  const result: Schema = new Map();
  for (const file of files) {
    const sql = stripComments(file);
    for (const match of sql.matchAll(/CREATE TABLE (\w+) \(/gi)) {
      const start = (match.index ?? 0) + match[0].length;
      const body = balancedBody(sql, start);
      const entry = { columns: new Set<string>(), references: new Set<string>() };
      result.set(match[1] as string, entry);
      for (const item of splitTopLevel(body)) {
        const first = item.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
        if (["primary", "unique", "check", "foreign", "constraint"].includes(first)) {
          for (const reference of item.matchAll(/REFERENCES (\w+)/gi)) {
            entry.references.add(reference[1] as string);
          }
          continue;
        }
        entry.columns.add(item.trim().split(/\s+/)[0] as string);
        for (const reference of item.matchAll(/REFERENCES (\w+)/gi)) {
          entry.references.add(reference[1] as string);
        }
      }
    }
    for (const match of sql.matchAll(/ALTER TABLE (\w+)([^;]*);/gi)) {
      const entry = result.get(match[1] as string);
      if (entry === undefined) throw new Error(`ALTER of unknown table ${match[1]}`);
      for (const column of (match[2] as string).matchAll(/ADD COLUMN (\w+)/gi)) {
        entry.columns.add(column[1] as string);
      }
      for (const reference of (match[2] as string).matchAll(/REFERENCES (\w+)/gi)) {
        entry.references.add(reference[1] as string);
      }
    }
  }
  return result;
}

function balancedBody(sql: string, start: number): string {
  let depth = 1;
  let index = start;
  while (depth > 0 && index < sql.length) {
    const character = sql[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    index += 1;
  }
  return sql.slice(start, index - 1);
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** Every SQL string literal (template or quoted) of a store source file. */
function sqlStatements(source: string): string[] {
  const literals = [...source.matchAll(/`([^`]*)`/g)].map((match) => match[1] as string);
  return literals.filter(
    (text) =>
      /^\s*(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i.test(text) && !text.includes("${table}"),
  );
}

type Usage = Readonly<{ table: string; columns: readonly string[] }>;

/** The tables a statement names and, where unambiguous, the columns it reads or writes. */
function statementUsage(statement: string): readonly Usage[] {
  const sql = statement.replace(/\s+/g, " ").trim();
  const usages: Usage[] = [];
  const insert = /^INSERT INTO (\w+) \(([^)]*)\)/i.exec(sql);
  if (insert !== null) {
    const columns = (insert[2] as string).split(",").map((column) => column.trim());
    usages.push({ table: insert[1] as string, columns });
  }
  const update = /^UPDATE (\w+) SET (.*?)(?: WHERE (.*))?$/i.exec(sql);
  if (update !== null) {
    const assigned = [...(update[2] as string).matchAll(/(?:^|, )(\w+) = /g)].map(
      (match) => match[1] as string,
    );
    usages.push({ table: update[1] as string, columns: [...assigned, ...whereColumns(update[3])] });
  }
  const ctes = new Set(
    [...sql.matchAll(/\b(\w+)(?: \([\w, ]*\))? AS \(/gi)].map((match) => match[1] as string),
  );
  const from = [...sql.matchAll(/\b(?:FROM|JOIN) (\w+)/gi)]
    .map((match) => match[1] as string)
    .filter((table) => !ctes.has(table));
  const single = from.length === 1 && !/\bJOIN\b/i.test(sql) && !/\(\s*SELECT/i.test(sql);
  if (/^(SELECT|DELETE)/i.test(sql)) {
    const columns: string[] = [];
    if (single) {
      const select = /^SELECT (.*?) FROM /i.exec(sql);
      if (select !== null) {
        for (const item of (select[1] as string).split(", ")) {
          const plain = /^(?:\w+\.)?([a-z_]\w*)(?: AS \w+)?$/i.exec(item.trim());
          if (plain !== null && plain[1] !== undefined) columns.push(plain[1]);
        }
      }
      columns.push(...whereColumns(/ WHERE (.*)$/i.exec(sql)?.[1]));
    }
    for (const table of from) usages.push({ table, columns: from.length === 1 ? columns : [] });
  }
  return usages;
}

function whereColumns(where: string | undefined): string[] {
  if (where === undefined) return [];
  return [...where.matchAll(/(?:^|\s|\()(\w+) (?:=|<>|>|<|IN|IS)\b/gi)]
    .map((match) => match[1] as string)
    .filter((word) => !/^(AND|OR|NOT|NULL|TRUE|FALSE)$/i.test(word));
}
