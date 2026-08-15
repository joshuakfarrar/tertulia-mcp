/**
 * list_routes — recover the HTTP surface by reading the source.
 *
 * This is a static, regex-driven read of Http4s route definitions. It is a
 * heuristic, and the README says so plainly: it recognises the literal
 * `case ... METHOD -> Root / ...` shape that both Tertulia and Apollo are
 * written in, and it will miss routes assembled dynamically, routes built by
 * combining path fragments in a variable, and anything a middleware mounts
 * under a prefix. It reports what the source says, not what the running
 * server would answer to.
 *
 * The alternative — asking the running application to enumerate its own routes
 * — would require linking against Http4s, which is exactly the coupling this
 * server is built to avoid.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { type Config, type ProjectName, projectRoot } from "../config.js";

/** Build output and tooling caches — large, generated, and never interesting. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  ".metals",
  ".bloop",
  ".bsp",
  ".idea",
  "node_modules",
  "target",
  "out",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * Matches an Http4s route case clause.
 *
 * Handles the optional `request @` binding, both `HttpRoutes.of` and
 * `AuthedRoutes.of` bodies, and stops at the `=>` that opens the handler.
 */
const ROUTE_PATTERN = /case\s+(?:[A-Za-z_][\w]*\s*@\s*)?([A-Z]+)\s*->\s*(Root\b[^=]*?)\s*=>/g;

export const listRoutesInput = {
  project: z
    .enum(["tertulia", "apollo"])
    .optional()
    .describe("Which checkout to scan. Defaults to 'tertulia'. 'apollo' requires APOLLO_ROOT."),
};

export interface Route {
  method: string;
  path: string;
  file: string;
  line: number;
}

function* walkScalaFiles(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable directory: skip rather than fail the whole scan
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // broken symlink or a file that vanished mid-walk
    }
    if (stats.isDirectory()) {
      yield* walkScalaFiles(full);
    } else if (entry.endsWith(".scala")) {
      yield full;
    }
  }
}

/**
 * Convert an Http4s path expression into a readable path template.
 *
 * `Root / "reset" / code` becomes `/reset/{code}`; extractors such as
 * `IntVar(id)` become `{id}`. Query-parameter matchers (`:? Matcher(...)`) are
 * reported as a suffix rather than dropped, because whether a route takes a
 * query parameter is usually the thing being asked.
 */
export function renderPath(expression: string): string {
  const [pathPart = "", ...queryParts] = expression.split(":?");

  const segments = pathPart
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const rendered: string[] = [];
  for (const segment of segments) {
    if (segment === "Root") continue;
    const literal = segment.match(/^"([^"]*)"$/);
    if (literal) {
      rendered.push(literal[1]!);
      continue;
    }
    // Extractors like IntVar(id) / UUIDVar(id): name the bound variable.
    const extractor = segment.match(/^[A-Za-z_][\w]*\s*\(\s*([A-Za-z_][\w]*)\s*\)$/);
    if (extractor) {
      rendered.push(`{${extractor[1]}}`);
      continue;
    }
    if (/^[A-Za-z_][\w]*$/.test(segment)) {
      rendered.push(`{${segment}}`);
      continue;
    }
    rendered.push(`{${segment.replace(/\s+/g, " ")}}`);
  }

  const path = `/${rendered.join("/")}`;
  const query = queryParts.join(":?").trim();
  return query === "" ? path : `${path}?${query.replace(/\s+/g, " ")}`;
}

export function parseRoutes(source: string, file: string): Route[] {
  const routes: Route[] = [];
  // Precompute line starts so each match can report a line number.
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  ROUTE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ROUTE_PATTERN.exec(source)) !== null) {
    const method = match[1]!;
    if (!HTTP_METHODS.has(method)) continue;
    routes.push({
      method,
      path: renderPath(match[2]!),
      file,
      line: lineOf(match.index),
    });
  }
  return routes;
}

export async function listRoutes(config: Config, args: { project?: ProjectName }): Promise<string> {
  const project = args.project ?? "tertulia";
  const root = projectRoot(config, project);

  const routes: Route[] = [];
  let filesScanned = 0;
  for (const file of walkScalaFiles(root)) {
    filesScanned++;
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!source.includes("-> Root")) continue; // cheap pre-filter
    routes.push(...parseRoutes(source, relative(root, file)));
  }

  if (routes.length === 0) {
    return (
      `No Http4s route definitions found in ${root} (${filesScanned} .scala files scanned).\n\n` +
      `This scan recognises the literal \`case METHOD -> Root / ...\` form. Routes built ` +
      `dynamically or assembled from path variables are not detected.`
    );
  }

  routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const methodWidth = Math.max(...routes.map((r) => r.method.length));
  const pathWidth = Math.max(...routes.map((r) => r.path.length));

  const lines = [
    `project: ${project} (${root})`,
    `${routes.length} routes across ${filesScanned} .scala files scanned`,
    "",
    ...routes.map(
      (r) => `${r.method.padEnd(methodWidth)}  ${r.path.padEnd(pathWidth)}  ${r.file}:${r.line}`,
    ),
    "",
    "Static parse: recognises `case METHOD -> Root / ...` clauses. Dynamically assembled",
    "routes and middleware-mounted prefixes are not visible to this scan.",
  ];
  return lines.join("\n");
}
