/**
 * query_scratch — run a single read-only SELECT against the scratch database.
 *
 * This is the widest tool in the server, so it carries the most constraint.
 * Three independent layers stand between a tool call and the database, and the
 * design assumes each one will eventually be found wanting:
 *
 *   1. Shape:  the statement must be a single SELECT or WITH, with no statement
 *              separator and no dollar-quoting that could hide one.
 *   2. Content: a denylist of write and file-access keywords, scanned after
 *              string literals have been masked out.
 *   3. Server: the connection runs with default_transaction_read_only=on, so
 *              Postgres refuses writes even if layers 1 and 2 are defeated.
 *
 * Layer 3 is the one that actually holds. Layers 1 and 2 exist to make failures
 * legible — an agent gets a clear refusal instead of a driver error — and to
 * keep read-only from being the single point of failure.
 */

import { z } from "zod";
import type { Config } from "../config.js";
import { queryJson } from "../psql.js";

const DEFAULT_ROW_LIMIT = 100;
const MAX_ROW_LIMIT = 1000;
/** Guard against a pathological cell (a large text column) flooding the reply. */
const MAX_CELL_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 40_000;

/**
 * Keywords that must not appear outside a string literal.
 *
 * Writes are the obvious entries. The rest close paths that read or write the
 * host rather than the data: COPY and the `pg_read_file` / `pg_ls_dir` family
 * reach the filesystem, the large-object functions move bytes, and dblink and
 * postgres_fdw would let a query reach a database this server never validated
 * as local — which would route straight around the locality guard.
 */
const FORBIDDEN = [
  "insert",
  "update",
  "delete",
  "truncate",
  "drop",
  "create",
  "alter",
  "grant",
  "revoke",
  "comment",
  "copy",
  "call",
  "do",
  "merge",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
  "refresh",
  "listen",
  "notify",
  "prepare",
  "execute",
  "set",
  "reset",
  "begin",
  "commit",
  "rollback",
  "savepoint",
  "lock",
  "dblink",
  "dblink_exec",
  "lo_import",
  "lo_export",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_logdir_ls",
  "pg_file_write",
];

export const queryScratchInput = {
  sql: z
    .string()
    .min(1)
    .max(8_000)
    .describe(
      "A single read-only SQL statement. Must begin with SELECT or WITH. Multiple " +
        "statements, writes, DDL, and filesystem functions are rejected.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ROW_LIMIT)
    .optional()
    .describe(`Maximum rows to return. Default ${DEFAULT_ROW_LIMIT}, maximum ${MAX_ROW_LIMIT}.`),
};

/**
 * Replace the contents of single-quoted string literals with a placeholder.
 *
 * Keyword scanning runs against the masked text so that `SELECT 'delete'`
 * is not mistaken for a DELETE. Doubled quotes ('') are the SQL escape and
 * keep the literal open. Double-quoted identifiers are left alone: a keyword
 * cannot execute from inside one, and masking them would hide a column named
 * "update" that is perfectly legal to select.
 */
export function maskStringLiterals(sql: string): string {
  let out = "";
  let inLiteral = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (!inLiteral) {
      if (ch === "'") {
        inLiteral = true;
        out += "'";
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === "'") {
      if (sql[i + 1] === "'") {
        i++; // escaped quote; still inside the literal
        continue;
      }
      inLiteral = false;
      out += "'";
      continue;
    }
    // Inside a literal: drop the character so no keyword can hide there.
  }
  return out;
}

/** Remove `-- line` and `/* block *\/` comments. */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  let depth = 0;
  while (i < sql.length) {
    if (depth === 0 && sql.startsWith("--", i)) {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) break;
      out += " ";
      i = nl;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0 && sql.startsWith("*/", i)) {
      depth--;
      i += 2;
      if (depth === 0) out += " ";
      continue;
    }
    if (depth === 0) out += sql[i];
    i++;
  }
  return out;
}

export class QueryRejected extends Error {}

/**
 * Apply layers 1 and 2. Throws QueryRejected with the specific reason.
 *
 * Returns the normalised statement (comments stripped, trailing semicolon
 * removed) that should actually be sent.
 */
export function validateSelect(rawSql: string): string {
  const withoutComments = stripComments(rawSql).trim();
  if (withoutComments === "") {
    throw new QueryRejected("The statement is empty once comments are removed.");
  }

  // Dollar-quoting can conceal anything at all, including statement
  // separators, so it is refused outright rather than parsed.
  if (/\$[A-Za-z_0-9]*\$/.test(withoutComments)) {
    throw new QueryRejected(
      "Dollar-quoted strings ($$...$$) are not permitted, because their contents cannot be " +
        "reliably scanned. Use standard single-quoted literals.",
    );
  }

  const masked = maskStringLiterals(withoutComments);

  const withoutTrailingSemicolon = masked.replace(/;\s*$/, "");
  if (withoutTrailingSemicolon.includes(";")) {
    throw new QueryRejected(
      "Multiple statements are not permitted. Submit exactly one SELECT, with no internal semicolons.",
    );
  }

  if (!/^\s*(select|with)\b/i.test(withoutTrailingSemicolon)) {
    throw new QueryRejected(
      "Only SELECT statements are permitted. The statement must begin with SELECT or WITH. " +
        "This server has no write tools by design.",
    );
  }

  for (const keyword of FORBIDDEN) {
    // \b on both sides so `selected_at` does not trip the `select` family and
    // `updated_at` does not trip `update`.
    const pattern = new RegExp(`\\b${keyword}\\b`, "i");
    if (pattern.test(withoutTrailingSemicolon)) {
      throw new QueryRejected(
        `The statement contains the keyword "${keyword.toUpperCase()}", which is not permitted in a ` +
          `read-only query. If this keyword appears as part of an identifier, quote it as "${keyword}".`,
      );
    }
  }

  return withoutComments.replace(/;\s*$/, "");
}

function renderCell(value: unknown): string {
  if (value === null) return "NULL";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…[truncated]` : text;
}

export async function queryScratch(config: Config, args: { sql: string; limit?: number }): Promise<string> {
  const statement = validateSelect(args.sql);
  const limit = args.limit ?? DEFAULT_ROW_LIMIT;

  // Fetch one extra row so truncation can be reported honestly rather than
  // silently returning a full page that looks complete.
  const rows = await queryJson<Record<string, unknown>[]>(
    config.dbUrl,
    `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)
     FROM (SELECT * FROM (${statement}) AS inner_q LIMIT ${limit + 1}) AS t`,
  );

  const truncated = rows.length > limit;
  const shown = truncated ? rows.slice(0, limit) : rows;

  if (shown.length === 0) return "0 rows.";

  const columns = Object.keys(shown[0]!);
  const lines: string[] = [];
  for (const [index, row] of shown.entries()) {
    lines.push(`— row ${index + 1} —`);
    for (const col of columns) {
      lines.push(`  ${col}: ${renderCell(row[col])}`);
    }
  }

  const header = truncated
    ? `${shown.length} rows (row cap of ${limit} reached — more rows match; raise \`limit\` up to ${MAX_ROW_LIMIT} or narrow the query)`
    : `${shown.length} row${shown.length === 1 ? "" : "s"}`;

  const body = lines.join("\n");
  const clipped =
    body.length > MAX_OUTPUT_CHARS
      ? `${body.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated at ${MAX_OUTPUT_CHARS} characters]`
      : body;

  return `${header}\n\n${clipped}`;
}
