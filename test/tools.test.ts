import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { DeerFlowClient } from "../src/lib/client.js";
import { registerTools } from "../src/lib/tools.js";
import { makeConfig, createMockFetch, type MockCall, type MockResponse } from "./helpers.js";

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
  it("registers exactly the nine expected tools", async () => {
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
          name: "deerflow_research",
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
          name: "deerflow_chat",
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

  it("deerflow_run_status returns status with a terminal flag", async () => {
    await withTools(
      () => ({ body: { run_id: "r-1", status: "success", stop_reason: null } }),
      async (client) => {
        const res = await client.callTool({
          name: "deerflow_run_status",
          arguments: { thread_id: "t-1", run_id: "r-1" },
        });
        const text = textOf(res);
        expect(text).toContain('"status": "success"');
        expect(text).toContain('"terminal": true');
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
          name: "deerflow_get_report",
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
          name: "deerflow_list_threads",
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
          name: "deerflow_cancel_run",
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
          name: "deerflow_list_artifacts",
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
          name: "deerflow_get_artifact",
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
        const res = await client.callTool({ name: "deerflow_list_models", arguments: {} });
        const text = textOf(res);
        expect(text).toContain('"name": "gpt-x"');
        expect(text).toContain('"supports_thinking": true');
      }
    );
  });

  it("surfaces a 401 as an error result without leaking the token", async () => {
    await withTools(
      () => ({ status: 401, body: { detail: "Invalid token" } }),
      async (client) => {
        const res = await client.callTool({ name: "deerflow_list_models", arguments: {} });
        expect(res.isError).toBe(true);
        const text = textOf(res);
        expect(text).toContain("401");
        expect(text).not.toContain("dfp_testtoken");
      }
    );
  });
});
