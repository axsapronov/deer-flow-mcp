import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

// End-to-end tests: the real built binary (dist/index.js) is spawned as a
// child process over both transports (streamable HTTP and stdio) and driven
// by a real MCP client. The remote DeerFlow API is stubbed with a local HTTP
// server that records every request, so we can assert what actually goes
// over the wire (auth headers, thread/run creation) instead of trusting the
// in-process unit tests alone.
//
// This complements test/tools.test.ts, which covers the same tools through
// an InMemoryTransport with a mocked fetch.

const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIST = path.join(PKG_ROOT, "dist", "index.js");

const ALL_TOOLS = [
  "deerflow_cancel_run",
  "deerflow_chat",
  "deerflow_get_artifact",
  "deerflow_get_report",
  "deerflow_list_artifacts",
  "deerflow_list_models",
  "deerflow_list_threads",
  "deerflow_research",
  "deerflow_run_status",
].sort();

// --- Stub DeerFlow API ------------------------------------------------------

interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

const requests: RecordedRequest[] = [];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

/**
 * A local stand-in for the DeerFlow Gateway API. It answers the routes the
 * client uses and records each request (method, path, headers, parsed body)
 * so tests can assert on the wire.
 */
function startStubDeerFlow(): Promise<{ url: string; server: http.Server }> {
  let threadSeq = 0;
  let runSeq = 0;
  const runPolls = new Map<string, number>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub.local");
    const method = req.method ?? "GET";
    const path = url.pathname;
    const rawBody = await readBody(req);
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      body = rawBody;
    }
    requests.push({ method, path, headers: req.headers, body });

    res.setHeader("Content-Type", "application/json");

    if (method === "POST" && path === "/api/threads") {
      threadSeq += 1;
      res.end(JSON.stringify({ thread_id: `t-${threadSeq}` }));
      return;
    }
    if (method === "POST" && path === "/api/threads/search") {
      res.end(JSON.stringify([]));
      return;
    }
    const runCreate = path.match(/^\/api\/threads\/([^/]+)\/runs$/);
    if (method === "POST" && runCreate) {
      runSeq += 1;
      res.end(
        JSON.stringify({ run_id: `r-${runSeq}`, thread_id: runCreate[1], status: "pending" })
      );
      return;
    }
    const runGet = path.match(/^\/api\/threads\/([^/]+)\/runs\/([^/]+)$/);
    if (method === "GET" && runGet) {
      const runId = runGet[2];
      const seen = (runPolls.get(runId) ?? 0) + 1;
      runPolls.set(runId, seen);
      // First poll is still running, later polls are done — exercises the
      // waitForRun polling loop without waiting for a real (minutes-long) run.
      res.end(
        JSON.stringify({
          run_id: runId,
          thread_id: runGet[1],
          status: seen === 1 ? "running" : "success",
        })
      );
      return;
    }
    if (method === "POST" && /^\/api\/threads\/[^/]+\/runs\/[^/]+\/cancel/.test(path)) {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "GET" && /\/api\/threads\/[^/]+\/state$/.test(path)) {
      res.end(
        JSON.stringify({
          values: {
            title: "My Report",
            artifacts: ["mnt/user-data/outputs/report.md"],
            messages: [{ type: "ai", content: "Final findings." }],
          },
        })
      );
      return;
    }
    if (method === "GET" && path === "/api/models") {
      res.end(
        JSON.stringify({
          models: [{ name: "gpt-x", display_name: "GPT X", supports_thinking: true }],
        })
      );
      return;
    }
    if (method === "GET" && /\/api\/threads\/[^/]+\/artifacts\/.+/.test(path)) {
      res.setHeader("Content-Type", "text/markdown");
      res.end("# Report\nbody");
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: `stub: no route for ${method} ${path}` }));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

// --- Child-process helpers ---------------------------------------------------

function getFreePort(): Promise<number> {
  const server = http.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Spawn the built HTTP server and resolve once it announces it is listening. */
function startHttpServer(
  port: number,
  env: Record<string, string>
): Promise<{ child: ChildProcess; stderr: () => string; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST, "--transport", "http", "--port", String(port)], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = stderr.match(/running on HTTP at (http:\/\/localhost:\d+)/);
      if (match) resolve({ child, stderr: () => stderr, url: match[1] });
    });
    child.once("exit", (code) => {
      reject(new Error(`HTTP server exited before listening (code ${code}): ${stderr}`));
    });
  });
}

/** Spawn a process and resolve with its exit code and stderr once it exits. */
function runToExit(
  args: string[],
  env: Record<string, string>
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

/** Connect a real MCP client to a freshly spawned stdio child. */
async function connectStdio(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [DIST], env }));
  return client;
}

function textOf(result: { content: unknown[] }): string {
  const block = result.content?.[0] as { type?: string; text?: string } | undefined;
  return block?.text ?? "";
}

// --- Fixtures ----------------------------------------------------------------

let childEnv: Record<string, string>;
let httpChild: ChildProcess;
let httpUrl: string;
let stubServer: http.Server;

beforeAll(async () => {
  execSync("pnpm build", { cwd: PKG_ROOT, stdio: "pipe" });
  const stub = await startStubDeerFlow();
  stubServer = stub.server;
  childEnv = {
    // getDefaultEnvironment() inherits only safe vars, so a real DEERFLOW_PAT
    // in the parent shell cannot leak into the children.
    ...getDefaultEnvironment(),
    DEERFLOW_BASE_URL: stub.url,
    DEERFLOW_PAT: "dfp_testtoken",
    DEERFLOW_WEB_BASE_URL: "https://deer.example.com",
  };
  ({ child: httpChild, url: httpUrl } = await startHttpServer(await getFreePort(), childEnv));
}, 120_000);

afterAll(() => {
  httpChild?.kill();
  stubServer?.close();
});

// --- Per-transport protocol tests ----------------------------------------------

describe.each([
  ["http", () => new StreamableHTTPClientTransport(new URL(httpUrl))],
  [
    "stdio",
    () => new StdioClientTransport({ command: process.execPath, args: [DIST], env: childEnv }),
  ],
] as const)("%s transport", (_name, makeTransport) => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ name: "integration-test", version: "1.0.0" });
    await client.connect(makeTransport());
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  test("lists the nine DeerFlow tools with derived input schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);

    // The zod v4 schemas must survive the MCP wire as JSON Schema.
    const research = tools.find((t) => t.name === "deerflow_research")!;
    expect(Object.keys(research.inputSchema.properties ?? {}).sort()).toEqual([
      "focus",
      "model",
      "recursion_limit",
      "topic",
    ]);
    const report = tools.find((t) => t.name === "deerflow_get_report")!;
    expect(report.annotations?.readOnlyHint).toBe(true);
  });

  test("deerflow_research creates a thread and run on the wire", async () => {
    requests.length = 0;
    const res = await client.callTool({
      name: "deerflow_research",
      arguments: { topic: "AI safety" },
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toMatch(/"thread_id": "t-\d+"/);
    expect(text).toMatch(/"run_id": "r-\d+"/);
    expect(text).toContain("https://deer.example.com/workspace/chats/");

    // The env-configured PAT must arrive as a Bearer token on the wire.
    const createThread = requests.find((r) => r.method === "POST" && r.path === "/api/threads");
    expect(createThread?.headers.authorization).toBe("Bearer dfp_testtoken");

    const createRun = requests.find(
      (r) => r.method === "POST" && /^\/api\/threads\/t-\d+\/runs$/.test(r.path)
    );
    expect(createRun).toBeDefined();
    const runBody = createRun?.body as { input: { messages: { role: string; content: string }[] } };
    expect(runBody.input.messages[0].role).toBe("user");
    expect(runBody.input.messages[0].content).toContain("AI safety");
  });

  test("deerflow_run_status polls until the run reaches a terminal status", async () => {
    requests.length = 0;
    const started = await client.callTool({
      name: "deerflow_chat",
      arguments: { message: "hello" },
    });
    const startedText = textOf(started);
    const threadId = startedText.match(/"thread_id": "(t-\d+)"/)?.[1];
    const runId = startedText.match(/"run_id": "(r-\d+)"/)?.[1];
    expect(threadId && runId).toBeTruthy();

    const res = await client.callTool({
      name: "deerflow_run_status",
      arguments: { thread_id: threadId!, run_id: runId!, wait_seconds: 5 },
    });
    const text = textOf(res);
    expect(text).toContain('"status": "success"');
    expect(text).toContain('"terminal": true');

    // The stub answers "running" on the first poll and "success" after, so
    // the wait loop must have polled at least twice.
    const polls = requests.filter((r) => r.path === `/api/threads/${threadId}/runs/${runId}`);
    expect(polls.length).toBeGreaterThanOrEqual(2);
  });

  test("deerflow_get_report returns the synthesized report", async () => {
    const started = await client.callTool({
      name: "deerflow_chat",
      arguments: { message: "write a report" },
    });
    const threadId = textOf(started).match(/"thread_id": "(t-\d+)"/)?.[1];
    expect(threadId).toBeTruthy();

    const res = await client.callTool({
      name: "deerflow_get_report",
      arguments: { thread_id: threadId! },
    });
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("# My Report");
    expect(text).toContain("Final findings.");
    expect(text).toContain("- mnt/user-data/outputs/report.md");
    expect(text).toContain("https://deer.example.com/workspace/chats/");
  });
});

// --- Wire-level HTTP checks -----------------------------------------------------

describe("HTTP wire protocol", () => {
  test("answers a raw JSON-RPC initialize with the server info", async () => {
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "raw-test", version: "1.0.0" },
        },
      }),
    });
    expect(response.status).toBe(200);
    // Streamable HTTP delivers the JSON-RPC result as an SSE message.
    const raw = await response.text();
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice("data: ".length)) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(payload.result.protocolVersion).toBe("2025-11-25");
    expect(payload.result.serverInfo.name).toBe("deer-flow");
  });
});

// --- Process-lifecycle checks ---------------------------------------------------

describe("process lifecycle", () => {
  test("fails fast with a ConfigError when no credentials are configured", async () => {
    const env: Record<string, string> = { ...getDefaultEnvironment() };
    for (const key of Object.keys(env)) {
      if (key.startsWith("DEERFLOW_")) delete env[key];
    }
    const { code, stderr } = await runToExit([DIST], env);
    expect(code).toBe(1);
    expect(stderr).toContain("DEERFLOW_BASE_URL is required");
  });

  test("sends internal-token headers when configured with DEERFLOW_INTERNAL_TOKEN", async () => {
    requests.length = 0;
    const env = {
      ...childEnv,
      DEERFLOW_INTERNAL_TOKEN: "dt_test-internal",
      DEERFLOW_OWNER_USER_ID: "owner-1",
    };
    delete env.DEERFLOW_PAT;
    const client = await connectStdio(env);
    try {
      const res = await client.callTool({ name: "deerflow_list_models", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain('"name": "gpt-x"');

      const call = requests.find((r) => r.path === "/api/models");
      expect(call?.headers["x-deerflow-internal-token"]).toBe("dt_test-internal");
      expect(call?.headers["x-deerflow-owner-user-id"]).toBe("owner-1");
      expect(call?.headers.authorization).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test("surfaces a 401 as an error result without leaking the token", async () => {
    const failServer = http.createServer((req, res) => {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ detail: "Invalid token" }));
    });
    await new Promise<void>((resolve) => failServer.listen(0, "127.0.0.1", resolve));
    const address = failServer.address() as { port: number };
    const env = { ...childEnv, DEERFLOW_BASE_URL: `http://127.0.0.1:${address.port}` };
    const client = await connectStdio(env);
    try {
      const res = await client.callTool({ name: "deerflow_list_models", arguments: {} });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain("401");
      expect(text).not.toContain("dfp_testtoken");
    } finally {
      await client.close();
      failServer.close();
    }
  });
});
