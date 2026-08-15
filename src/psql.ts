/**
 * The database access layer: a thin wrapper around the `psql` client.
 *
 * Two deliberate choices here.
 *
 * First, this server shells out to `psql` rather than linking a Postgres
 * driver. It therefore holds no connection pool, keeps no session open between
 * tool calls, and has no in-process handle that could be reused by code added
 * later. Every query is a fresh, short-lived, independently constrained
 * connection.
 *
 * Second, read-only is enforced by the *server*, not by this process. Every
 * connection sets `default_transaction_read_only=on` through PGOPTIONS, so
 * Postgres itself rejects any write regardless of what SQL reaches it. The
 * statement allowlist in query_scratch is a second, independent layer; neither
 * one is trusted to be sufficient alone.
 */

import { execa, ExecaError } from "execa";

/** Abort a query that runs longer than this. Applied by the server. */
const STATEMENT_TIMEOUT_MS = 15_000;
/** Give up on an unreachable database rather than hanging a tool call. */
const CONNECT_TIMEOUT_SECONDS = 5;

export class PsqlError extends Error {}

/**
 * Backend options applied to every connection.
 *
 * `default_transaction_read_only=on` makes writes fail at the server.
 * `idle_in_transaction_session_timeout` and `statement_timeout` bound how long
 * a single call can occupy a backend.
 */
function backendOptions(): string {
  return [
    "-c default_transaction_read_only=on",
    `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
    "-c idle_in_transaction_session_timeout=10000",
  ].join(" ");
}

/**
 * Run one SQL statement and return raw stdout.
 *
 * The statement travels as an argv element, never through a shell.
 */
async function run(dbUrl: string, sql: string): Promise<string> {
  try {
    const result = await execa(
      "psql",
      [
        "-X", // ignore ~/.psqlrc, so operator dotfiles cannot change behaviour
        "-q", // no chatter
        "-w", // never prompt for a password; fail instead of blocking on stdin
        "-A", // unaligned output
        "-t", // tuples only, no headers or row counts
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        dbUrl,
        "-c",
        sql,
      ],
      {
        timeout: STATEMENT_TIMEOUT_MS + 10_000,
        reject: true,
        shell: false,
        env: {
          PGOPTIONS: backendOptions(),
          PGCONNECT_TIMEOUT: String(CONNECT_TIMEOUT_SECONDS),
        },
      },
    );
    return result.stdout;
  } catch (error) {
    if (error instanceof ExecaError) {
      if (error.code === "ENOENT") {
        throw new PsqlError(
          "The `psql` client was not found on PATH. This server uses psql as its " +
            "database client; install the PostgreSQL client tools to enable the " +
            "database tools.",
        );
      }
      if (error.timedOut) {
        throw new PsqlError(`Query exceeded the ${STATEMENT_TIMEOUT_MS / 1000}s statement timeout and was aborted.`);
      }
      const stderr = (error.stderr ?? "").trim();
      throw new PsqlError(stderr || error.shortMessage || "psql failed with no diagnostic output.");
    }
    throw error;
  }
}

/**
 * Run a query that yields a single JSON value and parse it.
 *
 * Returning JSON from the server sidesteps delimiter parsing entirely: no
 * choice of field separator can be confused with data, which matters because
 * some of this data is user-controlled content in the scratch database.
 */
export async function queryJson<T>(dbUrl: string, sql: string): Promise<T> {
  const stdout = await run(dbUrl, sql);
  const trimmed = stdout.trim();
  if (trimmed === "" || trimmed === "null") return [] as unknown as T;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new PsqlError(`Expected JSON from psql but could not parse the response:\n${trimmed.slice(0, 500)}`);
  }
}

/** Confirm the database is reachable, returning the server version. */
export async function serverVersion(dbUrl: string): Promise<string> {
  return (await run(dbUrl, "SELECT version()")).trim();
}
