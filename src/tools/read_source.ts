/**
 * read_source — read one file from a configured checkout.
 *
 * An agent cannot reason about code it cannot see, so file reading has to
 * exist. The boundary is therefore not *whether* to allow reads but *which*
 * files: exactly the two configured source roots, and nothing else on the
 * disk. That line is enforced after symlink resolution, so a symlink inside a
 * checkout that points at ~/.ssh resolves to a path outside the roots and is
 * refused — checking the requested path before resolution would let the
 * filesystem decide the boundary for us.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type Config, type ProjectName, projectRoot } from "../config.js";
import { formatBytes } from "../util.js";

/** Files larger than this are almost certainly generated or binary. */
const MAX_FILE_BYTES = 512 * 1024;
const MAX_RETURNED_CHARS = 60_000;

export const readSourceInput = {
  project: z
    .enum(["tertulia", "apollo"])
    .describe("Which checkout the path is relative to. 'apollo' requires APOLLO_ROOT."),
  path: z
    .string()
    .min(1)
    .describe("Path to the file, relative to the project root (e.g. 'apollo-http4s/src/.../AuthRoutes.scala')."),
  start_line: z.number().int().min(1).optional().describe("First line to return, 1-indexed. Omit to start at line 1."),
  end_line: z.number().int().min(1).optional().describe("Last line to return, inclusive. Omit to read to the end."),
};

/**
 * Resolve `requested` inside `root`, refusing anything that escapes.
 *
 * Exported so the containment rule can be tested directly — it is the whole
 * security property of this tool.
 */
export function resolveWithinRoot(root: string, requested: string): string {
  if (isAbsolute(requested)) {
    throw new Error(
      `Path must be relative to the project root, but "${requested}" is absolute. ` +
        `Absolute paths are refused so that the configured root is the only anchor.`,
    );
  }

  const candidate = resolve(root, requested);

  // Resolve symlinks before deciding. A path that merely *looks* contained can
  // still land outside once the filesystem is consulted.
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`No such file: ${requested} (resolved to ${candidate})`);
  }

  const realRoot = realpathSync(root);
  const rel = relative(realRoot, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error(
      `Refused: "${requested}" resolves to ${real}, which is outside the configured project root. ` +
        `This server can only read files inside TERTULIA_ROOT and APOLLO_ROOT.`,
    );
  }
  return real;
}

export async function readSource(
  config: Config,
  args: { project: ProjectName; path: string; start_line?: number; end_line?: number },
): Promise<string> {
  const root = projectRoot(config, args.project);
  const file = resolveWithinRoot(root, args.path);

  const stats = statSync(file);
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${args.path}`);
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new Error(
      `File is ${formatBytes(stats.size)}, over the ${formatBytes(MAX_FILE_BYTES)} cap. ` +
        `Use start_line and end_line to read a portion of it.`,
    );
  }

  if (args.start_line !== undefined && args.end_line !== undefined && args.end_line < args.start_line) {
    throw new Error(`end_line (${args.end_line}) is before start_line (${args.start_line}).`);
  }

  const content = readFileSync(file, "utf8");
  const allLines = content.split("\n");

  const start = args.start_line ?? 1;
  const end = Math.min(args.end_line ?? allLines.length, allLines.length);
  if (start > allLines.length) {
    throw new Error(`start_line ${start} is past the end of the file (${allLines.length} lines).`);
  }

  const selected = allLines.slice(start - 1, end);
  const width = String(end).length;
  const numbered = selected.map((line, i) => `${String(start + i).padStart(width)}  ${line}`).join("\n");

  const body =
    numbered.length > MAX_RETURNED_CHARS
      ? `${numbered.slice(0, MAX_RETURNED_CHARS)}\n…[truncated at ${MAX_RETURNED_CHARS} characters]`
      : numbered;

  const range = start === 1 && end === allLines.length ? `all ${allLines.length} lines` : `lines ${start}–${end} of ${allLines.length}`;

  return `${args.project}:${relative(root, file)} (${formatBytes(stats.size)}, ${range})\n\n${body}`;
}
