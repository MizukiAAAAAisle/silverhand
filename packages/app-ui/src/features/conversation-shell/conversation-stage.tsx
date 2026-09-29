import { useCompactLayout } from "@/navigation/layout";
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
  const compact = useCompactLayout();
  if (!ready) {
    return (
      <ConversationViewSkeleton
        showTabs={content.loadingTabs && !(content.secondary && fullscreen)}
      />
    );
  }
  if (content.secondary && (fullscreen || compact)) {
    return content.secondary;
  }
  if (compact) return content.primary;
  return <SplitPane left={content.primary} right={content.secondary} storageKey={storageKey} />;
}
