export const workspacesKey = ["workspaces"] as const;
export const channelsKey = (workspaceId: string) =>
  ["workspaces", workspaceId, "channels"] as const;
export const channelDetailKey = (channelId: string) => ["channel-detail", channelId] as const;
export const archivedChannelsKey = (workspaceId: string) =>
  ["workspaces", workspaceId, "channels", "archived"] as const;
export const archivedChannelsIndexKey = (workspaceId: string | null, since: number | null) =>
  ["archived-channels", { workspaceId, since }] as const;
export const membersKey = (workspaceId: string) => ["workspaces", workspaceId, "members"] as const;
export const capabilitiesKey = (workspaceId: string, agentId: string) =>
  ["workspaces", workspaceId, "agents", agentId, "capabilities"] as const;
