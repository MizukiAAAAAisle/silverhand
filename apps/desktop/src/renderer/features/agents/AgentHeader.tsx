import { useState } from 'react';
import { MessageSquare, Power, Trash2 } from 'lucide-react';
import type { AgentDto, AgentRuntimeStateDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { Button } from '@/components/ui/button';
import { neutralAction } from '@/features/common/ControlInkBorder';
import {
  destructiveAction,
  DESTRUCTIVE_TRIGGER,
} from '@/features/common/DestructiveAction';
import {
  HeroDot,
  PersonHero,
  PresencePill,
} from '@/features/common/PersonHero';
import { useAgentOnlineByHost } from '@/features/hosts/hooks';
import { useStopAgent } from './hooks';
import { useAgentAvatarObjectUrl } from './avatar-hooks';
import { DeleteAgentDialog } from './DeleteAgentDialog';

interface AgentHeaderProps {
  agent: AgentDto;
  runtimeState: AgentRuntimeStateDto | undefined;
  onDeleted: () => void;
  /** Open the direct line with this agent — the existing one, or the pre-mint
   *  draft when there is none. Navigation only: nothing is created by asking for
   *  it (#task:2039). When absent, the Message entry is not offered. */
  onMessageAgent?: (agentId: string) => void;
}

/**
 * Agent panel header. Thin adapter over the shared {@link PersonHero}
 * primitive — owns the agent-specific data wiring (Message draft + Stop button +
 * mutation, Delete dialog, runtime presence aggregation, avatar
 * object URL) and forwards presentation to the Hero. Keeps `AgentView`
 * unchanged at the call site.
 */
export function AgentHeader({
  agent,
  runtimeState,
  onDeleted,
  onMessageAgent,
}: AgentHeaderProps): JSX.Element {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const stopAgent = useStopAgent(agent.id);
  const avatarObjectUrl = useAgentAvatarObjectUrl(agent.avatar_url);
  // Hero status = agent-on-computer liveness (is the agent's runtime live on
  // its computer), read from the same host-status source as the members rail
  // (#task:1362). The Agent page is the agent's global profile, not a
  // conversation — a resident-but-idle agent must read as Online here, else
  // users mistake a live runtime for "no runtime".
  const onlineByAgent = useAgentOnlineByHost([agent.host_id]);
  const online = onlineByAgent.get(agent.id) ?? false;
  // Stop targets conversation-running work, so it keeps the conversation
  // runtime-state predicate: count both `starting` and `active` so an agent
  // mid-spawn doesn't slip past the Stop button between exec and first message.
  const running = (runtimeState?.seats ?? []).filter(
    s => s.status === 'starting' || s.status === 'active',
  );
  const runningCount = running.length;

  // Offer the Message entry only when there is somewhere to go (the caller wires
  // `onMessageAgent`) AND the agent's human line is a DirectPair — i.e. it is
  // agent-scoped. A conversation-scoped agent's human entrance is its
  // workspace/Agent Space, not this door.
  const canMessage = Boolean(onMessageAgent) && agent.session_scope === 'agent';

  return (
    <>
      <PersonHero
        avatar={
          <AgentAvatar
            runtime={agent.runtime}
            size={AVATAR_PX['2xl']}
            avatarObjectUrl={avatarObjectUrl}
            alt={agent.display_name || agent.name}
          />
        }
        displayName={agent.display_name || agent.name}
        handle={agent.name}
        meta={
          <>
            <HeroDot />
            <span className="capitalize">{agent.runtime}</span>
            {agent.model ? (
              <>
                <HeroDot />
                <span>{agent.model}</span>
              </>
            ) : null}
            <HeroDot />
            <PresencePill online={online} />
          </>
        }
        bio={agent.description}
        actions={
          <>
            {/* The hero's action pair is ONE group, ranked by hue, not by how
                loud each button is (shiki 2026-07-26: "agent header 那一对要一起
                看"). Stop is a reversible runtime action → the neutral framed
                rank; Delete is terminal → the same red-on-paper trigger as
                `Delete computer` / `Log out`. Before this, Stop was a bare
                `outline` and Delete a `ghost` with `hover:bg-error/10` — two
                different amounts of "not quite a button" sitting side by side,
                and Delete's alpha-thinned red was the washed recipe already
                rejected elsewhere. Neither is a primary CTA: this page has no
                commit, so nothing here takes a fill. */}
            {/* Message is offered only for agent-scoped agents (the sole scope
                whose human line is a DirectPair). Visibility is product-domain
                only — everyone who can see this page sees the entry (shiki
                xpY0-CI0: "现在全部可见，将来再优化"); the door re-authorizes the
                actual first send. It NAVIGATES: the ordinary chat interface, the
                line's own route when it exists and a draft of the same surface
                when it does not (@shiki, #task:2039 — no modal). */}
            {canMessage && onMessageAgent ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onMessageAgent(agent.id)}
                title={`Message @${agent.name}`}
                {...neutralAction()}
              >
                <MessageSquare className="size-3.5" />
                Message
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={runningCount === 0 || stopAgent.isPending}
              onClick={() => stopAgent.mutate()}
              title={
                runningCount === 0
                  ? 'Nothing is running'
                  : `Hard-stop ${runningCount} running conversation${runningCount === 1 ? '' : 's'}`
              }
              {...neutralAction()}
            >
              <Power className="size-3.5" />
              Stop
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              title="Delete agent…"
              {...destructiveAction(DESTRUCTIVE_TRIGGER)}
            >
              <Trash2 className="size-3.5" />
              Delete
            </Button>
          </>
        }
      />
      <DeleteAgentDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        agent={agent}
        onDeleted={onDeleted}
      />
    </>
  );
}
