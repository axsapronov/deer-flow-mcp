import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/lib/config.js";

describe("loadConfig", () => {
  it("requires a base URL", () => {
    expect(() => loadConfig({ DEERFLOW_PAT: "dfp_x" })).toThrow(ConfigError);
  });

  it("requires credentials", () => {
    expect(() => loadConfig({ DEERFLOW_BASE_URL: "https://x.example" })).toThrow(/credentials/i);
  });

  it("rejects a non-http base URL", () => {
    expect(() => loadConfig({ DEERFLOW_BASE_URL: "ftp://x", DEERFLOW_PAT: "dfp_x" })).toThrow(
      /http/
    );
  });

  it("parses email/password auth (session mode)", () => {
    const cfg = loadConfig({
      DEERFLOW_BASE_URL: "https://x.example",
      DEERFLOW_EMAIL: "user@example.com",
      DEERFLOW_PASSWORD: "s3cret",
    });
    expect(cfg.auth).toEqual({ kind: "session", email: "user@example.com", password: "s3cret" });
  });

  it("requires DEERFLOW_EMAIL and DEERFLOW_PASSWORD to be set together", () => {
    expect(() =>
      loadConfig({ DEERFLOW_BASE_URL: "https://x.example", DEERFLOW_EMAIL: "user@example.com" })
    ).toThrow(/DEERFLOW_EMAIL and DEERFLOW_PASSWORD must be set together/);
    expect(() =>
      loadConfig({ DEERFLOW_BASE_URL: "https://x.example", DEERFLOW_PASSWORD: "s3cret" })
    ).toThrow(/DEERFLOW_EMAIL and DEERFLOW_PASSWORD must be set together/);
  });

  it("prefers email/password over PAT and internal token when all are set", () => {
    const cfg = loadConfig({
      DEERFLOW_BASE_URL: "https://x.example",
      DEERFLOW_EMAIL: "user@example.com",
      DEERFLOW_PASSWORD: "s3cret",
      DEERFLOW_PAT: "dfp_x",
      DEERFLOW_INTERNAL_TOKEN: "tok",
    });
    expect(cfg.auth).toEqual({ kind: "session", email: "user@example.com", password: "s3cret" });
  });

  it("parses PAT auth and strips trailing slashes", () => {
    const cfg = loadConfig({ DEERFLOW_BASE_URL: "https://x.example/", DEERFLOW_PAT: "dfp_x" });
    expect(cfg.baseUrl).toBe("https://x.example");
    expect(cfg.auth).toEqual({ kind: "pat", token: "dfp_x" });
  });

  it("parses internal auth with an owner user id", () => {
    const cfg = loadConfig({
      DEERFLOW_BASE_URL: "https://x.example",
      DEERFLOW_INTERNAL_TOKEN: "tok",
      DEERFLOW_OWNER_USER_ID: "u-1",
    });
    expect(cfg.auth).toEqual({ kind: "internal", token: "tok", ownerUserId: "u-1" });
  });

  it("prefers PAT over internal token when both are set", () => {
    const cfg = loadConfig({
      DEERFLOW_BASE_URL: "https://x.example",
      DEERFLOW_PAT: "dfp_x",
      DEERFLOW_INTERNAL_TOKEN: "tok",
    });
    expect(cfg.auth).toEqual({ kind: "pat", token: "dfp_x" });
  });

  it("defaults web base URL, recursion limit, and timeout", () => {
    const cfg = loadConfig({ DEERFLOW_BASE_URL: "https://x.example", DEERFLOW_PAT: "dfp_x" });
    expect(cfg.webBaseUrl).toBe("https://x.example");
    expect(cfg.defaultRecursionLimit).toBe(1000);
    expect(cfg.timeoutMs).toBe(60_000);
  });

  it("honors explicit overrides and a separate web base URL", () => {
    const cfg = loadConfig({
      DEERFLOW_BASE_URL: "https://api.example",
      DEERFLOW_WEB_BASE_URL: "https://app.example",
      DEERFLOW_DEFAULT_RECURSION_LIMIT: "250",
      DEERFLOW_TIMEOUT_MS: "1234",
      DEERFLOW_PAT: "dfp_x",
    });
    expect(cfg.webBaseUrl).toBe("https://app.example");
    expect(cfg.defaultRecursionLimit).toBe(250);
    expect(cfg.timeoutMs).toBe(1234);
  });

  it("rejects a non-integer recursion limit", () => {
    expect(() =>
      loadConfig({
        DEERFLOW_BASE_URL: "https://x.example",
        DEERFLOW_PAT: "dfp_x",
        DEERFLOW_DEFAULT_RECURSION_LIMIT: "abc",
      })
    ).toThrow(ConfigError);
  });

  it("defaults the stall threshold and progress wait cap", () => {
    const cfg = loadConfig({ DEERFLOW_BASE_URL: "https://x.example", DEERFLOW_PAT: "dfp_x" });
    expect(cfg.stallThresholdSeconds).toBe(180);
    expect(cfg.progressWaitMaxSeconds).toBe(120);
  });

  it("honors explicit stall threshold and progress wait cap overrides", () => {
    const cfg = loadConfig({
      DEERFLOW_BASE_URL: "https://x.example",
      DEERFLOW_PAT: "dfp_x",
      DEERFLOW_STALL_THRESHOLD_SECONDS: "60",
      DEERFLOW_PROGRESS_WAIT_MAX_SECONDS: "300",
    });
    expect(cfg.stallThresholdSeconds).toBe(60);
    expect(cfg.progressWaitMaxSeconds).toBe(300);
  });

  it("rejects a non-integer stall threshold", () => {
    expect(() =>
      loadConfig({
        DEERFLOW_BASE_URL: "https://x.example",
        DEERFLOW_PAT: "dfp_x",
        DEERFLOW_STALL_THRESHOLD_SECONDS: "abc",
      })
    ).toThrow(ConfigError);
  });
});
