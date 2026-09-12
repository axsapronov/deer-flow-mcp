# deer-flow-mcp

[![npm version](https://badge.fury.io/js/deer-flow-mcp.svg)](https://www.npmjs.com/package/deer-flow-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](https://opensource.org/licenses/MIT) [![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.18.1-brightgreen)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that drives a deployed
[DeerFlow](https://deerflow.tech) instance over its HTTP API. It exposes DeerFlow's capabilities —
deep research, model listing, and full thread/run/artifact control — as MCP tools, so any
MCP-compatible client (Kilo, Claude Code, Cursor, VS Code, and others) can use them.

## How it works

`deer-flow-mcp` is a thin, stateless adapter. It does not run DeerFlow itself; it talks to an
already-deployed DeerFlow instance (the nginx entry point) using the credentials you configure.
Each MCP tool maps to one or more DeerFlow HTTP routes and returns the result as MCP content.

## Capabilities

- **Deep research** — kick off a DeerFlow "super agent" run on a topic and get back a structured,
  cited report saved as an artifact.
- **Model listing** — list the models available to DeerFlow (email/password or internal-token
  mode).
- **Thread / run / artifact control** — create threads, start and inspect runs, track status, and
  retrieve artifacts and reports.

## Requirements

- Node.js >= 20.18.1
- A deployed DeerFlow instance reachable at `DEERFLOW_BASE_URL`

## Install

`deer-flow-mcp` is published on npm and runs directly with `npx` — no local build required:

```bash
npx -y deer-flow-mcp --version
```

> To build from source (for development or contribution), see [Development](#development).

## Configuration

All configuration is environment-driven — there is **no config file and no `.env` loading**. The
server reads `process.env` directly, so an MCP client must pass the DeerFlow variables through its
own `env` / `environment` field (see [Install in an MCP client](#install-in-an-mcp-client)).

The server **fails fast** with a descriptive error at startup if required values are missing, so
the MCP client gets a clean error instead of a cryptic first-request failure.

| Variable                           | Required     | Description                                                                  |
| ---------------------------------- | ------------ | ---------------------------------------------------------------------------- |
| `DEERFLOW_BASE_URL`                | yes          | Base URL of the deployed DeerFlow instance (trailing slashes ignored)        |
| `DEERFLOW_EMAIL`                   | one of three | Account email; used with `DEERFLOW_PASSWORD` (tried first; full user access) |
| `DEERFLOW_PASSWORD`                | one of three | Account password; used with `DEERFLOW_EMAIL` (tried first; full user access) |
| `DEERFLOW_PAT`                     | one of three | Personal Access Token (starts with `dfp_`); threads/runs routes only         |
| `DEERFLOW_INTERNAL_TOKEN`          | one of three | Gateway internal token; full access (models + artifact files)                |
| `DEERFLOW_OWNER_USER_ID`           | no           | Used only with internal-token mode                                           |
| `DEERFLOW_DEFAULT_MODEL`           | no           | Default model when a tool call omits `model`                                 |
| `DEERFLOW_DEFAULT_RECURSION_LIMIT` | no           | Default LangGraph recursion limit (default `1000`)                           |
| `DEERFLOW_TIMEOUT_MS`              | no           | Per-request HTTP timeout in ms (default `60000`)                             |
| `DEERFLOW_WEB_BASE_URL`            | no           | Base URL for "open in DeerFlow" links (defaults to `DEERFLOW_BASE_URL`)      |

### Authentication

`deer-flow-mcp` authenticates to DeerFlow one of three ways — a discriminated union, so set
**exactly one** of the credential modes (email/password is tried first, then PAT, then internal
token):

- **Email/password** (`DEERFLOW_EMAIL` + `DEERFLOW_PASSWORD`) — logs in like the web UI
  (`POST /api/v1/auth/login/local`) and carries the resulting session cookie (plus the
  CSRF token) on every call. This is the same credential you type into the browser: it works on
  every deployment (no DB, no internal secret) and grants **full user access**, including models
  and artifact files. Both variables must be set together; the login happens lazily on first use
  and is retried once if the session expires.
- **PAT** (`DEERFLOW_PAT`) — a per-user **Personal Access Token** (`dfp_…`), sent as
  `Authorization: Bearer dfp_…`. Restricted to the thread/run lifecycle routes;
  `deerflow_list_models` and `deerflow_get_artifact` return 403 for PAT callers.
- **Internal token** (`DEERFLOW_INTERNAL_TOKEN`) — the deployment-level
  `DEER_FLOW_INTERNAL_AUTH_TOKEN` shared secret, sent as `X-DeerFlow-Internal-Token` (optionally
  with `X-DeerFlow-Owner-User-Id`). Full access, including models and artifact files.

All three target the same entry point: the nginx reverse proxy, default `http://<host>:2026`
(the port is configurable via the `PORT` env var). That is the URL you put in
`DEERFLOW_BASE_URL`.

#### Getting a Personal Access Token (`DEERFLOW_PAT`)

A PAT is a per-user credential created from the Gateway API while you are logged in. There is
no dedicated page for it in the web UI, and it requires a **database-backed** deployment (SQLite
or PostgreSQL) — a memory-only instance rejects Bearer tokens and the PAT routes return `503`.

1. **Sign in to the web UI.** Open your DeerFlow instance.
   - First boot: open `/setup` and create the first admin account (email + password).
   - Afterwards: open `/login` and sign in with your email and password (or your SSO provider).
     A successful login sets the `access_token` session cookie.
2. **Create the token from the API.** Copy your `access_token` cookie value (browser DevTools →
   **Application → Cookies**, or the `Cookie` header of any request in **Network**), then:

   ```bash
   curl -s -X POST "$DEERFLOW_BASE_URL/api/v1/auth/pats" \
     -H "Content-Type: application/json" \
     -H "Cookie: access_token=<ACCESS_TOKEN>" \
     -d '{
           "name": "deer-flow-mcp",
           "scopes": ["threads:read", "threads:write", "runs:create", "runs:read", "runs:cancel"],
           "expires_in_days": 365
         }'
   ```

   The `token` field in the response is your `dfp_…` value. It is **shown exactly once** and
   cannot be retrieved again — only its SHA-256 digest is stored. Save it immediately.

3. **Use it.** Put that value in `DEERFLOW_PAT`.

The scopes above cover every `deer-flow-mcp` tool except `deerflow_list_models` and
`deerflow_get_artifact` (both 403 for PAT callers — use email/password or an internal token if
you need them).
You can list your tokens with `GET /api/v1/auth/pats` and revoke one with
`DELETE /api/v1/auth/pats/{pat_id}`; revocation is immediate.

#### Getting the internal token (`DEERFLOW_INTERNAL_TOKEN`)

The internal token is a **deployment-level secret** set on the Gateway — it is not tied to any
user and is not created from the web UI. Its value is the Gateway's `DEER_FLOW_INTERNAL_AUTH_TOKEN`
environment variable.

- **Docker** (`make up` / the bundled deploy script) — the token is generated automatically and
  persisted to `$DEER_FLOW_HOME/.internal-auth-token` (mode `600`). `DEER_FLOW_HOME` defaults to
  `<repo>/backend/.deer-flow` on the host (mounted into the container at
  `/app/backend/.deer-flow`), so read it with:

  ```bash
  cat backend/.deer-flow/.internal-auth-token
  # or from the running gateway container:
  docker compose exec gateway printenv DEER_FLOW_INTERNAL_AUTH_TOKEN
  ```

- **Helm / Kubernetes** — it is stored in the chart's app Secret under the key
  `DEER_FLOW_INTERNAL_AUTH_TOKEN` (the Secret name is printed in the install NOTES):

  ```bash
  kubectl -n <namespace> get secret <app-secret> \
    -o jsonpath='{.data.DEER_FLOW_INTERNAL_AUTH_TOKEN}' | base64 -d
  ```

- **Manual** — set `DEER_FLOW_INTERNAL_AUTH_TOKEN` to a long random secret in your `.env` and
  restart the stack, then use that same value here.

Put the value in `DEERFLOW_INTERNAL_TOKEN`. To isolate runs under a specific owner, also set
`DEERFLOW_OWNER_USER_ID` (sent as `X-DeerFlow-Owner-User-Id`).

## Install in an MCP client

`deer-flow-mcp` is a local **stdio** server started with `npx -y deer-flow-mcp`. In every client
config below the server is launched via `npx`, and you must pass at least `DEERFLOW_BASE_URL` and
one credential (`DEERFLOW_EMAIL` + `DEERFLOW_PASSWORD`, `DEERFLOW_PAT`, or
`DEERFLOW_INTERNAL_TOKEN`) through the `env` / `environment` field. For remote/shared access over
Streamable HTTP instead, see [Usage](#usage).

### Kilo

Kilo reads MCP servers from `kilo.json`. Use the project file `./kilo.json` (or `.kilo/kilo.json`)
for a single project, or the global `~/.config/kilo/kilo.json` for all projects.

```json
{
  "mcp": {
    "deerflow": {
      "type": "local",
      "command": ["npx", "-y", "deer-flow-mcp"],
      "environment": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      },
      "enabled": true
    }
  }
}
```

Notes:

- `command` is an **array**; the first element is the executable (`npx`), the rest are its args.
- Environment variables go in the `environment` object (`KEY: value`).
- Email/password is the simplest full-access option and is tried first. As
  alternatives: `DEERFLOW_PAT` (threads/runs routes only) or
  `DEERFLOW_INTERNAL_TOKEN` (deployment-level full access, optionally with
  `DEERFLOW_OWNER_USER_ID`).
- Restart Kilo (or reload MCP servers) to pick up the change.

<details>
<summary><b>Install in Claude Code</b></summary>

Add it with the CLI (user scope, so it is available across projects):

```bash
claude mcp add --scope user \
  --env DEERFLOW_BASE_URL=https://deerflow.example.com \
  --env DEERFLOW_EMAIL=you@example.com \
  --env DEERFLOW_PASSWORD=... \
  --transport stdio \
  deerflow -- npx -y deer-flow-mcp
```

Or add a `deerflow` entry under `mcpServers` in a project `.mcp.json` (shared with your team) or
in `~/.claude.json` (user scope):

```json
{
  "mcpServers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

Verify with `claude mcp get deerflow` or `/mcp` inside a session.
</details>

<details>
<summary><b>Install in Cursor</b></summary>

Add a `deerflow` entry under `mcpServers` in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json`
(per project):

```json
{
  "mcpServers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

</details>

<details>
<summary><b>Install in VS Code</b></summary>

Add a `deerflow` entry under `servers` in `.vscode/mcp.json` (per project) or in your user
`mcp.json`:

```json
{
  "servers": {
    "deerflow": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

</details>

<details>
<summary><b>Install in OpenAI Codex</b></summary>

Add a `[mcp_servers.deerflow]` table to `~/.codex/config.toml` (or a project-scoped
`.codex/config.toml`):

```toml
[mcp_servers.deerflow]
command = "npx"
args = ["-y", "deer-flow-mcp"]

[mcp_servers.deerflow.env]
DEERFLOW_BASE_URL = "https://deerflow.example.com"
DEERFLOW_EMAIL = "you@example.com"
DEERFLOW_PASSWORD = "..."
```

Or add it with the CLI:

```bash
codex mcp add deerflow \
  --env DEERFLOW_BASE_URL=https://deerflow.example.com \
  --env DEERFLOW_EMAIL=you@example.com \
  --env DEERFLOW_PASSWORD=... \
  -- npx -y deer-flow-mcp
```

Verify with `codex mcp list` or `/mcp` in the TUI.
</details>

<details>
<summary><b>Install in Gemini CLI</b></summary>

Add a `deerflow` entry under `mcpServers` in `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

</details>

<details>
<summary><b>Install in Zed</b></summary>

Add a `deerflow` entry under `context_servers` in your Zed `settings.json`:

```json
{
  "context_servers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

</details>

<details>
<summary><b>Install in Cline</b></summary>

Add a `deerflow` entry under `mcpServers` in `.cline/mcp_settings.json` (or add it from the Cline
**MCP Servers** UI):

```json
{
  "mcpServers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

</details>

<details>
<summary><b>Install in Roo Code</b></summary>

Add a `deerflow` entry under `mcpServers` in your Roo Code MCP configuration:

```json
{
  "mcpServers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

</details>

<details>
<summary><b>Install in Claude Desktop</b></summary>

Add a `deerflow` entry under `mcpServers` in your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "deerflow": {
      "command": "npx",
      "args": ["-y", "deer-flow-mcp"],
      "env": {
        "DEERFLOW_BASE_URL": "https://deerflow.example.com",
        "DEERFLOW_EMAIL": "you@example.com",
        "DEERFLOW_PASSWORD": "..."
      }
    }
  }
}
```

Restart Claude Desktop after saving.
</details>

## Available MCP tools

| Tool                      | Description                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deerflow_research`       | Start a deep-research run on a fresh thread. Args: `topic`, optional `focus`, `model`, `recursion_limit`. Returns thread/run ids and a web URL immediately. |
| `deerflow_chat`           | Send a message to a DeerFlow thread and start a run. Args: `message`, optional `thread_id`, `model`, `recursion_limit`.                                     |
| `deerflow_run_status`     | Check a run's status, optionally waiting up to `wait_seconds` (0–30) for a terminal status. Args: `thread_id`, `run_id`, optional `wait_seconds`.           |
| `deerflow_get_report`     | Fetch the synthesized report (title, assistant message, artifact paths). Args: `thread_id`, optional `run_id`.                                              |
| `deerflow_list_threads`   | List recent threads. Args: optional `limit`, `include_archived`.                                                                                            |
| `deerflow_cancel_run`     | Cancel (interrupt) an in-flight run. Args: `thread_id`, `run_id`.                                                                                           |
| `deerflow_list_artifacts` | List artifact file paths produced by a thread. Args: `thread_id`.                                                                                           |
| `deerflow_get_artifact`   | Fetch one artifact (inline text, or a URL for binary files). Args: `thread_id`, `path`.                                                                     |
| `deerflow_list_models`    | List configured models (name, display name, capability flags). No args. Not available with a PAT (email/password or internal token required).               |

The server also advertises MCP `instructions` that walk a client through the typical deep-research
flow: `deerflow_research` → poll `deerflow_run_status` → `deerflow_get_report` → `deerflow_get_artifact`.

## Usage

Run over **stdio** (the default MCP transport for local clients):

```bash
npx -y deer-flow-mcp
```

Run over **Streamable HTTP** for remote or shared access (default port `3000`, override with
`--port`):

```bash
npx -y deer-flow-mcp --transport http --port 3000
```

For a remote instance, a client points at the resulting URL (e.g. `http://localhost:3000`) with a
`url` / remote entry instead of launching a local `command`.

Or, after a local build, use the package binary:

```bash
deer-flow-mcp --transport http
```

CLI options:

| Flag                        | Description                 | Default |
| --------------------------- | --------------------------- | ------- |
| `--transport <stdio\|http>` | Transport type              | `stdio` |
| `--port <number>`           | Port for the HTTP transport | `3000`  |
| `-v, --version`             | Print the version           | —       |

## Development

To build from source:

```bash
pnpm install       # install dependencies
pnpm build         # compile to dist/
pnpm typecheck     # tsc --noEmit
pnpm lint          # eslint
pnpm test          # vitest run
pnpm format        # prettier --write .
```

Run the built server locally:

```bash
node dist/index.js                               # stdio
node dist/index.js --transport http --port 3000  # Streamable HTTP
```

The same targets are available via the Makefile (see `make help`):

```bash
make install
make build
make check         # typecheck + lint + test
make start         # build then run the HTTP server
```

## Publishing

```bash
npm publish        # or: pnpm publish
```

The `prepublishOnly` script runs typecheck, lint, test, and build automatically before publishing,
so the published package is always built and verified.

## Security

- Never commit `.env` or secrets; only `.env.example` is tracked.
- Tokens are credentials — they are sent as auth headers and must never be logged.
- All outbound traffic goes to `DEERFLOW_BASE_URL`.
