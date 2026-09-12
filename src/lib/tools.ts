import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { DeerFlowClient, DeerFlowError, type ArtifactResult } from "./client.js";
import { isTerminalRunStatus, type Report, type RunStatus } from "./types.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown): ToolResult {
  const message =
    err instanceof DeerFlowError
      ? err.message
      : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return {
    content: [{ type: "text" as const, text: `DeerFlow error: ${message}` }],
    isError: true,
  };
}

/**
 * Wrap a tool body so any failure becomes a clean, credential-free tool error
 * result instead of an unhandled exception.
 */
function withTool(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  return (async () => {
    try {
      return await fn();
    } catch (err) {
      return errorResult(err);
    }
  })();
}

function parseIsoMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Register the DeerFlow toolset on an MCP server. Each tool is a thin wrapper
 * over a {@link DeerFlowClient} method.
 */
export function registerTools(server: McpServer, client: DeerFlowClient): void {
  server.registerTool(
    "deerflow_research",
    {
      title: "Start Deep Research",
      description:
        "Kick off a long-running deep-research run on a fresh DeerFlow thread. Returns immediately with the thread/run ids and a web URL; poll deerflow_run_status until it reaches a terminal status, then call deerflow_get_report to read the findings. Deep research takes minutes to ~45 minutes and never blocks this call.",
      inputSchema: z.object({
        topic: z.string().describe("The research topic or question to investigate in depth."),
        focus: z
          .string()
          .optional()
          .describe(
            "Optional one-line constraint to fold into the brief (e.g. 'focus on the EU')."
          ),
        model: z
          .string()
          .optional()
          .describe("Optional DeerFlow model name (see deerflow_list_models)."),
        recursion_limit: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe("Optional agent recursion budget for this run (default 1000)."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    (args) =>
      withTool(async () => {
        const result = await client.research(args.topic, {
          focus: args.focus,
          model: args.model,
          recursionLimit: args.recursion_limit,
        });
        return textResult(`Deep research started.\n${JSON.stringify(result, null, 2)}`);
      })
  );

  server.registerTool(
    "deerflow_chat",
    {
      title: "Send Chat Message",
      description:
        "Send a message to a DeerFlow thread and start a run. Omit thread_id to create a new thread, or pass an existing thread_id to continue a conversation. Returns immediately with the thread/run ids and a web URL; poll deerflow_run_status, then deerflow_get_report.",
      inputSchema: z.object({
        message: z.string().describe("The message to send to the DeerFlow agent."),
        thread_id: z
          .string()
          .optional()
          .describe("Existing thread id to continue. Omit to start a new thread."),
        model: z.string().optional().describe("Optional DeerFlow model name."),
        recursion_limit: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe("Optional agent recursion budget for this run (default 1000)."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    (args) =>
      withTool(async () => {
        const result = await client.chat(args.message, {
          threadId: args.thread_id,
          model: args.model,
          recursionLimit: args.recursion_limit,
        });
        return textResult(`Chat run started.\n${JSON.stringify(result, null, 2)}`);
      })
  );

  server.registerTool(
    "deerflow_run_status",
    {
      title: "Get Run Status",
      description:
        "Check the status of a DeerFlow run. Optionally wait up to wait_seconds (capped at 30s) for it to reach a terminal status before returning, to reduce polling round-trips. Terminal statuses: success, error, timeout, interrupted. Also returns live counters (llm_call_count, message_count, total_tokens) and elapsed/last-update times: the counters advance while the run is working, so if they stop moving for several minutes the run may be stalled — use deerflow_run_progress or deerflow_wait_activity for event-level detail.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
        run_id: z.string().describe("The run id."),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(30)
          .optional()
          .describe("Seconds to poll for a terminal status before returning (0 = check once)."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const run = await client.waitForRun(args.thread_id, args.run_id, args.wait_seconds ?? 0);
        const now = Date.now();
        const out: Record<string, unknown> = {
          thread_id: run.thread_id,
          run_id: run.run_id,
          status: run.status,
          stop_reason: run.stop_reason ?? null,
          terminal: isTerminalRunStatus(run.status),
        };
        const createdMs = parseIsoMs(run.created_at);
        const updatedMs = parseIsoMs(run.updated_at);
        if (createdMs !== undefined)
          out.elapsed_seconds = Math.max(0, Math.round((now - createdMs) / 1000));
        if (updatedMs !== undefined) {
          out.updated_at = run.updated_at;
          out.seconds_since_update = Math.max(0, Math.round((now - updatedMs) / 1000));
        }
        if (run.llm_call_count !== undefined) out.llm_call_count = run.llm_call_count;
        if (run.message_count !== undefined) out.message_count = run.message_count;
        if (run.total_tokens !== undefined) out.total_tokens = run.total_tokens;
        if (run.error) out.error = run.error;
        return textResult(JSON.stringify(out, null, 2));
      })
  );

  server.registerTool(
    "deerflow_run_progress",
    {
      title: "Get Run Progress",
      description:
        "Get live progress for a DeerFlow run: status + live counters (llm_call_count, message_count, total_tokens), recent activity (the latest events as one-line summaries, e.g. tool calls and their results), the plan-mode todo checklist, and stall detection (stalled: true when no activity for longer than the configured threshold while the run is still running, with a hint). Pass since_seq (the last_event_seq from a previous response) to return only new events. Requires session or internal-token auth: the event stream and thread state are not reachable with a Personal Access Token.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
        run_id: z.string().describe("The run id."),
        since_seq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Only include events with seq greater than this (delta mode; use last_event_seq from a previous response)."
          ),
        activity_limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum recent events to summarize (default 10)."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const progress = await client.getProgress(args.thread_id, args.run_id, {
          sinceSeq: args.since_seq,
          activityLimit: args.activity_limit,
        });
        return textResult(JSON.stringify(progress, null, 2));
      })
  );

  server.registerTool(
    "deerflow_wait_activity",
    {
      title: "Wait for Run Activity",
      description:
        "Block server-side until the run produces new activity, reaches a terminal status, or the timeout elapses — one call replaces many status polls (the server re-checks the event stream every few seconds). Returns reason ('terminal' | 'activity' | 'timeout'), waited_seconds, the new activity since since_seq (one-line summaries), the plan-mode todo checklist, and stall detection. Pass the returned last_event_seq as since_seq on the next call to continue from where you left off. Requires session or internal-token auth.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
        run_id: z.string().describe("The run id."),
        since_seq: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Only report events with seq greater than this (use last_event_seq from a previous response; 0 or omitted = latest events)."
          ),
        timeout_seconds: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe("Maximum seconds to wait before returning (default 30, capped server-side)."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const result = await client.waitForActivity(args.thread_id, args.run_id, {
          sinceSeq: args.since_seq,
          timeoutSeconds: args.timeout_seconds,
        });
        return textResult(JSON.stringify(result, null, 2));
      })
  );

  server.registerTool(
    "deerflow_get_report",
    {
      title: "Get Report",
      description:
        "Fetch the synthesized report for a DeerFlow thread: the most recent assistant message, its title, and any produced artifact file paths. Call after a run reaches a terminal status. Optionally pass run_id to scope the report to a specific run.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
        run_id: z
          .string()
          .optional()
          .describe("Optional run id to scope the report to a specific run."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const report = await client.getReport(args.thread_id, args.run_id);
        return textResult(formatReport(report));
      })
  );

  server.registerTool(
    "deerflow_list_threads",
    {
      title: "List Threads",
      description:
        "List recent DeerFlow threads (id, title, status, timestamps). Use the returned thread_id with deerflow_chat to continue a conversation or deerflow_get_report to read a finished one.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum threads to return (default 20)."),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include archived threads (default false)."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const threads = await client.searchThreads({
          limit: args.limit ?? 20,
          archived: args.include_archived,
        });
        return textResult(JSON.stringify({ threads }, null, 2));
      })
  );

  server.registerTool(
    "deerflow_cancel_run",
    {
      title: "Cancel Run",
      description: "Cancel an in-flight DeerFlow run (interrupts it). Returns the accepted status.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
        run_id: z.string().describe("The run id to cancel."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        await client.cancelRun(args.thread_id, args.run_id);
        const result = {
          thread_id: args.thread_id,
          run_id: args.run_id,
          status: "interrupted" as RunStatus,
        };
        return textResult(JSON.stringify(result, null, 2));
      })
  );

  server.registerTool(
    "deerflow_list_artifacts",
    {
      title: "List Artifacts",
      description:
        "List the artifact file paths produced by a DeerFlow thread (e.g. reports, generated files). Pass a path to deerflow_get_artifact to read its content.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const artifacts = await client.listArtifacts(args.thread_id);
        return textResult(JSON.stringify({ artifacts }, null, 2));
      })
  );

  server.registerTool(
    "deerflow_get_artifact",
    {
      title: "Get Artifact",
      description:
        "Fetch a single artifact file from a DeerFlow thread. Text-like files (markdown, json, csv, plain text) are returned inline as content; binary files return a URL reference instead. Note: with a Personal Access Token this endpoint is not in the PAT route allowlist — an internal token is required.",
      inputSchema: z.object({
        thread_id: z.string().describe("The thread id."),
        path: z
          .string()
          .describe(
            "The artifact path, as listed by deerflow_list_artifacts (e.g. 'mnt/user-data/outputs/report.md')."
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    (args) =>
      withTool(async () => {
        const artifact = await client.getArtifact(args.thread_id, args.path);
        return textResult(formatArtifact(artifact));
      })
  );

  server.registerTool(
    "deerflow_list_models",
    {
      title: "List Models",
      description:
        "List the models configured on the DeerFlow instance (name, display name, and capability flags). Use a returned name for the model argument of deerflow_research / deerflow_chat. Note: with a Personal Access Token this endpoint is not in the PAT route allowlist — an internal token is required.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    () =>
      withTool(async () => {
        const models = await client.listModels();
        return textResult(JSON.stringify({ models }, null, 2));
      })
  );
}

function formatReport(report: Report): string {
  const lines: string[] = [];
  lines.push(`# ${report.title?.trim() || "Report"}`);
  lines.push("");
  if (report.report) {
    lines.push(report.report);
  } else {
    lines.push(
      "(No assistant message yet — the run may still be in progress or produced no final text.)"
    );
  }
  if (report.artifacts.length > 0) {
    lines.push("");
    lines.push("Artifacts:");
    for (const path of report.artifacts) lines.push(`- ${path}`);
  }
  lines.push("");
  lines.push(`Web: ${report.web_url}`);
  return lines.join("\n");
}

function formatArtifact(artifact: ArtifactResult): string {
  if (artifact.content !== undefined) {
    const header = artifact.contentType
      ? `# ${artifact.path} (${artifact.contentType})`
      : `# ${artifact.path}`;
    return `${header}\n\n${artifact.content}`;
  }
  return JSON.stringify(
    {
      path: artifact.path,
      url: artifact.url,
      content_type: artifact.contentType ?? null,
      note: "Binary artifact — content not inlined. Use the URL with your DeerFlow credential to download it.",
    },
    null,
    2
  );
}
