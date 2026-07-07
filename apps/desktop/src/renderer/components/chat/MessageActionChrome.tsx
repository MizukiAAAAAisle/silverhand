import type { ReactElement } from 'react';
import { SelectionToolbar } from '@/components/chat/SelectionToolbar';
import { ImagePreviewModal } from '@/components/chat/ImagePreviewModal';
import type { MessageActionSurface } from '@/components/chat/useMessageActionSurface';
import type { MessageRenderContext } from '@/components/chat/useMessageRenderContext';
import type { ConversationReference } from './ConversationRef';

/** Render context the image-export modal needs: a subset of
 *  `MessageRenderContext` plus the agent avatar batch (lifted per surface
 *  so authors / member chips / activity strip share one fetch). */
export type MessageActionChromeRenderContext = Pick<
  MessageRenderContext,
  | 'agentsById'
  | 'agentsByName'
  | 'humansByName'
  | 'channelsByName'
  | 'viewer'
  | 'viewerAvatarObjectUrl'
> & {
  agentAvatarUrls: ReadonlyMap<string, string | null>;
  conversationRefsById?: ReadonlyMap<string, ConversationReference>;
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
  channelTitle,
}: {
  surface: MessageActionSurface;
  renderCtx: MessageActionChromeRenderContext;
  workspaceId: string | null;
  channelTitle: string | null;
}): ReactElement {
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
        channelTitle={channelTitle}
        agentsById={renderCtx.agentsById}
        agentsByName={renderCtx.agentsByName}
        humansByName={renderCtx.humansByName}
        channelsByName={renderCtx.channelsByName}
        conversationRefsById={renderCtx.conversationRefsById}
        agentAvatarUrls={renderCtx.agentAvatarUrls}
        viewer={renderCtx.viewer}
        viewerAvatarObjectUrl={renderCtx.viewerAvatarObjectUrl}
      />
    </>
  );
}
