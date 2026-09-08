import { ChannelView } from "@/features/conversation-shell/components/channel-view";
import { DirectPairDraftPane } from "@/features/direct-pairs/DirectPairDraftPane";
import type { PrimaryPaneModel } from "./pane-render-models";

export function PrimaryPaneContent({ model }: { model: PrimaryPaneModel }) {
  switch (model.kind) {
    case "draft":
      // A different agent must never inherit the previous draft's send state.
      return <DirectPairDraftPane key={model.props.agentId} {...model.props} />;
    case "conversation":
      return <ChannelView {...model.props} />;
  }
}
