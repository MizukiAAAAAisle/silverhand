import { ChannelView } from '@/components/layout/ChannelView';
import { ThreadPanel } from '@/components/layout/ThreadPanel';
import { ChannelThreadsPanel } from '@/components/layout/ChannelThreadsPanel';
import { ChannelAttachmentsPanel } from '@/components/layout/ChannelAttachmentsPanel';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { AgentView } from '@/features/agents/AgentView';
import { SideUnresolvedPlaceholder } from '@/components/layout/SideUnresolvedPlaceholder';
import { ConversationPaneCapabilitiesProvider } from '@/features/conversations/pane-capabilities-context';
import type { SecondaryPaneModel } from './pane-render-models';

export function SecondaryPaneContent({ model }: { model: SecondaryPaneModel }) {
  switch (model.kind) {
    case 'none':
      return null;
    case 'agent':
      return <AgentView variant="side" key={`side-${model.props.agentId}`} {...model.props} />;
    case 'files':
      return <ChannelAttachmentsPanel {...model.props} />;
    case 'task':
      return <TaskDetailPanel key={`task-${model.props.taskId}`} {...model.props} />;
    case 'conversation':
      return model.status === 'resolved' ? (
        <ChannelView {...model.props} />
      ) : (
        <SideUnresolvedPlaceholder {...model.props} />
      );
    case 'thread':
      // A thread inherits the parent's capability; it has no placement of its own.
      return (
        <ConversationPaneCapabilitiesProvider value={model.capabilities}>
          <ThreadPanel {...model.props} />
        </ConversationPaneCapabilitiesProvider>
      );
    case 'threads':
      return <ChannelThreadsPanel {...model.props} />;
  }
}
