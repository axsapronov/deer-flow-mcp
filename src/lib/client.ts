import { fetch as undiciFetch } from "undici";
import type {
  ActivityWaitReason,
  ArtifactRef,
  DeerFlowConfig,
  ModelInfo,
  Report,
  ReportSource,
  RunActivityWaitResult,
  RunEventSummary,
  RunInfo,
  RunProgress,
  RunStatus,
  ThreadSummary,
  TodoItem,
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

// --- SSE (Server-Sent Events) ------------------------------------------------

/** A single parsed SSE frame. */
export interface SseFrame {
  /** The `event:` field (defaults to "message" when absent). */
  event: string;
  /** The `data:` payload (multiple `data:` lines joined with "\n"). */
  data: string;
  /** The `id:` field, when present. */
  id?: string;
}

/** The outcome of waiting on a joined run SSE stream. */
export type SseWaitOutcome = "end" | "gap" | "timeout" | "aborted" | "unavailable";

/**
 * A line-based SSE parser that survives frames split across arbitrary chunk
 * boundaries. Handles `event:`/`data:`/`id:` fields, multi-line `data`, and
 * comment lines (heartbeats). Feed it decoded text chunks via {@link feed}.
 */
export class SseParser {
  private buffer = "";
  private event = "";
  private dataLines: string[] = [];
  private id?: string;
  /** True when the current frame carries at least one field. */
  private hasField = false;

  /**
   * Feed a decoded text chunk. Invokes `onFrame` for each complete frame and
   * `onComment` for each comment (heartbeat) line.
   */
  feed(chunk: string, onFrame: (frame: SseFrame) => void, onComment: () => void): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.processLine(line, onFrame, onComment);
    }
  }

  private processLine(
    line: string,
    onFrame: (frame: SseFrame) => void,
    onComment: () => void
  ): void {
    if (line === "") {
      if (this.hasField) {
        onFrame({
          event: this.event || "message",
          data: this.dataLines.join("\n"),
          ...(this.id !== undefined ? { id: this.id } : {}),
        });
      }
      this.event = "";
      this.dataLines = [];
      this.id = undefined;
      this.hasField = false;
      return;
    }
    if (line.startsWith(":")) {
      onComment();
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        this.event = value;
        this.hasField = true;
        break;
      case "data":
        this.dataLines.push(value);
        this.hasField = true;
        break;
      case "id":
        this.id = value;
        this.hasField = true;
        break;
      // ignore other fields (e.g. "retry")
    }
  }
}

/**
 * Sleep for `ms` milliseconds, resolving early if `signal` aborts. Used so an
 * in-flight wait can be cancelled by the client's AbortSignal.
 */
export function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    if (signal) {
      if (signal.aborted) done();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
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

  /** The capped upper bound (seconds) for `waitForActivity` timeouts. */
  get progressWaitMaxSeconds(): number {
    return this.config.progressWaitMaxSeconds;
  }

  /** How often (ms) progress notifications are emitted during a long wait. */
  get progressTickMs(): number {
    return this.config.progressTickMs;
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

  // --- Progress & activity ----------------------------------------------

  /**
   * Fetch persisted run events (the audit/progress stream). Without
   * `afterSeq` the latest `limit` events are returned, ascending; with
   * `afterSeq` only events with `seq > afterSeq` (forward delta).
   */
  async listRunEvents(
    threadId: string,
    runId: string,
    opts: { limit?: number; afterSeq?: number } = {}
  ): Promise<RawRunEvent[]> {
    const params: string[] = [];
    if (opts.limit !== undefined) params.push(`limit=${opts.limit}`);
    // The backend validates after_seq with ge=1; 0 (no cursor) must be omitted.
    if (opts.afterSeq !== undefined && opts.afterSeq > 0) params.push(`after_seq=${opts.afterSeq}`);
    const qs = params.length > 0 ? `?${params.join("&")}` : "";
    const data = await this.requestJson<unknown>(
      `/api/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/events${qs}`
    );
    return Array.isArray(data) ? (data as RawRunEvent[]) : [];
  }

  /** Plan-mode checklist from the thread state (`values.todos`). */
  async getTodos(threadId: string): Promise<TodoItem[]> {
    const state = await this.getThreadState(threadId);
    const todos = state.values?.todos;
    if (!Array.isArray(todos)) return [];
    return todos.filter(isRecord).map((t) => ({
      content: typeof t.content === "string" ? t.content : String(t.content ?? ""),
      status: typeof t.status === "string" ? t.status : "pending",
    }));
  }

  /**
   * Compose a live progress snapshot for a run from three sources: the run row
   * (status + live counters + timestamps), the run event stream (recent
   * activity), and the thread state (plan-mode todos).
   *
   * Pass `sinceSeq` for delta mode: only events with `seq > sinceSeq` are
   * included in `activity` (and `last_event_seq` never goes below `sinceSeq`).
   */
  async getProgress(
    threadId: string,
    runId: string,
    opts: { sinceSeq?: number; activityLimit?: number; now?: number } = {}
  ): Promise<RunProgress> {
    const nowMs = opts.now ?? Date.now();
    const activityLimit = opts.activityLimit ?? 10;
    const sinceSeq = opts.sinceSeq;
    const [run, events, todos] = await Promise.all([
      this.getRun(threadId, runId),
      sinceSeq !== undefined && sinceSeq > 0
        ? this.listRunEvents(threadId, runId, { limit: activityLimit, afterSeq: sinceSeq })
        : this.latestRunEvents(threadId, runId, activityLimit),
      this.getTodos(threadId),
    ]);
    return composeProgress(run, events, todos, {
      baseUrl: this.config.webBaseUrl,
      stallThresholdSeconds: this.config.stallThresholdSeconds,
      quietThresholdSeconds: this.config.quietThresholdSeconds,
      nowMs,
    });
  }

  /**
   * The latest `count` events of a run. The events endpoint paginates forward
   * only (after_seq), so a bare `limit` returns the FIRST events; fetch a
   * bounded window from the start and slice the tail. Refetches with a wider
   * window when the first one was full (the run has more events than the
   * window).
   */
  private async latestRunEvents(
    threadId: string,
    runId: string,
    count: number
  ): Promise<RawRunEvent[]> {
    const WINDOW = 500;
    let events = await this.listRunEvents(threadId, runId, { limit: WINDOW });
    if (events.length === WINDOW) {
      events = await this.listRunEvents(threadId, runId, { limit: 2000 });
    }
    return events.slice(-count);
  }

  /**
   * Join an existing run's SSE stream (`GET /api/threads/{id}/runs/{run_id}/join`)
   * and wait for a terminal/gap/timeout/abort outcome. This is the primary
   * "wait for the run to finish" mechanism: a single long-lived connection that
   * receives the `end` frame exactly when the run ends, instead of polling
   * every few seconds.
   *
   * Returns:
   *  - `"end"`         — the `end` frame arrived (run reached a terminal state).
   *  - `"gap"`         — a replay-gap frame arrived (fall back to durable state).
   *  - `"timeout"`     — `timeoutMs` elapsed without an `end`/`gap` frame.
   *  - `"aborted"`     — `signal` aborted the wait.
   *  - `"unavailable"` — the stream could not be used (404/409/network error or
   *                      no body); the caller should fall back to polling.
   *
   * SSE frames other than `end`/`gap` are forwarded to `onEvent`; heartbeat
   * comment lines are forwarded to `onHeartbeat` (aliveness signal).
   */
  async joinRunStream(
    threadId: string,
    runId: string,
    opts: {
      signal?: AbortSignal;
      timeoutMs: number;
      onEvent?: (frame: SseFrame) => void;
      onHeartbeat?: () => void;
    }
  ): Promise<SseWaitOutcome> {
    const url = `${this.config.baseUrl}/api/threads/${encodeURIComponent(
      threadId
    )}/runs/${encodeURIComponent(runId)}/join`;
    const controller = new AbortController();
    let abortReason: "timeout" | "external" | undefined;
    const onTimer = () => {
      if (abortReason === undefined) abortReason = "timeout";
      controller.abort();
    };
    const onExternal = () => {
      if (abortReason === undefined) abortReason = "external";
      controller.abort();
    };
    const timer = setTimeout(onTimer, opts.timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) onExternal();
      else opts.signal.addEventListener("abort", onExternal, { once: true });
    }
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternal);
    };

    let res: Response;
    try {
      if (this.config.auth.kind === "session") await this.ensureSession();
      res = await this.fetchFn(url, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...this.authHeaders() },
        signal: controller.signal,
      });
    } catch {
      cleanup();
      return abortReason === "external" ? "aborted" : "unavailable";
    }

    if (!res.ok) {
      // 404 (unknown run), 409 (store_only without a cross-process bridge), etc.
      await res.body?.cancel().catch(() => {});
      cleanup();
      return abortReason === "external" ? "aborted" : "unavailable";
    }
    const body = res.body;
    if (!body) {
      cleanup();
      return abortReason === "external" ? "aborted" : "unavailable";
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    type SseReadResult = Awaited<ReturnType<typeof reader.read>>;
    try {
      for (;;) {
        let chunk: SseReadResult;
        try {
          chunk = await reader.read();
        } catch {
          // read failed: an abort (timeout/external) or a mid-stream network error.
          if (abortReason === "external") return "aborted";
          if (abortReason === "timeout") return "timeout";
          return "unavailable";
        }
        if (chunk.done) break; // the stream closed
        const text = decoder.decode(chunk.value, { stream: true });
        if (!text) continue;
        let outcome: SseWaitOutcome | undefined;
        parser.feed(
          text,
          (frame) => {
            if (frame.event === "end") outcome = "end";
            else if (frame.event === "gap") outcome = "gap";
            else opts.onEvent?.(frame);
          },
          () => opts.onHeartbeat?.()
        );
        if (outcome) {
          await reader.cancel().catch(() => {});
          return outcome;
        }
      }
      // The stream closed cleanly without an end/gap frame (e.g. the server
      // ended the connection early, or a non-SSE body was returned). Fall back
      // to polling rather than treating it as a timeout that ends the wait.
      if (abortReason === "external") return "aborted";
      if (abortReason === "timeout") return "timeout";
      return "unavailable";
    } finally {
      cleanup();
      await reader.cancel().catch(() => {});
    }
  }

  /**
   * Server-side long-poll: wait until the run produces new activity (an event
   * with `seq > sinceSeq`), reaches a terminal status, or `timeoutSeconds`
   * elapses.
   *
   * The primary mechanism is joining the run's SSE stream ({@link joinRunStream}):
   * a single long-lived connection that receives the `end` frame exactly when
   * the run ends. When the SSE stream is unavailable (404/409/network error or
   * a replay gap), it falls back to polling the run row + event stream every
   * `pollIntervalMs`.
   *
   * `signal` (the MCP client's AbortSignal) cancels the wait and the result
   * carries `stop_reason: "cancelled_by_client"`. `onTick` is invoked
   * periodically with the latest snapshot so the caller can emit progress
   * notifications. Returns the progress snapshot plus `reason`,
   * `waited_seconds`, and `timeout_seconds`.
   */
  async waitForActivity(
    threadId: string,
    runId: string,
    opts: {
      sinceSeq?: number;
      timeoutSeconds?: number;
      signal?: AbortSignal;
      onTick?: (elapsedSeconds: number, snapshot: RunProgress) => void;
    } = {}
  ): Promise<RunActivityWaitResult> {
    const timeoutSeconds = Math.max(
      1,
      Math.min(opts.timeoutSeconds ?? 30, this.config.progressWaitMaxSeconds)
    );
    const timeoutMs = timeoutSeconds * 1000;
    const startedAt = Date.now();
    let sinceSeq = opts.sinceSeq ?? 0;
    const signal = opts.signal;
    const elapsed = () => Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const build = (
      progress: RunProgress,
      reason: ActivityWaitReason,
      extra?: Partial<RunActivityWaitResult>
    ): RunActivityWaitResult =>
      buildWaitResult(progress, reason, elapsed(), timeoutSeconds, this.config.webBaseUrl, extra);

    // Initial check (full snapshot, todos included).
    let progress = await this.getProgress(threadId, runId, { sinceSeq });
    if (progress.terminal) return build(progress, "terminal");
    if (progress.activity.length > 0) {
      sinceSeq = progress.last_event_seq ?? sinceSeq;
      return build(progress, "activity");
    }

    const deadline = startedAt + timeoutMs;

    // Primary: join the SSE stream for the remaining budget.
    if (!signal?.aborted) {
      const outcome = await this.joinRunStream(threadId, runId, {
        signal,
        timeoutMs: Math.max(0, deadline - Date.now()),
        onHeartbeat: () => opts.onTick?.(elapsed(), progress),
      });
      if (outcome === "end") {
        progress = await this.getProgress(threadId, runId, { sinceSeq });
        return build(progress, "terminal");
      }
      if (outcome === "aborted") {
        progress = await this.getProgress(threadId, runId, { sinceSeq });
        return build(progress, "timeout", { stop_reason: "cancelled_by_client" });
      }
      if (outcome === "timeout") {
        progress = await this.getProgress(threadId, runId, { sinceSeq });
        return build(progress, "timeout");
      }
      // "gap" or "unavailable" → fall through to the polling fallback below.
    }

    // Fallback: poll the run row + event stream until the deadline.
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const sleep = Math.max(0, Math.min(this.pollIntervalMs, remaining));
      if (sleep > 0) await sleepInterruptible(sleep, signal);
      if (signal?.aborted) {
        progress = await this.getProgress(threadId, runId, { sinceSeq });
        return build(progress, "timeout", { stop_reason: "cancelled_by_client" });
      }
      if (Date.now() >= deadline) break;
      const [run, events] = await Promise.all([
        this.getRun(threadId, runId),
        this.listRunEvents(threadId, runId, { limit: 20, afterSeq: sinceSeq }),
      ]);
      if (isTerminalRunStatus(run.status)) {
        progress = await this.getProgress(threadId, runId, { sinceSeq });
        return build(progress, "terminal");
      }
      if (events.length > 0) {
        sinceSeq = Math.max(sinceSeq, ...events.map((e) => e.seq ?? 0));
        progress = await this.getProgress(threadId, runId, { sinceSeq });
        return build(progress, "activity");
      }
      opts.onTick?.(elapsed(), progress);
    }
    progress = await this.getProgress(threadId, runId, { sinceSeq });
    return build(progress, "timeout");
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
   * Fetch the synthesized report for a thread. The report text is resolved
   * through a fallback chain:
   *   a. run-scoped messages (last 50, ascending) → last assistant text;
   *   b. thread state `values.messages` → last assistant text (consulted only
   *      when (a) yielded no assistant text);
   *   c. `values.summary_text`;
   *   d. run terminal and still empty → auto-inline the first text-like
   *      artifact (≤ 256 KB), with an explicit note.
   * When `runId` is supplied the run row is fetched for its status so the
   * report can distinguish "run still in progress" from "run finished with no
   * final chat text".
   */
  async getReport(threadId: string, runId?: string): Promise<Report> {
    const state = await this.getThreadState(threadId);
    const title = state.values?.title ?? undefined;
    const summaryText = state.values?.summary_text ?? undefined;
    const artifacts = Array.isArray(state.values?.artifacts)
      ? state.values!.artifacts!.map((p) => String(p))
      : [];

    let run: RunInfo | undefined;
    if (runId) {
      try {
        run = await this.getRun(threadId, runId);
      } catch {
        run = undefined; // run missing/unreadable — continue without its status
      }
    }
    const terminal = run ? isTerminalRunStatus(run.status) : false;

    // (a) primary: run-scoped messages (last 50, ascending).
    let messages: Record<string, unknown>[] = [];
    if (runId) {
      try {
        const raw = await this.listRunMessages(threadId, runId, 50);
        messages = raw.filter(isMessageObject) as Record<string, unknown>[];
      } catch {
        messages = []; // message log unavailable — rely on the state fallback
      }
    }
    let report = lastAssistantText(messages);
    let reportSource: ReportSource | undefined = report ? "run-messages" : undefined;

    // (b) fallback: thread state messages — only when (a) found no assistant text.
    if (!report && Array.isArray(state.values?.messages)) {
      const stateMessages = state.values!.messages!.filter(isMessageObject) as Record<
        string,
        unknown
      >[];
      report = lastAssistantText(stateMessages);
      if (report) reportSource = "state-messages";
    }

    // (c) fallback: summary_text.
    if (!report && summaryText) {
      report = summaryText;
      reportSource = "summary";
    }

    // (d) terminal + still empty → auto-inline the first text-like artifact.
    let artifactNote: string | undefined;
    if (!report && terminal && artifacts.length > 0) {
      for (const path of artifacts) {
        try {
          const artifact = await this.getArtifact(threadId, path);
          if (artifact.content !== undefined) {
            report = artifact.content;
            reportSource = "artifact";
            artifactNote = `The run has finished but produced no final chat message; the report below is inlined from the artifact "${path}".`;
            break;
          }
        } catch {
          // artifact unreadable (e.g. 403 for a PAT) — try the next one
        }
      }
    }

    return {
      report: report ?? "",
      title,
      summary_text: summaryText,
      artifacts,
      web_url: this.webUrl(threadId),
      ...(run ? { terminal, run_status: run.status } : {}),
      ...(reportSource ? { report_source: reportSource } : {}),
      ...(artifactNote ? { artifact_note: artifactNote } : {}),
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
  total_tokens?: number;
  llm_call_count?: number;
  message_count?: number;
  /**
   * Kept for forward compatibility, but the backend's `RunResponse` does not
   * currently populate this field. The authoritative error source is the run
   * event stream (`run.error`/`llm.error` events), which `composeProgress`
   * reads into `RunProgress.error`.
   */
  error?: string | null;
}

/**
 * A persisted run event from `GET /api/threads/{id}/runs/{run_id}/events`.
 * `content` is a serialized LangChain message for `llm.*` events, a string for
 * `run.error`/`llm.error`, and an object otherwise.
 */
export interface RawRunEvent {
  seq?: number;
  event_type?: string;
  category?: string;
  content?: unknown;
  metadata?: Record<string, unknown> | null;
  created_at?: string;
  run_id?: string;
}

interface ThreadState {
  values?: {
    title?: string | null;
    summary_text?: string | null;
    artifacts?: unknown[];
    messages?: unknown[];
    todos?: unknown[];
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
    ...(raw.total_tokens !== undefined ? { total_tokens: raw.total_tokens } : {}),
    ...(raw.llm_call_count !== undefined ? { llm_call_count: raw.llm_call_count } : {}),
    ...(raw.message_count !== undefined ? { message_count: raw.message_count } : {}),
    ...(raw.error ? { error: raw.error } : {}),
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

// --- Progress composition & event summarization --------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneLine(value: string, max: number): string {
  const flattened = value.replace(/\s+/g, " ").trim();
  return flattened.length > max ? `${flattened.slice(0, max)}…` : flattened;
}

/** Tool-call argument keys whose string value reads as "the" argument. */
const PREFERRED_ARG_KEYS = [
  "query",
  "prompt",
  "message",
  "content",
  "text",
  "topic",
  "url",
  "path",
  "file_path",
  "pattern",
  "title",
];

/** Reduce a tool-call argument to a short human-readable string. */
function summarizeArgValue(arg: unknown): string {
  if (arg === undefined || arg === null) return "";
  if (typeof arg === "string") return arg;
  if (typeof arg === "number" || typeof arg === "boolean") return String(arg);
  const obj = asRecord(arg);
  if (obj) {
    for (const key of PREFERRED_ARG_KEYS) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return JSON.stringify(arg);
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Truncate a string to `max` chars, preferring a word boundary so we never cut
 * mid-token (e.g. mid-JSON-key). Falls back to a hard cut when there is no
 * reasonable boundary in the first half of the slice.
 */
function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const sliced = value.slice(0, max);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace >= max / 2) return `${sliced.slice(0, lastSpace).trimEnd()}…`;
  return `${sliced}…`;
}

/**
 * Reduce a tool-result payload to a short, human-readable summary. Handles the
 * known shapes (web_search `total_results`, JSON/text error bodies) and falls
 * back to a word-boundary truncation so we never cut mid-JSON.
 */
function summarizeToolResult(name: string, text: string): string {
  const flat = oneLine(text, 200);
  if (!flat) return `${name} → (no content)`;
  const trimmed = flat.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      if (parsed) {
        if (typeof parsed.total_results === "number") {
          return `${name} → ${parsed.total_results} results`;
        }
        if (typeof parsed.error === "string" && parsed.error) {
          return `${name} → error: ${truncateAtWord(parsed.error, 120)}`;
        }
      }
    } catch {
      // not valid JSON — fall through to plain-text handling
    }
  }
  if (/^error:/i.test(flat)) {
    const essence = flat.replace(/^error:/i, "").trim();
    return `${name} → error: ${truncateAtWord(essence || flat, 120)}`;
  }
  if (/\berror\b/i.test(flat)) {
    return `${name} → error: ${truncateAtWord(flat, 120)}`;
  }
  return `${name} → ${truncateAtWord(flat, 100)}`;
}

/**
 * Reduce one raw run event to a compact one-line summary. Exported for tests.
 */
export function summarizeRunEvent(evt: RawRunEvent): RunEventSummary {
  const type = evt.event_type ?? "unknown";
  const base = { seq: evt.seq ?? 0, ...(evt.created_at ? { at: evt.created_at } : {}) };
  if (type.startsWith("middleware:")) {
    const label = type.slice("middleware:".length).replace(/_/g, " ");
    const content = asRecord(evt.content);
    const changes = asRecord(content?.changes);
    const toolNames = Array.isArray(changes?.tool_names)
      ? (changes!.tool_names as unknown[]).map((t) => String(t)).join(", ")
      : undefined;
    const count = typeof changes?.count === "number" ? changes.count : undefined;
    let summary: string;
    if (toolNames && count !== undefined) {
      summary = `${label}: agent repeated ${toolNames} ${count} times`;
    } else if (typeof content?.action === "string" && content.action) {
      summary = `${label}: ${content.action}`;
    } else {
      summary = label;
    }
    return { ...base, kind: "warning", summary };
  }
  switch (type) {
    case "llm.ai.response": {
      const msg = asRecord(evt.content);
      const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
      if (toolCalls.length > 0) {
        const names = toolCalls.slice(0, 3).map((tc) => {
          const t = asRecord(tc);
          const name = typeof t?.name === "string" ? t.name : "tool";
          const argText = summarizeArgValue(t?.args);
          return argText ? `${name}(${oneLine(argText, 80)})` : name;
        });
        const more = toolCalls.length > 3 ? ` +${toolCalls.length - 3} more` : "";
        return { ...base, kind: "ai", summary: `tool_calls: ${names.join("; ")}${more}` };
      }
      const text = oneLine(messageText(msg ?? {}), 160);
      return { ...base, kind: "ai", summary: text || "(empty ai message)" };
    }
    case "llm.tool.result": {
      const msg = asRecord(evt.content);
      const name = typeof msg?.name === "string" ? msg.name : "tool";
      const inner = typeof msg?.content === "string" ? msg.content : messageText(msg ?? {});
      return { ...base, kind: "tool", summary: summarizeToolResult(name, inner) };
    }
    case "run.error":
    case "llm.error": {
      const text =
        typeof evt.content === "string" ? evt.content : JSON.stringify(evt.content ?? "");
      return { ...base, kind: "error", summary: `error: ${oneLine(text, 160)}` };
    }
    case "run.delivery": {
      const content = asRecord(evt.content);
      const msg =
        (typeof content?.message === "string" && content.message) ||
        (typeof content?.text === "string" && content.text) ||
        (typeof content?.summary === "string" && content.summary);
      return {
        ...base,
        kind: "other",
        summary: msg ? `delivery: ${oneLine(msg, 100)}` : "run delivered",
      };
    }
    default:
      return { ...base, kind: "other", summary: type };
  }
}

/**
 * Compose a {@link RunProgress} snapshot from a run row, its recent events,
 * and the thread's plan-mode todos. Pure so it can be unit-tested without
 * network access.
 */
export function composeProgress(
  run: RunInfo,
  events: RawRunActivityLike[],
  todos: TodoItem[],
  opts: {
    baseUrl: string;
    stallThresholdSeconds: number;
    quietThresholdSeconds: number;
    nowMs: number;
  }
): RunProgress {
  const terminal = isTerminalRunStatus(run.status);

  const activity = events.map(summarizeRunEvent);
  const eventSeqs = events.map((e) => e.seq ?? 0);
  const lastEventSeq = eventSeqs.length > 0 ? Math.max(...eventSeqs) : undefined;

  // Last activity signal: newest of run timestamps and event timestamps.
  const candidates: number[] = [];
  const createdMs = parseIsoMs(run.created_at);
  const updatedMs = parseIsoMs(run.updated_at);
  if (createdMs !== undefined) candidates.push(createdMs);
  if (updatedMs !== undefined) candidates.push(updatedMs);
  for (const e of events) {
    const ms = parseIsoMs(e.created_at);
    if (ms !== undefined) candidates.push(ms);
  }
  const lastActivityMs = candidates.length > 0 ? Math.max(...candidates) : undefined;

  const elapsedSeconds =
    createdMs !== undefined ? Math.max(0, Math.round((opts.nowMs - createdMs) / 1000)) : 0;
  const secondsSinceUpdate =
    updatedMs !== undefined ? Math.max(0, Math.round((opts.nowMs - updatedMs) / 1000)) : undefined;
  const secondsSinceActivity =
    lastActivityMs !== undefined
      ? Math.max(0, Math.round((opts.nowMs - lastActivityMs) / 1000))
      : undefined;

  const quiet =
    !terminal &&
    secondsSinceActivity !== undefined &&
    secondsSinceActivity > opts.quietThresholdSeconds;
  const stalled =
    !terminal &&
    secondsSinceActivity !== undefined &&
    secondsSinceActivity > opts.stallThresholdSeconds;

  let lastActivityAt: string | undefined;
  if (lastActivityMs !== undefined) {
    // Prefer the timestamp of the signal that produced the max value.
    const eventMax = events.reduce<number | undefined>((max, e) => {
      const ms = parseIsoMs(e.created_at);
      return ms !== undefined && (max === undefined || ms > max) ? ms : max;
    }, undefined);
    lastActivityAt =
      eventMax !== undefined && eventMax === lastActivityMs
        ? events.find((e) => parseIsoMs(e.created_at) === eventMax)?.created_at
        : updatedMs === lastActivityMs
          ? run.updated_at
          : run.created_at;
  }

  let error = run.error;
  if (!error) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && (e.event_type === "run.error" || e.event_type === "llm.error")) {
        error = typeof e.content === "string" ? e.content : JSON.stringify(e.content ?? "");
        break;
      }
    }
  }

  const webUrl = `${opts.baseUrl}/workspace/chats/${run.thread_id}`;
  const hasStopReason = run.stop_reason !== null && run.stop_reason !== undefined;
  const needsNextStep = !terminal && (quiet || stalled || error !== undefined || hasStopReason);
  let nextStep: string | undefined;
  if (needsNextStep) {
    const lead =
      secondsSinceActivity !== undefined
        ? `Quiet for ${secondsSinceActivity}s`
        : "No recent activity";
    nextStep = `${lead} while the run is still "${run.status}" — keep waiting, or open ${webUrl} to check, or stop it with deerflow_cancel_run.`;
  }

  return {
    run_id: run.run_id,
    thread_id: run.thread_id,
    status: run.status,
    stop_reason: run.stop_reason ?? null,
    terminal,
    created_at: run.created_at,
    updated_at: run.updated_at,
    elapsed_seconds: elapsedSeconds,
    ...(secondsSinceUpdate !== undefined ? { seconds_since_update: secondsSinceUpdate } : {}),
    ...(run.total_tokens !== undefined ? { total_tokens: run.total_tokens } : {}),
    ...(run.llm_call_count !== undefined ? { llm_call_count: run.llm_call_count } : {}),
    ...(run.message_count !== undefined ? { message_count: run.message_count } : {}),
    ...(lastEventSeq !== undefined ? { last_event_seq: lastEventSeq } : {}),
    ...(lastActivityAt !== undefined ? { last_activity_at: lastActivityAt } : {}),
    ...(secondsSinceActivity !== undefined ? { seconds_since_activity: secondsSinceActivity } : {}),
    quiet,
    stalled,
    ...(stalled
      ? {
          hint: `No activity for ${secondsSinceActivity}s while status is still "${run.status}". The run may be stuck on a long tool call or on a dead worker — open ${webUrl} to check, or stop it with deerflow_cancel_run.`,
        }
      : {}),
    ...(nextStep !== undefined ? { next_step: nextStep } : {}),
    ...(error ? { error: truncate(error, 500) } : {}),
    activity,
    todos,
  };
}

/**
 * Build a {@link RunActivityWaitResult} from a progress snapshot.
 *
 * When the wait timed out with no activity and no quiet/stalled/error signal,
 * a compact object is returned (no duplicated timestamps/snapshot) carrying
 * `status`, counters, `last_event_seq`, and a `next_step`. Otherwise the full
 * snapshot is returned. A `timeout` reason always carries a `next_step`. A
 * `stop_reason: "cancelled_by_client"` (client abort) always yields the full
 * snapshot.
 */
export function buildWaitResult(
  progress: RunProgress,
  reason: ActivityWaitReason,
  waitedSeconds: number,
  timeoutSeconds: number,
  baseUrl: string,
  extra?: Partial<RunActivityWaitResult>
): RunActivityWaitResult {
  const webUrl = `${baseUrl}/workspace/chats/${progress.thread_id}`;
  let nextStep = progress.next_step;
  if (reason === "timeout" && !nextStep) {
    nextStep = `No new activity within ${timeoutSeconds}s — call deerflow_wait_activity again (pass last_event_seq as since_seq) to keep waiting, or open ${webUrl} to check, or stop it with deerflow_cancel_run.`;
  }
  const cancelled = extra?.stop_reason === "cancelled_by_client";
  const compact =
    reason === "timeout" &&
    !cancelled &&
    progress.activity.length === 0 &&
    !progress.quiet &&
    !progress.stalled &&
    !progress.error;
  if (compact) {
    return {
      run_id: progress.run_id,
      thread_id: progress.thread_id,
      status: progress.status,
      terminal: progress.terminal,
      elapsed_seconds: progress.elapsed_seconds,
      ...(progress.seconds_since_activity !== undefined
        ? { seconds_since_activity: progress.seconds_since_activity }
        : {}),
      ...(progress.total_tokens !== undefined ? { total_tokens: progress.total_tokens } : {}),
      ...(progress.llm_call_count !== undefined ? { llm_call_count: progress.llm_call_count } : {}),
      ...(progress.message_count !== undefined ? { message_count: progress.message_count } : {}),
      ...(progress.last_event_seq !== undefined ? { last_event_seq: progress.last_event_seq } : {}),
      quiet: false,
      stalled: false,
      ...(nextStep !== undefined ? { next_step: nextStep } : {}),
      activity: [],
      todos: progress.todos,
      reason,
      waited_seconds: waitedSeconds,
      timeout_seconds: timeoutSeconds,
    };
  }
  return {
    ...progress,
    ...(nextStep !== undefined ? { next_step: nextStep } : {}),
    ...(extra ?? {}),
    reason,
    waited_seconds: waitedSeconds,
    timeout_seconds: timeoutSeconds,
  };
}

/** The event fields `composeProgress` needs (a structural subset of RawRunEvent). */
type RawRunActivityLike = Pick<RawRunEvent, "seq" | "event_type" | "content" | "created_at"> &
  Partial<RawRunEvent>;

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
