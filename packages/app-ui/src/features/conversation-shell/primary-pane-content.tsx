import { ChannelView } from "@/features/conversation-shell/components/channel-view";
import { DirectPairDraftPane } from "@/features/direct-pairs/direct-pair-draft-pane";
import type { PrimaryPaneModel } from "./pane-render-models";

export function PrimaryPaneContent({ model }: { model: PrimaryPaneModel }) {
  switch (model.kind) {
    case "draft":
      // A different participant must never inherit the previous draft's send state.
      return (
        <DirectPairDraftPane
          key={`${model.props.target.kind}:${model.props.target.id}`}
          {...model.props}
        />
      );
    case "conversation":
      return <ChannelView {...model.props} />;
  }
}
