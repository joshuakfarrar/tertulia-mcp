#!/usr/bin/env node
/**
 * tertulia-mcp — an MCP server exposing a bounded operational surface over
 * Tertulia and Apollo.
 *
 * The whole design rests on one property: the agent's capabilities are exactly
 * the tools registered below, and nothing else. This process links against no
 * part of the Scala application, so the boundary is a process boundary rather
 * than a convention — there is no in-process API for an agent to reach past a
 * tool and into the system it is operating.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig, redact, type Config } from "./config.js";
import { appStatus, appStatusInput } from "./tools/app_status.js";
import { describeSchema, describeSchemaInput } from "./tools/describe_schema.js";
import { listRoutes, listRoutesInput } from "./tools/list_routes.js";
import { queryScratch, queryScratchInput } from "./tools/query_scratch.js";
import { readSource, readSourceInput } from "./tools/read_source.js";
import { runTests, runTestsInput } from "./tools/run_tests.js";

/**
 * Wrap a tool implementation into an MCP handler.
 *
 * Errors become tool results with isError rather than transport faults: a
 * refusal is information the agent should be able to read and act on, not a
 * broken connection. The refusal text is deliberately explicit about *why* a
 * boundary exists, so an agent does not waste turns retrying a call that is
 * structurally impossible.
 */
function handler<A>(fn: (config: Config, args: A) => Promise<string>, config: Config) {
  return async (args: A) => {
    try {
      return { content: [{ type: "text" as const, text: await fn(config, args) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  };
}

function buildServer(config: Config): McpServer {
  const server = new McpServer(
    { name: "tertulia-mcp", version: "0.1.0" },
    {
      instructions:
        "Read-only operational tools for the Tertulia application and the Apollo auth library. " +
        "This server has no write tools: it can read source, introspect the scratch database " +
        "schema, run test suites, and check a local dev instance. It cannot modify source, " +
        "write to any database, or reach any host other than localhost.",
    },
  );

  server.registerTool(
    "run_tests",
    {
      title: "Run test suite",
      description:
        "Run the test suite for the Tertulia or Apollo checkout and report pass/fail with failure " +
        "details. The build tool (Mill or sbt) is detected from the project's marker files. " +
        "Concurrent runs are refused; a run is killed after its timeout.",
      inputSchema: runTestsInput,
    },
    handler(runTests, config),
  );

  server.registerTool(
    "describe_schema",
    {
      title: "Describe scratch database schema",
      description:
        "Introspect the scratch database: tables, columns, types, nullability, defaults, indexes, " +
        "and constraints. Returns structure only — this tool cannot return row data.",
      inputSchema: describeSchemaInput,
    },
    handler(describeSchema, config),
  );

  server.registerTool(
    "list_routes",
    {
      title: "List HTTP routes",
      description:
        "Statically parse Http4s route definitions from source and report method, path, and the " +
        "file and line where each is defined. Heuristic: recognises literal `case METHOD -> Root / ...` " +
        "clauses and does not see dynamically assembled routes.",
      inputSchema: listRoutesInput,
    },
    handler(listRoutes, config),
  );

  server.registerTool(
    "app_status",
    {
      title: "Check local instance status",
      description:
        "GET a path on the local dev instance and report whether it is up, the HTTP status, " +
        "identifying headers, and a body preview. The host is fixed by configuration.",
      inputSchema: appStatusInput,
    },
    handler(appStatus, config),
  );

  server.registerTool(
    "read_source",
    {
      title: "Read a source file",
      description:
        "Read a file from the Tertulia or Apollo checkout, optionally a line range. Reads are " +
        "confined to the two configured source roots, enforced after symlink resolution.",
      inputSchema: readSourceInput,
    },
    handler(readSource, config),
  );

  server.registerTool(
    "query_scratch",
    {
      title: "Query the scratch database (SELECT only)",
      description:
        "Run a single read-only SELECT against the scratch database and return capped rows. " +
        "Multiple statements, writes, DDL, and filesystem functions are rejected, and the " +
        "connection itself is read-only at the server.",
      inputSchema: queryScratchInput,
    },
    handler(queryScratch, config),
  );

  return server;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // stderr, not stdout: stdout is the MCP transport.
      process.stderr.write(`tertulia-mcp: refusing to start.\n\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  process.stderr.write(
    [
      "tertulia-mcp starting",
      `  TERTULIA_ROOT     ${config.tertuliaRoot}`,
      `  APOLLO_ROOT       ${config.apolloRoot ?? "(not set — Apollo tools disabled)"}`,
      `  TERTULIA_DB_URL   ${redact(config.dbUrl)}`,
      `  TERTULIA_BASE_URL ${config.baseUrl}`,
      "",
    ].join("\n"),
  );

  const server = buildServer(config);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`tertulia-mcp: fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
