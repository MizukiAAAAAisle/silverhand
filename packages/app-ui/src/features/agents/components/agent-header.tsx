import { ProfileHeaderContent } from "@/features/profile/profile-header-content";
import { useState } from "react";
import { DeleteIcon, MessageIcon, PowerIcon } from "@/icons";
import type { AgentDto, AgentRuntimeStateDto } from "@silverhand/shared";
import { AgentAvatar } from "@/components/agent-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { iconMarkup } from "@/components/layout/native-page-bar";
import { SidePanelHeader } from "@/components/layout/side-panel-header";
import { ProfileHeaderAction as HeaderAction } from "@/features/profile/profile-header-action";
import { useAgentPresence, useStopAgent } from "../hooks/hooks";
import { projectPresence, PRESENCE_TONE_DOT } from "../model/presence-projection";
import { useAgentAvatarObjectUrl } from "../hooks/avatar-hooks";
import { DeleteAgentDialog } from "./delete-agent-dialog";

interface AgentHeaderProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
  onDeleted: () => void;
  onClose?: () => void;
  mode: "full" | "side";
  onMessageAgent?: (agentId: string) => void;
}

export function AgentHeader({
  agent,
  runtimeState,
  onDeleted,
  onMessageAgent,
  onClose,
  mode,
}: AgentHeaderProps): JSX.Element {
  const compact = mode === "side";

  const [deleteOpen, setDeleteOpen] = useState(false);

  const stopAgent = useStopAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  const presence = useAgentPresence(agent.id);

  // Availability describes the agent globally; seats only decide whether Stop is actionable.
  const runningCount = (runtimeState?.seats ?? []).filter(
    (seat) => seat.status === "starting" || seat.status === "active",
  ).length;
  const canMessage = Boolean(onMessageAgent) && agent.session_scope === "agent";
  const displayName = agent.display_name || agent.name;
  const presenceDisplay = presence === null ? null : projectPresence({ scope: "global", presence });

  const statusDot = presenceDisplay ? (
    <span
      role="img"
      aria-label={presenceDisplay.a11yLabel}
      title={presenceDisplay.detail}
      className={`size-1.5 shrink-0 self-center rounded-full ${PRESENCE_TONE_DOT[presenceDisplay.tone]}`}
    />
  ) : null;

  const avatar = (
    <AgentAvatar
      runtime={agent.runtime}
      size={compact ? AVATAR_PX.md : AVATAR_PX.xl}
      avatarObjectUrl={avatarObjectUrl}
      alt={displayName}
    />
  );

  const actions = (
    <>
      {canMessage && onMessageAgent ? (
        <HeaderAction
          compact={compact}
          label="Message"
          title={`Message @${agent.name}`}
          onClick={() => onMessageAgent(agent.id)}
        >
          <MessageIcon className="size-3.5" />
        </HeaderAction>
      ) : null}
      <HeaderAction
        compact={compact}
        label="Stop"
        title={
          runningCount === 0
            ? "Nothing is running"
            : `Hard-stop ${runningCount} running session${runningCount === 1 ? "" : "s"}`
        }
        disabled={runningCount === 0 || stopAgent.isPending}
        onClick={() => stopAgent.mutate()}
      >
        <PowerIcon className="size-3.5" />
      </HeaderAction>
      {!compact ? (
        <HeaderAction
          compact={compact}
          label="Delete"
          title="Delete agent…"
          destructive
          onClick={() => setDeleteOpen(true)}
        >
          <DeleteIcon className="size-3.5" />
        </HeaderAction>
      ) : null}
    </>
  );

  const content = (
    <ProfileHeaderContent
      compact={compact}
      avatar={avatar}
      displayName={displayName}
      status={statusDot}
      description={agent.description}
      actions={actions}
    />
  );

  return (
    <>
      {compact ? (
        <SidePanelHeader
          onClose={onClose}
          nativeBar={{
            title: displayName,
            subtitle: presenceDisplay?.a11yLabel,
            titleAction: null,
            actions: [
              [
                ...(canMessage
                  ? [
                      {
                        id: "message",
                        label: `Message @${agent.name}`,
                        icon: iconMarkup(MessageIcon),
                      },
                    ]
                  : []),
                ...(runningCount > 0
                  ? [
                      {
                        id: "stop",
                        label: `Hard-stop ${runningCount} running session${runningCount === 1 ? "" : "s"}`,
                        icon: iconMarkup(PowerIcon),
                      },
                    ]
                  : []),
              ],
            ].filter((group) => group.length > 0),
            tabs: null,
            addTabs: null,
          }}
          nativeHandlers={{
            action: ({ id }) => {
              if (id === "message") {
                onMessageAgent?.(agent.id);
              } else if (id === "stop" && !stopAgent.isPending) {
                stopAgent.mutate();
              }
            },
          }}
        >
          {content}
        </SidePanelHeader>
      ) : (
        <header className="agent-header-full">{content}</header>
      )}
      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agent={agent}
        onDeleted={onDeleted}
      />
    </>
  );
}
