# tertulia-mcp — Project Brief

## What this is

An MCP (Model Context Protocol) server that gives an AI agent a bounded,
least-privilege operational surface over **Tertulia**, a production Scala/Http4s
microblogging application built on the **Apollo** authentication library
(github.com/joshuakfarrar/apollo).

Two goals, in priority order:

1. **Demonstrate agent-tooling design under governance constraints.** The README
   is a first-class deliverable: it documents the capability boundaries and maps
   the pattern to environments where agents cannot yet be connected at all
   (federal systems). This repo is the public twin of tooling the author has
   built inside a federal boundary.
2. **Be genuinely useful** for developing Tertulia and Apollo with an AI agent.

## Architecture — one decision that drives everything

The MCP server is a **separate TypeScript process** that never links against the
Scala application. It operates Tertulia from the outside, exactly as a human
developer does: subprocesses (`sbt`), direct DB queries against a **scratch
database only**, static reads of the source tree, and HTTP calls to a
**local dev instance only**.

Consequences (state these in the README):
- Tertulia's stack (Scala, Http4s, doobie, Apollo, JVM anything) is opaque to
  the MCP layer. Zero shared dependencies. The same server design works against
  any stack — that's the point.
- The agent's capabilities are exactly the enumerated tools, nothing more.
  Process boundary = governance boundary.
- **Boundary decision #1: production is unreachable by construction.** All
  connection strings/URLs point at local scratch resources; there is no
  configuration path to production. Document this as a design decision, not an
  omission.

## Stack

- TypeScript, Node 20+
- `@modelcontextprotocol/sdk` (official SDK), stdio transport
- `zod` for tool input schemas
- `execa` for subprocess execution (sbt, psql/db client)
- No framework beyond that. Boring on purpose.

## Configuration

Env vars (all with safe defaults, all local):
- `TERTULIA_ROOT` — path to the Tertulia source checkout
- `APOLLO_ROOT` — path to the Apollo source checkout (optional; enables Apollo tools)
- `TERTULIA_DB_URL` — connection string for the **scratch** database
  (adjust client/driver to whatever Tertulia actually uses — parameterize,
  don't assume)
- `TERTULIA_BASE_URL` — local dev instance, default `http://localhost:8080`

Refuse to start (with a clear error) if `TERTULIA_DB_URL` or
`TERTULIA_BASE_URL` look non-local (simple hostname allowlist: localhost,
127.0.0.1). This check is itself a README talking point.

## Tools (build in this order; stop when time runs out)

Read-only first, execution second, mutation never (v1 has no write tools —
another README talking point).

1. `run_tests` — run `sbt test` in `TERTULIA_ROOT` (or `APOLLO_ROOT` via an
   enum arg `project: "tertulia" | "apollo"`). Args: optional test-name filter.
   Returns: pass/fail summary + failure details, truncated sanely. Timeout
   (e.g. 10 min) and single-flight (reject concurrent runs).
2. `describe_schema` — introspect the scratch DB: tables, columns, types,
   indexes, FKs. Read-only connection. No row data — schema only (boundary:
   structure vs content).
3. `list_routes` — static parse of Tertulia's route definitions from source
   (regex/heuristic over the Http4s route files is fine for v1; note the
   limitation). Returns method + path + handler location.
4. `app_status` — GET the local instance's health/root endpoint; report
   up/down, version if exposed.
5. `read_source` — read a file within `TERTULIA_ROOT`/`APOLLO_ROOT` only
   (path-traversal guarded, size-capped). Justify existence in README: agents
   need code context; the boundary is *which* code (these two repos, nothing
   else on disk).
6. (stretch) `query_scratch` — run a **SELECT-only** query against the scratch
   DB (reject anything that isn't a single SELECT; statement allowlist, row
   cap). The README section on why SELECT-only, why scratch-only, and why row
   caps writes the governance chapter for you.
7. (stretch) `exercise_registration` — drive Apollo's registration/confirmation
   flow against the local instance with a throwaway user; report each step's
   outcome. This is the Apollo demo tool.

## Capability boundaries — the README's centerpiece

For every tool, document: what it can do, what it deliberately cannot, and why
the line is where it is. Summary table format:

| Tool | Reads | Executes | Mutates | Reaches |
|---|---|---|---|---|
| run_tests | build output | sbt | nothing persistent | local FS |
| describe_schema | schema only | — | — | scratch DB |
| ... | | | | |

Then the governance section (~500 words, the author will rewrite in his own
voice — leave a marked TODO):
- Why this pattern matters where agents are not yet permitted (federal
  governance problem: agents can't touch government code today; tool layers
  can be built and reviewed *now*, agent connection authorized *later*).
- The target architecture when permission arrives: authorized model inside the
  boundary (e.g. Bedrock in GovCloud), MCP as the controlled tool layer,
  capability boundaries as the ATO story — auditable tool calls,
  least-privilege by construction, no code exfiltration.
- Explicit parallel: this repo demonstrates the pattern on a production system
  the author owns, because the systems that need it most can't host the demo.

## Repo hygiene

- README.md as described (this is 40% of the project's value)
- `npm run build`, `npm run dev` (server on stdio), example Claude Desktop /
  Claude Code MCP config snippet showing how to register the server
- MIT license, matching Apollo's ecosystem posture
- Small: one `src/index.ts` + `src/tools/*.ts`; resist scaffolding sprawl

## Definition of done for the first session

Server starts, registers with a client, `run_tests` + `describe_schema` +
`list_routes` work against a local checkout, README exists with the boundary
table and a TODO-marked governance section. Everything else is stretch.