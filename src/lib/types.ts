/**
 * Shared types for the DeerFlow MCP server.
 */

/** Lifecycle status of a single DeerFlow run (mirrors backend `RunStatus`). */
export type RunStatus = "pending" | "running" | "success" | "error" | "timeout" | "interrupted";

/** Run statuses that mean the run has stopped and will not change again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  "success",
  "error",
  "timeout",
  "interrupted",
] as const;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** A lightweight summary of a DeerFlow thread (from `POST /api/threads/search`). */
export interface ThreadSummary {
  thread_id: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  title?: string;
}

/** A single run's status snapshot (from `GET /api/threads/{id}/runs/{run_id}`). */
export interface RunInfo {
  run_id: string;
  thread_id: string;
  status: RunStatus;
  error?: string;
  stop_reason?: string | null;
  created_at?: string;
  updated_at?: string;
  /** Total tokens consumed so far (advances while the run is working). */
  total_tokens?: number;
  /** Input (prompt) tokens consumed so far. */
  total_input_tokens?: number;
  /** Output (completion) tokens consumed so far. */
  total_output_tokens?: number;
  /** Tokens attributed to the lead agent. */
  lead_agent_tokens?: number;
  /** Tokens attributed to subagents. */
  subagent_tokens?: number;
  /** Tokens attributed to middleware. */
  middleware_tokens?: number;
  /** Number of LLM calls made so far (advances while the run is working). */
  llm_call_count?: number;
  /** Number of persisted messages so far (advances while the run is working). */
  message_count?: number;
}

/** A plan-mode task from the thread state's `todos` channel. */
export interface TodoItem {
  content: string;
  status: string;
}

/**
 * A compact, displayable summary of one persisted run event (from
 * `GET /api/threads/{id}/runs/{run_id}/events`).
 */
export interface RunEventSummary {
  seq: number;
  /** Event timestamp (ISO 8601). */
  at?: string;
  kind: "ai" | "tool" | "error" | "warning" | "other";
  /** One-line description, e.g. `web_search("vLLM v0.25.0 ...") -> 10 results`. */
  summary: string;
}

/**
 * A live progress snapshot for a run, composed from the run row (counters +
 * timestamps), the run event stream (latest activity), and the thread state
 * (plan-mode todo checklist).
 */
export interface RunProgress {
  run_id: string;
  thread_id: string;
  status: RunStatus;
  stop_reason?: string | null;
  terminal: boolean;
  created_at?: string;
  updated_at?: string;
  /** Seconds since the run was created. */
  elapsed_seconds: number;
  /** Seconds since the run row was last updated (progress-snapshot heartbeat). */
  seconds_since_update?: number;
  total_tokens?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  lead_agent_tokens?: number;
  subagent_tokens?: number;
  middleware_tokens?: number;
  llm_call_count?: number;
  message_count?: number;
  /** Highest event seq observed (pass back as `since_seq` to get only new events). */
  last_event_seq?: number;
  /** Timestamp of the most recent activity signal (event or run update). */
  last_activity_at?: string;
  /** Seconds since the most recent activity signal. */
  seconds_since_activity?: number;
  /** True when a non-terminal run has had no activity for longer than the quiet threshold. */
  quiet: boolean;
  /** True when a non-terminal run has had no activity for longer than the stall threshold. */
  stalled: boolean;
  /** Human hint explaining a stalled run, present only when `stalled` is true. */
  hint?: string;
  /**
   * Human next-step suggestion, present whenever the run needs attention:
   * `quiet`/`stalled`, an `error`/`stop_reason`, or (for `wait_activity`) a
   * `timeout` reason. Points at the web UI and the cancel tool.
   */
  next_step?: string;
  /** Error text from the run row or a `run.error`/`llm.error` event, when present. */
  error?: string;
  /** Recent activity, oldest first (delta mode: only events after `since_seq`). */
  activity: RunEventSummary[];
  /** Plan-mode checklist from the thread state (empty when plan mode is off). */
  todos: TodoItem[];
}

/** Why a `waitForActivity` long-poll returned. */
export type ActivityWaitReason = "terminal" | "activity" | "timeout";

/** The result of a `waitForActivity` long-poll. */
export interface RunActivityWaitResult extends RunProgress {
  reason: ActivityWaitReason;
  /** Seconds the server-side poll actually waited. */
  waited_seconds: number;
  /** The effective wait budget in seconds (requested timeout, capped server-side). */
  timeout_seconds: number;
}

/** A file produced by a run, addressable via the artifacts endpoint. */
export interface ArtifactRef {
  path: string;
}

/** Where the report text came from in the resolution chain. */
export type ReportSource = "run-messages" | "state-messages" | "summary" | "artifact";

/** The synthesized final report for a completed run. */
export interface Report {
  report: string;
  title?: string | null;
  summary_text?: string | null;
  artifacts: string[];
  web_url: string;
  /** Terminal status of the run (present when a run_id was supplied). */
  terminal?: boolean;
  /** The run's status (present when a run_id was supplied). */
  run_status?: RunStatus;
  /** Where the report text came from (present when non-empty). */
  report_source?: ReportSource;
  /** Note explaining an auto-inlined artifact report (present when report_source === "artifact"). */
  artifact_note?: string;
}

/** Per-model token breakdown for a thread (from `/api/threads/{id}/token-usage`). */
export interface TokenUsageByModel {
  tokens: number;
  runs: number;
}

/** Per-caller token breakdown for a thread. */
export interface TokenUsageByCaller {
  lead_agent: number;
  subagent: number;
  middleware: number;
}

/** Context-window usage for the most recent run of a thread. */
export interface TokenUsageContext {
  token_count: number;
  max_context_tokens: number | null;
  percentage: number | null;
}

/**
 * Aggregate token usage for a thread (from
 * `GET /api/threads/{id}/token-usage?include_active=true`).
 */
export interface TokenUsage {
  thread_id: string;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_runs: number;
  by_model: Record<string, TokenUsageByModel>;
  by_caller: TokenUsageByCaller;
  context_usage: TokenUsageContext | null;
}

/** A configured model (from `GET /api/models`). */
export interface ModelInfo {
  name: string;
  display_name?: string | null;
  description?: string | null;
  supports_thinking?: boolean;
  supports_reasoning_effort?: boolean;
}

/**
 * How the server authenticates to DeerFlow.
 *
 * `session` is email + password: the client logs in like the web UI
 * (`POST /api/v1/auth/login/local`) and carries the resulting session cookie.
 */
export type DeerFlowAuth =
  | { kind: "session"; email: string; password: string }
  | { kind: "pat"; token: string }
  | { kind: "internal"; token: string; ownerUserId?: string };

/** Fully-resolved server configuration. */
export interface DeerFlowConfig {
  baseUrl: string;
  webBaseUrl: string;
  auth: DeerFlowAuth;
  defaultModel?: string;
  defaultRecursionLimit: number;
  timeoutMs: number;
  /** Seconds without any activity signal before a running run is reported as stalled. */
  stallThresholdSeconds: number;
  /**
   * Seconds without any activity signal before a running run is reported as
   * "quiet" (a softer signal than `stalled`: the run is likely just between
   * steps, not stuck).
   */
  quietThresholdSeconds: number;
  /** Upper bound (seconds) for the `deerflow_wait_activity` timeout parameter. */
  progressWaitMaxSeconds: number;
  /** How often (ms) to emit a `notifications/progress` update during a long wait. */
  progressTickMs: number;
  /** How often (ms) the client polls the DeerFlow API while waiting. */
  pollIntervalMs: number;
}
