# deer-flow-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that drives a deployed
[DeerFlow](https://deerflow.tech) instance over its HTTP API. It exposes DeerFlow's capabilities —
deep research, model listing, and full thread/run/artifact control — as MCP tools, so any
MCP-compatible client (Claude, Cursor, VS Code, and others) can use them.

## How it works

`deer-flow-mcp` is a thin, stateless adapter. It does not run DeerFlow itself; it talks to an
already-deployed DeerFlow instance (the nginx entry point) using the credentials you configure.
Each MCP tool maps to one or more DeerFlow HTTP routes and returns the result as MCP content.

## Capabilities

- **Deep research** — kick off a DeerFlow "super agent" run on a topic and get back a structured,
  cited report saved as an artifact.
- **Model listing** — list the models available to DeerFlow (internal-token mode only).
- **Thread / run / artifact control** — create threads, start and inspect runs, track status, and
  retrieve artifacts and reports.

> Status: the core client, config, and prompt modules are implemented. The `McpServer` entry point
> and the MCP tool registrations are the primary remaining surface.

## Requirements

- Node.js >= 20.18.1
- [pnpm](https://pnpm.io)
- A deployed DeerFlow instance reachable at `DEERFLOW_BASE_URL`

## Install

```bash
pnpm install
pnpm build
```

## Configuration

All configuration is environment-driven — no config files. Copy [`.env.example`](.env.example) as a
starting point. The server **fails fast** with a descriptive error at startup if required values
are missing, so the MCP client gets a clean error instead of a cryptic first-request failure.

| Variable                           | Required   | Description                                                             |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `DEERFLOW_BASE_URL`                | yes        | Base URL of the deployed DeerFlow instance (trailing slashes ignored)   |
| `DEERFLOW_PAT`                     | one of two | Personal Access Token (starts with `dfp_`); threads/runs routes only    |
| `DEERFLOW_INTERNAL_TOKEN`          | one of two | Gateway internal token; full access (models + artifact files)           |
| `DEERFLOW_OWNER_USER_ID`           | no         | Used only with internal-token mode                                      |
| `DEERFLOW_DEFAULT_MODEL`           | no         | Default model when a tool call omits `model`                            |
| `DEERFLOW_DEFAULT_RECURSION_LIMIT` | no         | Default LangGraph recursion limit (default `1000`)                      |
| `DEERFLOW_TIMEOUT_MS`              | no         | Per-request HTTP timeout in ms (default `60000`)                        |
| `DEERFLOW_WEB_BASE_URL`            | no         | Base URL for "open in DeerFlow" links (defaults to `DEERFLOW_BASE_URL`) |

### Authentication

Auth is a discriminated union: either `pat` or `internal`.

- **PAT** (`DEERFLOW_PAT`) — restricted to the threads/runs routes. `/api/models` and individual
  artifact files return 403 for PAT callers.
- **Internal token** (`DEERFLOW_INTERNAL_TOKEN`) — full access, including models and artifact
  files. Set `DEER_FLOW_INTERNAL_AUTH_TOKEN` on the DeerFlow Gateway to the same shared secret,
  then put that value here.

## Usage

Run over **stdio** (the default MCP transport for local clients):

```bash
node dist/index.js
```

Run over **Streamable HTTP** (for remote or shared access):

```bash
node dist/index.js --transport http
```

Or use the package binary:

```bash
deer-flow-mcp --transport http
```

## Development

```bash
pnpm install       # install dependencies
pnpm build         # compile to dist/
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm test          # vitest run
pnpm format        # prettier --write .
```

The same targets are available via the Makefile (see `make help`):

```bash
make install
make build
make check         # typecheck + lint + test
make start         # build then run the HTTP server
```

## Security

- Never commit `.env` or secrets; only `.env.example` is tracked.
- Tokens are credentials — they are sent as auth headers and must never be logged.
- All outbound traffic goes to `DEERFLOW_BASE_URL`.
