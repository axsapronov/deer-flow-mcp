/**
 * Human-readable text builders for the MCP tool `content` blocks. These turn
 * the machine-readable progress/run/token shapes into the legible, multi-line
 * output the DeerFlow web UI shows, while the full object is still returned as
 * `structuredContent` for programmatic clients.
 *
 * Every builder is pure and defensive: it only renders the fields that are
 * present, so a partial response degrades to fewer lines rather than throwing.
 */

import type { RunActivityWaitResult, RunProgress, RunStatus, TokenUsage } from "./types.js";

/**
 * The subset of a run row that {@link formatRunStatus} renders. `elapsed_seconds`
 * is computed by the caller from the run row's `created_at` timestamp.
 */
export interface RunStatusView {
  run_id: string;
  status: RunStatus;
  elapsed_seconds?: number;
  total_tokens?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  llm_call_count?: number;
  message_count?: number;
}

/** Format a non-negative integer with thousands separators (e.g. 40418 → "40,418"). */
function formatInt(value: number): string {
  return Math.trunc(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Compact K-format for context-window sizes (e.g. 125000 → "125K", 200000 → "200K"). */
function formatK(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  const rounded = k >= 100 ? Math.round(k) : Math.round(k * 10) / 10;
  return `${rounded}K`;
}

/**
 * One-line human summary of a run's status row, e.g.
 * `Run 3344f693 — running (elapsed 34s) · 40,418 tokens (12,345 in / 28,073 out) · 2 LLM calls · 4 messages`.
 */
export function formatRunStatus(run: RunStatusView): string {
  const head =
    run.elapsed_seconds !== undefined
      ? `${run.status} (elapsed ${run.elapsed_seconds}s)`
      : run.status;
  const segments: string[] = [`Run ${run.run_id} — ${head}`];

  const stats: string[] = [];
  if (run.total_tokens !== undefined) {
    let tokens = `${formatInt(run.total_tokens)} tokens`;
    if (run.total_input_tokens !== undefined || run.total_output_tokens !== undefined) {
      const inn = run.total_input_tokens !== undefined ? formatInt(run.total_input_tokens) : "?";
      const out = run.total_output_tokens !== undefined ? formatInt(run.total_output_tokens) : "?";
      tokens = `${tokens} (${inn} in / ${out} out)`;
    }
    stats.push(tokens);
  }
  if (run.llm_call_count !== undefined) stats.push(`${run.llm_call_count} LLM calls`);
  if (run.message_count !== undefined) stats.push(`${run.message_count} messages`);
  if (stats.length > 0) segments.push(stats.join(" · "));

  return segments.join(" · ");
}

/** True when the progress snapshot is actually a `waitForActivity` result. */
function isWaitResult(p: RunProgress | RunActivityWaitResult): p is RunActivityWaitResult {
  return (p as RunActivityWaitResult).reason !== undefined;
}

/** The trailing "Wait:" line, only present on a {@link RunActivityWaitResult}. */
function waitLine(p: RunActivityWaitResult): string {
  switch (p.reason) {
    case "terminal":
      return `Wait: run reached terminal status (${p.status}) after ${p.waited_seconds}s`;
    case "activity":
      return `Wait: new activity after ${p.waited_seconds}s`;
    case "timeout":
      return p.activity.length > 0
        ? `Wait: timed out after ${p.timeout_seconds}s`
        : `Wait: timed out after ${p.timeout_seconds}s (no new activity)`;
    default:
      return `Wait: ${p.reason}`;
  }
}

/**
 * Multi-line, legible rendering of a run's live progress (or a
 * `waitForActivity` result). Mirrors the DeerFlow web UI: a status header with
 * elapsed time, a token/LLM/message line, an optional caller split, the
 * plan-mode todo checklist with live per-item markers, the recent activity
 * feed, and quiet/stall/error/next-step signals.
 */
export function formatProgress(p: RunProgress | RunActivityWaitResult): string {
  const lines: string[] = [];

  // Header: status + elapsed (or completion) time.
  const timePart = p.terminal
    ? `completed in ${p.elapsed_seconds}s`
    : `elapsed ${p.elapsed_seconds}s`;
  lines.push(`DeerFlow run ${p.run_id} — ${p.status} · ${timePart}`);

  // Token / LLM-call / message line (only the parts that exist).
  const stats: string[] = [];
  if (p.total_tokens !== undefined) {
    let tokens = `${formatInt(p.total_tokens)} total`;
    if (p.total_input_tokens !== undefined || p.total_output_tokens !== undefined) {
      const inn = p.total_input_tokens !== undefined ? formatInt(p.total_input_tokens) : "?";
      const out = p.total_output_tokens !== undefined ? formatInt(p.total_output_tokens) : "?";
      tokens = `${tokens} (${inn} in / ${out} out)`;
    }
    stats.push(`Tokens: ${tokens}`);
  }
  if (p.llm_call_count !== undefined) stats.push(`LLM calls: ${p.llm_call_count}`);
  if (p.message_count !== undefined) stats.push(`messages: ${p.message_count}`);
  if (stats.length > 0) lines.push(`  ${stats.join(" · ")}`);

  // Caller split (only when at least one bucket is non-zero).
  const caller: string[] = [];
  if ((p.lead_agent_tokens ?? 0) > 0) caller.push(`lead ${formatInt(p.lead_agent_tokens!)}`);
  if ((p.subagent_tokens ?? 0) > 0) caller.push(`subagent ${formatInt(p.subagent_tokens!)}`);
  if ((p.middleware_tokens ?? 0) > 0) caller.push(`middleware ${formatInt(p.middleware_tokens!)}`);
  if (caller.length > 0) lines.push(`  Caller: ${caller.join(" · ")}`);

  // Plan-mode checklist with live per-item status markers.
  if (p.todos.length > 0) {
    const completed = p.todos.filter((t) => t.status === "completed").length;
    const inProgress = p.todos.find((t) => t.status === "in_progress");
    const head = `Plan: ${completed}/${p.todos.length} done`;
    lines.push(inProgress ? `  ${head} — now: "${inProgress.content}"` : `  ${head}`);
    for (const t of p.todos) {
      const marker = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
      lines.push(`    ${marker} ${t.content}`);
    }
  }

  // Recent activity feed.
  if (p.activity.length > 0) {
    lines.push(`  Activity (last ${p.activity.length}):`);
    for (const a of p.activity) lines.push(`    · ${a.summary}`);
  }

  // Quiet / stalled / error / next-step signals.
  if (p.stalled && p.hint) {
    lines.push(`  STALLED: ${p.hint}`);
  } else if (p.quiet && p.seconds_since_activity !== undefined) {
    lines.push(`  Quiet for ${p.seconds_since_activity}s`);
  }
  if (p.error) lines.push(`  Error: ${p.error}`);
  if (p.next_step) lines.push(`  Next: ${p.next_step}`);

  // Wait outcome (only on a waitForActivity result).
  if (isWaitResult(p)) lines.push(`  ${waitLine(p)}`);

  return lines.join("\n");
}

/**
 * Multi-line rendering of a thread-level token-usage aggregate: a header with
 * total/input/output, run count, and context-window fill, followed by
 * per-model and per-caller breakdowns when non-trivial.
 */
export function formatTokenUsage(u: TokenUsage): string {
  const lines: string[] = [];
  const runs = `${u.total_runs} run${u.total_runs === 1 ? "" : "s"}`;
  let header = `Tokens (thread ${u.thread_id}): ${formatInt(u.total_tokens)} total (${formatInt(
    u.total_input_tokens
  )} in / ${formatInt(u.total_output_tokens)} out) across ${runs}`;

  const ctx = u.context_usage;
  if (ctx) {
    const pct = ctx.percentage !== null ? `${Math.round(ctx.percentage)}%` : null;
    const maxK = ctx.max_context_tokens !== null ? formatK(ctx.max_context_tokens) : null;
    const ctxText =
      pct !== null && maxK !== null
        ? `context ${pct} (${formatK(ctx.token_count)}/${maxK})`
        : pct !== null
          ? `context ${pct}`
          : `context ${formatK(ctx.token_count)}`;
    header = `${header} · ${ctxText}`;
  }
  lines.push(header);

  const models = Object.entries(u.by_model);
  if (models.length > 0) {
    lines.push(
      `  By model: ${models
        .map(
          ([name, m]) => `${name} ${formatInt(m.tokens)} (${m.runs} run${m.runs === 1 ? "" : "s"})`
        )
        .join(" · ")}`
    );
  }

  const c = u.by_caller;
  const caller: string[] = [];
  if (c.lead_agent > 0) caller.push(`lead ${formatInt(c.lead_agent)}`);
  if (c.subagent > 0) caller.push(`subagent ${formatInt(c.subagent)}`);
  if (c.middleware > 0) caller.push(`middleware ${formatInt(c.middleware)}`);
  if (caller.length > 0) lines.push(`  By caller: ${caller.join(" · ")}`);

  return lines.join("\n");
}
