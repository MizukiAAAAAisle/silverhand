/**
 * `#task:1630` — the command side of the same unknown boundary.
 *
 * The pill regression was "we painted a status we had not observed".
 * This is its command twin: with no `BackendInfo` snapshot yet,
 * `ConnectionPane` defaulted `mode` to `'embedded'`, so a Save typed
 * inside that window (or during a persistent `backend:info` failure)
 * routed a REMOTE app's address change into `settings:saveServerUrl` —
 * a daemon-config rewrite plus daemon reload — while the app's own
 * server profile stayed on the old origin (Cindy's review).
 *
 * Guessing an owner is worse than guessing a status word: the pill
 * self-heals on the next snapshot, a wrong write does not.
 */
import { describe, expect, it } from "vitest";
import {
  planServerUrlSave,
  runServerUrlSave,
  type ServerUrlSaveApi,
  type ServerUrlSaveCommand,
} from "./server-url-save-command";
import type { DesktopServerMode } from "./connection-readiness";

const SERVER_URL = "https://silverhand.example.com";

interface CountedApi {
  api: ServerUrlSaveApi;
  calls: { profile: number; daemon: number };
  urls: string[];
}

/**
 * Both stubs answer a terminal (non-retryable) result so the retry
 * wrapper in `runServerUrlSave`'s profile arm cannot inflate the call
 * counts this suite is asserting on.
 */
function countingApi(): CountedApi {
  const calls = { profile: 0, daemon: 0 };
  const urls: string[] = [];
  return {
    calls,
    urls,
    api: {
      saveServerConnectionProfile: async ({ serverUrl }) => {
        calls.profile += 1;
        urls.push(serverUrl);
        return { ok: false, phase: "write", reason: "write_failed" };
      },
      saveServerUrl: async ({ serverUrl }) => {
        calls.daemon += 1;
        urls.push(serverUrl);
        return { ok: true, kind: "unchanged" };
      },
    },
  };
}

/**
 * The exact composition `ConnectionPane.onSubmit` performs: plan from
 * the observed mode, and only mutate when a command exists. Written as
 * a helper so the "zero IPC" claim is proven against the whole submit
 * path, not just against `planServerUrlSave`'s return value.
 */
async function submit(
  mode: DesktopServerMode | null,
  api: ServerUrlSaveApi,
): Promise<ServerUrlSaveCommand | null> {
  const command = planServerUrlSave({ mode, serverUrl: SERVER_URL });
  if (command === null) return null;
  await runServerUrlSave(command, api);
  return command;
}

describe("planServerUrlSave — an unknown mode owns no command", () => {
  it("issues ZERO IPC calls when no snapshot has been observed", async () => {
    const { api, calls } = countingApi();
    await expect(submit(null, api)).resolves.toBeNull();
    // Both, explicitly: the bug was picking the WRONG one of these two,
    // so "neither fired" is the only assertion that falsifies it.
    expect(calls).toEqual({ profile: 0, daemon: 0 });
  });

  it("never falls back to the embedded arm for an unknown mode", () => {
    // Pinned separately from the call counts: if the plan itself
    // defaulted to embedded, the pane would never see a null to gate on
    // and the "nothing fired" test above could only fail by accident.
    expect(planServerUrlSave({ mode: null, serverUrl: SERVER_URL })).toBeNull();
  });
});

describe("planServerUrlSave / runServerUrlSave — a known mode routes to its own owner", () => {
  it("remote → the server connection profile only", async () => {
    const { api, calls } = countingApi();
    await expect(submit("remote", api)).resolves.toEqual({
      source: "profile",
      serverUrl: SERVER_URL,
    });
    expect(calls).toEqual({ profile: 1, daemon: 0 });
  });

  it("embedded → the daemon outbound reload only", async () => {
    const { api, calls } = countingApi();
    await expect(submit("embedded", api)).resolves.toEqual({
      source: "daemon_reload",
      serverUrl: SERVER_URL,
    });
    expect(calls).toEqual({ profile: 0, daemon: 1 });
  });

  it("reports which owner answered so the banner can describe it", async () => {
    const { api } = countingApi();
    const profile = await runServerUrlSave({ source: "profile", serverUrl: SERVER_URL }, api);
    const daemon = await runServerUrlSave({ source: "daemon_reload", serverUrl: SERVER_URL }, api);
    expect(profile.source).toBe("profile");
    expect(daemon.source).toBe("daemon_reload");
  });

  it("passes the address through untouched to the owning IPC", async () => {
    const { api, urls } = countingApi();
    await submit("remote", api);
    await submit("embedded", api);
    expect(urls).toEqual([SERVER_URL, SERVER_URL]);
  });
});
