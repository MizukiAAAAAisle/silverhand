import { useMemo } from "react";
import type { ComposerActivity } from "@silverhand/client";
import { BotIcon } from "@/icons";
import { agentAvatarImage } from "@/components/agent-avatar";
import { iconMarkup } from "@/components/layout/native-page-bar";
import { useAgentRunStates } from "@/features/channels/hooks";
import { useAgents } from "@/features/agents/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agents/hooks/avatar-hooks";
import { activityLineOf, selectActiveRunStates } from "../model/composer-activity";

const FACES = 3;

/**
 * The activity line for the native composer to draw: the faces of the agents
 * running, the leading one's name and state, and when it started. It is the
 * web line's resting state without the snippet, which a phone has no room for.
 */
export function useNativeComposerActivity(
  conversationId: string | null,
  restrictToAgentIds: readonly string[] | null | undefined,
  enabled: boolean,
): ComposerActivity | undefined {
  const { data: runStates = [] } = useAgentRunStates(enabled ? conversationId : null);
  const { data: directoryAgents = [] } = useAgents();
  const active = useMemo(
    () => selectActiveRunStates(runStates, restrictToAgentIds),
    [runStates, restrictToAgentIds],
  );
  const shown = useMemo(
    () =>
      active
        .slice(0, FACES)
        .flatMap((state) => directoryAgents.find((agent) => agent.id === state.agentId) ?? []),
    [directoryAgents, active],
  );
  const avatarUrls = useAgentAvatarObjectUrls(shown);

  const line = enabled ? activityLineOf(active, (id) => shown.find((a) => a.id === id)) : null;
  if (!line) {
    return undefined;
  }

  const title = line.others > 0 ? `${line.name} +${line.others}` : line.name;
  const detail = line.badge ?? line.status;
  const faces = active.slice(0, FACES).map((state) => {
    const agent = shown.find((candidate) => candidate.id === state.agentId);
    const image = agent ? agentAvatarImage(agent.runtime, avatarUrls.get(agent.id) ?? null) : null;
    return image ? { image } : { glyph: iconMarkup(BotIcon), ground: true };
  });

  return {
    id: line.subject.agentId,
    faces,
    title,
    detail,
    since: line.subject.startedAt,
    label: `${title}, ${detail}`,
  };
}
