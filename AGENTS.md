# AGENTS.md

This file provides guidance to AI coding agents (Codex, Claude, Cursor, Kilo, etc.)
when working with code in this repository. Keep it accurate as the project evolves.

## Project Overview

`deer-flow-mcp` is a **Model Context Protocol (MCP) server** that drives a deployed
[DeerFlow](https://deerflow.tech) instance over its HTTP API. It exposes DeerFlow's
capabilities — deep research, model listing, and full thread/run/artifact control —
as MCP tools so any MCP-compatible client can use them.

- Language: TypeScript (strict), ESM (`"type": "module"`, `module: NodeNext`)
- Runtime: Node.js >= 20.18.1
- MCP SDK (v2, 2026-07-28 spec): `@modelcontextprotocol/server` + `@modelcontextprotocol/node`
- Outbound HTTP client: `undici`
- CLI parsing: `commander`
- Schemas / validation: `zod` v4 (Standard Schema)
- Tests: Vitest

## Setup

- Package manager: **pnpm** (lockfile: `pnpm-lock.yaml`). Use `pnpm`, not `npm`/`yarn`.
- Requires Node.js >= 20.18.1.
- Install dependencies: `pnpm install`
- Configuration is 100% environment-driven — see [Configuration](#configuration) and `.env.example`.

## Commands

| Command             | Purpose                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| `pnpm build`        | Compile TypeScript to `dist/` (also `chmod 755 dist/index.js`)                    |
| `pnpm typecheck`    | Type-check without emitting (`tsc --noEmit`)                                      |
| `pnpm lint`         | ESLint (flat config, `eslint.config.js`)                                          |
| `pnpm format`       | Prettier write                                                                    |
| `pnpm format:check` | Verify formatting without writing                                                 |
| `pnpm test`         | Run the Vitest suite once (`vitest run`)                                          |
| `pnpm dev`          | `tsc --watch`                                                                     |
| `pnpm start`        | Run the built server over Streamable HTTP (`node dist/index.js --transport http`) |

Before finishing any change, run `pnpm typecheck`, `pnpm lint`, and `pnpm test`, and
fix all failures. After moving files or changing imports, re-run `pnpm lint` to confirm
ESLint + TypeScript rules still pass.

The same targets are available via the Makefile (`make help` to list them): `make install`,
`make build`, `make typecheck`, `make lint`, `make test`, and `make check` (runs
typecheck + lint + test together). Prefer the `pnpm` commands above; the Makefile is a
convenience wrapper around them.

## Project Structure

```
src/
  index.ts        # Entry point (-> dist/index.js): CLI parsing, transport selection, McpServer bootstrap
  lib/
    config.ts     # Env parsing/validation -> DeerFlowConfig; ConfigError
    types.ts      # Shared types: RunStatus, ThreadSummary, RunInfo, Report, ModelInfo, DeerFlowAuth, DeerFlowConfig
    prompts.ts    # Deep-research prompt assembly (buildResearchPrompt)
test/             # Vitest tests (mirror the src/ layout)
```

> Status: the server is implemented end to end. The entry point (`src/index.ts`) wires the
> CLI and transport; `src/lib/tools.ts` registers the DeerFlow tools (research, chat,
> run status/progress/wait-activity, report, threads, artifacts, models) on the `McpServer`.

## Configuration

All configuration comes from environment variables (see `.env.example`). **Never
hardcode or commit secrets.** Values are parsed and validated in `src/lib/config.ts`
(`loadConfig`), which **fails fast** with a descriptive `ConfigError` at startup so the
MCP client gets a clean error instead of a cryptic first-request failure.

- `DEERFLOW_BASE_URL` (required) — base URL of the deployed DeerFlow instance (trailing slashes ignored)
- `DEERFLOW_PAT` — Personal Access Token (starts with `dfp_`); restricted to threads/runs routes
- `DEERFLOW_INTERNAL_TOKEN` — gateway internal token; full access (models + artifact files)
- `DEERFLOW_OWNER_USER_ID` — used only with internal-token mode
- Optional defaults: `DEERFLOW_DEFAULT_MODEL`, `DEERFLOW_DEFAULT_RECURSION_LIMIT` (default 1000),
  `DEERFLOW_TIMEOUT_MS` (default 60000), `DEERFLOW_WEB_BASE_URL`,
  `DEERFLOW_STALL_THRESHOLD_SECONDS` (default 180 — seconds without activity before a running run is
  reported as stalled), `DEERFLOW_PROGRESS_WAIT_MAX_SECONDS` (default 120 — cap for the
  `deerflow_wait_activity` timeout)

Auth is a discriminated union (`DeerFlowAuth`): either `pat` or `internal`. PAT callers
cannot reach `/api/models` or individual artifact files (they 403); use internal-token
mode for full access.

## MCP Server Conventions

- Use the **v2** SDK: `import { McpServer } from "@modelcontextprotocol/server"` and
  `new McpServer({ name, version })`.
- Register tools with `server.registerTool(name, { description, inputSchema }, handler)`.
- Tool input schemas use **Standard Schema** — use `zod` v4 (`import * as z from "zod/v4"`).
- Transports: stdio via `@modelcontextprotocol/server/stdio`; HTTP via the
  `@modelcontextprotocol/node` Streamable HTTP wrapper. The CLI selects the transport
  (`--transport`); the `start` script defaults to `http`.
- Tool handlers return MCP content: `{ content: [{ type: "text", text }] }`.
- Tool `name` and `description` are the primary interface for LLM clients — make them
  clear, self-contained, and specific.
- Reuse the shared DeerFlow HTTP client and config from `src/lib/`; do **not** duplicate
  base-URL or auth logic per tool.

## Code Style

- TypeScript **strict** mode is on (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`).
- ESM only — relative imports **must** use explicit `.js` extensions
  (e.g. `import { DeerFlowConfig } from "./types.js"`), matching `module: NodeNext`.
- Prettier: 2-space indent, double quotes, 100-char print width, trailing commas (es5),
  LF line endings, always parens on arrow params.
- ESLint (typescript-eslint recommended + prettier-as-error): no unused vars (a leading
  `_` is allowed), and `no-explicit-any` is a warning — avoid `any`.
- Follow the existing style in `src/lib/`: small focused modules, exported types, and
  JSDoc on public functions.

## Testing

- Framework: **Vitest** (`pnpm test` = `vitest run`); tests live in `test/` and are
  type-checked by `tsconfig.test.json`.
- Add or update tests for the code you change, even if not asked.
- Prefer unit tests that **inject** a config/env map (see `loadConfig(env)`, which
  accepts an env argument) over mutating `process.env`.
- To run a single test, use `pnpm vitest run -t "<test name>"`.

## Security

- Never commit `.env` or any secrets; only `.env.example` is tracked (see `.gitignore`).
- PATs start with `dfp_`; internal tokens are shared secrets — treat them as credentials.
- All outbound traffic goes to `DEERFLOW_BASE_URL`. Do not add other network endpoints
  without review.
- Surface `ConfigError` messages safely, but **never** log tokens or full auth headers.

## Adding a New Tool

1. Define the tool's input schema with `zod` v4.
2. Register it on the `McpServer` with a clear `description` and `inputSchema`.
3. Implement the handler to call the DeerFlow HTTP API, reusing the shared client/config.
4. Map the DeerFlow response into MCP content; include a human-friendly "open in
   DeerFlow" link where useful (built from `webBaseUrl` → `/workspace/chats/<thread_id>`).
5. Add or adjust tests in `test/`, then run `pnpm typecheck`, `pnpm lint`, and `pnpm test`.
