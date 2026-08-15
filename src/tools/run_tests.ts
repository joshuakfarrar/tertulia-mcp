/**
 * run_tests — execute a project's test suite in a subprocess.
 *
 * This is the only tool that runs arbitrary project code, and it is the reason
 * the process boundary matters: the agent chooses *which* suite runs, never
 * *what command* runs. The command line is assembled here from a detected build
 * tool and a charset-restricted filter, so there is no argument the caller can
 * supply that turns this into general shell access.
 */

import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { type Config, type ProjectName, projectRoot } from "../config.js";
import { SingleFlight, truncateMiddle } from "../util.js";

/** Hard ceiling on a single run. A build that exceeds this is hung, not slow. */
const MAX_TIMEOUT_SECONDS = 600;
const DEFAULT_TIMEOUT_SECONDS = 600;
const OUTPUT_LIMIT = 24_000;

/**
 * Characters permitted in a test filter.
 *
 * Deliberately narrow. The filter is interpolated into a build-tool command
 * (sbt in particular reads each argument as a command to evaluate), so anything
 * outside this set — spaces, semicolons, quotes, backticks — could turn a test
 * selector into a second build command. Rejecting is safer than escaping.
 */
const FILTER_PATTERN = /^[A-Za-z0-9_.*:/$-]+$/;

const millRunner = new SingleFlight();

export const runTestsInput = {
  project: z
    .enum(["tertulia", "apollo"])
    .describe("Which checkout to run tests in. 'apollo' requires APOLLO_ROOT to be configured."),
  filter: z
    .string()
    .optional()
    .describe(
      "Optional test selector passed to the build tool (e.g. a suite name like " +
        "'io.github.joshuakfarrar.apollo.http4s.AuthRoutesSuite', or a glob like '*AuthRoutes*'). " +
        "Restricted to letters, digits, and . * : / _ - $ characters.",
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(MAX_TIMEOUT_SECONDS)
    .optional()
    .describe(`Kill the run after this many seconds. Default and maximum ${MAX_TIMEOUT_SECONDS}.`),
};

type BuildTool = "mill" | "sbt";

interface Detected {
  tool: BuildTool;
  /** Executable to invoke, absolute for wrapper scripts. */
  command: string;
  /** How the tool was identified, for the tool's own output. */
  evidence: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identify the build tool from marker files in the project root.
 *
 * Both Tertulia and Apollo are Scala projects, but they need not share a build
 * tool — Apollo builds with Mill, and assuming sbt everywhere would break the
 * tool on the repo it is most likely to be pointed at. Detection is by marker
 * file, so a project that migrates build tools keeps working without a change
 * here.
 */
export function detectBuildTool(root: string): Detected {
  // Mill: build.mill (Mill 0.12+) or build.sc (older layouts).
  for (const marker of ["build.mill", "build.sc"]) {
    if (existsSync(join(root, marker))) {
      const wrapper = join(root, "mill");
      const useWrapper = isExecutable(wrapper);
      return {
        tool: "mill",
        command: useWrapper ? wrapper : "mill",
        evidence: `${marker} present; using ${useWrapper ? "./mill wrapper script" : "mill from PATH"}`,
      };
    }
  }

  if (existsSync(join(root, "build.sbt"))) {
    const wrapper = join(root, "sbt");
    const useWrapper = isExecutable(wrapper);
    return {
      tool: "sbt",
      command: useWrapper ? wrapper : "sbt",
      evidence: `build.sbt present; using ${useWrapper ? "./sbt wrapper script" : "sbt from PATH"}`,
    };
  }

  throw new Error(
    `No supported build tool found in ${root}. Looked for build.mill, build.sc, and build.sbt. ` +
      `Only Mill and sbt projects can be tested through this server.`,
  );
}

/** Build the argument vector. Kept pure so the command line can be asserted on. */
export function testArgs(tool: BuildTool, filter?: string): string[] {
  if (tool === "mill") {
    // `__.test` selects the test task of every module in the build.
    return filter ? ["__.test", filter] : ["__.test"];
  }
  // sbt reads each argv element as a command, so a selector and its task must
  // travel as one element.
  return filter ? [`testOnly ${filter}`] : ["test"];
}

/**
 * Pull the lines most likely to explain a failure out of a long build log.
 *
 * Heuristic and intentionally so — this supplements the raw output below it,
 * it does not replace it.
 */
function failureHighlights(output: string): string[] {
  const patterns = [
    /^\s*==> X /, // munit failed test
    /^\[error\]/, // sbt / mill error line
    /^\s*\*\*\* FAILED \*\*\*/, // scalatest
    /^Tests:/, // mill summary
    /^\s*Failed tests?:/,
    /^\s*\d+ tests?, .*failed/i,
  ];
  const hits: string[] = [];
  for (const line of output.split("\n")) {
    if (patterns.some((p) => p.test(line))) {
      hits.push(line.trimEnd());
      if (hits.length >= 60) break;
    }
  }
  return hits;
}

/** Grace period between asking a build to stop and killing it outright. */
const SIGKILL_GRACE_MS = 5_000;

/**
 * Run a build command, enforcing the timeout against the whole process group.
 *
 * The child is spawned detached so that it leads a new process group, and the
 * timeout signals that group rather than the child alone. This matters because
 * both Mill and sbt run their real work in a long-lived daemon: signalling only
 * the launcher leaves the daemon alive, still holding the inherited stdout
 * pipe, so the output stream never ends and the tool call hangs indefinitely
 * despite having "timed out". Killing the group closes the pipes and lets the
 * call return.
 */
async function spawnWithGroupTimeout(command: string, argv: string[], cwd: string, timeoutMs: number) {
  const subprocess = execa(command, argv, {
    cwd,
    reject: false,
    all: true,
    // No shell: argv elements reach the process verbatim, so nothing in
    // `filter` can be reinterpreted as shell syntax.
    shell: false,
    stripFinalNewline: false,
    detached: true,
  });

  const pid = subprocess.pid;
  let timedOut = false;

  /** Signal the whole group; ESRCH just means it already exited. */
  const signalGroup = (signal: NodeJS.Signals): void => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      /* already gone */
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    signalGroup("SIGTERM");
    // Escalate if the group ignores SIGTERM. Unref'd so a build that exits
    // cleanly in the grace window does not hold the event loop open.
    setTimeout(() => signalGroup("SIGKILL"), SIGKILL_GRACE_MS).unref();
  }, timeoutMs);

  try {
    const result = await subprocess;
    return { result, timedOut };
  } finally {
    clearTimeout(timer);
    // If the launcher exited but left the group behind, do not leak it.
    if (timedOut) signalGroup("SIGKILL");
  }
}

export async function runTests(
  config: Config,
  args: { project: ProjectName; filter?: string; timeout_seconds?: number },
): Promise<string> {
  const root = projectRoot(config, args.project);

  if (args.filter !== undefined && !FILTER_PATTERN.test(args.filter)) {
    throw new Error(
      `Test filter ${JSON.stringify(args.filter)} contains characters that are not permitted. ` +
        `Filters may contain letters, digits, and the characters . * : / _ - $ only. ` +
        `This restriction exists because the filter becomes part of a build-tool command line.`,
    );
  }

  const detected = detectBuildTool(root);
  const argv = testArgs(detected.tool, args.filter);
  const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;

  return millRunner.run(async () => {
    const startedAt = Date.now();
    const { result, timedOut } = await spawnWithGroupTimeout(
      detected.command,
      argv,
      root,
      timeoutSeconds * 1000,
    );

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const output = result.all ?? "";
    const { text, truncated } = truncateMiddle(output, OUTPUT_LIMIT);

    const lines: string[] = [];
    lines.push(`project:   ${args.project} (${root})`);
    lines.push(`build:     ${detected.tool} — ${detected.evidence}`);
    lines.push(`command:   ${detected.command} ${argv.join(" ")}`);
    lines.push(`duration:  ${elapsed}s`);

    if (timedOut) {
      lines.push(`result:    TIMED OUT after ${timeoutSeconds}s (process group killed)`);
    } else if (result.failed && result.exitCode === undefined) {
      lines.push(`result:    FAILED TO START — ${result.shortMessage ?? "unknown error"}`);
    } else {
      lines.push(`result:    ${result.exitCode === 0 ? "PASS" : "FAIL"} (exit code ${result.exitCode})`);
    }

    const highlights = failureHighlights(output);
    if (highlights.length > 0 && result.exitCode !== 0) {
      lines.push("", "failure lines:", ...highlights.map((l) => `  ${l}`));
    }

    lines.push("", truncated ? "output (truncated, head and tail kept):" : "output:", text);
    return lines.join("\n");
  });
}
