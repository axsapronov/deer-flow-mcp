import { ResourceTemplate, type Variables } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { DeerFlowClient, type ArtifactResult } from "./client.js";
import type { Report } from "./types.js";

/**
 * Register DeerFlow resources on an MCP server. Resources expose the same data
 * as the report/artifact tools but as addressable, cacheable URIs that clients
 * can list and read directly:
 *
 *  - `deerflow://threads/{threadId}/report` — the synthesized report for a thread.
 *  - `deerflow://threads/{threadId}/artifacts/{+path}` — a single artifact file.
 *
 * Both use resource *templates* (dynamic URIs); `{+path}` matches a multi-segment
 * artifact path. A short `cacheHint` TTL avoids hammering the DeerFlow API on
 * repeated reads while still reflecting recent updates.
 */
export function registerResources(server: McpServer, client: DeerFlowClient): void {
  const cacheHint = { ttlMs: 5000 };

  server.registerResource(
    "report",
    new ResourceTemplate("deerflow://threads/{threadId}/report", { list: undefined }),
    {
      title: "DeerFlow Report",
      description:
        "The synthesized report for a DeerFlow thread (markdown). Read after a run reaches a terminal status.",
      mimeType: "text/markdown",
      cacheHint,
    },
    async (uri, variables) => {
      const threadId = varString(variables, "threadId");
      const report = await client.getReport(threadId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: reportText(report),
          },
        ],
      };
    }
  );

  server.registerResource(
    "artifact",
    new ResourceTemplate("deerflow://threads/{threadId}/artifacts/{+path}", {
      list: undefined,
    }),
    {
      title: "DeerFlow Artifact",
      description:
        "A single artifact file produced by a DeerFlow thread (text inlined, binary as a download note).",
      mimeType: "text/plain",
      cacheHint,
    },
    async (uri, variables) => {
      const threadId = varString(variables, "threadId");
      const path = varString(variables, "path");
      const artifact = await client.getArtifact(threadId, path);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: artifact.contentType ?? "text/plain",
            text: artifactText(artifact),
          },
        ],
      };
    }
  );
}

/** Extract a single string from a URI-template variable (handles `string | string[]`). */
function varString(variables: Variables, key: string): string {
  const value = variables[key];
  if (Array.isArray(value)) return value.join("/");
  return value ?? "";
}

/** Human-readable text for a report resource. */
function reportText(report: Report): string {
  if (report.report) return report.report;
  if (report.terminal) {
    return `(The run reached a terminal status (${report.run_status ?? "ended"}) but produced no final report text. Check the artifacts or open ${report.web_url}.)`;
  }
  return `(No report yet — the run is still in progress. Keep waiting with deerflow_wait_activity, then read this resource again.)`;
}

/** Human-readable text for an artifact resource. */
function artifactText(artifact: ArtifactResult): string {
  if (artifact.content !== undefined) return artifact.content;
  return `(Binary artifact — content not inlined. Download it from: ${artifact.url})`;
}
