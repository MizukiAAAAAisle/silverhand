import type {
  AttachmentDto,
  ChannelLeaveBlockedReason,
  ConversationAgentRuntimeDto,
  ConversationVisibility,
} from "@silverhand/shared";
import type { MessageJumpTarget } from "@/features/channels/useMessageJumpController";
import type { PanelTabKind } from "@/features/conversation-shell/model/conversation-tabs";
import { ChannelAttachmentsContent } from "@/features/conversation-shell/components/channel-attachments-panel";
import { ChannelThreadsContent } from "@/features/conversation-shell/components/channel-threads-panel";
import { ChannelAddMemberEntry, ChannelMembersContent } from "./members-dialog";

/**
 * The custom-tab HOST for a conversation surface. It owns only the tab's
 * container: a full-height column that fills the main pane and its own padding —
 * no title (the tab chip is the title), no close (Remove lives on the chip's
 * context menu), no `open` lifecycle.
 *
 * It shares NO shell with the side panel / modal: the only reused units are the
 * three surfaces' content components, which read their own authorities and adapt
 * to the width of whatever container they land in. Hence no `variant` prop and
 * no way for a content component to learn which host it is under.
 */
export function ConversationPanelTab({
  panel,
  channelId,
  workspaceId,
  onJumpToMessage,
  onOpenAttachment,
  onOpenThread,
  agentRuntime,
  agentAvatarUrls,
  onLeave,
  canLeave,
  leaveBlockedReason,
  addMemberWorkspaceId,
  visibility,
}: {
  panel: PanelTabKind;
  channelId: string;
  workspaceId: string | null;
  onJumpToMessage: (target: MessageJumpTarget) => void;
  onOpenAttachment?: (attachment: AttachmentDto) => void;
  onOpenThread?: (rootMessageId: string) => void;
  agentRuntime: readonly ConversationAgentRuntimeDto[] | undefined;
  agentAvatarUrls: Map<string, string | null>;
  onLeave?: () => Promise<void>;
  canLeave?: boolean;
  leaveBlockedReason?: ChannelLeaveBlockedReason | null;
  addMemberWorkspaceId?: string;
  visibility?: ConversationVisibility;
}): JSX.Element | null {
  switch (panel) {
    case "attachments":
      return (
        // This host's inset. Pane-edge gutter is the container's, not the
        // surface's — so the same content sits at a different distance from the
        // edge here than in the narrow side panel, and its width rules read the
        // box that is left.
        <div className="flex h-full min-h-0 flex-col px-3">
          <ChannelAttachmentsContent
            channelId={channelId}
            workspaceId={workspaceId}
            onJumpToMessage={onJumpToMessage}
            onOpenAttachment={onOpenAttachment}
          />
        </div>
      );
    case "threads":
      if (!onOpenThread) return null;
      return (
        <div className="flex h-full min-h-0 flex-col px-3">
          <ChannelThreadsContent channelId={channelId} onOpenThread={onOpenThread} />
        </div>
      );
    case "members":
      return (
        <div className="flex h-full min-h-0 flex-col overflow-y-auto px-3 py-3">
          {/* Add member is a natural-width top action — no divider, no restyle:
              same primary poster as the modal, just sized to its label instead
              of stretched to a banner, so it reads as the roster's action above
              the HUMANS/AGENTS columns. Gate is the header `+`'s add-member
              floor. */}
          {addMemberWorkspaceId ? (
            <div className="mb-3">
              <ChannelAddMemberEntry
                workspaceId={addMemberWorkspaceId}
                conversationId={channelId}
                align="start"
              />
            </div>
          ) : null}
          <ChannelMembersContent
            channelId={channelId}
            agentRuntime={agentRuntime}
            agentAvatarUrls={agentAvatarUrls}
            onLeave={onLeave}
            canLeave={canLeave}
            leaveBlockedReason={leaveBlockedReason}
            visibility={visibility}
          />
        </div>
      );
  }
}
