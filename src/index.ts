#!/usr/bin/env node
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  McpServer,
  createMcpHandler,
  type Implementation,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import http from "node:http";
import { Command } from "commander";
import { loadConfig } from "./lib/config.js";
import { DeerFlowClient } from "./lib/client.js";
import { registerTools } from "./lib/tools.js";
import { registerResources } from "./lib/resources.js";

const SERVER_VERSION = "0.1.0";
const DEFAULT_HTTP_PORT = 3000;

const program = new Command()
  .name("deer-flow-mcp")
  .description("MCP server that drives a deployed DeerFlow instance over its HTTP API.")
  .version(SERVER_VERSION, "-v, --version", "output the current version")
  .option("--transport <stdio|http>", "transport type", "stdio")
  .option("--port <number>", "port for the HTTP transport", String(DEFAULT_HTTP_PORT))
  .allowUnknownOption()
  .parse(process.argv);

const cliOptions = program.opts<{ transport: string; port: string }>();

const allowedTransports = ["stdio", "http"];
if (!allowedTransports.includes(cliOptions.transport)) {
  console.error(
    `Invalid --transport value: '${cliOptions.transport}'. Must be one of: stdio, http.`
  );
  process.exit(1);
}
const TRANSPORT = cliOptions.transport as "stdio" | "http";

const SERVER_INFO: Implementation = {
  name: "deer-flow",
  version: SERVER_VERSION,
  description:
    "Drive a deployed DeerFlow instance: deep research plus full thread, run, and artifact control over the Gateway HTTP API.",
};

const SERVER_OPTIONS: ServerOptions = {
  instructions: `Use this server to run research and conversations on a deployed DeerFlow "super agent" and inspect the results.

Typical deep-research flow:
1. Call deerflow_research with the topic — it starts a background run and returns thread_id, run_id, and a web URL immediately.
2. Wait with deerflow_wait_activity(thread_id, run_id, since_seq=<last_event_seq>, timeout_seconds=30) in a loop. Each call blocks server-side (joining the run's live event stream, falling back to polling) and returns what happened: new activity (tool calls, messages), the plan-mode todo checklist, quiet/stall detection, and a next_step hint. It also emits MCP progress notifications while waiting. Pass the returned last_event_seq as since_seq on the next call. Stop when status is a terminal value (success, error, timeout, interrupted).
3. Call deerflow_get_report(thread_id, run_id) to read the synthesized report and artifact paths (it auto-inlines the first text artifact when no assistant message exists); use deerflow_get_artifact to read a specific file.

For quick non-blocking checks use deerflow_run_status (status + live counters: llm_call_count, message_count, total_tokens — if they stop advancing the run may be stalled) or deerflow_run_progress (event-level detail + todos + quiet/stall/next_step).

The report and each artifact are also available as MCP resources: deerflow://threads/{thread_id}/report and deerflow://threads/{thread_id}/artifacts/{path}.

For ordinary back-and-forth, use deerflow_chat (pass an existing thread_id to continue a conversation). Use deerflow_list_models to discover model names, deerflow_list_threads to find prior work, deerflow_cancel_run to stop a run, and deerflow_list_artifacts / deerflow_get_artifact to retrieve produced files.`,
};

function makeServer(client: DeerFlowClient): McpServer {
  const server = new McpServer(SERVER_INFO, SERVER_OPTIONS);
  registerTools(server, client);
  registerResources(server, client);
  return server;
}

function startStdio(): void {
  const config = loadConfig();
  const client = new DeerFlowClient(config, undefined, { pollIntervalMs: config.pollIntervalMs });
  const server = makeServer(client);
  const transport = new StdioServerTransport();
  void server.connect(transport).catch((err) => {
    console.error("Failed to start stdio transport:", err);
    process.exit(1);
  });
  console.error(`deer-flow-mcp v${SERVER_VERSION} running on stdio`);
}

function startHttp(): void {
  const config = loadConfig();
  const client = new DeerFlowClient(config, undefined, { pollIntervalMs: config.pollIntervalMs });
  const handler = createMcpHandler(() => makeServer(client), {
    onerror: (err) => console.error("MCP handler error:", err),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (err) => console.error("MCP node adapter error:", err),
  });

  const port = (() => {
    const parsed = parseInt(cliOptions.port, 10);
    return Number.isNaN(parsed) ? DEFAULT_HTTP_PORT : parsed;
  })();

  const httpServer = http.createServer((req, res) => {
    void nodeHandler(req, res).catch((err) => {
      console.error("MCP request error:", err);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        })
      );
    });
  });

  const shutdown = () => {
    void handler.close().catch(() => {});
    httpServer.close(() => process.exit(0));
    // Hard exit if connections keep the server open.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`Failed to start HTTP server: ${err.message}`);
    process.exit(1);
  });
  httpServer.listen(port, () => {
    console.error(`deer-flow-mcp v${SERVER_VERSION} running on HTTP at http://localhost:${port}`);
  });
}

try {
  if (TRANSPORT === "http") {
    startHttp();
  } else {
    startStdio();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
