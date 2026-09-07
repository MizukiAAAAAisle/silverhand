import type { Dispatch, SetStateAction } from 'react';
import type {
  AgentDto,
  AttentionBadgeRollupDto,
  SavedMessageDto,
  AttachmentSnapshot,
  ConversationVisibility,
} from '@silverhand/shared';
import type { RouteState, ChatView, useNav } from '@/router';
import type { AppSection } from '@/components/layout/NavRail';
import type { SidebarPane } from '@/hooks/useSidebarPane';
import type { WorkspaceListItem, ChannelListItem } from '@/features/workspaces/hooks';
import type { WorkspaceChannelReference } from '@/components/chat/ConversationRef';
import type { AdvancedSearchSeed } from '@/features/search/advanced-search-seed';
import type { MessageJumpTarget } from '@/features/channels/useMessageJumpController';
import type { JumpPhase } from '@/features/channels/messageJumpPhase';
import type { ResolvedChannelMembership } from '@/features/channels/use-channel-membership';
import type { MembershipState } from '@/features/channels/membership';
import type { ConversationPaneDescriptor } from '@/features/conversations/pane-descriptor';
import type {
  ConversationPaneCapabilities,
  ComposerDirectory,
} from '@/features/conversations/pane-mode';
import type {
  ConversationPointer,
  SecondaryDescriptor,
  SecondaryViewInputs,
} from '@/lib/secondary-pane';
import type { UnreadCounts } from '@/features/notifications/hooks';
import type { DirectPairPaneProps } from '@/features/direct-pairs/hooks';

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

export interface ConversationPanesModel {
  nav: ReturnType<typeof useNav>;
  selectedWorkspaceId: string | null;
  selectedChannelId: string | null;
  directDraftAgentId: string | null;
  threadRootId: string | null;
  agentPanelId: string | null;
  requestJump: (target: MessageJumpTarget) => void;
  workspaceNameById: (wid: string | null) => string | null;
  archivePending: boolean;
  handleOpenAdvancedSearch: (seed: AdvancedSearchSeed) => void;
  directPair: DirectPairPaneProps['pair'];
  directPairLoadFailed: boolean;
  directPairNotFound: boolean;
  secondaryDescriptor: SecondaryDescriptor | null;
  selectedChannel: ChannelListItem | null;
  parentMembership: ResolvedChannelMembership;
  channelIndexesAvailable: boolean;
  filesListMounted: boolean;
  threadsListMounted: boolean;
  parentChannelResolving: boolean;
  conversationRefsById: Map<string, WorkspaceChannelReference>;
  openTaskInPane: (taskId: string) => void;
  taskPaneId: string | null;
  setTaskPaneEditing: (editing: boolean) => void;
  requestCloseTaskPane: () => void;
  paneAttachmentRequest: PaneAttachmentRequest | null;
  setPaneAttachmentRequest: Dispatch<SetStateAction<PaneAttachmentRequest | null>>;
  handleOpenChannelByName: (workspaceId: string, channelId: string) => void;
  handleJumpToMessage: (target: MessageJumpTarget) => boolean;
  closeSecondary: () => void;
  handleMessageAgent: (agentId: string) => void;
  handleDraftOpenedPair: (conversationId: string) => void;
  handleJumped: () => void;
  handleArchiveChannelMutation: (channelId: string, archived: boolean) => void;
  handleRenameChannelMutation: (channelId: string, title: string) => Promise<void>;
  handleSetChannelVisibilityMutation: (
    channelId: string,
    visibility: ConversationVisibility,
  ) => Promise<void>;
  handleLeaveChannelMutation: (channelId: string) => Promise<void>;
  selectedChannelDescriptor: ConversationPaneDescriptor | null;
  primaryPaneDescriptor: ConversationPaneDescriptor | null;
  primaryPaneCapabilities: ConversationPaneCapabilities;
  primaryPaneHasChannelNamespace: boolean;
  primaryThreadComposerDirectory: ComposerDirectory;
  secondaryViewInputs: SecondaryViewInputs;
  secondaryConversationDescriptor: ConversationPaneDescriptor | null;
  handleArchiveSecondaryChannelMutation: (channelId: string, archived: boolean) => void;
  handleRenameSecondaryChannelMutation: (channelId: string, title: string) => Promise<void>;
  parentJumpTarget: { channelId: string; messageId: string } | null;
  secondaryJumpTarget: null;
  secondaryJumpPrimePending: boolean;
  threadJumpMessageId: string | null;
  parentJumpPrimePending: boolean;
  threadJumpPhase: JumpPhase | null;
  handleOpenThreadFromChannel: (rootMessageId: string, jumpToMessageId?: string) => void;
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
