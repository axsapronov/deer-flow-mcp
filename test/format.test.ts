import { describe, it, expect } from "vitest";
import { formatProgress, formatRunStatus, formatTokenUsage } from "../src/lib/format.js";
import type { RunActivityWaitResult, RunProgress, TokenUsage } from "../src/lib/types.js";

describe("formatRunStatus", () => {
  it("renders status, elapsed, tokens, and counters", () => {
    const text = formatRunStatus({
      run_id: "3344f693",
      status: "running",
      elapsed_seconds: 34,
      total_tokens: 40418,
      total_input_tokens: 12345,
      total_output_tokens: 28073,
      llm_call_count: 2,
      message_count: 4,
    });
    expect(text).toBe(
      "Run 3344f693 — running (elapsed 34s) · 40,418 tokens (12,345 in / 28,073 out) · 2 LLM calls · 4 messages"
    );
  });

  it("omits missing fields", () => {
    expect(formatRunStatus({ run_id: "r-1", status: "success" })).toBe("Run r-1 — success");
  });

  it("renders total tokens without the in/out split when only total is present", () => {
    expect(formatRunStatus({ run_id: "r-1", status: "error", total_tokens: 1000 })).toBe(
      "Run r-1 — error · 1,000 tokens"
    );
  });
});

describe("formatProgress", () => {
  const base: RunProgress = {
    run_id: "r-1",
    thread_id: "t-1",
    status: "running",
    terminal: false,
    elapsed_seconds: 120,
    total_tokens: 40418,
    total_input_tokens: 12345,
    total_output_tokens: 28073,
    lead_agent_tokens: 30000,
    subagent_tokens: 8000,
    middleware_tokens: 2418,
    llm_call_count: 2,
    message_count: 4,
    todos: [
      { content: "Gather vLLM release history", status: "completed" },
      { content: "Deep-dive most recent releases", status: "in_progress" },
      { content: "Cross-check with secondary sources", status: "pending" },
      { content: "Write full Markdown report", status: "pending" },
    ],
    activity: [
      { seq: 1, kind: "tool", summary: "web_search → 10 results" },
      { seq: 2, kind: "other", summary: "subagent[call_1] tool_name: reading releases.md" },
    ],
    quiet: false,
    stalled: false,
  };

  it("renders the full legible layout", () => {
    expect(formatProgress(base)).toBe(
      [
        "DeerFlow run r-1 — running · elapsed 120s",
        "  Tokens: 40,418 total (12,345 in / 28,073 out) · LLM calls: 2 · messages: 4",
        "  Caller: lead 30,000 · subagent 8,000 · middleware 2,418",
        '  Plan: 1/4 done — now: "Deep-dive most recent releases"',
        "    [x] Gather vLLM release history",
        "    [>] Deep-dive most recent releases",
        "    [ ] Cross-check with secondary sources",
        "    [ ] Write full Markdown report",
        "  Activity (last 2):",
        "    · web_search → 10 results",
        "    · subagent[call_1] tool_name: reading releases.md",
      ].join("\n")
    );
  });

  it("shows 'completed in Xs' for a terminal run", () => {
    const text = formatProgress({
      ...base,
      status: "success",
      terminal: true,
      elapsed_seconds: 90,
    });
    expect(text.split("\n")[0]).toBe("DeerFlow run r-1 — success · completed in 90s");
  });

  it("omits the caller/plan/activity lines when they are empty", () => {
    const text = formatProgress({
      ...base,
      lead_agent_tokens: 0,
      subagent_tokens: 0,
      middleware_tokens: 0,
      activity: [],
      todos: [],
    });
    expect(text).not.toContain("Caller:");
    expect(text).not.toContain("Plan:");
    expect(text).not.toContain("Activity");
  });

  it("renders quiet, error, and next_step signals", () => {
    const text = formatProgress({
      ...base,
      activity: [],
      todos: [],
      quiet: true,
      seconds_since_activity: 90,
      error: "Recursion limit exceeded",
      next_step: 'Quiet for 90s while the run is still "running" — keep waiting.',
    });
    expect(text).toContain("Quiet for 90s");
    expect(text).toContain("Error: Recursion limit exceeded");
    expect(text).toContain("Next: Quiet for 90s while the run is still");
  });

  it("renders the STALLED line (not Quiet) when stalled", () => {
    const text = formatProgress({
      ...base,
      activity: [],
      todos: [],
      quiet: true,
      stalled: true,
      seconds_since_activity: 300,
      hint: 'No activity for 300s while status is still "running".',
    });
    expect(text).toContain("STALLED: No activity for 300s");
    expect(text).not.toContain("Quiet for 300s");
  });

  it("renders a timeout Wait line on a waitForActivity result", () => {
    const wait: RunActivityWaitResult = {
      ...base,
      activity: [],
      todos: [],
      reason: "timeout",
      waited_seconds: 30,
      timeout_seconds: 30,
    };
    expect(formatProgress(wait)).toContain("Wait: timed out after 30s (no new activity)");
  });

  it("renders an activity Wait line on a waitForActivity result", () => {
    const wait: RunActivityWaitResult = {
      ...base,
      reason: "activity",
      waited_seconds: 5,
      timeout_seconds: 30,
    };
    expect(formatProgress(wait)).toContain("Wait: new activity after 5s");
  });
});

describe("formatTokenUsage", () => {
  const usage: TokenUsage = {
    thread_id: "t-1",
    total_tokens: 128410,
    total_input_tokens: 90000,
    total_output_tokens: 38410,
    total_runs: 3,
    by_model: { "gpt-x": { tokens: 100000, runs: 2 }, "claude-3-7": { tokens: 28410, runs: 1 } },
    by_caller: { lead_agent: 100000, subagent: 20000, middleware: 8410 },
    context_usage: { token_count: 124000, max_context_tokens: 200000, percentage: 62 },
  };

  it("renders the header, by-model, and by-caller lines", () => {
    expect(formatTokenUsage(usage)).toBe(
      [
        "Tokens (thread t-1): 128,410 total (90,000 in / 38,410 out) across 3 runs · context 62% (124K/200K)",
        "  By model: gpt-x 100,000 (2 runs) · claude-3-7 28,410 (1 run)",
        "  By caller: lead 100,000 · subagent 20,000 · middleware 8,410",
      ].join("\n")
    );
  });

  it("omits the context and breakdown lines when absent", () => {
    const text = formatTokenUsage({
      ...usage,
      by_model: {},
      by_caller: { lead_agent: 0, subagent: 0, middleware: 0 },
      context_usage: null,
    });
    expect(text).toBe("Tokens (thread t-1): 128,410 total (90,000 in / 38,410 out) across 3 runs");
  });

  it("uses the singular 'run' for a single run", () => {
    const text = formatTokenUsage({
      ...usage,
      total_runs: 1,
      by_model: {},
      by_caller: { lead_agent: 0, subagent: 0, middleware: 0 },
      context_usage: null,
    });
    expect(text).toContain("across 1 run");
  });
});
