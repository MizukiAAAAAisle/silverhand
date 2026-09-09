import { describe, expect, it, vi } from "vitest";
import type { DesktopProfileSaveWithTestResult } from "../../../../preload/api";
import {
  isRetryableSettingsProfileSaveResult,
  saveServerConnectionProfileWithSettingsRetry,
} from "./save-server-url-retry";

const tlsFailed = (): DesktopProfileSaveWithTestResult => ({
  ok: false,
  phase: "test",
  test: {
    ok: false,
    kind: "tls_failed",
    code: "host_tls_chain_invalid",
    message: "TLS chain not trusted",
  },
});

const networkFailed = (): DesktopProfileSaveWithTestResult => ({
  ok: false,
  phase: "test",
  test: {
    ok: false,
    kind: "network_failed",
    message: "fetch failed",
  },
});

const okSaved = (): DesktopProfileSaveWithTestResult => ({
  ok: true,
  test: {
    ok: true,
    kind: "system_ca_verified",
    info: { signup_enabled: true },
    originUrl: "https://silverhand.ai",
  },
  profile: {
    server_url: "https://silverhand.ai",
    updated_at: 1_720_000_000_000,
  },
  phase2: {
    kind: "no_op_no_host_claim",
    profileVersion: 1,
  },
});

describe("saveServerConnectionProfileWithSettingsRetry", () => {
  it("retries Settings profile saves for transient TLS probe failures", async () => {
    const responses = [tlsFailed(), tlsFailed(), okSaved()];
    const save = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected extra save");
      return next;
    });
    const delays: number[] = [];

    const result = await saveServerConnectionProfileWithSettingsRetry({
      serverUrl: "https://silverhand.ai",
      save,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });

    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([250, 750]);
  });

  it("stops after three total attempts when retryable failures continue", async () => {
    const save = vi.fn(async () => networkFailed());

    const result = await saveServerConnectionProfileWithSettingsRetry({
      serverUrl: "https://silverhand.ai",
      save,
      sleep: async () => {},
    });

    expect(result).toEqual(networkFailed());
    expect(save).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-transient profile save failures", async () => {
    const nonRetryable: DesktopProfileSaveWithTestResult[] = [
      {
        ok: false,
        phase: "test",
        test: {
          ok: false,
          kind: "classify_rejected",
          reason: "malformed_url",
          message: "bad url",
        },
      },
      {
        ok: false,
        phase: "test",
        test: {
          ok: false,
          kind: "http_failed",
          status: 404,
          statusText: "Not Found",
          bodyText: "missing",
        },
      },
      {
        ok: false,
        phase: "test",
        test: {
          ok: false,
          kind: "invalid_response",
          message: "not silverhand",
        },
      },
      {
        ok: false,
        phase: "write",
        reason: "write_failed",
        detail: "EACCES",
      },
      {
        ok: false,
        phase: "commit_guard",
        reason: "remote_backend_not_yet_supported",
        message: "not supported",
        test: {
          ok: true,
          kind: "system_ca_verified",
          info: { signup_enabled: true },
          originUrl: "https://silverhand.ai",
        },
      },
    ];

    for (const response of nonRetryable) {
      const save = vi.fn(async () => response);
      const result = await saveServerConnectionProfileWithSettingsRetry({
        serverUrl: "https://silverhand.ai",
        save,
        sleep: async () => {
          throw new Error("sleep should not be called");
        },
      });

      expect(result).toBe(response);
      expect(save).toHaveBeenCalledTimes(1);
      expect(isRetryableSettingsProfileSaveResult(response)).toBe(false);
    }
  });
});
