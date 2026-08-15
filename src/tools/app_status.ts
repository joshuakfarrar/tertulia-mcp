/**
 * app_status — check whether the local dev instance is answering.
 *
 * The URL is not a parameter. It comes from the configuration that was
 * validated as loopback at startup; the caller may choose a path beneath it and
 * nothing more. That is what keeps this tool from becoming a general-purpose
 * HTTP client — an agent that can name the host has an egress channel, and an
 * agent that can only name a path does not.
 */

import { z } from "zod";
import type { Config } from "../config.js";

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_BODY_PREVIEW = 1_500;

/** Headers worth reporting when identifying a running build. */
const INTERESTING_HEADERS = ["server", "x-powered-by", "x-version", "x-build", "content-type", "location"];

export const appStatusInput = {
  path: z
    .string()
    .optional()
    .describe(
      "Path to request beneath the configured base URL, e.g. '/health'. Defaults to '/'. " +
        "Must be a path only — the host is fixed by configuration and cannot be overridden.",
    ),
};

/**
 * Join a caller-supplied path onto the configured base URL.
 *
 * Resolution is done with the URL constructor and then re-checked against the
 * base origin, because inputs like `//evil.example.com/x` or a fully-qualified
 * URL would otherwise resolve to a different host entirely.
 */
export function resolvePath(baseUrl: string, path: string | undefined): URL {
  const base = new URL(baseUrl);
  if (path === undefined || path === "") return base;

  const resolved = new URL(path, base);
  if (resolved.origin !== base.origin) {
    throw new Error(
      `Refused: "${path}" resolves to ${resolved.origin}, but this tool may only reach ${base.origin}. ` +
        `Supply a path such as '/health', not a full URL.`,
    );
  }
  return resolved;
}

export async function appStatus(config: Config, args: { path?: string }): Promise<string> {
  const target = resolvePath(config.baseUrl, args.path);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(target, {
      method: "GET",
      redirect: "manual", // report a redirect rather than following it off-path
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "*/*" },
    });
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    const reason = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return [
      `target:  ${target.href}`,
      `status:  DOWN`,
      `elapsed: ${elapsed}ms`,
      `reason:  ${timedOut ? `no response within ${REQUEST_TIMEOUT_MS}ms` : reason}`,
      "",
      "The local instance is not answering. Start it with the project's run task and try again.",
    ].join("\n");
  }

  const elapsed = Date.now() - startedAt;
  const body = await response.text().catch(() => "");

  const lines: string[] = [];
  lines.push(`target:  ${target.href}`);
  lines.push(`status:  UP (HTTP ${response.status} ${response.statusText})`);
  lines.push(`elapsed: ${elapsed}ms`);

  const headers: string[] = [];
  for (const name of INTERESTING_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.push(`  ${name}: ${value}`);
  }
  if (headers.length > 0) lines.push("headers:", ...headers);

  if (body.trim() !== "") {
    const preview = body.length > MAX_BODY_PREVIEW ? `${body.slice(0, MAX_BODY_PREVIEW)}\n…[truncated]` : body;
    lines.push("", "body:", preview);
  } else {
    lines.push("", "body: (empty)");
  }

  return lines.join("\n");
}
