import type { AppSection } from "@/components/layout/NavRail";
import type { MembershipState } from "@/features/channels/membership";
import type { JumpPhase } from "@/features/channels/messageJumpPhase";
import type { MessageJumpTarget } from "@/features/channels/useMessageJumpController";
import type { UnreadCounts } from "@/features/notifications/hooks";
import type { WorkspaceListItem } from "@/features/workspaces/hooks";
import type { SidebarPane } from "@/hooks/useSidebarPane";
import type { ConversationPointer, SecondaryDescriptor } from "@/lib/secondary-pane";
import type { ChatView, RouteState, useNav } from "@/router";
import type {
  AgentDto,
  AttachmentSnapshot,
  AttentionBadgeRollupDto,
  SavedMessageDto,
} from "@silverhand/shared";
import type { ConversationPanesModel } from "./pane-render-models";

export interface ConversationShellSignals {
  attentionBadges: AttentionBadgeRollupDto | undefined;
  unreadCounts: UnreadCounts | undefined;
}

export interface PaneAttachmentRequest {
  conversationId: string;
  attachment: AttachmentSnapshot;
}

export interface PaneReadModel {
  primaryPointer: ConversationPointer | null;
  parentChannelMembership: MembershipState;
  hasChannelNamespace: boolean;
  deferredChannelId: string | null;
}

export interface PaneJumpModel {
  jumpTarget: MessageJumpTarget | null;
  isPrimePendingFor: (channelId: string, messageId: string) => boolean;
  primePhaseFor: (channelId: string, messageId: string) => JumpPhase | null;
  handleJumpToMessage: (target: MessageJumpTarget) => boolean;
}

export interface ChatShellModel {
  route: RouteState;
  nav: ReturnType<typeof useNav>;
  appSection: AppSection;
  view: ChatView;
  selectedWorkspaceId: string | null;
  directDraftAgentId: string | null;
  workspaceSidebarPane: SidebarPane;
  workspaceSidebarVisible: boolean;
  workspaces: WorkspaceListItem[];
  agentsById: Map<string, AgentDto>;
  savedItems: SavedMessageDto[] | undefined;
  attentionBadges: AttentionBadgeRollupDto | undefined;
  resolveNavWorkspaceId: (
    workspaceId: string | undefined,
    channelId?: string | null,
  ) => string | null;
  deferredSection: AppSection;
  handleSelectWorkspace: (id: string) => void;
  handleSelectChannel: (id: string, workspaceId?: string | null) => void;
  handleJumpToMessage: (target: MessageJumpTarget) => boolean;
  sidebarSelectedConversationId: string | null;
}

export interface ActivityShellModel {
  appSection: AppSection;
  selectedChannelId: string | null;
  agentsById: Map<string, AgentDto>;
  workspaceRefById: Map<string, { readonly name: string; readonly ownerAgentId: string | null }>;
  deferredSection: AppSection;
  handleJumpToMessageStable: (target: MessageJumpTarget) => boolean;
}

export interface ConversationAppModel {
  toggleWorkspaceSidebar: () => void;
  nav: ReturnType<typeof useNav>;
  appSection: AppSection;
  workspaceSidebarVisible: boolean;
  selectedWorkspace: WorkspaceListItem | null;
  titlebarWorkspaceName: string | null;
  openAgentConversation: (conversationId: string, workspaceId: string | null) => void;
  deferredSection: AppSection;
  handleJumpToMessage: (target: MessageJumpTarget) => boolean;
  handleMessageAgent: (agentId: string) => void;
  secondaryDescriptor: SecondaryDescriptor | null;
  routeFullscreen: boolean;
}

export interface ConversationShellModel {
  chat: ChatShellModel;
  activity: ActivityShellModel;
  panes: ConversationPanesModel;
  app: ConversationAppModel;
}
