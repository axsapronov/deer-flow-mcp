import { describe, it, expect } from "vitest";
import { DeerFlowClient, DeerFlowError } from "../src/lib/client.js";
import { makeConfig, createMockFetch } from "./helpers.js";

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
