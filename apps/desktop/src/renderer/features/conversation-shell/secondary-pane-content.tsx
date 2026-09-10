import { HumanView } from "@/features/profile/human-view";
import { ChannelView } from "@/features/conversation-shell/components/channel-view";
import { ThreadPanel } from "@/features/conversation-shell/components/thread-panel";
import { ChannelThreadsPanel } from "@/features/conversation-shell/components/channel-threads-panel";
import { ChannelAttachmentsPanel } from "@/features/conversation-shell/components/channel-attachments-panel";
import { TaskDetailPanel } from "@/features/task-shell/components/task-detail-panel";
import { AgentView } from "@/features/agent-shell/components/agent-view";
import { SideUnresolvedPlaceholder } from "@/features/conversation-shell/components/side-unresolved-placeholder";
import { ConversationPaneCapabilitiesProvider } from "@/features/conversations/pane-capabilities-context";
import type { SecondaryPaneModel } from "./pane-render-models";

export function SecondaryPaneContent({ model }: { model: SecondaryPaneModel }) {
  switch (model.kind) {
    case "none":
      return null;
    case "agent":
      return <AgentView mode="side" key={`side-${model.props.agentId}`} {...model.props} />;
    case "human":
      return <HumanView variant="side" key={`human-${model.props.userId}`} {...model.props} />;
    case "files":
      return <ChannelAttachmentsPanel {...model.props} />;
    case "task":
      return <TaskDetailPanel key={`task-${model.props.taskId}`} {...model.props} />;
    case "conversation":
      return model.status === "resolved" ? (
        <ChannelView {...model.props} />
      ) : (
        <SideUnresolvedPlaceholder {...model.props} />
      );
    case "thread":
      // A thread inherits the parent's capability; it has no placement of its own.
      return (
        <ConversationPaneCapabilitiesProvider value={model.capabilities}>
          <ThreadPanel {...model.props} />
        </ConversationPaneCapabilitiesProvider>
      );
    case "threads":
      return <ChannelThreadsPanel {...model.props} />;
  }
}
