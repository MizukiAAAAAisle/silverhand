import { SplitPane } from "@/components/layout/SplitPane";
import { ConversationViewSkeleton } from "@/components/layout/ConversationViewSkeleton";
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
    return <ConversationViewSkeleton />;
  }
  if (content.secondary && fullscreen) {
    return content.secondary;
  }
  return <SplitPane left={content.primary} right={content.secondary} storageKey={storageKey} />;
}
