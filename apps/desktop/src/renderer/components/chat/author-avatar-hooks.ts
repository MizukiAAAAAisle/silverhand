import { useMemo } from "react";
import type { MessageAuthorDto } from "@silverhand/shared";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { collectAuthorAvatarSources } from "./author-presentation";

/**
 * Resolve avatar bytes for a set of message/thread authors STRICTLY from their
 * own {@link MessageAuthorDto}s (#task:1792 B2), never a live-directory join.
 *
 * A surface passes the exact author DTOs it renders; only the `active` arm's
 * `avatar_url` enters the batch (see {@link collectAuthorAvatarSources}), so a
 * byline's image and name share ONE source — the DTO — and a `deleted` /
 * `unresolved` author draws its neutral glyph with no fetch and no directory
 * lookup. The returned maps drop straight into `AuthorAvatarView`'s
 * `agentAvatarUrls` / `humanAvatarUrls` props.
 *
 * Directory-backed avatar batches remain correct for INDEPENDENT facets — the
 * hover popover's extra detail, @mention chips, sender-filter options — which
 * resolve arbitrary actors, not the row's own author.
 */
export function useAuthorAvatarObjectUrls(authors: ReadonlyArray<MessageAuthorDto | null>): {
  agentAvatarUrls: Map<string, string | null>;
  humanAvatarUrls: Map<string, string | null>;
} {
  const { agents, users } = useMemo(() => collectAuthorAvatarSources(authors), [authors]);
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const humanAvatarUrls = useUserAvatarObjectUrls(users);
  return { agentAvatarUrls, humanAvatarUrls };
}
