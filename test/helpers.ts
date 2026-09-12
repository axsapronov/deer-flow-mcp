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
    ...overrides,
  };
}

/** A canned HTTP response the mock fetch will return. */
export interface MockResponse {
  status?: number;
  /** JSON body (stringified unless `text` is provided). */
  body?: unknown;
  /** Raw body text (overrides `body`). */
  text?: string;
  headers?: Record<string, string>;
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
    const outHeaders: Record<string, string> = {
      "content-type": "application/json",
      ...(resp.headers ?? {}),
    };
    const text = resp.text !== undefined ? resp.text : JSON.stringify(resp.body ?? {});
    return new Response(text, { status, headers: outHeaders });
  };
  return { fetchFn, calls };
}
