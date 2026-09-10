import { useMemo, type ReactElement } from "react";
import { SelectionToolbar } from "@/components/chat/selection-toolbar";
import { ImagePreviewModal } from "@/components/chat/image-preview-modal";
import { useAuthorAvatarObjectUrls } from "@/components/chat/author-avatar-hooks";
import type { MessageActionSurface } from "@/components/chat/use-message-action-surface";
import type { MessageRenderContext } from "@/components/chat/use-message-render-context";
import type { WorkspaceChannelReference } from "./conversation-ref";

/** Render context the image-export modal needs: a subset of
 *  `MessageRenderContext` plus the agent avatar batch (lifted per surface
 *  so authors / member chips / activity strip share one fetch). */
export type MessageActionChromeRenderContext = Pick<
  MessageRenderContext,
  "agentsByName" | "humansByName" | "channelsByName" | "viewer" | "viewerAvatarObjectUrl"
> & {
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  conversationRefsById?: ReadonlyMap<string, WorkspaceChannelReference>;
};

/**
 * The selection toolbar + image-export modal for the shared message action
 * surface (`useMessageActionSurface`). Both the channel pane and the thread
 * reply-cluster pane render this so the toolbar/modal wiring lives in one
 * place (#task:1067) and can't drift apart. Drop it where the toolbar
 * should sit — directly above the message list — in either pane.
 */
export function MessageActionChrome({
  surface,
  renderCtx,
  workspaceId,
  conversationId,
  channelTitle,
}: {
  surface: MessageActionSurface;
  renderCtx: MessageActionChromeRenderContext;
  workspaceId: string | null;
  /** The conversation these messages belong to — REQUIRED, because every pane that
   *  renders this chrome is looking at one (#task:2041 B3). With `workspaceId`,
   *  which is the only legitimately nullable half of the coordinate, it projects
   *  the by-number cache scope so the static export reads the SAME cell the live
   *  chip resolved — including a DM (workspaceId null) whose board is the pair
   *  conversation. */
  conversationId: string;
  channelTitle: string | null;
}): ReactElement {
  // The screenshot byline resolves each selected author's avatar bytes STRICTLY
  // from its own `MessageAuthorDto` (#task:1792 B2) — never the live directory.
  // The directory batch (`renderCtx.agentAvatarUrls`) stays for the Markdown
  // body's inline @-mention pills, a separate axis. Active authors already
  // resolved in the live view are session-cached by url, so this is a hit.
  const previewAuthors = useMemo(
    () => surface.previewSnapshots.map((m) => m.author),
    [surface.previewSnapshots],
  );
  const { agentAvatarUrls: authorAgentAvatarUrls, humanAvatarUrls: authorUserAvatarUrls } =
    useAuthorAvatarObjectUrls(previewAuthors);
  return (
    <>
      {surface.selection.active ? (
        <SelectionToolbar
          count={surface.selection.count}
          onCancel={surface.selection.exit}
          onCopyMarkdown={surface.handleCopyMarkdownTranscript}
          onSaveImage={surface.handleSaveImage}
        />
      ) : null}
      <ImagePreviewModal
        open={surface.imagePreviewOpen}
        onOpenChange={surface.setImagePreviewOpen}
        onExportComplete={surface.selection.exit}
        messages={surface.previewSnapshots}
        workspaceId={workspaceId}
        conversationId={conversationId}
        channelTitle={channelTitle}
        agentsByName={renderCtx.agentsByName}
        humansByName={renderCtx.humansByName}
        channelsByName={renderCtx.channelsByName}
        conversationRefsById={renderCtx.conversationRefsById}
        agentAvatarUrls={renderCtx.agentAvatarUrls}
        authorAgentAvatarUrls={authorAgentAvatarUrls}
        authorUserAvatarUrls={authorUserAvatarUrls}
        viewer={renderCtx.viewer}
        viewerAvatarObjectUrl={renderCtx.viewerAvatarObjectUrl}
      />
    </>
  );
}
