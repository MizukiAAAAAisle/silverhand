import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "../preload/contract";
import { createDesktopPlatform } from "./platform";

describe("Desktop platform composition", () => {
  it("publishes connection facts independently of the optional local computer", async () => {
    const bridge = {
      getBackendInfo: vi.fn(async () => ({
        url: "https://server.example",
        mode: "remote",
        local_host_id: "computer",
        local_host_status: "claimed",
      })),
    } as unknown as DesktopBridge;
    const platform = createDesktopPlatform(bridge, vi.fn());
    expect(await platform.client.getConnectionInfo()).toEqual({
      url: "https://server.example",
      mode: "remote",
    });
    expect(await platform.localHost!.getSnapshot()).toEqual({
      local_host_id: "computer",
      local_host_status: "claimed",
    });
    expect(platform.client).not.toHaveProperty("rotateHostToken");
    expect(platform.files).not.toHaveProperty("backendRequest");
  });

  it("restarts the renderer after a server change to discard caches and WS resume floors", async () => {
    let url = "https://first.example";
    const bridge = {
      getBackendInfo: vi.fn(async () => ({ url, mode: "remote" })),
      saveServerConnectionProfile: vi.fn(async () => {
        url = "https://second.example";
        return { ok: true };
      }),
    } as unknown as DesktopBridge;
    const restart = vi.fn();
    const platform = createDesktopPlatform(bridge, restart);
    await platform.client.saveServerConnectionProfile({ serverUrl: "https://second.example" });
    expect(restart).toHaveBeenCalledOnce();
    await platform.client.saveServerConnectionProfile({ serverUrl: "https://second.example" });
    expect(restart).toHaveBeenCalledOnce();
  });
});


it("plays custom notification audio without waiting for playback and reports invalid previews", async () => {
  const players: any[] = [];
  class Player {
    duration = 1;
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onloadedmetadata: (() => void) | null = null;
    pause = vi.fn();
    removeAttribute = vi.fn();
    play = vi.fn(async () => {});
    constructor(public source: string) { players.push(this); }
  }
  vi.stubGlobal("Audio", Player);
  const bridge = {
    showSystemNotification: vi.fn(async () => "data:audio/ogg;base64,AAAA"),
    notificationSounds: { preview: vi.fn(async () => "data:audio/ogg;base64,BBBB") },
  } as unknown as DesktopBridge;
  try {
    const platform = createDesktopPlatform(bridge, vi.fn());
    await platform.notifications!.showSystemNotification({ title: "Mention", body: "Hello" });
    expect(players).toHaveLength(1);
    expect(players[0].play).toHaveBeenCalledOnce();
    const preview = platform.notificationSounds!.preview({id:"test.ogg", name:"test.ogg"});
    await Promise.resolve();
    expect(players[0].pause).toHaveBeenCalledOnce();
    players[1].onerror();
    await expect(preview).rejects.toThrow("could not be played");
  } finally { vi.unstubAllGlobals(); }
});
