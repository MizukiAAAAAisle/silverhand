import { describe, expect, it, vi } from "vitest";
import type { ClientPlatform } from "@silverhand/client";
import { configurePlatform, getPlatform, requireLocalHost } from "./platform";
import {
  fetchBackendInfo,
  revokeComputer,
  backendInfoRefetchIntervalMs,
} from "./features/computers/hooks/hooks";
import { api, getBackendInfo } from "./lib/api";
import { mapAuthStateToViewer } from "./features/session/hooks";

const user = {
  id: "user",
  name: "test",
  display_name: "Test",
  avatar_url: null,
  created_at: 0,
  updated_at: 0,
};
const connection = { url: "https://self-hosted.example", mode: "remote" as const };
const client = {
  getConnectionInfo: vi.fn(async () => connection),
  getConnectionPolicy: vi.fn(),
  getAuthState: vi.fn(),
  getServerInfo: vi.fn(),
  signup: vi.fn(),
  login: vi.fn(async () => ({ ok: true as const, user })),
  logout: vi.fn(),
  passwordRecovery: vi.fn(),
  backendRequest: vi.fn(async () => ({
    status: 200,
    statusText: "OK",
    headers: {},
    bodyText: '{"messages":[]}',
  })),
  backendUpload: vi.fn(),
  recordEventWsDiagnostic: vi.fn(),
  getServerConnectionProfile: vi.fn(),
  saveServerConnectionProfile: vi.fn(),
  clearServerConnectionProfile: vi.fn(),
  onEpochUpdateRequired: vi.fn(),
  openEventSocket: vi.fn(),
};
const platform: ClientPlatform = {
  client,
  files: {
    openExternal: vi.fn(),
    openAttachmentExternal: vi.fn(),
    saveAttachment: vi.fn(),
    savePngExport: vi.fn(),
    copyPngExport: vi.fn(),
  },
};

describe("pure remote application", () => {
  it("reads connection and HTTP without declaring or synthesizing any local host", async () => {
    configurePlatform(platform);
    await expect(
      getPlatform().client.login({ email: "test@example.com", password: "password" }),
    ).resolves.toEqual({ ok: true, user });
    expect(getPlatform().localHost).toBeUndefined();
    expect(getPlatform().shell).toBeUndefined();
    const snapshot = await fetchBackendInfo();
    expect(snapshot).toEqual(connection);
    expect(snapshot).not.toHaveProperty("local_host_status");
    expect(snapshot).not.toHaveProperty("outbound_protocol_compatibility");
    expect(backendInfoRefetchIntervalMs(snapshot, { pollProtocolCompatibility: true })).toBe(false);
    await expect(api("/api/messages")).resolves.toEqual({ messages: [] });
    expect(() => requireLocalHost()).toThrow("does not provide a local host");
    expect(mapAuthStateToViewer({ status: "unauthenticated" })).toMatchObject({
      registration_required: true,
    });
  });

  it("revokes a remote app computer with no native host capability", async () => {
    const host = {
      id: "remote-computer",
      name: "remote",
      kind: "local",
      provisioning_source: "app_install",
      created_at: 0,
      revoked_at: 1,
      last_seen_at: null,
      display_label: null,
    };
    client.backendRequest.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      headers: {},
      bodyText: JSON.stringify({ host }),
    });
    await expect(revokeComputer(host.id)).resolves.toBeUndefined();
    expect(client.backendRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: "/api/hosts/remote-computer/revoke", method: "POST" }),
    );
    expect(getPlatform().localHost).toBeUndefined();
  });

  it("reads the current connection again instead of reconnecting a socket to a cached origin", async () => {
    await expect(getBackendInfo()).resolves.toEqual(connection);
    client.getConnectionInfo.mockResolvedValueOnce({
      ...connection,
      url: "https://second.example",
    });
    await expect(getBackendInfo()).resolves.toMatchObject({ url: "https://second.example" });
  });
});
