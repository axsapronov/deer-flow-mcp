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
}

/** A file produced by a run, addressable via the artifacts endpoint. */
export interface ArtifactRef {
  path: string;
}

/** The synthesized final report for a completed run. */
export interface Report {
  report: string;
  title?: string | null;
  summary_text?: string | null;
  artifacts: string[];
  web_url: string;
}

/** A configured model (from `GET /api/models`). */
export interface ModelInfo {
  name: string;
  display_name?: string | null;
  description?: string | null;
  supports_thinking?: boolean;
  supports_reasoning_effort?: boolean;
}

/** How the server authenticates to DeerFlow. */
export type DeerFlowAuth =
  { kind: "pat"; token: string } | { kind: "internal"; token: string; ownerUserId?: string };

/** Fully-resolved server configuration. */
export interface DeerFlowConfig {
  baseUrl: string;
  webBaseUrl: string;
  auth: DeerFlowAuth;
  defaultModel?: string;
  defaultRecursionLimit: number;
  timeoutMs: number;
}
