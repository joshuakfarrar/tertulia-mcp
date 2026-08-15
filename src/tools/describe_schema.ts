/**
 * describe_schema — report the structure of the scratch database.
 *
 * The boundary here is structure versus content. Schema tells an agent what
 * the application's data model is, which is what it needs to reason about
 * migrations, queries, and doobie mappings. Rows tell it what people wrote,
 * which it does not need for that work. This tool reads catalogs only; it
 * cannot return a row of application data no matter how it is called.
 */

import { z } from "zod";
import type { Config } from "../config.js";
import { queryJson } from "../psql.js";

export const describeSchemaInput = {
  schema: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Schema names may contain letters, digits, and underscores only.")
    .optional()
    .describe("Postgres schema to introspect. Defaults to 'public'."),
  table: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Table names may contain letters, digits, and underscores only.")
    .optional()
    .describe("Restrict output to a single table. Omit to describe every table in the schema."),
};

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

interface IndexRow {
  table_name: string;
  index_name: string;
  definition: string;
}

interface ConstraintRow {
  table_name: string;
  constraint_name: string;
  definition: string;
}

/**
 * Quote a literal for interpolation into a catalog query.
 *
 * Both callers already constrain their inputs to an identifier charset via
 * zod, so this cannot receive a quote character today. It is here so that the
 * queries below remain safe if that validation is ever loosened.
 */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function describeSchema(
  config: Config,
  args: { schema?: string; table?: string },
): Promise<string> {
  const schema = args.schema ?? "public";
  const tableFilter = args.table ? ` AND c.relname = ${literal(args.table)}` : "";

  const columns = await queryJson<ColumnRow[]>(
    config.dbUrl,
    `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.table_name, t.ordinal_position), '[]'::json)
     FROM (
       SELECT c.relname AS table_name,
              a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS data_type,
              CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
              pg_get_expr(d.adbin, d.adrelid) AS column_default,
              a.attnum AS ordinal_position
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE n.nspname = ${literal(schema)}
         AND c.relkind IN ('r', 'p')
         AND a.attnum > 0
         AND NOT a.attisdropped${tableFilter}
     ) t`,
  );

  if (columns.length === 0) {
    return `No tables found in schema "${schema}"${args.table ? ` matching table "${args.table}"` : ""}.`;
  }

  const indexes = await queryJson<IndexRow[]>(
    config.dbUrl,
    `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.table_name, t.index_name), '[]'::json)
     FROM (
       SELECT c.relname AS table_name,
              i.relname AS index_name,
              pg_get_indexdef(x.indexrelid) AS definition
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${literal(schema)}${tableFilter}
     ) t`,
  );

  const constraints = await queryJson<ConstraintRow[]>(
    config.dbUrl,
    `SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.table_name, t.constraint_name), '[]'::json)
     FROM (
       SELECT c.relname AS table_name,
              con.conname AS constraint_name,
              pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = ${literal(schema)}${tableFilter}
     ) t`,
  );

  const byTable = new Map<string, ColumnRow[]>();
  for (const col of columns) {
    const list = byTable.get(col.table_name) ?? [];
    list.push(col);
    byTable.set(col.table_name, list);
  }

  const out: string[] = [];
  out.push(`schema: ${schema}`);
  out.push(`tables: ${byTable.size}`);
  out.push("");
  out.push("(structure only — this tool does not read row data)");
  out.push("");

  for (const [table, cols] of byTable) {
    out.push(`TABLE ${schema}.${table}`);
    const nameWidth = Math.max(...cols.map((c) => c.column_name.length));
    const typeWidth = Math.max(...cols.map((c) => c.data_type.length));
    for (const col of cols) {
      const parts = [
        `  ${col.column_name.padEnd(nameWidth)}`,
        col.data_type.padEnd(typeWidth),
        col.is_nullable === "NO" ? "NOT NULL" : "        ",
      ];
      if (col.column_default) parts.push(`DEFAULT ${col.column_default}`);
      out.push(parts.join("  ").trimEnd());
    }

    const tableConstraints = constraints.filter((c) => c.table_name === table);
    if (tableConstraints.length > 0) {
      out.push("  constraints:");
      for (const con of tableConstraints) {
        out.push(`    ${con.constraint_name}: ${con.definition}`);
      }
    }

    // Index-backed constraints already print above; listing the raw index too
    // is redundant noise, so filter those out by name.
    const constraintNames = new Set(tableConstraints.map((c) => c.constraint_name));
    const tableIndexes = indexes.filter((i) => i.table_name === table && !constraintNames.has(i.index_name));
    if (tableIndexes.length > 0) {
      out.push("  indexes:");
      for (const idx of tableIndexes) {
        out.push(`    ${idx.definition}`);
      }
    }

    out.push("");
  }

  return out.join("\n").trimEnd();
}
