import type { DeerFlowConfig } from "../src/lib/types.js";
import type { FetchLike } from "../src/lib/client.js";

/** Build a fully-resolved config for tests, overriding individual fields. */
export function makeConfig(overrides: Partial<DeerFlowConfig> = {}): DeerFlowConfig {
  return {
    baseUrl: "https://deer.example.com",
    webBaseUrl: "https://deer.example.com",
    auth: { kind: "pat", token: "dfp_testtoken" },
    defaultRecursionLimit: 1000,
    timeoutMs: 60_000,
    stallThresholdSeconds: 180,
    quietThresholdSeconds: 60,
    progressWaitMaxSeconds: 120,
    progressTickMs: 10_000,
    pollIntervalMs: 2_000,
    ...overrides,
  };
}

/** A canned HTTP response the mock fetch will return. */
export interface MockResponse {
  status?: number;
  /** JSON body (stringified unless `text` or `stream` is provided). */
  body?: unknown;
  /** Raw body text (overrides `body`). */
  text?: string;
  /**
   * A streaming body (e.g. for SSE endpoints). When present, it is used as the
   * Response body directly, overriding `text`/`body`.
   */
  stream?: ReadableStream<Uint8Array>;
  headers?: Record<string, string>;
  /** Raw `Set-Cookie` header lines (e.g. `"access_token=jwt; HttpOnly"`). */
  setCookies?: string[];
}

/** A recorded outgoing request. */
export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Build a `FetchLike` that records every call and answers via `responder`.
 * Returns the fetch function plus the recorded calls.
 */
export function createMockFetch(responder: (call: MockCall) => MockResponse): {
  fetchFn: FetchLike;
  calls: MockCall[];
} {
  const calls: MockCall[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    const headers = init?.headers ?? {};
    let body: unknown;
    if (init?.body !== undefined) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: MockCall = { url, method, headers, body };
    calls.push(call);
    const resp = responder(call) ?? {};
    const status = resp.status ?? 200;
    // Build the Response from an array of [name, value] pairs so that
    // multiple `Set-Cookie` values survive (a plain object dedupes them).
    // Regular headers still go through an object so later keys override the
    // defaults (the array form would append duplicate names instead).
    const outHeaders: [string, string][] = [
      ...Object.entries({ "content-type": "application/json", ...(resp.headers ?? {}) }),
      ...(resp.setCookies ?? []).map((value) => ["set-cookie", value] as [string, string]),
    ];
    if (resp.stream !== undefined) {
      const stream = init?.signal ? streamWithAbort(resp.stream, init.signal) : resp.stream;
      return new Response(stream, { status, headers: outHeaders });
    }
    const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.body ?? {});
    return new Response(text, { status, headers: outHeaders });
  };
  return { fetchFn, calls };
}

/**
 * Wrap a stream so that aborting `signal` errors it, which rejects any pending
 * `reader.read()` (mirroring how a real `fetch` aborts its response body).
 */
function streamWithAbort(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = source.getReader();
      const pump = async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      };
      void pump();
      const onAbort = () => {
        controller.error(new Error("aborted"));
        void reader.cancel().catch(() => {});
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    },
  });
}

/**
 * Build a `ReadableStream` that emits the given SSE frames (already formatted
 * as `event: ...\ndata: ...\n\n` chunks) and then stays open (or closes) as
 * requested. Used to exercise the SSE join-stream path in tests.
 */
export function sseStream(
  chunks: string[],
  opts: { keepOpen?: boolean } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else if (opts.keepOpen) {
        // No more data; leave the stream open (the consumer's timeout/abort
        // will end it).
      } else {
        controller.close();
      }
    },
  });
}
