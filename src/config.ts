/**
 * Configuration and the locality guard.
 *
 * Boundary decision #1: production is unreachable by construction. Every
 * network-addressable target this server can reach is resolved once, here, at
 * startup, and rejected unless it names a loopback host. There is deliberately
 * no tool argument, no request field, and no runtime path that can introduce a
 * new host after this module has run.
 */

import { realpathSync, statSync } from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { resolve } from "node:path";

/** Hosts considered local. Everything else is refused at startup. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export class ConfigError extends Error {}

export interface Config {
  /** Absolute, symlink-resolved path to the Tertulia checkout. */
  tertuliaRoot: string;
  /** Absolute, symlink-resolved path to the Apollo checkout, if configured. */
  apolloRoot: string | undefined;
  /** libpq connection URI for the scratch database. Loopback-only. */
  dbUrl: string;
  /** Base URL of the local dev instance. Loopback-only. */
  baseUrl: string;
}

/**
 * True if `host` is a loopback address or name.
 *
 * Bare IPv4 literals are checked octet-wise so the whole 127.0.0.0/8 block is
 * accepted, not just 127.0.0.1. Any name that is not a recognised literal must
 * match the hostname allowlist exactly — we never resolve DNS to make this
 * decision, because a name that resolves to loopback today can resolve
 * somewhere else tomorrow, and the guard would silently stop holding.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (bare === "") return false;
  if (LOOPBACK_HOSTNAMES.has(bare)) return true;
  if (isIPv4(bare)) return bare.startsWith("127.");
  if (isIPv6(bare)) return bare === "::1";
  return false;
}

/**
 * Extract the hostname from a URL-ish string without trusting it.
 *
 * Returns null when the value cannot be parsed, which callers must treat as a
 * failure: an unparseable target is refused rather than assumed local.
 */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

/** `noun` names the target in lower case, e.g. "scratch database". */
function requireLoopback(noun: string, envVar: string, value: string): void {
  // The most common shape of an unverifiable URL, called out by name: a JDBC
  // URL from a Java/Scala habit. Its nested scheme hides the hostname from the
  // parser, and psql would not accept it anyway.
  if (/^jdbc:/i.test(value)) {
    throw new ConfigError(
      `${envVar} looks like a JDBC URL. This server's database client is psql, which takes a ` +
        `libpq URI — drop the "jdbc:" prefix (e.g. postgresql://localhost:5432/dbname). Refusing to start.`,
    );
  }
  const host = hostnameOf(value);
  if (host === null || host === "") {
    throw new ConfigError(
      `${envVar} is not a parseable URL, so its target host cannot be verified as local. ` +
        `Refusing to start. Received: ${redact(value)}`,
    );
  }
  if (!isLoopbackHost(host)) {
    throw new ConfigError(
      `${envVar} points at "${host}", which is not a loopback host. ` +
        `The ${noun} may only address localhost, 127.0.0.0/8, or ::1. ` +
        `This is a design boundary, not a configuration gap: this server has no ` +
        `supported path to a non-local ${noun}. Refusing to start.`,
    );
  }
}

/** Strip credentials from a connection string before it reaches a log or an error. */
export function redact(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    if (url.username) url.username = "***";
    return url.toString();
  } catch {
    return value.replace(/\/\/[^@/]*@/, "//***@");
  }
}

function requireDirectory(envVar: string, value: string): string {
  const abs = resolve(value);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw new ConfigError(`${envVar} points at "${abs}", which does not exist. Refusing to start.`);
  }
  if (!statSync(real).isDirectory()) {
    throw new ConfigError(`${envVar} points at "${real}", which is not a directory. Refusing to start.`);
  }
  return real;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tertuliaRootRaw = env.TERTULIA_ROOT?.trim();
  if (!tertuliaRootRaw) {
    throw new ConfigError(
      "TERTULIA_ROOT is not set. It must be an absolute path to a local Tertulia " +
        "checkout; there is no default, because guessing a source root would " +
        "widen the file-read boundary to whatever happened to be nearby.",
    );
  }

  const apolloRootRaw = env.APOLLO_ROOT?.trim();

  // Defaults are local by construction so that the common case cannot be
  // misconfigured into reaching production.
  const dbUrl = env.TERTULIA_DB_URL?.trim() || "postgresql://localhost:5432/tertulia_scratch";
  const baseUrl = env.TERTULIA_BASE_URL?.trim() || "http://localhost:8080";

  requireLoopback("scratch database", "TERTULIA_DB_URL", dbUrl);
  requireLoopback("application instance", "TERTULIA_BASE_URL", baseUrl);

  return {
    tertuliaRoot: requireDirectory("TERTULIA_ROOT", tertuliaRootRaw),
    apolloRoot: apolloRootRaw ? requireDirectory("APOLLO_ROOT", apolloRootRaw) : undefined,
    dbUrl,
    baseUrl,
  };
}

export type ProjectName = "tertulia" | "apollo";

/**
 * Resolve a project name to its configured root.
 *
 * Apollo is optional; asking for it when it is not configured is a normal
 * error, not a crash.
 */
export function projectRoot(config: Config, project: ProjectName): string {
  if (project === "tertulia") return config.tertuliaRoot;
  if (!config.apolloRoot) {
    throw new ConfigError(
      "APOLLO_ROOT is not configured, so Apollo tools are unavailable. " +
        "Set APOLLO_ROOT to a local Apollo checkout to enable them.",
    );
  }
  return config.apolloRoot;
}
