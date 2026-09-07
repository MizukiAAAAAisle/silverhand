import { SectionShell } from '@/components/layout/SectionShell';
import { SectionLayer } from '@/components/layout/SectionLayer';
import { ActivityView } from '@/components/layout/ActivityView';
import { VerticalSplitter } from '@/components/layout/VerticalSplitter';
import { useResizableWidth } from '@/hooks/useResizableWidth';
import type { ActivityShellModel } from '@/features/conversation-shell/conversation-shell-models';
import type { ConversationContent } from '@/features/conversation-shell/conversation-content';
import { ConversationStage } from '@/features/conversation-shell/conversation-stage';

export function ActivityShell({
  model,
  content,
  fullscreen,
}: {
  model: ActivityShellModel;
  content: ConversationContent;
  fullscreen: boolean;
}) {
  const {
    appSection,
    selectedChannelId,
    agentsById,
    workspaceRefById,
    deferredSection,
    handleJumpToMessageStable,
  } = model;
  const activityList = useResizableWidth({
    storageKey: 'silverhand.layout.activity-list-width',
    defaultWidth: 360,
    min: 280,
    max: 560,
    cssVar: '--activity-list-width',
  });

  return (
    <>
      {deferredSection === 'activity' && (
        <SectionLayer visible={appSection !== 'chat'}>
          <SectionShell
            name="activity"
            fill={selectedChannelId == null}
            width="var(--activity-list-width)"
            sidebar={
              <ActivityView
                workspaceRefById={workspaceRefById}
                agentsById={agentsById}
                onJump={handleJumpToMessageStable}
              />
            }
            splitter={
              selectedChannelId != null ? (
                <VerticalSplitter
                  onPointerDown={activityList.startResize}
                  active={activityList.isDragging}
                />
              ) : null
            }
          >
            {selectedChannelId != null ? (
              <ConversationStage
                content={content}
                ready={appSection === 'activity'}
                fullscreen={fullscreen}
                storageKey="silverhand.layout.activity-split-ratio"
              />
            ) : null}
          </SectionShell>
        </SectionLayer>
      )}
    </>
  );
}
