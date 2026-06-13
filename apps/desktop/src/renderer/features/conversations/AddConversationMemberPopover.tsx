import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Plus, Search } from 'lucide-react';
import type { AgentDto, MemberDto, UserDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { useUsers } from '@/features/users/hooks';
import { ApiError } from '@/lib/api';
import { useWorkspaceMemberLists, useWorkspaces } from '../workspaces/hooks';
import { useConversationMembers } from './useConversationMembers';
import { useAddConversationMember } from './useAddConversationMember';

export interface AddConversationMemberPopoverProps {
  workspaceId: string;
  conversationId: string;
}

/**
 * `+` button trailing the conversation-header member strip + the
 * Radix popover that anchors a member picker to it.
 *
 * The trigger sits flush in the chip row with no resting fill — only a
 * subtle hover background — so it reads as a low-key affordance rather
 * than competing with the avatar chips beside it. Inside, the popover
 * lists every eligible member that is NOT yet in this conversation:
 * workspace agents + humans, and (for workspace admins/owners) both
 * humans and agents from the global directory. Targets outside the
 * workspace are eligible for governance users because the server's
 * add-member use case provisions the workspace membership first under
 * the same admin-level guard — humans via a plain roster insert, agents
 * via the placement / L2-seed / capability-default path. External agents
 * are filtered to the workspace's own host (`host_id` match) because an
 * agent can only join a workspace on its own host, so cross-host agents
 * would always fail placement — hiding them keeps the picker free of
 * dead candidates. Members are first-class regardless of kind, so the
 * row treats them uniformly: avatar + display name + `@handle` on a
 * single line, with the avatar component picked by kind.
 *
 * Caller is responsible for hiding this affordance when the
 * conversation shouldn't accept adds (DM channel, closed conversation,
 * non-member viewer). The route enforces the same guards as
 * defense-in-depth, but hiding the trigger keeps the surface
 * intentional: the only way to see the add-member popover is when
 * it should actually work.
 */
export function AddConversationMemberPopover({
  workspaceId,
  conversationId,
}: AddConversationMemberPopoverProps): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Add member to this conversation"
          title="Add member"
          data-member-chip="add"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] border-0 bg-transparent p-0 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          <Plus className="size-3.5" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-popover-frame="info"
          className="z-50 w-[280px] rounded-md border border-border bg-bg-floating p-3 shadow-lg outline-none"
        >
          <PopoverBody
            workspaceId={workspaceId}
            conversationId={conversationId}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Body splits out so React Query hooks only mount once Radix opens
// the popover (Content is not rendered while closed).
function PopoverBody({
  workspaceId,
  conversationId,
}: AddConversationMemberPopoverProps): JSX.Element {
  const memberLists = useWorkspaceMemberLists(workspaceId);
  const viewerRole = memberLists.data?.viewerRole ?? null;
  // Governance users (owner/admin) may pull targets from the global
  // directory; the server auto-provisions workspace membership on add.
  // Same gate for humans and agents (agent workspace-add is admin-level).
  const canPickGlobal = viewerRole === 'owner' || viewerRole === 'admin';
  const humans = useUsers({ enabled: canPickGlobal });
  const agents = useAgents({ enabled: canPickGlobal });
  const workspaces = useWorkspaces();
  const conversationMembers = useConversationMembers(conversationId);
  const addMember = useAddConversationMember(conversationId, workspaceId);

  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const wsAgents: AgentDto[] = memberLists.data?.agents ?? [];
  const wsHumans: UserDto[] = memberLists.data?.humans ?? [];
  // The workspace's own host. External agents must match it to be
  // pickable — an agent can only join a workspace on its own host, so a
  // cross-host pick would always fail placement. Null while the
  // workspace list loads; no agent's `host_id` matches null, so external
  // agents simply appear once it resolves (gated by `isLoading` below).
  const workspaceHostId =
    workspaces.data?.find(w => w.id === workspaceId)?.workspace_host_id ?? null;
  const pickableHumans = useMemo(() => {
    if (!canPickGlobal) return wsHumans;
    const workspaceIds = new Set(wsHumans.map(u => u.id));
    const externalHumans = (humans.data ?? []).filter(u => !workspaceIds.has(u.id));
    return [...wsHumans, ...externalHumans];
  }, [canPickGlobal, wsHumans, humans.data]);
  const pickableAgents = useMemo(() => {
    if (!canPickGlobal) return wsAgents;
    const workspaceIds = new Set(wsAgents.map(a => a.id));
    const externalAgents = (agents.data ?? []).filter(
      a => !workspaceIds.has(a.id) && a.host_id === workspaceHostId,
    );
    return [...wsAgents, ...externalAgents];
  }, [canPickGlobal, wsAgents, agents.data, workspaceHostId]);
  const agentAvatars = useAgentAvatarObjectUrls(pickableAgents);
  const humanAvatars = useUserAvatarObjectUrls(pickableHumans);

  // Set of `agent:<id>` / `human:<id>` for current conversation
  // members. Used to filter workspace members down to "not yet in
  // conversation".
  const inConversation = useMemo(() => {
    const set = new Set<string>();
    if (conversationMembers.status === 'resolved') {
      for (const m of conversationMembers.members) set.add(memberKey(m));
    }
    return set;
  }, [conversationMembers]);

  const candidates = useMemo<PickableMember[]>(() => {
    const q = query.trim().toLowerCase();
    const list: PickableMember[] = [];
    for (const a of pickableAgents) {
      if (inConversation.has(`agent:${a.id}`)) continue;
      if (q && !matchesAgent(a, q)) continue;
      list.push({ kind: 'agent', agent: a });
    }
    for (const u of pickableHumans) {
      if (inConversation.has(`human:${u.id}`)) continue;
      if (q && !matchesHuman(u, q)) continue;
      list.push({ kind: 'human', user: u });
    }
    return list;
  }, [pickableAgents, pickableHumans, inConversation, query]);

  const onPick = async (c: PickableMember): Promise<void> => {
    setError(null);
    try {
      if (c.kind === 'agent') {
        await addMember.mutateAsync({ kind: 'agent', agent_id: c.agent.id });
      } else {
        await addMember.mutateAsync({ kind: 'human', user_id: c.user.id });
      }
      // Filter immediately picks up the new member via the
      // `useConversationMembers` invalidation; no manual close.
    } catch (err) {
      setError(formatError(err));
    }
  };

  const isLoading =
    !memberLists.data
    || (canPickGlobal && (!humans.data || !agents.data || !workspaces.data))
    || conversationMembers.status === 'loading';

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 rounded-[var(--control-radius)] border border-border-subtle bg-bg-base px-2.5 py-1.5">
        <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden />
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search by name or @handle"
          autoFocus
          className="w-full min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
        />
      </label>

      <ul className="flex max-h-[40vh] flex-col gap-0.5 overflow-y-auto">
        {candidates.length === 0 ? (
          <li className="px-2 py-3 text-center text-xs italic text-text-muted">
            {isLoading
              ? '加载中…'
              : query
                ? '没有匹配项'
                : '所有可添加成员都已在此会话'}
          </li>
        ) : (
          candidates.map(c => {
            const displayName =
              c.kind === 'agent'
                ? c.agent.display_name || c.agent.name
                : c.user.display_name || c.user.name;
            const handle = c.kind === 'agent' ? c.agent.name : c.user.name;
            return (
              <li key={candidateKey(c)}>
                <button
                  type="button"
                  onClick={() => void onPick(c)}
                  disabled={addMember.isPending}
                  className="flex w-full items-center gap-2 rounded-[var(--chip-radius)] px-2 py-1.5 text-left transition-colors hover:bg-bg-hover disabled:opacity-60"
                >
                  {c.kind === 'agent' ? (
                    <AgentAvatar
                      runtime={c.agent.runtime}
                      size={20}
                      avatarObjectUrl={agentAvatars.get(c.agent.id) ?? null}
                      alt={displayName}
                    />
                  ) : (
                    <UserAvatar
                      size={20}
                      avatarObjectUrl={humanAvatars.get(c.user.id) ?? null}
                      alt={displayName}
                    />
                  )}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {displayName}
                    </span>
                    <span className="truncate font-mono text-[11px] text-text-muted">
                      @{handle}
                    </span>
                  </span>
                </button>
              </li>
            );
          })
        )}
      </ul>

      {error ? (
        <div role="alert" className="text-xs text-error">
          {error}
        </div>
      ) : null}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────

type PickableMember =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'human'; user: UserDto };

function memberKey(m: MemberDto): string {
  return m.kind === 'agent' ? `agent:${m.agent_id}` : `human:${m.user_id}`;
}

function candidateKey(c: PickableMember): string {
  return c.kind === 'agent' ? `agent:${c.agent.id}` : `human:${c.user.id}`;
}

function matchesAgent(a: AgentDto, q: string): boolean {
  if (a.name.toLowerCase().includes(q)) return true;
  if ((a.display_name ?? '').toLowerCase().includes(q)) return true;
  return false;
}

function matchesHuman(u: UserDto, q: string): boolean {
  if (u.name.toLowerCase().includes(q)) return true;
  if ((u.display_name ?? '').toLowerCase().includes(q)) return true;
  return false;
}

/**
 * Map a backend error to a one-line user-facing message. Mirrors the
 * locked error code set Cindy committed in `d243460` so the renderer
 * never silently shows "HTTP 422".
 */
function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const code = parseCode(err.body);
    switch (code) {
      case 'workspace_membership_required':
        return 'Agent 需要先加入 workspace 后才能添加。';
      case 'host_mismatch':
        // Defensive: the picker filters cross-host agents out, so this
        // only surfaces on a race. Agents can't join a workspace on a
        // different host.
        return 'Agent 不在此 workspace 的 host 上,无法加入。';
      case 'host_attach_pending':
        return '当前 host 未连接,稍后再试。';
      case 'candidate_not_found':
        return '候选不存在,可能刚被删除。';
      case 'handle_ambiguous':
        return '同名候选有多个,无法消歧。';
      case 'conversation_member_add_unsupported':
        return '只能向 channel 或 thread 添加成员(DM 不支持)。';
      case 'conversation_closed':
        return '该会话已关闭,无法添加成员。';
      default:
        break;
    }
    if (err.status === 403) return '没有权限向此会话添加成员。';
    if (err.status === 404) return '该会话已不存在。';
    return `添加失败 (HTTP ${err.status})。`;
  }
  return '添加失败,请重试。';
}

function parseCode(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}
