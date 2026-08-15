#!/usr/bin/env node
/**
 * verify-boundaries — assert that every documented capability boundary holds.
 *
 * The README claims this server cannot do certain things. This script proves
 * those claims against a running instance rather than asking anyone to take
 * them on faith: it drives the real server over a real stdio MCP connection and
 * fails if any refusal does not fire, or if any legitimate call is refused.
 *
 * The second half matters as much as the first. A boundary that rejects
 * everything is not a boundary, it is a broken tool, so each refusal is paired
 * with a positive control that must succeed.
 *
 * Usage:
 *   npm run build
 *   TERTULIA_ROOT=/path/to/checkout node scripts/verify-boundaries.mjs
 *
 * Set TERTULIA_DB_URL to a reachable scratch database to include the database
 * checks; without it, those are skipped rather than silently passed.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TERTULIA_ROOT = process.env.TERTULIA_ROOT;
if (!TERTULIA_ROOT) {
  console.error("TERTULIA_ROOT must be set to a local checkout to run this verification.");
  process.exit(2);
}
const APOLLO_ROOT = process.env.APOLLO_ROOT ?? TERTULIA_ROOT;
const DB_CONFIGURED = Boolean(process.env.TERTULIA_DB_URL);

let passed = 0;
let failed = 0;
let skipped = 0;

const record = (ok, label, detail) => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}`);
    console.log(`        ${String(detail).split("\n")[0]}`);
  }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(projectRoot, "dist/index.js")],
  cwd: projectRoot,
  env: { ...process.env, TERTULIA_ROOT, APOLLO_ROOT },
});

const client = new Client({ name: "verify-boundaries", version: "1.0.0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content.map((c) => c.text ?? "").join("\n"), isError: Boolean(res.isError) };
}

/** The call must be refused, and the refusal must mention `expect`. */
async function mustRefuse(label, name, args, expect) {
  const { text, isError } = await call(name, args);
  if (!isError) return record(false, label, `expected refusal, got success: ${text.slice(0, 160)}`);
  if (expect && !text.toLowerCase().includes(expect.toLowerCase())) {
    return record(false, label, `refused, but not for the expected reason: ${text.slice(0, 160)}`);
  }
  record(true, label);
}

/** The call must succeed. Guards against a boundary that simply blocks everything. */
async function mustAllow(label, name, args, expectSubstring) {
  const { text, isError } = await call(name, args);
  if (isError) return record(false, label, `expected success, got refusal: ${text.slice(0, 160)}`);
  if (expectSubstring && !text.includes(expectSubstring)) {
    return record(false, label, `succeeded but output lacked ${JSON.stringify(expectSubstring)}`);
  }
  record(true, label);
}

console.log("\nfilesystem boundary — reads confined to the configured roots");
await mustRefuse("relative traversal escapes root", "read_source", { project: "tertulia", path: "../../../etc/passwd" }, "outside the configured project root");
await mustRefuse("absolute path refused", "read_source", { project: "tertulia", path: "/etc/passwd" }, "absolute");
await mustAllow("in-root read succeeds", "read_source", { project: "tertulia", path: "README.md", start_line: 1, end_line: 3 });

console.log("\nnetwork boundary — the host is fixed by configuration");
await mustRefuse("protocol-relative host override", "app_status", { path: "//example.com/x" }, "may only reach");
await mustRefuse("absolute URL override", "app_status", { path: "https://example.com/x" }, "may only reach");

console.log("\nexecution boundary — the agent picks a suite, not a command");
await mustRefuse("shell metacharacters in filter", "run_tests", { project: "tertulia", filter: "foo; publish" }, "not permitted");
await mustRefuse("whitespace in filter", "run_tests", { project: "tertulia", filter: "a b" }, "not permitted");

if (DB_CONFIGURED) {
  console.log("\ndatabase boundary — read-only, single statement, capped");
  await mustRefuse("write statement", "query_scratch", { sql: "DELETE FROM users" }, "Only SELECT");
  await mustRefuse("DDL", "query_scratch", { sql: "DROP TABLE users" }, "Only SELECT");
  await mustRefuse("statement stacking", "query_scratch", { sql: "SELECT 1; DROP TABLE users" }, "Multiple statements");
  await mustRefuse("data-modifying CTE", "query_scratch", { sql: "WITH x AS (INSERT INTO users(name) VALUES('a') RETURNING *) SELECT * FROM x" }, "INSERT");
  await mustRefuse("filesystem function", "query_scratch", { sql: "SELECT pg_read_file('/etc/passwd')" }, "PG_READ_FILE");
  await mustRefuse("dollar quoting", "query_scratch", { sql: "SELECT $$x$$" }, "Dollar-quoted");
  await mustRefuse("cross-database reach", "query_scratch", { sql: "SELECT * FROM dblink('host=prod', 'SELECT 1') AS t(x int)" }, "DBLINK");

  console.log("\ndatabase positive controls — legitimate reads must still work");
  await mustAllow("plain select", "query_scratch", { sql: "SELECT 1 AS n" }, "n: 1");
  await mustAllow("keyword inside a string literal", "query_scratch", { sql: "SELECT 'delete me' AS note" }, "delete me");
  await mustAllow("keyword as a column-name prefix", "query_scratch", { sql: "SELECT 1 AS created_at, 2 AS updated_at" }, "created_at");
  await mustAllow("trailing semicolon", "query_scratch", { sql: "SELECT 1 AS n;" }, "n: 1");
  await mustAllow("trailing comment", "query_scratch", { sql: "SELECT 1 AS n -- note" }, "n: 1");
  await mustAllow("row cap is reported, not silent", "query_scratch", { sql: "SELECT n FROM generate_series(1,50) AS n", limit: 2 }, "row cap of 2 reached");
  await mustAllow("schema introspection", "describe_schema", {}, "structure only");
} else {
  skipped += 14;
  console.log("\ndatabase boundary — SKIPPED (set TERTULIA_DB_URL to a scratch database to include)");
}

console.log("\nsource tools");
await mustAllow("route listing runs", "list_routes", { project: "tertulia" });

await client.close();

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log("\nA capability boundary did not hold. This is a release blocker.");
  process.exit(1);
}
