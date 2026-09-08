import type { HumanView } from "@/features/me/HumanView";
import type { ComponentProps } from "react";
import type { DirectPairDraftPane } from "@/features/direct-pairs/DirectPairDraftPane";
import type { ChannelView } from "@/components/layout/ChannelView";
import type { AgentView } from "@/features/agent-shell/components/agent-view";
import type { ChannelAttachmentsPanel } from "@/components/layout/ChannelAttachmentsPanel";
import type { TaskDetailPanel } from "@/components/tasks/TaskDetailPanel";
import type { SideUnresolvedPlaceholder } from "@/components/layout/SideUnresolvedPlaceholder";
import type { ThreadPanel } from "@/components/layout/ThreadPanel";
import type { ChannelThreadsPanel } from "@/components/layout/ChannelThreadsPanel";
import type { ConversationPaneCapabilities } from "@/features/conversations/pane-mode";
export type DraftPaneProps = Pick<
  ComponentProps<typeof DirectPairDraftPane>,
  "agentId" | "onOpenPair"
>;

export type PrimaryPaneProps = Pick<
  ComponentProps<typeof ChannelView>,
  | "hasChannelNamespace"
  | "workspaceName"
  | "conversation"
  | "resolving"
  | "loadFailed"
  | "notFound"
  | "parentTitle"
  | "jumpTarget"
  | "jumpPrimePending"
  | "onJumped"
  | "onOpenThread"
  | "onToggleThreadsList"
  | "threadsListActive"
  | "onToggleFilesList"
  | "filesListActive"
  | "onArchiveChannel"
  | "onRenameChannel"
  | "onSetChannelVisibility"
  | "onLeaveChannel"
  | "archivePending"
  | "conversationRefsById"
  | "onOpenConversationRef"
  | "onOpenChannelRef"
  | "onOpenTask"
  | "onJumpToMessage"
  | "onOpenAdvancedSearch"
  | "viewTabsEnabled"
  | "openAttachmentRequest"
  | "onAttachmentRequestConsumed"
>;

export type AgentPaneProps = Pick<
  ComponentProps<typeof AgentView>,
  | "agentId"
  | "contextConversationId"
  | "contextWorkspaceId"
  | "onClose"
  | "onDeleted"
  | "onMessageAgent"
>;

export type FilesPaneProps = Pick<
  ComponentProps<typeof ChannelAttachmentsPanel>,
  "channelId" | "workspaceId" | "parentTitle" | "onClose" | "onJumpToMessage" | "onOpenAttachment"
>;

export type TaskPaneProps = Pick<
  ComponentProps<typeof TaskDetailPanel>,
  "taskId" | "onClose" | "onEditingChange"
>;

export type UnresolvedPaneProps = Pick<
  ComponentProps<typeof SideUnresolvedPlaceholder>,
  "conversationId" | "status" | "onClose"
>;

export type SidePaneProps = Pick<
  ComponentProps<typeof ChannelView>,
  | "hasChannelNamespace"
  | "workspaceName"
  | "conversation"
  | "parentTitle"
  | "jumpTarget"
  | "jumpPrimePending"
  | "onJumped"
  | "onCloseChild"
  | "closeLabel"
  | "isFullscreen"
  | "onArchiveChannel"
  | "onRenameChannel"
  | "archivePending"
  | "conversationRefsById"
  | "onOpenConversationRef"
  | "onOpenChannelRef"
  | "onOpenTask"
>;

export type ThreadPaneProps = Pick<
  ComponentProps<typeof ThreadPanel>,
  | "channelId"
  | "workspaceId"
  | "directory"
  | "rootMessageId"
  | "onOpenAttachment"
  | "parentTitle"
  | "closed"
  | "archived"
  | "gate"
  | "onClose"
  | "onViewInChannel"
  | "conversationRefsById"
  | "onOpenConversationRef"
  | "onOpenChannelRef"
  | "onOpenTask"
  | "jumpMessageId"
  | "jumpPhase"
  | "onJumped"
  | "onJumpToMessage"
  | "onOpenAdvancedSearch"
  | "advancedSearchSender"
>;

export type ThreadsPaneProps = Pick<
  ComponentProps<typeof ChannelThreadsPanel>,
  "channelId" | "parentTitle" | "onClose" | "onOpenThread"
>;
export type PrimaryPaneModel =
  | { kind: "draft"; props: DraftPaneProps }
  | { kind: "conversation"; props: PrimaryPaneProps };

export type SecondaryPaneModel =
  | { kind: "none" }
  | { kind: "agent"; props: AgentPaneProps }
  | { kind: "human"; props: Pick<ComponentProps<typeof HumanView>, "userId" | "onClose"> }
  | { kind: "files"; props: FilesPaneProps }
  | { kind: "task"; props: TaskPaneProps }
  | { kind: "conversation"; status: "resolved"; props: SidePaneProps }
  | { kind: "conversation"; status: "unresolved"; props: UnresolvedPaneProps }
  | { kind: "thread"; props: ThreadPaneProps; capabilities: ConversationPaneCapabilities }
  | { kind: "threads"; props: ThreadsPaneProps };

export interface ConversationPanesModel {
  primary: PrimaryPaneModel;
  secondary: SecondaryPaneModel;
}
