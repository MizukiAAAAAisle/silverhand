import { SplitPane } from "@/components/layout/split-pane";
import { ConversationViewSkeleton } from "@/features/conversation-shell/components/conversation-view-skeleton";
import type { ConversationContent } from "./conversation-content";

export function ConversationStage({
  content,
  ready,
  fullscreen,
  storageKey,
}: {
  content: ConversationContent;
  ready: boolean;
  fullscreen: boolean;
  storageKey: string;
}) {
  if (!ready) {
    return (
      <ConversationViewSkeleton
        showTabs={content.loadingTabs && !(content.secondary && fullscreen)}
      />
    );
  }
  if (content.secondary && fullscreen) {
    return content.secondary;
  }
  return <SplitPane left={content.primary} right={content.secondary} storageKey={storageKey} />;
}
