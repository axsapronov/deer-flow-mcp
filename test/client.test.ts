import { describe, it, expect } from "vitest";
import {
  DeerFlowClient,
  DeerFlowError,
  SseParser,
  buildWaitResult,
  summarizeRunEvent,
  type SseFrame,
} from "../src/lib/client.js";
import type { RunProgress } from "../src/lib/types.js";
import { makeConfig, createMockFetch, sseStream } from "./helpers.js";

describe("DeerFlowClient", () => {
  it("createThread posts to /api/threads with Bearer auth", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({ body: { thread_id: "t-1" } }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const res = await client.createThread();
    expect(res.thread_id).toBe("t-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://deer.example.com/api/threads");
    expect(calls[0].headers["Authorization"]).toBe("Bearer dfp_testtoken");
  });

  it("createRun sends input messages, recursion_limit, and model context", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({
      body: { run_id: "r-1", status: "pending" },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    await client.createRun("t-1", { prompt: "hello", model: "gpt-x", recursionLimit: 500 });
    const call = calls[0];
    expect(call.url).toBe("https://deer.example.com/api/threads/t-1/runs");
    expect(call.body).toEqual({
      input: { messages: [{ role: "user", content: "hello" }] },
      config: { recursion_limit: 500 },
      context: { model_name: "gpt-x" },
    });
  });

  it("createRun omits context when no context fields are set", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({
      body: { run_id: "r-1", status: "running" },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    await client.createRun("t-1", { prompt: "hi" });
    const call = calls[0];
    expect(call.body.config).toEqual({ recursion_limit: 1000 });
    expect(call.body.context).toBeUndefined();
  });

  it("getRun returns normalized run info", async () => {
    const { fetchFn } = createMockFetch(() => ({
      body: { run_id: "r-1", status: "success", stop_reason: "done" },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const run = await client.getRun("t-1", "r-1");
    expect(run.status).toBe("success");
    expect(run.stop_reason).toBe("done");
    expect(run.thread_id).toBe("t-1");
  });

  it("waitForRun polls until a terminal status", async () => {
    let n = 0;
    const { fetchFn, calls } = createMockFetch(() => {
      n += 1;
      return { body: { run_id: "r-1", status: n < 3 ? "running" : "success" } };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 1 });
    const run = await client.waitForRun("t-1", "r-1", 5);
    expect(run.status).toBe("success");
    expect(calls.length).toBe(3);
  });

  it("waitForRun with waitSeconds=0 checks exactly once", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({
      body: { run_id: "r-1", status: "running" },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const run = await client.waitForRun("t-1", "r-1", 0);
    expect(run.status).toBe("running");
    expect(calls.length).toBe(1);
  });

  it("listModels maps GET /api/models", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({
      body: { models: [{ name: "m1", supports_thinking: true }] },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const models = await client.listModels();
    expect(calls[0].url).toBe("https://deer.example.com/api/models");
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("m1");
  });

  it("listArtifacts reads state.values.artifacts", async () => {
    const { fetchFn } = createMockFetch(() => ({
      body: { values: { artifacts: ["mnt/user-data/outputs/a.md"] } },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const artifacts = await client.listArtifacts("t-1");
    expect(artifacts).toEqual([{ path: "mnt/user-data/outputs/a.md" }]);
  });

  it("getArtifact returns inline text for text-like content", async () => {
    const { fetchFn } = createMockFetch(() => ({
      text: "# Report\ncontent",
      headers: { "content-type": "text/markdown" },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const artifact = await client.getArtifact("t-1", "mnt/user-data/outputs/a.md");
    expect(artifact.content).toBe("# Report\ncontent");
    expect(artifact.url).toBe(
      "https://deer.example.com/api/threads/t-1/artifacts/mnt/user-data/outputs/a.md"
    );
  });

  it("getArtifact returns a URL reference (no content) for binary content", async () => {
    const { fetchFn } = createMockFetch(() => ({
      text: "binary-bytes",
      headers: { "content-type": "application/octet-stream" },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const artifact = await client.getArtifact("t-1", "mnt/user-data/outputs/img.png");
    expect(artifact.content).toBeUndefined();
    expect(artifact.url).toContain("/api/threads/t-1/artifacts/");
  });

  it("cancelRun posts to the cancel endpoint and accepts 202", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({ status: 202, text: "" }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    await client.cancelRun("t-1", "r-1");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://deer.example.com/api/threads/t-1/runs/r-1/cancel?action=interrupt&wait=false"
    );
  });

  it("session auth logs in lazily and sends cookie + CSRF on state-changing calls", async () => {
    const { fetchFn, calls } = createMockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/login/local")) {
        return {
          setCookies: ["access_token=jwt123; HttpOnly", "csrf_token=c123; SameSite=Lax"],
          body: {},
        };
      }
      return { body: { thread_id: "t-1" } };
    });
    const config = makeConfig({
      auth: { kind: "session", email: "user@example.com", password: "s3cret" },
    });
    const client = new DeerFlowClient(config, fetchFn);
    await client.createThread();
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://deer.example.com/api/v1/auth/login/local");
    expect(calls[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0].body).toBe("username=user%40example.com&password=s3cret&remember_me=true");
    expect(calls[1].headers["Cookie"]).toBe("access_token=jwt123; csrf_token=c123");
    expect(calls[1].headers["X-CSRF-Token"]).toBe("c123");
    expect(calls[1].headers["Authorization"]).toBeUndefined();
    expect(calls.length).toBe(2);
  });

  it("session auth without a csrf_token cookie sends only the access_token cookie", async () => {
    const { fetchFn, calls } = createMockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/login/local")) {
        return { setCookies: ["access_token=jwt123; HttpOnly"], body: {} };
      }
      return { body: { models: [] } };
    });
    const config = makeConfig({ auth: { kind: "session", email: "e", password: "p" } });
    const client = new DeerFlowClient(config, fetchFn);
    await client.listModels();
    expect(calls[1].headers["Cookie"]).toBe("access_token=jwt123");
    expect(calls[1].headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("session auth re-logs in once after a 401 and then succeeds", async () => {
    let logins = 0;
    let apiCalls = 0;
    const { fetchFn, calls } = createMockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/login/local")) {
        logins += 1;
        return { setCookies: [`access_token=jwt${logins}; HttpOnly`], body: {} };
      }
      apiCalls += 1;
      if (apiCalls === 1) return { status: 401, body: { detail: "session expired" } };
      return { body: { models: [] } };
    });
    const config = makeConfig({ auth: { kind: "session", email: "e", password: "p" } });
    const client = new DeerFlowClient(config, fetchFn);
    const models = await client.listModels();
    expect(models).toEqual([]);
    expect(logins).toBe(2);
    // login, 401, re-login, retried request
    expect(calls.length).toBe(4);
    expect(calls[3].headers["Cookie"]).toBe("access_token=jwt2");
  });

  it("session auth with bad credentials throws a clear login error", async () => {
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.endsWith("/api/v1/auth/login/local")) {
        return { status: 401, body: { detail: "Invalid credentials" } };
      }
      return { body: {} };
    });
    const config = makeConfig({ auth: { kind: "session", email: "e", password: "p" } });
    const client = new DeerFlowClient(config, fetchFn);
    await expect(client.listModels()).rejects.toThrow(/DEERFLOW_EMAIL and DEERFLOW_PASSWORD/);
  });

  it("uses internal-token headers when configured", async () => {
    const config = makeConfig({ auth: { kind: "internal", token: "tok", ownerUserId: "u-1" } });
    const { fetchFn, calls } = createMockFetch(() => ({ body: { models: [] } }));
    const client = new DeerFlowClient(config, fetchFn);
    await client.listModels();
    expect(calls[0].headers["X-DeerFlow-Internal-Token"]).toBe("tok");
    expect(calls[0].headers["X-DeerFlow-Owner-User-Id"]).toBe("u-1");
    expect(calls[0].headers["Authorization"]).toBeUndefined();
  });

  it("research creates a thread then a run and builds the web URL", async () => {
    const { fetchFn } = createMockFetch((call) => {
      if (call.method === "POST" && call.url.endsWith("/api/threads"))
        return { body: { thread_id: "t-9" } };
      if (call.url.endsWith("/runs")) return { body: { run_id: "r-9", status: "pending" } };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const started = await client.research("AI safety");
    expect(started.thread_id).toBe("t-9");
    expect(started.run_id).toBe("r-9");
    expect(started.web_url).toBe("https://deer.example.com/workspace/chats/t-9");
  });

  it("getReport synthesizes title, last assistant message, and artifacts", async () => {
    const { fetchFn } = createMockFetch(() => ({
      body: {
        values: {
          title: "My Report",
          artifacts: ["mnt/user-data/outputs/report.md"],
          messages: [
            { type: "human", content: "research X" },
            { type: "ai", content: "Here is the analysis." },
          ],
        },
      },
    }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const report = await client.getReport("t-1");
    expect(report.title).toBe("My Report");
    expect(report.report).toBe("Here is the analysis.");
    expect(report.artifacts).toEqual(["mnt/user-data/outputs/report.md"]);
  });

  it("maps 401 to a credential error", async () => {
    const { fetchFn } = createMockFetch(() => ({ status: 401, body: { detail: "Invalid token" } }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    await expect(client.listModels()).rejects.toThrow(/401/);
  });

  it("maps 403 for a PAT on models to an allowlist hint", async () => {
    const { fetchFn } = createMockFetch(() => ({ status: 403, body: { detail: "forbidden" } }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const err = await client.listModels().catch((e) => e);
    expect(err).toBeInstanceOf(DeerFlowError);
    expect((err as DeerFlowError).message).toMatch(/allowlist/);
  });

  it("maps 404 to a not-found error", async () => {
    const { fetchFn } = createMockFetch(() => ({ status: 404, body: { detail: "not found" } }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    await expect(client.getRun("t-1", "r-1")).rejects.toThrow(/404/);
  });

  it("marks 429 and 5xx as retryable", async () => {
    let status = 429;
    const { fetchFn } = createMockFetch(() => ({ status, body: { detail: "slow down" } }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const err429 = await client.listModels().catch((e) => e);
    expect((err429 as DeerFlowError).retryable).toBe(true);
    status = 503;
    const err503 = await client.listModels().catch((e) => e);
    expect((err503 as DeerFlowError).retryable).toBe(true);
  });
});

describe("DeerFlowClient progress & activity", () => {
  const NOW = Date.parse("2026-09-12T04:10:00.000Z");

  function runRow(overrides: Record<string, unknown> = {}) {
    return {
      run_id: "r-1",
      status: "running",
      created_at: "2026-09-12T03:53:51.000Z",
      updated_at: "2026-09-12T04:09:50.000Z",
      total_tokens: 1000,
      llm_call_count: 20,
      message_count: 52,
      ...overrides,
    };
  }

  const EVENTS = [
    {
      seq: 39,
      event_type: "llm.ai.response",
      created_at: "2026-09-12T04:09:40.000Z",
      content: {
        type: "ai",
        content: "",
        tool_calls: [{ name: "web_search", args: { query: "vLLM v0.25.0" } }],
      },
    },
    {
      seq: 40,
      event_type: "llm.tool.result",
      created_at: "2026-09-12T04:09:50.000Z",
      content: { type: "tool", name: "web_search", content: "10 results found" },
    },
  ];

  const TODOS = [
    { content: "Gather history", status: "in_progress" },
    { content: "Write report", status: "pending" },
  ];

  /** Routes the three endpoints getProgress uses (URLs carry query strings). */
  function progressResponder(run: Record<string, unknown>, events: unknown[]) {
    return (call: { url: string }) => {
      if (call.url.includes("/runs/r-1/events")) return { body: events };
      if (call.url.includes("/runs/r-1")) return { body: run };
      if (call.url.endsWith("/state")) return { body: { values: { todos: TODOS } } };
      return { body: {} };
    };
  }

  it("listRunEvents sends limit and omits after_seq=0", async () => {
    const { fetchFn, calls } = createMockFetch(() => ({ body: [] }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    await client.listRunEvents("t-1", "r-1", { limit: 10, afterSeq: 0 });
    expect(calls[0].url).toBe("https://deer.example.com/api/threads/t-1/runs/r-1/events?limit=10");
    await client.listRunEvents("t-1", "r-1", { limit: 10, afterSeq: 5 });
    expect(calls[1].url).toBe(
      "https://deer.example.com/api/threads/t-1/runs/r-1/events?limit=10&after_seq=5"
    );
  });

  it("getTodos reads state.values.todos", async () => {
    const { fetchFn } = createMockFetch(() => ({ body: { values: { todos: TODOS } } }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    expect(await client.getTodos("t-1")).toEqual(TODOS);
  });

  it("summarizeRunEvent renders tool calls, tool results, errors, and text", () => {
    const ai = summarizeRunEvent(EVENTS[0]);
    expect(ai.kind).toBe("ai");
    expect(ai.summary).toContain("web_search(vLLM v0.25.0)");
    const tool = summarizeRunEvent(EVENTS[1]);
    expect(tool.kind).toBe("tool");
    expect(tool.summary).toBe("web_search → 10 results found");
    const err = summarizeRunEvent({
      seq: 41,
      event_type: "run.error",
      created_at: "2026-09-12T04:11:00.000Z",
      content: "boom happened",
    });
    expect(err.kind).toBe("error");
    expect(err.summary).toBe("error: boom happened");
    const text = summarizeRunEvent({
      seq: 42,
      event_type: "llm.ai.response",
      content: { type: "ai", content: "Final answer text" },
    });
    expect(text.kind).toBe("ai");
    expect(text.summary).toBe("Final answer text");
  });

  it("summarizeRunEvent renders subagent start/step/end events", () => {
    const start = summarizeRunEvent({
      seq: 50,
      event_type: "subagent.start",
      content: { task_id: "call_1", description: "research vLLM releases" },
      metadata: { task_id: "call_1" },
    });
    expect(start.kind).toBe("other");
    expect(start.summary).toBe("subagent start: research vLLM releases");

    const toolStep = summarizeRunEvent({
      seq: 51,
      event_type: "subagent.step",
      content: {
        task_id: "call_1",
        message_index: 2,
        kind: "tool",
        tool_name: "read_file",
        text: "reading releases.md",
        truncated: false,
      },
      metadata: { task_id: "call_1", message_index: 2 },
    });
    expect(toolStep.summary).toBe("subagent[call_1] read_file: reading releases.md");

    const aiStep = summarizeRunEvent({
      seq: 52,
      event_type: "subagent.step",
      content: {
        task_id: "call_1",
        message_index: 1,
        kind: "ai",
        text: "Let me search the web.",
        truncated: false,
        tool_calls: [{ name: "web_search", args: { query: "vLLM" } }],
      },
      metadata: { task_id: "call_1", message_index: 1 },
    });
    expect(aiStep.summary).toBe("subagent[call_1] ai: Let me search the web.");

    const end = summarizeRunEvent({
      seq: 53,
      event_type: "subagent.end",
      content: { task_id: "call_1", status: "completed", model_name: "claude-3-7" },
      metadata: { task_id: "call_1" },
    });
    expect(end.summary).toBe("subagent[call_1] completed");

    const failed = summarizeRunEvent({
      seq: 54,
      event_type: "subagent.end",
      content: { task_id: "call_2", status: "failed", error: "boom" },
      metadata: { task_id: "call_2" },
    });
    expect(failed.summary).toBe("subagent[call_2] failed — boom");
  });

  it("getProgress composes run counters, activity, and todos", async () => {
    const { fetchFn } = createMockFetch(progressResponder(runRow(), EVENTS));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const p = await client.getProgress("t-1", "r-1", { now: NOW });
    expect(p.status).toBe("running");
    expect(p.terminal).toBe(false);
    expect(p.elapsed_seconds).toBe(969);
    expect(p.seconds_since_update).toBe(10);
    expect(p.seconds_since_activity).toBe(10);
    expect(p.last_event_seq).toBe(40);
    expect(p.llm_call_count).toBe(20);
    expect(p.message_count).toBe(52);
    expect(p.total_tokens).toBe(1000);
    expect(p.stalled).toBe(false);
    expect(p.todos).toEqual(TODOS);
    expect(p.activity).toHaveLength(2);
    expect(p.activity[0].summary).toContain("web_search(vLLM v0.25.0)");
  });

  it("getProgress flags a stalled run with a hint", async () => {
    const stale = runRow({
      created_at: "2026-09-12T03:00:00.000Z",
      updated_at: "2026-09-12T03:50:00.000Z",
    });
    const staleEvents = EVENTS.map((e) => ({ ...e, created_at: "2026-09-12T03:50:00.000Z" }));
    const { fetchFn } = createMockFetch(progressResponder(stale, staleEvents));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const p = await client.getProgress("t-1", "r-1", { now: NOW });
    expect(p.stalled).toBe(true);
    expect(p.seconds_since_activity).toBe(1200);
    expect(p.hint).toMatch(/No activity for 1200s/);
    expect(p.hint).toContain("https://deer.example.com/workspace/chats/t-1");
  });

  it("getProgress surfaces a run.error event as error text", async () => {
    const events = [
      {
        seq: 41,
        event_type: "run.error",
        created_at: "2026-09-12T04:09:00.000Z",
        content: "Recursion limit exceeded",
      },
    ];
    const { fetchFn } = createMockFetch(progressResponder(runRow({ status: "error" }), events));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const p = await client.getProgress("t-1", "r-1", { now: NOW });
    expect(p.terminal).toBe(true);
    expect(p.error).toBe("Recursion limit exceeded");
    expect(p.stalled).toBe(false);
  });

  it("waitForActivity returns 'activity' immediately when new events exist", async () => {
    const { fetchFn, calls } = createMockFetch(progressResponder(runRow(), EVENTS));
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 1 });
    const res = await client.waitForActivity("t-1", "r-1", { sinceSeq: 38 });
    expect(res.reason).toBe("activity");
    expect(res.last_event_seq).toBe(40);
    expect(res.waited_seconds).toBe(0);
    // The delta query must use the provided cursor.
    expect(calls.some((c) => c.url.includes("after_seq=38"))).toBe(true);
  });

  it("waitForActivity returns 'terminal' for a finished run", async () => {
    const { fetchFn } = createMockFetch(progressResponder(runRow({ status: "success" }), []));
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 1 });
    const res = await client.waitForActivity("t-1", "r-1");
    expect(res.reason).toBe("terminal");
    expect(res.status).toBe("success");
  });

  it("waitForActivity returns 'timeout' when nothing changes", async () => {
    const { fetchFn } = createMockFetch(progressResponder(runRow(), []));
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 1 });
    const res = await client.waitForActivity("t-1", "r-1", { timeoutSeconds: 1 });
    expect(res.reason).toBe("timeout");
    expect(res.status).toBe("running");
    expect(res.waited_seconds).toBeGreaterThanOrEqual(1);
    expect(res.activity).toEqual([]);
  });

  it("getProgress flags a quiet (not stalled) run with a next_step", async () => {
    // Last activity 90s before NOW: > quietThreshold (60) but < stallThreshold (180).
    const quietRun = runRow({ updated_at: "2026-09-12T04:08:30.000Z" });
    const { fetchFn } = createMockFetch(progressResponder(quietRun, []));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const p = await client.getProgress("t-1", "r-1", { now: NOW });
    expect(p.seconds_since_activity).toBe(90);
    expect(p.quiet).toBe(true);
    expect(p.stalled).toBe(false);
    expect(p.next_step).toMatch(/Quiet for 90s/);
  });

  it("getReport auto-inlines the first text artifact when the run ended with no chat text", async () => {
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/messages")) return { body: { messages: [] } };
      if (call.url.includes("/runs/r-1")) return { body: { run_id: "r-1", status: "success" } };
      if (call.url.includes("/artifacts/"))
        return { text: "# Artifact report\nbody", headers: { "content-type": "text/markdown" } };
      if (call.url.endsWith("/state"))
        return {
          body: { values: { title: "T", artifacts: ["mnt/user-data/outputs/report.md"] } },
        };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const report = await client.getReport("t-1", "r-1");
    expect(report.report).toBe("# Artifact report\nbody");
    expect(report.report_source).toBe("artifact");
    expect(report.artifact_note).toMatch(/inlined from the artifact/);
    expect(report.terminal).toBe(true);
    expect(report.run_status).toBe("success");
  });

  it("getReport reports run_status and terminal when a run_id is supplied", async () => {
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/messages")) return { body: { messages: [] } };
      if (call.url.includes("/runs/r-1")) return { body: { run_id: "r-1", status: "error" } };
      if (call.url.endsWith("/state")) return { body: { values: { messages: [] } } };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const report = await client.getReport("t-1", "r-1");
    expect(report.report).toBe("");
    expect(report.report_source).toBeUndefined();
    expect(report.terminal).toBe(true);
    expect(report.run_status).toBe("error");
  });

  it("waitForActivity joins the SSE stream and returns 'terminal' on the end frame", async () => {
    const joinStream = sseStream([": heartbeat\n\nevent: end\ndata: null\n\n"]);
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/join")) return { stream: joinStream };
      if (call.url.includes("/runs/r-1/events")) return { body: [] };
      if (call.url.includes("/runs/r-1")) return { body: runRow() };
      if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 1 });
    const res = await client.waitForActivity("t-1", "r-1", { timeoutSeconds: 5 });
    expect(res.reason).toBe("terminal");
  });

  it("waitForActivity falls back to polling when the join stream is unavailable", async () => {
    let joinCalls = 0;
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/join")) {
        joinCalls += 1;
        return { status: 404, body: { detail: "unknown run" } };
      }
      if (call.url.includes("/runs/r-1/events")) return { body: [] };
      if (call.url.includes("/runs/r-1")) return { body: runRow() };
      if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 5 });
    const res = await client.waitForActivity("t-1", "r-1", { timeoutSeconds: 1 });
    expect(res.reason).toBe("timeout");
    expect(res.waited_seconds).toBeGreaterThanOrEqual(1);
    expect(joinCalls).toBe(1);
  });

  it("waitForActivity emits onTick while polling", async () => {
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/join")) return { status: 404, body: {} };
      if (call.url.includes("/runs/r-1/events")) return { body: [] };
      if (call.url.includes("/runs/r-1")) return { body: runRow() };
      if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 10 });
    const ticks: number[] = [];
    const res = await client.waitForActivity("t-1", "r-1", {
      timeoutSeconds: 1,
      onTick: (elapsed) => ticks.push(elapsed),
    });
    expect(res.reason).toBe("timeout");
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("waitForActivity returns stop_reason 'cancelled_by_client' when aborted", async () => {
    const joinStream = sseStream([": heartbeat\n\n"], { keepOpen: true });
    const { fetchFn } = createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/join")) return { stream: joinStream };
      if (call.url.includes("/runs/r-1/events")) return { body: [] };
      if (call.url.includes("/runs/r-1")) return { body: runRow() };
      if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
      return { body: {} };
    });
    const client = new DeerFlowClient(makeConfig(), fetchFn, { pollIntervalMs: 10 });
    const controller = new AbortController();
    const promise = client.waitForActivity("t-1", "r-1", {
      timeoutSeconds: 10,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const res = await promise;
    expect(res.stop_reason).toBe("cancelled_by_client");
  });
});

describe("SseParser", () => {
  it("parses a single complete frame", () => {
    const parser = new SseParser();
    const frames: SseFrame[] = [];
    parser.feed(
      "event: end\ndata: null\n\n",
      (f) => frames.push(f),
      () => {}
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("end");
    expect(frames[0].data).toBe("null");
  });

  it("handles a frame split across chunk boundaries", () => {
    const parser = new SseParser();
    const frames: SseFrame[] = [];
    parser.feed(
      "event: mes",
      (f) => frames.push(f),
      () => {}
    );
    parser.feed(
      "sage\ndata: hel",
      (f) => frames.push(f),
      () => {}
    );
    parser.feed(
      "lo\n\n",
      (f) => frames.push(f),
      () => {}
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("message");
    expect(frames[0].data).toBe("hello");
  });

  it("joins multi-line data with newlines", () => {
    const parser = new SseParser();
    const frames: SseFrame[] = [];
    parser.feed(
      "data: line1\ndata: line2\n\n",
      (f) => frames.push(f),
      () => {}
    );
    expect(frames[0].data).toBe("line1\nline2");
  });

  it("invokes onComment for heartbeat comment lines", () => {
    const parser = new SseParser();
    let comments = 0;
    parser.feed(
      ": heartbeat\n\n",
      () => {},
      () => comments++
    );
    expect(comments).toBe(1);
  });

  it("defaults the event name to 'message' when absent and captures id", () => {
    const parser = new SseParser();
    const frames: SseFrame[] = [];
    parser.feed(
      "id: 42\ndata: x\n\n",
      (f) => frames.push(f),
      () => {}
    );
    expect(frames[0].event).toBe("message");
    expect(frames[0].id).toBe("42");
  });
});

describe("joinRunStream", () => {
  function joinResponder(stream?: ReadableStream<Uint8Array>, status = 200) {
    return createMockFetch((call) => {
      if (call.url.includes("/runs/r-1/join"))
        return stream ? { stream, status } : { status, body: {} };
      if (call.url.includes("/runs/r-1/events")) return { body: [] };
      if (call.url.includes("/runs/r-1")) return { body: { run_id: "r-1", status: "running" } };
      if (call.url.endsWith("/state")) return { body: { values: { todos: [] } } };
      return { body: {} };
    });
  }

  it("returns 'end' when the stream sends an end frame", async () => {
    const { fetchFn } = joinResponder(sseStream(["event: end\ndata: null\n\n"]));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const outcome = await client.joinRunStream("t-1", "r-1", { timeoutMs: 2000 });
    expect(outcome).toBe("end");
  });

  it("returns 'gap' when the stream sends a gap frame", async () => {
    const { fetchFn } = joinResponder(
      sseStream(['event: gap\ndata: {"code":"stream_replay_gap"}\n\n'])
    );
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const outcome = await client.joinRunStream("t-1", "r-1", { timeoutMs: 2000 });
    expect(outcome).toBe("gap");
  });

  it("forwards non-terminal frames to onEvent and heartbeats to onHeartbeat", async () => {
    const { fetchFn } = joinResponder(
      sseStream([
        ": heartbeat\n\n",
        'event: message\ndata: {"seq":1}\n\n',
        "event: end\ndata: null\n\n",
      ])
    );
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const events: SseFrame[] = [];
    let heartbeats = 0;
    const outcome = await client.joinRunStream("t-1", "r-1", {
      timeoutMs: 2000,
      onEvent: (f) => events.push(f),
      onHeartbeat: () => heartbeats++,
    });
    expect(outcome).toBe("end");
    expect(heartbeats).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message");
  });

  it("returns 'timeout' when the budget elapses on an open stream", async () => {
    const { fetchFn } = joinResponder(sseStream([": heartbeat\n\n"], { keepOpen: true }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const outcome = await client.joinRunStream("t-1", "r-1", { timeoutMs: 50 });
    expect(outcome).toBe("timeout");
  });

  it("returns 'aborted' when the signal aborts", async () => {
    const { fetchFn } = joinResponder(sseStream([": heartbeat\n\n"], { keepOpen: true }));
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const controller = new AbortController();
    const promise = client.joinRunStream("t-1", "r-1", {
      timeoutMs: 5000,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    controller.abort();
    expect(await promise).toBe("aborted");
  });

  it("returns 'unavailable' when the join endpoint is 404", async () => {
    const { fetchFn } = joinResponder(undefined, 404);
    const client = new DeerFlowClient(makeConfig(), fetchFn);
    const outcome = await client.joinRunStream("t-1", "r-1", { timeoutMs: 2000 });
    expect(outcome).toBe("unavailable");
  });
});

describe("buildWaitResult", () => {
  const base: RunProgress = {
    run_id: "r-1",
    thread_id: "t-1",
    status: "running",
    terminal: false,
    elapsed_seconds: 100,
    quiet: false,
    stalled: false,
    activity: [],
    todos: [],
  };

  it("returns a compact object on a quiet timeout with no activity", () => {
    const res = buildWaitResult(base, "timeout", 30, 30, "https://deer.example.com");
    expect(res.reason).toBe("timeout");
    expect(res.timeout_seconds).toBe(30);
    expect(res.waited_seconds).toBe(30);
    expect(res.activity).toEqual([]);
    expect(res.next_step).toMatch(/No new activity within 30s/);
    expect("created_at" in res).toBe(false);
    expect("seconds_since_activity" in res).toBe(false);
  });

  it("returns the full snapshot when there is activity", () => {
    const res = buildWaitResult(
      { ...base, activity: [{ seq: 5, kind: "tool", summary: "x" }], last_event_seq: 5 },
      "timeout",
      30,
      30,
      "https://deer.example.com"
    );
    expect(res.reason).toBe("timeout");
    expect(res.activity).toHaveLength(1);
    expect(res.last_event_seq).toBe(5);
  });

  it("returns the full snapshot for a client cancellation", () => {
    const res = buildWaitResult(base, "timeout", 0, 30, "https://deer.example.com", {
      stop_reason: "cancelled_by_client",
    });
    expect(res.stop_reason).toBe("cancelled_by_client");
    expect(res.elapsed_seconds).toBe(100);
  });
});
