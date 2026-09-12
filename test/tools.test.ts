import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { DeerFlowClient } from "../src/lib/client.js";
import { registerTools } from "../src/lib/tools.js";
import { makeConfig, createMockFetch, type MockCall, type MockResponse } from "./helpers.js";

const ALL_TOOLS = [
  "cancel_run",
  "chat",
  "get_artifact",
  "get_report",
  "list_artifacts",
  "list_models",
  "list_threads",
  "research",
  "run_progress",
  "run_status",
  "token_usage",
  "wait_activity",
].sort();

/**
 * Run a function with a fully-wired MCP client talking to a DeerFlow tool
 * server whose network is stubbed by `responder`.
 */
async function withTools(
  responder: (call: MockCall) => MockResponse,
  fn: (client: Client, calls: MockCall[]) => Promise<void>
): Promise<void> {
  const { fetchFn, calls } = createMockFetch(responder);
  const client = new DeerFlowClient(makeConfig(), fetchFn);
  const server = new McpServer({ name: "deer-flow", version: "0.1.0" }, {});
  registerTools(server, client);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "test-client", version: "0.1.0" });
  // The server must connect first so it is ready to answer the client's
  // initialize handshake; connecting the client first leaves it "not connected".
  await server.connect(serverTransport);
  await mcpClient.connect(clientTransport);
  try {
    await fn(mcpClient, calls);
  } finally {
    await mcpClient.close();
    await server.close();
  }
}

function textOf(result: { content: unknown[] }): string {
  const block = result.content?.[0] as { type?: string; text?: string } | undefined;
  return block?.text ?? "";
}

describe("MCP tools", () => {
  it("registers exactly the twelve expected tools", async () => {
    await withTools(
      () => ({ body: {} }),
      async (client) => {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(ALL_TOOLS);
      }
    );
  });

  it("deerflow_research starts a thread + run and returns ids and web URL", async () => {
    await withTools(
      (call) => {
        if (call.method === "POST" && call.url.endsWith("/api/threads"))
          return { body: { thread_id: "t-9" } };
        if (call.url.endsWith("/runs")) return { body: { run_id: "r-9", status: "pending" } };
        return { body: {} };
      },
      async (client, calls) => {
        const res = await client.callTool({
          name: "research",
          arguments: { topic: "AI safety" },
        });
        expect(res.isError).toBeFalsy();
        const text = textOf(res);
        expect(text).toContain('"thread_id": "t-9"');
        expect(text).toContain('"run_id": "r-9"');
        expect(text).toContain("https://deer.example.com/workspace/chats/t-9");
        // The run body must carry the research prompt as a user message.
        const runCall = calls.find((c) => c.url.endsWith("/runs"));
        expect(runCall?.body.input.messages[0].role).toBe("user");
      }
    );
  });

  it("deerflow_chat with an existing thread_id only creates a run", async () => {
    await withTools(
      (call) => {
        if (call.url.endsWith("/runs")) return { body: { run_id: "r-2", status: "running" } };
        return { body: {} };
      },
      async (client, calls) => {
        const res = await client.callTool({
          name: "chat",
          arguments: { message: "follow up", thread_id: "t-existing" },
        });
        expect(res.isError).toBeFalsy();
        expect(textOf(res)).toContain('"thread_id": "t-existing"');
        // No thread-create call should have been made.
        expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/threads"))).toBe(
          false
        );
      }
    );
  });

  it("deerflow_run_status returns status, a terminal flag, and live counters", async () => {
    await withTools(
      () => ({
        body: {
          run_id: "r-1",
          status: "success",
          stop_reason: null,
          created_at: "2026-09-12T03:53:51.000Z",
          updated_at: "2026-09-12T04:00:00.000Z",
          llm_call_count: 20,
          message_count: 52,
          total_tokens: 40418,
          total_input_tokens: 12345,
          total_output_tokens: 28073,
          lead_agent_tokens: 30000,
          subagent_tokens: 8000,
          middleware_tokens: 2418,
        },
      }),
      async (client) => {
        const res = await client.callTool({
          name: "run_status",
          arguments: { thread_id: "t-1", run_id: "r-1" },
        });
        const text = textOf(res);
        expect(text).toContain("Run r-1 — success");
        expect(text).toContain("40,418 tokens");
        expect(text).toContain("12,345 in / 28,073 out");
        expect(text).toContain("20 LLM calls");
        expect(text).toContain("52 messages");
        const sc = res.structuredContent as {
          status: string;
          terminal: boolean;
          total_tokens: number;
          total_input_tokens: number;
          lead_agent_tokens: number;
        };
        expect(sc.status).toBe("success");
        expect(sc.terminal).toBe(true);
        expect(sc.total_tokens).toBe(40418);
        expect(sc.total_input_tokens).toBe(12345);
        expect(sc.lead_agent_tokens).toBe(30000);
      }
    );
  });

  it("deerflow_run_progress returns activity, todos, and stall detection", async () => {
    const now = Date.now();
    const recent = new Date(now - 10_000).toISOString();
    const started = new Date(now - 40 * 60_000).toISOString();
    await withTools(
      (call) => {
        if (call.url.includes("/runs/r-1/events"))
          return {
            body: [
              {
                seq: 9,
                event_type: "llm.ai.response",
                created_at: recent,
                content: {
                  type: "ai",
                  content: "",
                  tool_calls: [{ name: "web_search", args: { query: "vLLM v0.25.0" } }],
                },
              },
              {
                seq: 10,
                event_type: "llm.tool.result",
                created_at: recent,
                content: { type: "tool", name: "web_search", content: "10 results found" },
              },
            ],
          };
        if (call.url.endsWith("/state"))
          return {
            body: {
              values: {
                todos: [
                  { content: "Gather history", status: "in_progress" },
                  { content: "Write report", status: "pending" },
                ],
              },
            },
          };
        return {
          body: {
            run_id: "r-1",
            status: "running",
            created_at: started,
            updated_at: recent,
            llm_call_count: 20,
          },
        };
      },
      async (client) => {
        const res = await client.callTool({
          name: "run_progress",
          arguments: { thread_id: "t-1", run_id: "r-1" },
        });
        expect(res.isError).toBeFalsy();
        const text = textOf(res);
        expect(text).toContain("DeerFlow run r-1 — running");
        expect(text).toContain("LLM calls: 20");
        expect(text).toContain('now: "Gather history"');
        expect(text).toContain("[>] Gather history");
        expect(text).toContain("[ ] Write report");
        expect(text).toContain("web_search(vLLM v0.25.0)");
        expect(text).toContain("web_search → 10 results found");
        const sc = res.structuredContent as { stalled: boolean; last_event_seq: number };
        expect(sc.stalled).toBe(false);
        expect(sc.last_event_seq).toBe(10);
      }
    );
  });

  it("deerflow_wait_activity returns new activity with reason 'activity'", async () => {
    const now = Date.now();
    const recent = new Date(now - 1_000).toISOString();
    const started = new Date(now - 40 * 60_000).toISOString();
    await withTools(
      (call) => {
        if (call.url.includes("/runs/r-1/events"))
          return {
            body: [
              {
                seq: 11,
                event_type: "llm.tool.result",
                created_at: recent,
                content: { type: "tool", name: "web_search", content: "done" },
              },
            ],
          };
        if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
        return { body: { run_id: "r-1", status: "running", created_at: started } };
      },
      async (client) => {
        const res = await client.callTool({
          name: "wait_activity",
          arguments: { thread_id: "t-1", run_id: "r-1", since_seq: 10, timeout_seconds: 5 },
        });
        expect(res.isError).toBeFalsy();
        const text = textOf(res);
        expect(text).toContain("web_search → done");
        expect(text).toContain("Wait: new activity after");
        const sc = res.structuredContent as { reason: string; last_event_seq: number };
        expect(sc.reason).toBe("activity");
        expect(sc.last_event_seq).toBe(11);
      }
    );
  });

  it("deerflow_get_report returns the synthesized report text", async () => {
    await withTools(
      () => ({
        body: {
          values: {
            title: "My Report",
            artifacts: ["mnt/user-data/outputs/report.md"],
            messages: [{ type: "ai", content: "Final findings here." }],
          },
        },
      }),
      async (client) => {
        const res = await client.callTool({
          name: "get_report",
          arguments: { thread_id: "t-1" },
        });
        const text = textOf(res);
        expect(text).toContain("# My Report");
        expect(text).toContain("Final findings here.");
        expect(text).toContain("- mnt/user-data/outputs/report.md");
        expect(text).toContain("https://deer.example.com/workspace/chats/t-1");
      }
    );
  });

  it("deerflow_list_threads returns a threads array", async () => {
    await withTools(
      (call) =>
        call.url.endsWith("/api/threads/search")
          ? {
              body: [
                {
                  thread_id: "t-a",
                  status: "idle",
                  created_at: "2026-01-01",
                  values: { title: "Hello" },
                },
              ],
            }
          : { body: {} },
      async (client) => {
        const res = await client.callTool({
          name: "list_threads",
          arguments: { limit: 5 },
        });
        const text = textOf(res);
        expect(text).toContain('"thread_id": "t-a"');
        expect(text).toContain('"title": "Hello"');
      }
    );
  });

  it("deerflow_cancel_run reports the accepted status", async () => {
    await withTools(
      () => ({ status: 202, text: "" }),
      async (client) => {
        const res = await client.callTool({
          name: "cancel_run",
          arguments: { thread_id: "t-1", run_id: "r-1" },
        });
        expect(res.isError).toBeFalsy();
        expect(textOf(res)).toContain('"status": "interrupted"');
      }
    );
  });

  it("deerflow_list_artifacts returns the artifact list", async () => {
    await withTools(
      () => ({ body: { values: { artifacts: ["a.md", "b.csv"] } } }),
      async (client) => {
        const res = await client.callTool({
          name: "list_artifacts",
          arguments: { thread_id: "t-1" },
        });
        const text = textOf(res);
        expect(text).toContain('"a.md"');
        expect(text).toContain('"b.csv"');
      }
    );
  });

  it("deerflow_get_artifact returns inline content for text files", async () => {
    await withTools(
      () => ({ text: "# Report\nbody", headers: { "content-type": "text/markdown" } }),
      async (client) => {
        const res = await client.callTool({
          name: "get_artifact",
          arguments: { thread_id: "t-1", path: "mnt/user-data/outputs/a.md" },
        });
        const text = textOf(res);
        expect(text).toContain("# mnt/user-data/outputs/a.md");
        expect(text).toContain("# Report\nbody");
      }
    );
  });

  it("deerflow_list_models returns the models array", async () => {
    await withTools(
      () => ({
        body: { models: [{ name: "gpt-x", display_name: "GPT X", supports_thinking: true }] },
      }),
      async (client) => {
        const res = await client.callTool({ name: "list_models", arguments: {} });
        const text = textOf(res);
        expect(text).toContain('"name": "gpt-x"');
        expect(text).toContain('"supports_thinking": true');
      }
    );
  });

  it("token_usage returns the thread-level token breakdown", async () => {
    await withTools(
      () => ({
        body: {
          thread_id: "t-1",
          total_tokens: 128410,
          total_input_tokens: 90000,
          total_output_tokens: 38410,
          total_runs: 3,
          by_model: {
            "gpt-x": { tokens: 100000, runs: 2 },
            "claude-3-7": { tokens: 28410, runs: 1 },
          },
          by_caller: { lead_agent: 100000, subagent: 20000, middleware: 8410 },
          context_usage: { token_count: 124000, max_context_tokens: 200000, percentage: 62 },
        },
      }),
      async (client, calls) => {
        const res = await client.callTool({
          name: "token_usage",
          arguments: { thread_id: "t-1" },
        });
        expect(res.isError).toBeFalsy();
        // The client must hit the thread token-usage endpoint with include_active.
        expect(calls.some((c) => c.url.endsWith("/token-usage?include_active=true"))).toBe(true);
        const text = textOf(res);
        expect(text).toContain(
          "Tokens (thread t-1): 128,410 total (90,000 in / 38,410 out) across 3 runs"
        );
        expect(text).toContain("context 62% (124K/200K)");
        expect(text).toContain("By model:");
        expect(text).toContain("gpt-x 100,000 (2 runs)");
        expect(text).toContain("By caller: lead 100,000 · subagent 20,000 · middleware 8,410");
        const sc = res.structuredContent as {
          total_tokens: number;
          by_caller: { lead_agent: number };
          context_usage: { percentage: number | null };
        };
        expect(sc.total_tokens).toBe(128410);
        expect(sc.by_caller.lead_agent).toBe(100000);
        expect(sc.context_usage.percentage).toBe(62);
      }
    );
  });

  it("surfaces a 401 as an error result without leaking the token", async () => {
    await withTools(
      () => ({ status: 401, body: { detail: "Invalid token" } }),
      async (client) => {
        const res = await client.callTool({ name: "list_models", arguments: {} });
        expect(res.isError).toBe(true);
        const text = textOf(res);
        expect(text).toContain("401");
        expect(text).not.toContain("dfp_testtoken");
      }
    );
  });

  it("returns machine-readable structuredContent that matches the output schema", async () => {
    await withTools(
      (call) => {
        if (call.method === "POST" && call.url.endsWith("/api/threads"))
          return { body: { thread_id: "t-9" } };
        if (call.url.endsWith("/runs")) return { body: { run_id: "r-9", status: "pending" } };
        return { body: {} };
      },
      async (client) => {
        const res = await client.callTool({
          name: "research",
          arguments: { topic: "AI safety" },
        });
        // The MCP client validates structuredContent against the advertised
        // outputSchema; reaching here without an error proves it is present
        // and valid. Assert the shape explicitly too.
        expect(res.isError).toBeFalsy();
        expect(res.structuredContent).toEqual({
          thread_id: "t-9",
          run_id: "r-9",
          status: "pending",
          web_url: "https://deer.example.com/workspace/chats/t-9",
        });
      }
    );
  });

  it("deerflow_wait_activity returns structuredContent with reason and timeout_seconds", async () => {
    const now = Date.now();
    const recent = new Date(now - 1_000).toISOString();
    const started = new Date(now - 40 * 60_000).toISOString();
    await withTools(
      (call) => {
        if (call.url.includes("/runs/r-1/join")) return { status: 404, body: {} };
        if (call.url.includes("/runs/r-1/events"))
          return {
            body: [
              {
                seq: 11,
                event_type: "llm.tool.result",
                created_at: recent,
                content: { type: "tool", name: "web_search", content: "done" },
              },
            ],
          };
        if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
        return { body: { run_id: "r-1", status: "running", created_at: started } };
      },
      async (client) => {
        const res = await client.callTool({
          name: "wait_activity",
          arguments: { thread_id: "t-1", run_id: "r-1", since_seq: 10, timeout_seconds: 5 },
        });
        expect(res.isError).toBeFalsy();
        const structured = res.structuredContent as {
          reason: string;
          timeout_seconds: number;
          waited_seconds: number;
          last_event_seq: number;
        };
        expect(structured.reason).toBe("activity");
        expect(structured.timeout_seconds).toBe(5);
        expect(structured.last_event_seq).toBe(11);
      }
    );
  });

  // Note: `deerflow_wait_activity` also emits MCP progress notifications when the
  // client supplies a progress token (`params._meta.progressToken`). That path
  // is exercised by modern-era (2026-07-28+) clients over the HTTP transport;
  // the in-memory test harness negotiates a legacy era where the token is not
  // surfaced to the server context, so it is not integration-tested here.
});
