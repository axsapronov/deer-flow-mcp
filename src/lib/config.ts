import type { DeerFlowAuth, DeerFlowConfig } from "./types.js";

/** Environment variable names the server reads. */
export const ENV = {
  baseUrl: "DEERFLOW_BASE_URL",
  email: "DEERFLOW_EMAIL",
  password: "DEERFLOW_PASSWORD",
  pat: "DEERFLOW_PAT",
  internalToken: "DEERFLOW_INTERNAL_TOKEN",
  ownerUserId: "DEERFLOW_OWNER_USER_ID",
  defaultModel: "DEERFLOW_DEFAULT_MODEL",
  defaultRecursionLimit: "DEERFLOW_DEFAULT_RECURSION_LIMIT",
  timeoutMs: "DEERFLOW_TIMEOUT_MS",
  webBaseUrl: "DEERFLOW_WEB_BASE_URL",
  stallThresholdSeconds: "DEERFLOW_STALL_THRESHOLD_SECONDS",
  progressWaitMaxSeconds: "DEERFLOW_PROGRESS_WAIT_MAX_SECONDS",
} as const;

const DEFAULT_RECURSION_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_STALL_THRESHOLD_SECONDS = 180;
const DEFAULT_PROGRESS_WAIT_MAX_SECONDS = 120;

export type Env = Record<string, string | undefined>;

function readTrimmed(env: Env, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

/** Raised when the environment is missing or invalid. Message is safe to surface. */
export class ConfigError extends Error {}

function requireHttpUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: "${value}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http:// or https://, got "${url.protocol}"`);
  }
  return stripTrailingSlashes(value);
}

function resolveAuth(env: Env): DeerFlowAuth {
  const email = readTrimmed(env, ENV.email);
  const password = readTrimmed(env, ENV.password);
  if (email !== undefined || password !== undefined) {
    if (email === undefined || password === undefined) {
      throw new ConfigError("DEERFLOW_EMAIL and DEERFLOW_PASSWORD must be set together.");
    }
    return { kind: "session", email, password };
  }
  const pat = readTrimmed(env, ENV.pat);
  if (pat) {
    return { kind: "pat", token: pat };
  }
  const internalToken = readTrimmed(env, ENV.internalToken);
  if (internalToken) {
    const ownerUserId = readTrimmed(env, ENV.ownerUserId);
    return {
      kind: "internal",
      token: internalToken,
      ...(ownerUserId ? { ownerUserId } : {}),
    };
  }
  throw new ConfigError(
    [
      "No DeerFlow credentials configured. Set DEERFLOW_EMAIL + DEERFLOW_PASSWORD (email/password,",
      "  simplest — full user access, tried first), DEERFLOW_PAT (Personal Access Token,",
      "  threads/runs only) or DEERFLOW_INTERNAL_TOKEN (full access to models + artifact files).",
      "  See .env.example for details.",
    ].join(" ")
  );
}

/**
 * Parse and validate the server configuration from an environment map.
 *
 * Fails fast with a descriptive {@link ConfigError} when required values are
 * missing or invalid, so the MCP client gets a clean startup error instead of a
 * cryptic first-request failure.
 */
export function loadConfig(env: Env = process.env): DeerFlowConfig {
  const rawBase = readTrimmed(env, ENV.baseUrl);
  if (!rawBase) {
    throw new ConfigError(
      `${ENV.baseUrl} is required. Set it to the base URL of your deployed DeerFlow instance (e.g. https://deerflow.example.com).`
    );
  }
  const baseUrl = requireHttpUrl(rawBase, ENV.baseUrl);

  const auth = resolveAuth(env);

  const webRaw = readTrimmed(env, ENV.webBaseUrl);
  const webBaseUrl = webRaw ? requireHttpUrl(webRaw, ENV.webBaseUrl) : baseUrl;

  const defaultModel = readTrimmed(env, ENV.defaultModel);
  const defaultRecursionLimit = parsePositiveInt(
    readTrimmed(env, ENV.defaultRecursionLimit),
    DEFAULT_RECURSION_LIMIT,
    ENV.defaultRecursionLimit
  );
  const timeoutMs = parsePositiveInt(
    readTrimmed(env, ENV.timeoutMs),
    DEFAULT_TIMEOUT_MS,
    ENV.timeoutMs
  );
  const stallThresholdSeconds = parsePositiveInt(
    readTrimmed(env, ENV.stallThresholdSeconds),
    DEFAULT_STALL_THRESHOLD_SECONDS,
    ENV.stallThresholdSeconds
  );
  const progressWaitMaxSeconds = parsePositiveInt(
    readTrimmed(env, ENV.progressWaitMaxSeconds),
    DEFAULT_PROGRESS_WAIT_MAX_SECONDS,
    ENV.progressWaitMaxSeconds
  );

  return {
    baseUrl,
    webBaseUrl,
    auth,
    ...(defaultModel ? { defaultModel } : {}),
    defaultRecursionLimit,
    timeoutMs,
    stallThresholdSeconds,
    progressWaitMaxSeconds,
  };
}
