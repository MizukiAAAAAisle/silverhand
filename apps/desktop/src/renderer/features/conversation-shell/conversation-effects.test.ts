import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelListItem, WorkspaceListItem } from "@/features/workspaces/hooks";

const h = vi.hoisted(() => ({
  route: {
    section: "chat",
    chatView: "channel",
    workspaceId: "w",
    channelId: "c" as string | null,
    directConversationId: null,
    directDraftAgentId: null,
    sideConversationId: null,
    threadRootId: null,
    threadsListOpen: false,
  },
  effects: [] as Array<() => void>,
  removal: undefined as undefined | ((id: string) => void),
  archive: vi.fn(),
  leave: vi.fn(),
  rename: vi.fn(),
  visibility: vi.fn(),
  go: vi.fn(),
  toChannel: vi.fn(),
  toWorkspace: vi.fn(),
  persist: vi.fn(),
  memory: new Map<string, string>(),
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(cb: T) => cb,
  useRef: <T>(current: T) => ({ current }),
  useEffect: (effect: () => void) => {
    h.effects.push(effect);
  },
}));
vi.mock("@/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/router")>()),
  useRouteState: () => h.route,
  useNav: () => ({ go: h.go, toChannel: h.toChannel, toWorkspace: h.toWorkspace }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useArchiveChannel: () => ({ mutate: h.archive }),
  useLeaveChannel: () => ({ mutateAsync: h.leave }),
  useRenameChannel: () => ({ mutateAsync: h.rename }),
  useSetChannelVisibility: () => ({ mutateAsync: h.visibility }),
}));
vi.mock("@/features/channels/useViewerChannelRemovalSync", () => ({
  useViewerChannelRemovalSync: (p: { onVisibilityLoss: (id: string) => void }) => {
    h.removal = p.onVisibilityLoss;
  },
  useForeignWorkspaceChannelRemovalSync: vi.fn(),
}));
vi.mock("@/features/app-shell/selection-persistence", () => ({
  useSelectionPersistenceEffects: vi.fn(),
}));
vi.mock("@/features/app-shell/place-memory", () => ({
  lastChannelByWorkspace: h.memory,
  persistLastChannel: h.persist,
  getLastWorkspaceId: () => null,
  getLastChatPlace: () => null,
  getChannelLayout: () => null,
  getCloseWatermark: () => null,
  recordChannelLayout: vi.fn(),
  recordCloseWatermark: vi.fn(),
}));
import { useConversationInvalidation } from "./use-conversation-invalidation";
import { useChatRouteRecovery } from "@/features/chat-shell/use-chat-route-recovery";

const channel = (id: string): ChannelListItem => ({
  id,
  workspace_id: "w",
  placement_kind: "workspace",
  roster_policy: "open",
  title: id,
  status: "active",
  spawned_by_agent_id: null,
  closed_at: null,
  close_summary: null,
  archived_at: null,
  created_at: 0,
  updated_at: 0,
  visibility: "private",
  is_member: true,
});
const workspace: WorkspaceListItem = {
  id: "w",
  name: "Workspace",
  description: null,
  created_at: 0,
  updated_at: 0,
  archived_at: null,
  owner_agent_id: null,
  dm_channel_ids: [],
  workspace_scope_ids: ["w"],
};
function mountInvalidation(ids = ["c"]) {
  const channels = ids.map(channel);
  return useConversationInvalidation({
    activeChannels: channels,
    archivedChannels: [],
    memberActiveChannels: channels,
    activeSettled: true,
    archivedSettled: true,
    visibleWorkspaceIds: ["w"],
  });
}
function recover(
  removed: { current: { workspaceId: string; channelId: string } | null },
  ids = ["c"],
) {
  useChatRouteRecovery({
    workspaces: [workspace],
    channels: ids.map(channel),
    memberActiveChannels: ids.map(channel),
    messageUnreadData: undefined,
    directPairAuthority: { status: "ready", conversationIds: new Set() },
    jumpTarget: null,
    onJump: vi.fn(),
    recentlyRemovedPrimaryRef: removed,
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  h.effects = [];
  h.removal = undefined;
  h.memory.clear();
  Object.assign(h.route, {
    section: "chat",
    chatView: "channel",
    workspaceId: "w",
    channelId: "c" as string | null,
    directConversationId: null,
  });
  h.archive.mockImplementation((_input, options) => options?.onSuccess());
  h.leave.mockResolvedValue({ channel: { roster_policy: "open", visibility: "private" } });
});

describe("shared conversation invalidation", () => {
  it.each(["archive", "leave", "external"])(
    "uses the same empty fallback and stale guard for %s",
    async (origin) => {
      h.memory.set("w", "c");
      const owner = mountInvalidation();
      if (origin === "archive") {
        owner.handleArchiveChannelMutation("c", true);
      } else if (origin === "leave") {
        await owner.handleLeaveChannelMutation("c");
      } else {
        h.removal?.("c");
      }
      expect(owner.recentlyRemovedPrimaryRef.current).toEqual({ workspaceId: "w", channelId: "c" });
      expect(h.memory.has("w")).toBe(false);
      expect(h.persist).toHaveBeenCalledTimes(1);
      expect(h.toWorkspace).toHaveBeenCalledExactlyOnceWith("w");
      h.route.channelId = null;
      h.effects = [];
      recover(owner.recentlyRemovedPrimaryRef);
      h.effects.forEach((e) => e());
      expect(h.go).not.toHaveBeenCalled();
    },
  );
  it("selects one member neighbor without clearing unrelated memory", () => {
    const owner = mountInvalidation(["c", "next"]);
    owner.handleArchiveChannelMutation("c", true);
    expect(h.toChannel).toHaveBeenCalledExactlyOnceWith("w", "next");
    expect(h.persist).not.toHaveBeenCalled();
    expect(owner.recentlyRemovedPrimaryRef.current).toBeNull();
  });
  it("does not depart on a failed archive or a public-channel leave", async () => {
    h.archive.mockImplementation(() => undefined);
    h.leave.mockResolvedValue({ channel: { roster_policy: "open", visibility: "public" } });
    const owner = mountInvalidation();
    owner.handleArchiveChannelMutation("c", true);
    await owner.handleLeaveChannelMutation("c");
    expect(h.toWorkspace).not.toHaveBeenCalled();
    expect(h.toChannel).not.toHaveBeenCalled();
    expect(owner.recentlyRemovedPrimaryRef.current).toBeNull();
  });

  it("does not move the primary for restore or another channel", () => {
    const owner = mountInvalidation();
    owner.handleArchiveChannelMutation("c", false);
    owner.handleArchiveChannelMutation("other", true);
    expect(h.toChannel).not.toHaveBeenCalled();
    expect(h.toWorkspace).not.toHaveBeenCalled();
    expect(h.archive).toHaveBeenCalledTimes(2);
  });
});
describe("Chat recovery boundary", () => {
  it("does not auto-select an Activity conversation", () => {
    h.route.section = "activity";
    h.route.channelId = null;
    recover({ current: null });
    h.effects.forEach((e) => e());
    expect(h.go).not.toHaveBeenCalled();
  });
  it("restores the same available channel in Chat", () => {
    h.route.channelId = null;
    recover({ current: null });
    h.effects.forEach((e) => e());
    expect(h.go).toHaveBeenCalledExactlyOnceWith("/chat/w/w/c/c", { replace: true });
  });
});
