import { useMemo } from 'react';
import type { AgentDto, UserDto } from '@silverhand/shared';
import { useAgents } from '@/features/agents/hooks';
import { useUsers, makeUserNameResolver } from '@/features/users/hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import {
  useWorkspaces,
  useChannelsForWorkspace,
  useArchivedChannelsForWorkspace,
  type ChannelListItem,
} from '@/features/workspaces/hooks';
import { useConversationMembers } from '@/features/conversations/useConversationMembers';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerAvatarObjectUrl,
  useViewerUser,
} from '@/features/me/hooks';
import type { UserNameResolver } from '@/lib/current-user';
import type { ChannelReference } from './ChannelRef';

/**
 * Single source of truth for the lookup maps every message-rendering
 * surface needs (channel pane + thread reply-cluster pane). Both
 * `ChannelView`'s `MessageList` and `ThreadPanel` consume this so an
 * inline `@mention` / `#<channel>` / `#conv:` / `#task:` sigil resolves
 * IDENTICALLY no matter which pane renders the message.
 *
 * Previously `MessageList` and `ThreadPanel` each hand-built a slice of
 * this context; ThreadPanel's slice was incomplete (empty
 * `channelsByName`, no `#conv:` refs) which made thread messages render
 * sigils as inert text — the divergence this hook removes (#task:1052).
 *
 * Scope boundary: this hook owns the *identity + sigil-resolution* maps
 * and the per-user avatar batch (`humanAvatarUrls`). It deliberately
 * does NOT build the AGENT avatar batch (`agentAvatarUrls`): that one is
 * lifted by the caller so message authors, the member strip, and the
 * activity bubble share a single batch fetch (Cindy's batching
 * discipline — leaf surfaces must not double-fetch avatar blobs). The
 * caller passes its lifted `agentAvatarUrls` straight to `MessageItem`.
 *
 * The raw `liveChannels` / `archivedChannels` lists are exposed too so
 * non-render consumers (e.g. the export-screenshot channel title) reuse
 * the same already-fetched data instead of refetching.
 */
export interface MessageRenderContext {
  /** Author lookup by `from_agent_id` (avatar + display name). */
  agentsById: Map<string, AgentDto>;
  /** `@handle` mention lookup (agents). */
  agentsByName: Map<string, AgentDto>;
  /** User lookup by `users.id` for user-authored rows. */
  humansById: Map<string, UserDto>;
  /** `@handle` mention lookup (humans, same namespace as agents). */
  humansByName: Map<string, UserDto>;
  /** `#<channel_name>` ref lookup keyed by channel title. `null` value
   *  = ambiguity sentinel (multiple channels share that title). */
  channelsByName: Map<string, ChannelReference | null>;
  /** Per-user avatar object-URL batch (single fetch for the surface). */
  humanAvatarUrls: Map<string, string | null>;
  /** Current viewer's avatar object URL (or null). */
  viewerAvatarObjectUrl: string | null;
  /** Resolved viewer row, or undefined when registration isn't complete
   *  / backend is unreachable. Already guarded — callers pass it through
   *  to `MessageItem` without re-checking. */
  viewer: UserDto | undefined;
  /** `user_id` → display-name resolver for foreign-author fallbacks. */
  userResolver: UserNameResolver;
  /** Raw workspace channel lists (exposed for non-render consumers). */
  liveChannels: ChannelListItem[];
  archivedChannels: ChannelListItem[];
}

export function useMessageRenderContext(
  workspaceId: string,
  conversationId: string,
  membersEnabled = true,
): MessageRenderContext {
  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  const { data: workspaces = [] } = useWorkspaces();
  // Resolve `#<channel_name>` against the message's workspace (not the
  // primary-selected one) so cross-workspace panes resolve their own
  // refs. Both queries short-circuit (`enabled: false`) until the
  // workspace kind is known, so they emit empty arrays in that window.
  const workspaceKind: 'regular' | 'dm' | null =
    workspaces.find(w => w.id === workspaceId)?.kind ?? null;
  const { data: liveChannels = [] } = useChannelsForWorkspace(
    workspaceId,
    workspaceKind,
  );
  const { data: archivedChannels = [] } = useArchivedChannelsForWorkspace(
    workspaceId,
    workspaceKind,
  );
  const { data: rawViewer } = useViewerUser();
  const viewer =
    rawViewer &&
    !isRegistrationRequired(rawViewer) &&
    !isBackendUnreachable(rawViewer)
      ? rawViewer
      : undefined;
  const viewerAvatarObjectUrl = useViewerAvatarObjectUrl();
  const humanAvatarUrls = useUserAvatarObjectUrls(users);
  // The conversation roster feeds ONLY @human-mention chip resolution
  // (`humansByName` below). It is a member surface: a non-member
  // browsing a public channel must not fetch it, so pass a null id to disable
  // both the query and its WS side-scope interest. Author display names come
  // from the global `useUsers()` (`humansById`), not the roster, so reading the
  // stream is unaffected — only unresolved @human chips degrade to plain text.
  const conversationMembers = useConversationMembers(
    membersEnabled ? conversationId : null,
  );

  const { agentsById, agentsByName } = useMemo(() => {
    const byId = new Map<string, AgentDto>();
    const byName = new Map<string, AgentDto>();
    for (const a of agents) {
      byId.set(a.id, a);
      byName.set(a.name, a);
    }
    return { agentsById: byId, agentsByName: byName };
  }, [agents]);

  const humansById = useMemo(() => {
    const byId = new Map<string, UserDto>();
    for (const user of users) byId.set(user.id, user);
    if (viewer) byId.set(viewer.id, viewer);
    return byId;
  }, [users, viewer]);

  const userResolver = useMemo(
    () => makeUserNameResolver(humansById),
    [humansById],
  );

  const humansByName = useMemo(() => {
    const byName = new Map<string, UserDto>();
    if (conversationMembers.status === 'resolved') {
      for (const member of conversationMembers.members) {
        if (member.kind !== 'human') continue;
        const user = humansById.get(member.user_id);
        if (user) byName.set(user.name, user);
      }
    }
    if (viewer) byName.set(viewer.name, viewer);
    return byName;
  }, [conversationMembers.status, conversationMembers.members, humansById, viewer]);

  // Channel-name lookup keyed by `title`. A shared title records the
  // ambiguity sentinel `null` so `<ChannelRef>` degrades to inert text
  // rather than guess a target.
  const channelsByName = useMemo(() => {
    const m = new Map<string, ChannelReference | null>();
    if (workspaceKind === null) return m;
    const consider = (c: ChannelListItem): void => {
      const title = c.title;
      if (m.has(title)) {
        m.set(title, null);
        return;
      }
      m.set(title, {
        id: c.id,
        title: c.title,
        closed_at: c.closed_at ?? null,
        archived_at: c.archived_at ?? null,
      });
    };
    for (const c of liveChannels) consider(c);
    for (const c of archivedChannels) consider(c);
    return m;
  }, [workspaceKind, liveChannels, archivedChannels]);

  return {
    agentsById,
    agentsByName,
    humansById,
    humansByName,
    channelsByName,
    humanAvatarUrls,
    viewerAvatarObjectUrl,
    viewer,
    userResolver,
    liveChannels,
    archivedChannels,
  };
}
