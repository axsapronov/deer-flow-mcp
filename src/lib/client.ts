import { fetch as undiciFetch } from "undici";
import type {
  ArtifactRef,
  DeerFlowConfig,
  ModelInfo,
  Report,
  RunInfo,
  RunStatus,
  ThreadSummary,
} from "./types.js";
import { isTerminalRunStatus } from "./types.js";
import { buildResearchPrompt, type ResearchPromptOptions } from "./prompts.js";

/**
 * A fetch-shaped function. The client defaults to `undici.fetch` but accepts an
 * injected implementation so tests can stub the network without touching the
 * real DeerFlow instance.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<Response>;

const DEFAULT_FETCH: FetchLike = (url, init) => undiciFetch(url, init) as Promise<Response>;

/** Error kinds the client can report. All carry a safe, loggable message. */
export type DeerFlowErrorKind = "http" | "network" | "timeout" | "bad_response";

/**
 * A failure talking to the DeerFlow instance. `message` is always safe to
 * surface to an MCP client (no stack, no credentials). `status` is the HTTP
 * status for `http` errors; `retryable` hints that a transient retry may help.
 */
export class DeerFlowError extends Error {
  readonly status?: number;
  readonly kind: DeerFlowErrorKind;
  readonly retryable: boolean;

  constructor(message: string, kind: DeerFlowErrorKind, status?: number, retryable = false) {
    super(message);
    this.name = "DeerFlowError";
    this.kind = kind;
    this.status = status;
    this.retryable = retryable;
  }
}

/** Options for the run-creating methods (`research`, `chat`). */
export interface RunOptions {
  /** Explicit model name (validated server-side against the allowlist). */
  model?: string;
  /** Override the default recursion limit for this run. */
  recursionLimit?: number;
  /** Enable plan mode (TodoMiddleware task list). */
  isPlanMode?: boolean;
  /** Enable extended thinking. */
  thinkingEnabled?: boolean;
  /** Reasoning effort: minimal | low | medium | high. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

/** A run that has just been started (background — still executing). */
export interface StartedRun {
  thread_id: string;
  run_id: string;
  status: RunStatus;
  web_url: string;
}

/** A text artifact fetched inline, or a reference to a binary one. */
export interface ArtifactResult {
  path: string;
  url: string;
  contentType?: string;
  /** Present only for text-like artifacts (markdown, json, csv, plain text, …). */
  content?: string;
}

/** Parameters for `searchThreads`. */
export interface SearchThreadsParams {
  limit?: number;
  offset?: number;
  status?: string;
  archived?: boolean;
  metadata?: Record<string, unknown>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const MAX_INLINE_ARTIFACT_BYTES = 256 * 1024;

/** Optional client tuning knobs (mainly used to speed up tests). */
export interface DeerFlowClientOptions {
  /** Poll interval for `waitForRun`, in milliseconds (default 2000). */
  pollIntervalMs?: number;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isTextLikeContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("text/") ||
    ct.includes("application/json") ||
    ct.includes("application/xml") ||
    ct.includes("application/yaml") ||
    ct.includes("application/csv") ||
    ct.includes("markdown") ||
    ct.includes("ndjson")
  );
}

function coerceRunStatus(value: unknown): RunStatus {
  const v = typeof value === "string" ? value : "unknown";
  const known: RunStatus[] = ["pending", "running", "success", "error", "timeout", "interrupted"];
  return (known.includes(v as RunStatus) ? v : "unknown") as RunStatus;
}

/**
 * Parse all `Set-Cookie` headers of a response into a name → value map.
 * Uses `Headers.getSetCookie()` (multiple cookies survive); falls back to the
 * single-value `get("set-cookie")` on older runtimes.
 */
function readSetCookies(res: Response): Map<string, string> {
  const map = new Map<string, string>();
  const raw =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie") as string]
        : [];
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const name = entry.slice(0, eq).trim();
    const value =
      entry
        .slice(eq + 1)
        .split(";")[0]
        ?.trim() ?? "";
    map.set(name, value);
  }
  return map;
}

/**
 * Thin, dependency-light client for the DeerFlow Gateway HTTP API.
 *
 * It targets the native `/api/...` routes (the same handlers nginx exposes as
 * `/api/langgraph/...`). Authentication is fixed at construction: a session
 * (email/password, logged in lazily and carried as cookies), a Personal Access
 * Token (`Authorization: Bearer dfp_…`), or the internal token
 * (`X-DeerFlow-Internal-Token` [+ owner user id]).
 */
export class DeerFlowClient {
  private readonly config: DeerFlowConfig;
  private readonly fetchFn: FetchLike;
  private readonly pollIntervalMs: number;
  /** Cached login result for session auth; `undefined` until the first login. */
  private session?: { accessToken: string; csrfToken?: string };

  constructor(
    config: DeerFlowConfig,
    fetchFn: FetchLike = DEFAULT_FETCH,
    options: DeerFlowClientOptions = {}
  ) {
    this.config = config;
    this.fetchFn = fetchFn;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Human link to a thread in the DeerFlow web UI. */
  webUrl(threadId: string): string {
    return `${this.config.webBaseUrl}/workspace/chats/${threadId}`;
  }

  /**
   * Log in with email/password like the web UI does
   * (`POST /api/v1/auth/login/local`, form-encoded). The resulting JWT lives
   * only in the `access_token` cookie (plus the double-submit `csrf_token`
   * cookie); neither is returned in the body.
   */
  private async login(): Promise<void> {
    const auth = this.config.auth;
    if (auth.kind !== "session") return;
    const url = `${this.config.baseUrl}/api/v1/auth/login/local`;
    const body = `username=${encodeURIComponent(auth.email)}&password=${encodeURIComponent(
      auth.password
    )}&remember_me=true`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new DeerFlowError(
          `Login to DeerFlow timed out after ${this.config.timeoutMs}ms.`,
          "timeout",
          undefined,
          true
        );
      }
      throw new DeerFlowError(
        `Network error logging in to DeerFlow: ${truncate(messageOf(err), 300)}`,
        "network",
        undefined,
        true
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await this.extractDetail(res);
      throw new DeerFlowError(
        [
          `DeerFlow login failed (HTTP ${res.status}). Check DEERFLOW_EMAIL and DEERFLOW_PASSWORD.`,
          detail,
        ]
          .filter(Boolean)
          .join(" "),
        "http",
        res.status
      );
    }
    const cookies = readSetCookies(res);
    const accessToken = cookies.get("access_token");
    if (!accessToken) {
      throw new DeerFlowError(
        "DeerFlow login succeeded but did not set the access_token cookie.",
        "bad_response",
        res.status
      );
    }
    const csrfToken = cookies.get("csrf_token");
    this.session = {
      accessToken,
      ...(csrfToken ? { csrfToken } : {}),
    };
  }

  /** Log in on first use (lazy) so startup stays credential-free. */
  private async ensureSession(): Promise<void> {
    if (this.session) return;
    await this.login();
  }

  private authHeaders(): Record<string, string> {
    const auth = this.config.auth;
    if (auth.kind === "pat") {
      return { Authorization: `Bearer ${auth.token}` };
    }
    if (auth.kind === "session") {
      const s = this.session;
      if (!s) return {};
      const headers: Record<string, string> = {
        Cookie: s.csrfToken
          ? `access_token=${s.accessToken}; csrf_token=${s.csrfToken}`
          : `access_token=${s.accessToken}`,
      };
      if (s.csrfToken) headers["X-CSRF-Token"] = s.csrfToken;
      return headers;
    }
    const headers: Record<string, string> = { "X-DeerFlow-Internal-Token": auth.token };
    if (auth.ownerUserId) headers["X-DeerFlow-Owner-User-Id"] = auth.ownerUserId;
    return headers;
  }

  private async requestRaw(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    retryOn401 = true
  ): Promise<Response> {
    const auth = this.config.auth;
    if (auth.kind === "session") await this.ensureSession();
    const url = `${this.config.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...this.authHeaders(),
      ...(init.headers ?? {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        signal: controller.signal,
      });
      if (auth.kind === "session" && res.status === 401 && retryOn401) {
        // The session was rejected (expired/invalidated): re-login once and
        // retry. The retry passes retryOn401=false so a second 401 surfaces
        // as an error instead of looping.
        this.session = undefined;
        await this.login();
        return await this.requestRaw(path, init, false);
      }
      return res;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new DeerFlowError(
          `Request to DeerFlow timed out after ${this.config.timeoutMs}ms (${path}).`,
          "timeout",
          undefined,
          true
        );
      }
      throw new DeerFlowError(
        `Network error calling DeerFlow at ${path}: ${truncate(messageOf(err), 300)}`,
        "network",
        undefined,
        true
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Extract the FastAPI `detail` (or raw body) from an error response. */
  private async extractDetail(res: Response): Promise<string | undefined> {
    try {
      const text = await res.text();
      if (!text) return undefined;
      try {
        const json = JSON.parse(text) as { detail?: unknown };
        if (typeof json.detail === "string") return json.detail;
        if (json.detail !== undefined) return truncate(JSON.stringify(json.detail), 500);
      } catch {
        // not JSON — fall through to raw text
      }
      return truncate(text, 500);
    } catch {
      return undefined;
    }
  }

  private async requestJson<T>(
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ): Promise<T> {
    const res = await this.requestRaw(path, init);
    if (!res.ok) {
      const detail = await this.extractDetail(res);
      throw new DeerFlowError(
        formatHttpError(res.status, detail, path, this.config.auth.kind),
        "http",
        res.status,
        res.status === 429 || res.status >= 500
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new DeerFlowError(
        `DeerFlow returned non-JSON data for ${path} (HTTP ${res.status}).`,
        "bad_response",
        res.status
      );
    }
  }

  // --- Threads -----------------------------------------------------------

  async createThread(metadata?: Record<string, unknown>): Promise<{ thread_id: string }> {
    const body: Record<string, unknown> = {};
    if (metadata) body.metadata = metadata;
    const data = await this.requestJson<{ thread_id: string }>("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!data?.thread_id) {
      throw new DeerFlowError(
        "DeerFlow did not return a thread_id when creating a thread.",
        "bad_response"
      );
    }
    return { thread_id: data.thread_id };
  }

  async searchThreads(params: SearchThreadsParams = {}): Promise<ThreadSummary[]> {
    const body: Record<string, unknown> = {};
    if (params.limit !== undefined) body.limit = params.limit;
    if (params.offset !== undefined) body.offset = params.offset;
    if (params.status !== undefined) body.status = params.status;
    if (params.archived !== undefined) body.archived = params.archived;
    if (params.metadata !== undefined) body.metadata = params.metadata;
    const data = await this.requestJson<unknown>("/api/threads/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const arr = Array.isArray(data) ? data : [];
    return arr.map(normalizeThreadSummary);
  }

  async getThreadState(threadId: string): Promise<ThreadState> {
    const data = await this.requestJson<ThreadState>(
      `/api/threads/${encodeURIComponent(threadId)}/state`
    );
    return data ?? {};
  }

  // --- Runs --------------------------------------------------------------

  async createRun(threadId: string, opts: RunOptions & { prompt: string }): Promise<RunInfo> {
    const context: Record<string, unknown> = {};
    if (opts.model) context.model_name = opts.model;
    if (opts.isPlanMode !== undefined) context.is_plan_mode = opts.isPlanMode;
    if (opts.thinkingEnabled !== undefined) context.thinking_enabled = opts.thinkingEnabled;
    if (opts.reasoningEffort !== undefined) context.reasoning_effort = opts.reasoningEffort;

    const config: Record<string, unknown> = {};
    const recursionLimit = opts.recursionLimit ?? this.config.defaultRecursionLimit;
    if (recursionLimit) config.recursion_limit = recursionLimit;

    const body: Record<string, unknown> = {
      input: { messages: [{ role: "user", content: opts.prompt }] },
    };
    if (Object.keys(config).length > 0) body.config = config;
    if (Object.keys(context).length > 0) body.context = context;

    const data = await this.requestJson<RawRunResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    return normalizeRun(data, threadId);
  }

  async getRun(threadId: string, runId: string): Promise<RunInfo> {
    const data = await this.requestJson<RawRunResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`
    );
    return normalizeRun(data, threadId);
  }

  async listRunMessages(threadId: string, runId: string, limit = 50): Promise<unknown[]> {
    const data = await this.requestJson<{ data?: unknown[] }>(
      `/api/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/messages?limit=${limit}`
    );
    return Array.isArray(data?.data) ? data.data : [];
  }

  async cancelRun(threadId: string, runId: string): Promise<void> {
    const res = await this.requestRaw(
      `/api/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel?action=interrupt&wait=false`,
      { method: "POST" }
    );
    // 202 (accepted) and 204 (no content) both mean the cancel was accepted.
    if (!res.ok) {
      const detail = await this.extractDetail(res);
      throw new DeerFlowError(
        formatHttpError(res.status, detail, "cancel run", this.config.auth.kind),
        "http",
        res.status,
        res.status === 429 || res.status >= 500
      );
    }
    await res.body?.cancel().catch(() => {});
  }

  /**
   * Poll a run until it reaches a terminal status or `waitSeconds` elapse.
   * Bounded so a single MCP call never blocks for the full (minutes-long) run.
   */
  async waitForRun(threadId: string, runId: string, waitSeconds = 0): Promise<RunInfo> {
    let info = await this.getRun(threadId, runId);
    if (waitSeconds <= 0 || isTerminalRunStatus(info.status)) return info;
    const deadline = Date.now() + waitSeconds * 1000;
    while (!isTerminalRunStatus(info.status) && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const sleep = Math.max(0, Math.min(this.pollIntervalMs, remaining));
      if (sleep > 0) await new Promise((resolve) => setTimeout(resolve, sleep));
      info = await this.getRun(threadId, runId);
    }
    return info;
  }

  // --- Models & artifacts ------------------------------------------------

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.requestJson<{ models?: ModelInfo[] }>("/api/models");
    return Array.isArray(data?.models) ? data.models : [];
  }

  async listArtifacts(threadId: string): Promise<ArtifactRef[]> {
    const state = await this.getThreadState(threadId);
    const artifacts = state.values?.artifacts;
    if (!Array.isArray(artifacts)) return [];
    return artifacts.map((p) => ({ path: String(p) }));
  }

  async getArtifact(threadId: string, path: string): Promise<ArtifactResult> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.requestRaw(
      `/api/threads/${encodeURIComponent(threadId)}/artifacts/${encoded}`
    );
    if (!res.ok) {
      const detail = await this.extractDetail(res);
      throw new DeerFlowError(
        formatHttpError(res.status, detail, `artifact ${path}`, this.config.auth.kind),
        "http",
        res.status,
        res.status === 429 || res.status >= 500
      );
    }
    const url = `${this.config.baseUrl}/api/threads/${encodeURIComponent(threadId)}/artifacts/${encoded}`;
    const contentType = res.headers.get("content-type") ?? undefined;
    if (isTextLikeContentType(contentType)) {
      const text = await res.text();
      if (Buffer.byteLength(text, "utf8") <= MAX_INLINE_ARTIFACT_BYTES) {
        return { path, url, contentType, content: text };
      }
    }
    return { path, url, contentType };
  }

  // --- Composite operations ------------------------------------------------

  /** Start a deep-research run on a fresh thread. */
  async research(
    topic: string,
    opts: RunOptions & ResearchPromptOptions = {}
  ): Promise<StartedRun> {
    const prompt = buildResearchPrompt(topic, { focus: opts.focus, model: opts.model });
    const thread = await this.createThread();
    const run = await this.createRun(thread.thread_id, {
      prompt,
      model: opts.model,
      recursionLimit: opts.recursionLimit,
      isPlanMode: opts.isPlanMode ?? true,
      thinkingEnabled: opts.thinkingEnabled,
      reasoningEffort: opts.reasoningEffort,
    });
    return {
      thread_id: thread.thread_id,
      run_id: run.run_id,
      status: run.status,
      web_url: this.webUrl(thread.thread_id),
    };
  }

  /** Start a chat run, on a new or existing thread. */
  async chat(message: string, opts: RunOptions & { threadId?: string } = {}): Promise<StartedRun> {
    let threadId = opts.threadId;
    if (!threadId) {
      const thread = await this.createThread();
      threadId = thread.thread_id;
    }
    const run = await this.createRun(threadId, {
      prompt: message,
      model: opts.model,
      recursionLimit: opts.recursionLimit,
      isPlanMode: opts.isPlanMode,
      thinkingEnabled: opts.thinkingEnabled,
      reasoningEffort: opts.reasoningEffort,
    });
    return {
      thread_id: threadId,
      run_id: run.run_id,
      status: run.status,
      web_url: this.webUrl(threadId),
    };
  }

  /**
   * Fetch the synthesized report for a thread: the most recent assistant
   * message plus its title and artifacts. When `runId` is supplied, the
   * run-scoped message log is used for the report text (more precise for a
   * single run); otherwise the thread state's message history is used.
   */
  async getReport(threadId: string, runId?: string): Promise<Report> {
    const state = await this.getThreadState(threadId);
    const title = state.values?.title ?? undefined;
    const summaryText = state.values?.summary_text ?? undefined;
    const artifacts = Array.isArray(state.values?.artifacts)
      ? state.values!.artifacts!.map((p) => String(p))
      : [];

    let messages: Record<string, unknown>[] = [];
    if (runId) {
      const raw = await this.listRunMessages(threadId, runId, 50);
      messages = raw.filter(isMessageObject) as Record<string, unknown>[];
    }
    if (messages.length === 0 && Array.isArray(state.values?.messages)) {
      messages = state.values!.messages!.filter(isMessageObject) as Record<string, unknown>[];
    }

    const report = lastAssistantText(messages) ?? summaryText ?? "";
    return {
      report,
      title,
      summary_text: summaryText,
      artifacts,
      web_url: this.webUrl(threadId),
    };
  }
}

// --- Raw response shapes -------------------------------------------------

interface RawRunResponse {
  run_id?: string;
  thread_id?: string;
  status?: string;
  stop_reason?: string | null;
  created_at?: string;
  updated_at?: string;
}

interface ThreadState {
  values?: {
    title?: string | null;
    summary_text?: string | null;
    artifacts?: unknown[];
    messages?: unknown[];
  };
}

// --- Normalizers ---------------------------------------------------------

function normalizeRun(raw: RawRunResponse | undefined, threadId: string): RunInfo {
  if (!raw || !raw.run_id) {
    throw new DeerFlowError("DeerFlow did not return a run_id for the run.", "bad_response");
  }
  return {
    run_id: raw.run_id,
    thread_id: raw.thread_id ?? threadId,
    status: coerceRunStatus(raw.status),
    stop_reason: raw.stop_reason ?? undefined,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

function normalizeThreadSummary(raw: unknown): ThreadSummary {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const values = (
    typeof obj.values === "object" && obj.values !== null ? obj.values : {}
  ) as Record<string, unknown>;
  return {
    thread_id: typeof obj.thread_id === "string" ? obj.thread_id : String(obj.thread_id ?? ""),
    status: typeof obj.status === "string" ? obj.status : undefined,
    created_at: typeof obj.created_at === "string" ? obj.created_at : undefined,
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
    title: typeof values.title === "string" ? values.title : undefined,
  };
}

function isMessageObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extract display text from a LangGraph message (string or content blocks). */
function messageText(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (typeof block === "object" && block !== null) {
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isAssistantMessage(msg: Record<string, unknown>): boolean {
  const type = msg.type;
  const role = msg.role;
  return type === "ai" || role === "assistant" || role === "ai";
}

/** The text of the most recent assistant message in a message list. */
function lastAssistantText(messages: Record<string, unknown>[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || !isAssistantMessage(msg)) continue;
    const text = messageText(msg).trim();
    if (text) return text;
  }
  return undefined;
}

function formatHttpError(
  status: number,
  detail: string | undefined,
  context: string,
  authKind: "session" | "pat" | "internal"
): string {
  const detailSuffix = detail ? ` ${detail}` : "";
  switch (status) {
    case 401:
      return `DeerFlow rejected the credential (401).${
        authKind === "pat"
          ? " Personal Access Tokens require a database-backed deployment; memory-only instances reject Bearer tokens."
          : authKind === "session"
            ? " The email/password credentials were rejected or the session expired — check DEERFLOW_EMAIL and DEERFLOW_PASSWORD."
            : ""
      } ${detailSuffix}`.trim();
    case 403:
      return `DeerFlow denied this operation (403).${
        authKind === "pat"
          ? " With a Personal Access Token, /api/models and artifact downloads are not in the PAT route allowlist — use an internal token for those."
          : authKind === "session"
            ? " The session is not authorized for this operation."
            : ""
      } ${detailSuffix}`.trim();
    case 404:
      return `Not found (404): the referenced thread/run/artifact does not exist or you lack access. ${context}.${detailSuffix}`.trim();
    case 409:
      return `Conflict (409): ${context} is not in a state that allows this action.${detailSuffix}`.trim();
    case 422:
      return `DeerFlow rejected the request (422).${detailSuffix}`.trim();
    case 429:
      return `Rate limited (429). Retry shortly.${detailSuffix}`.trim();
    default:
      if (status >= 500) return `DeerFlow server error (HTTP ${status}).${detailSuffix}`.trim();
      return `DeerFlow request failed (HTTP ${status}).${detailSuffix}`.trim();
  }
}
