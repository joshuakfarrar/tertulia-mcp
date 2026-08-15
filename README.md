# tertulia-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an AI agent a
bounded, least-privilege operational surface over **Tertulia**, a production
Scala/Http4s microblogging application built on the
[Apollo](https://github.com/joshuakfarrar/apollo) authentication library.

It exists for two reasons, in this order:

1. **To demonstrate agent-tooling design under governance constraints.** The
   capability boundaries below are the deliverable. They map to environments
   where agents cannot yet be connected to systems at all — see
   [Why this pattern](#why-this-pattern-governance) at the end.
2. **To be genuinely useful** for developing Tertulia and Apollo with an agent.

## The one architectural decision

The MCP server is a **separate TypeScript process that never links against the
Scala application.** It operates Tertulia from the outside, exactly as a human
developer does: subprocesses, database queries against a scratch database,
static reads of the source tree, and HTTP calls to a local dev instance.

Everything else follows from that:

- **Tertulia's stack is opaque to this layer.** Scala, Http4s, doobie, Apollo,
  the JVM — none of it is a dependency here. Zero shared code. The same server
  design would work against a Rails app or a Go service; that is the point.
- **The process boundary is the governance boundary.** An agent's capabilities
  are exactly the six tools registered in `src/index.ts`. There is no
  in-process API to reach past a tool, because there is no in-process anything
  — the application is on the other side of a `spawn()`.
- **Production is unreachable by construction.** Every network target is
  validated as loopback at startup, before the server accepts a single tool
  call. This is a design decision, not an omission. See
  [The locality guard](#the-locality-guard).

## Install

```bash
npm install
npm run build
```

Requires Node 20+. The database tools additionally require the PostgreSQL
client (`psql`) on `PATH`; the test runner requires whichever build tool the
target project uses (Mill or sbt).

## Configuration

All configuration is environment variables, and all of them are local.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TERTULIA_ROOT` | yes | — | Path to the Tertulia source checkout |
| `APOLLO_ROOT` | no | — | Path to the Apollo checkout; unset disables Apollo tools |
| `TERTULIA_DB_URL` | no | `postgresql://localhost:5432/tertulia_scratch` | Connection URI for the **scratch** database |
| `TERTULIA_BASE_URL` | no | `http://localhost:8080` | Local dev instance |

`TERTULIA_ROOT` deliberately has no default. Guessing a source root would widen
the file-read boundary to whatever happened to be in the working directory.

### The locality guard

At startup, `TERTULIA_DB_URL` and `TERTULIA_BASE_URL` are parsed and their
hostnames checked against a loopback allowlist: `localhost`, `127.0.0.0/8`,
and `::1`. Anything else and the process **refuses to start** with a message
saying so. There is no tool argument, no request field, and no runtime path
that can introduce a host afterwards.

```
$ TERTULIA_DB_URL=postgresql://db.prod.example.com/tertulia npm start
tertulia-mcp: refusing to start.

TERTULIA_DB_URL points at "db.prod.example.com", which is not a loopback host.
The scratch database may only address localhost, 127.0.0.0/8, or ::1. This is a
design boundary, not a configuration gap: this server has no supported path to a
non-local scratch database. Refusing to start.
```

Two details that matter more than they look:

- **Hostnames are never resolved through DNS to make this decision.** A name
  that resolves to loopback today can resolve elsewhere tomorrow, and the guard
  would silently stop holding. Only literal loopback addresses and the exact
  string `localhost` are accepted, so `127.0.0.1.attacker.example.com` is
  refused rather than parsed as an address.
- **An unparseable value is refused, not assumed local.** Failing closed is the
  only safe default for a check whose entire job is to be unbypassable.

### Registering with a client

Claude Code:

```bash
claude mcp add tertulia -- node /absolute/path/to/tertulia-mcp/dist/index.js
```

Claude Desktop (`claude_desktop_config.json`) or any other MCP client:

```json
{
  "mcpServers": {
    "tertulia": {
      "command": "node",
      "args": ["/absolute/path/to/tertulia-mcp/dist/index.js"],
      "env": {
        "TERTULIA_ROOT": "/absolute/path/to/tertulia",
        "APOLLO_ROOT": "/absolute/path/to/apollo",
        "TERTULIA_DB_URL": "postgresql://localhost:5432/tertulia_scratch",
        "TERTULIA_BASE_URL": "http://localhost:8080"
      }
    }
  }
}
```

## Capability boundaries

**v1 has no write tools.** Not "write tools that are carefully guarded" — none.
Nothing in this server modifies source, schema, or data.

| Tool | Reads | Executes | Mutates | Reaches |
|---|---|---|---|---|
| `run_tests` | build output | Mill or sbt | nothing persistent | local FS |
| `describe_schema` | catalog metadata only | — | — | scratch DB |
| `list_routes` | `.scala` files | — | — | local FS |
| `app_status` | one HTTP response | — | — | `localhost` only |
| `read_source` | files inside the two roots | — | — | local FS |
| `query_scratch` | rows, capped | — | — | scratch DB, read-only |

For each tool: what it does, what it deliberately cannot do, and why the line
sits there.

### `run_tests`

Runs the test suite for either checkout and reports pass/fail with extracted
failure lines. The build tool is detected from marker files — `build.mill` or
`build.sc` for Mill, `build.sbt` for sbt — and a repo-local `./mill` or `./sbt`
wrapper is preferred over one on `PATH`.

**Cannot:** run an arbitrary command. The agent chooses *which suite*, never
*what command*. The command line is assembled from the detected build tool plus
an optional filter restricted to `[A-Za-z0-9_.*:/$-]`.

**Why there:** this is the only tool that executes project code, so it is the
one place where "the agent supplies part of a command line" occurs at all. sbt
reads *each argv element as a command to evaluate*, so an unrestricted filter
would be a second build command — `testOnly *Foo*` and `; publishSigned` differ
only by punctuation. The charset restriction rejects rather than escapes,
because rejecting is auditable and escaping is a bug waiting to happen. No
shell is used, so argv elements reach the process verbatim.

**Also bounded:** concurrent runs are refused rather than queued (two builds in
one checkout contend for the same lock), and a run that exceeds its timeout has
its **entire process group** killed — necessary because both Mill and sbt do
their real work in a daemon that would otherwise survive, hold the inherited
output pipe open, and hang the call forever.

### `describe_schema`

Introspects the scratch database: tables, columns, types, nullability,
defaults, indexes, and constraints.

**Cannot:** return a row of application data, under any arguments.

**Why there:** the boundary is *structure versus content*. Schema is what an
agent needs to reason about migrations, queries, and doobie mappings. Rows are
what people wrote — and for Tertulia, that is user-generated content. The tool
queries `pg_catalog` exclusively, so there is no argument that turns it into a
data read.

### `list_routes`

Statically parses Http4s route definitions and reports method, path, and
`file:line`.

**Cannot:** tell you what the running server actually serves.

**Why there:** asking the application to enumerate its own routes would require
linking against Http4s — the exact coupling this design exists to avoid. So it
reads source instead, and accepts a real limitation in exchange for keeping the
process boundary intact. It recognises the literal
`case METHOD -> Root / "segment" / variable` form, including Scala 3
significant-indentation syntax and the `request @` binding. It does **not** see
routes assembled dynamically, paths built from variables, or prefixes mounted
by middleware. Treat the output as a map of the source, not a contract.

### `app_status`

GETs a path on the local instance and reports up/down, HTTP status,
identifying headers, and a body preview.

**Cannot:** choose a host. The caller supplies a *path*; the host comes from
configuration that was validated at startup.

**Why there:** an agent that can name a host has an egress channel. An agent
that can only name a path does not. Resolution is re-checked against the base
origin after parsing, so `//example.com/x` and `https://example.com/x` are both
refused rather than quietly resolving elsewhere. Redirects are reported, not
followed.

### `read_source`

Reads a file (optionally a line range) from either configured checkout.

**Cannot:** read anything outside those two roots.

**Why there:** an agent cannot reason about code it cannot see, so file reading
has to exist. The boundary is therefore not *whether* to allow reads but
*which* files — these two repositories, nothing else on the disk. Containment
is enforced **after** `realpath()`, so a symlink inside a checkout pointing at
`~/.ssh` resolves outside the root and is refused. Checking before resolution
would let the filesystem decide the boundary.

### `query_scratch`

Runs a single read-only `SELECT` and returns capped rows.

**Cannot:** write, run DDL, stack statements, reach the filesystem, or reach
another database.

**Why there:** this is the widest tool, so it carries the most constraint —
three independent layers, on the assumption that each will eventually be found
wanting:

1. **Shape.** Must be a single `SELECT` or `WITH`. No internal semicolons.
   Dollar-quoted strings are refused outright rather than parsed, because their
   contents cannot be reliably scanned.
2. **Content.** A keyword denylist covering writes, DDL, transaction control,
   the `pg_read_file` / `pg_ls_dir` family, large-object functions, and
   `dblink` — that last one because a federated query would route straight
   around the locality guard. Scanning happens *after* string literals are
   masked, so `SELECT 'delete me'` is allowed while
   `WITH x AS (INSERT ...) SELECT` is not.
3. **The server.** Every connection sets `default_transaction_read_only=on`,
   so PostgreSQL itself rejects writes regardless of what SQL arrives.

Layer 3 is the one that actually holds; layers 1 and 2 exist so an agent gets a
legible refusal instead of a driver error, and so read-only is not a single
point of failure. Row counts are capped and truncation is *reported* — a
silently-truncated result set reads as a complete answer, which is worse than
no answer.

**Not enforced by this server:** that the database is a *scratch* database.
The process enforces locality and read-only; "scratch" is a convention the
operator upholds. Said plainly because a boundary you claim but do not enforce
is worse than one you never claimed.

### Why there is no connection pool

The database tools shell out to `psql` rather than linking a driver. This
server therefore holds no pool, keeps no session between calls, and has no
in-process handle for later code to reuse. Every query is a fresh, short-lived,
independently constrained connection with its own statement timeout.

## Verifying the boundaries

The claims above are executable. `scripts/verify-boundaries.mjs` drives a real
server over a real stdio MCP connection and asserts each one:

```bash
npm run build
TERTULIA_ROOT=/path/to/tertulia \
TERTULIA_DB_URL=postgresql://localhost:5432/tertulia_scratch \
  npm run verify
```

```
filesystem boundary — reads confined to the configured roots
  PASS  relative traversal escapes root
  PASS  absolute path refused
  PASS  in-root read succeeds
...
22 passed, 0 failed, 0 skipped
```

Every refusal is paired with a **positive control** that must succeed. A filter
that rejects everything is not a boundary, it is a broken tool — so the suite
also asserts that `SELECT 'delete me'` is allowed, that a column named
`created_at` does not trip the `CREATE` denylist, and that legitimate reads
still work. Boundaries that only ever say no are indistinguishable from an
outage.

## Known limitations

Stated rather than buried, because a tool layer whose limits are undocumented
cannot be reviewed:

- `list_routes` is a heuristic source parse. It reports what the source says,
  not what the server serves.
- "Scratch database" is an operator convention, not an enforced property.
- The locality guard constrains *this server's* configuration. It is not a
  network control, and does not replace one.
- `run_tests` inherits the environment it is started with, including any
  credentials present there.

## Why this pattern (governance)

> **TODO — rewrite in the author's own voice.** Draft below; the argument is
> right, the phrasing is mine, not his.

The systems that most need governed agent tooling are the ones where agents
cannot be connected at all. Inside a federal boundary, an agent touching
government code is not a procurement question or a budget question — it is
simply not authorized today. The reflexive conclusion is that this work waits
until policy changes.

That conclusion is wrong, and the reason is a sequencing observation. The tool
layer and the model connection are separable. What makes an agent safe to
connect is not the model; it is the enumerated surface it can act through — and
that surface can be designed, built, reviewed, and accredited *now*, while
connection remains prohibited. When authorization arrives, the reviewable
artifact already exists and has a history. The alternative is to begin design
on the day permission is granted, which is the worst possible moment to start
thinking about least privilege.

The target architecture is not speculative. An authorized model runs inside the
boundary — Bedrock in GovCloud, or an equivalent accredited endpoint. MCP is
the controlled tool layer between that model and the system. The capability
boundaries are the ATO story, and they are unusually well-suited to it: every
agent action is a tool call, so the audit log is complete by construction rather
than by instrumentation. Least privilege is structural rather than
policy-enforced — an agent cannot exceed its tool list, because there is no
mechanism by which it could. And because the tool layer never links against the
application, source never leaves the boundary; the model sees what a tool
returns, and nothing else.

This is also why the boundaries here are stated as *deliberate negations*
rather than as unimplemented features. "No write tools in v1" is a reviewable
claim. "Writes not yet implemented" is a roadmap item. An accreditation
reviewer needs the first kind of sentence, and a design that cannot produce
one is not ready to be reviewed regardless of how well it works.

The parallel is exact, and it is the reason this repository exists on a
production system the author owns rather than on the systems that need it most:
those systems cannot host the demonstration. Tertulia is a real application
with real users, real authentication, and a real database — the pattern is
shown working under production constraints, in public, where it can be read and
argued with. The governance problem is not that we lack a safe way to connect
agents to sensitive systems. It is that the safe way has to be built and
reviewed before anyone will authorize connecting them, and almost nobody is
building it during the window when it would help.

## License

MIT. See [LICENSE](LICENSE).
