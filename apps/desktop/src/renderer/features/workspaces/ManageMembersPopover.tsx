import { useMemo, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as Select from '@radix-ui/react-select';
import { ChevronDown, Trash2, UserPlus } from 'lucide-react';
import type { AddWorkspaceMemberInput, AgentDto, UserDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { ApiError } from '@/lib/api';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { useUsers } from '@/features/users/hooks';
import {
  useAddWorkspaceMember,
  useWorkspaceMemberLists,
  useRemoveWorkspaceMember,
  useRemoveWorkspaceHumanMember,
  type WorkspaceHumanMember,
} from './hooks';

interface ManageMembersPopoverProps {
  workspaceId: string;
  /** The clickable element that triggers the popover (rendered as the
   *  Radix Trigger via `asChild`, so callers control the visual). */
  children: ReactNode;
}

/**
 * Anchored member-management surface for a workspace — shadcn-style.
 * Top: a unified selector that immediately enrolls the picked
 * candidate (agent or human); below that, a single MEMBERS section
 * lists everyone currently in the workspace. Agents and humans are
 * intentionally not split out — both are first-class members and the
 * grouping label would imply otherwise.
 *
 * Replaces the previous modal `ManageMembersDialog` so the action
 * stays anchored to its trigger in the titlebar.
 *
 * Role gating mirrors the backend governance gates, per-kind (a member must
 * never see a control that would only 403): agent add/remove and human add
 * need admin+, while human remove needs owner. So the add selector hides
 * entirely for plain members and is full for admins/owners; the agent Trash2
 * shows for admin+, the human Trash2 only for owners and never on the owner
 * row. `membersKey` invalidates on `role_changed`, so a promotion re-lights
 * these controls live.
 *
 * Removal: agents have a Trash2 row action backed by `DELETE
 * /api/workspaces/:id/members/:agentId` (admin+). Humans have a Trash2 backed
 * by `DELETE /api/workspaces/:id/members/users/:userId` (owner-only); the
 * owner row never renders it (UI mirror of the backend
 * `owner_removal_unsupported`, so removing an owner can't be attempted).
 */
export function ManageMembersPopover({
  workspaceId,
  children,
}: ManageMembersPopoverProps): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-popover-frame="info"
          className="z-50 w-[280px] rounded-md border border-border bg-bg-floating p-3 shadow-popover outline-none"
        >
          <PopoverBody workspaceId={workspaceId} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

type Candidate =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'human'; user: UserDto };

type Member =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'human'; user: WorkspaceHumanMember };

// Split body out so the React-Query hooks below only mount once the
// popover actually opens (Radix unmounts Content when closed).
function PopoverBody({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data: memberLists, isLoading: membersLoading } =
    useWorkspaceMemberLists(workspaceId);
  const agentMembers = memberLists?.agents ?? [];
  const humanMembers = memberLists?.humans ?? [];
  const agentAvatarUrls = useAgentAvatarObjectUrls(agentMembers);
  // Human avatars use the user-specific batch hook (multi-human audit
  // 2026-06-03 #task:857 P0.8). The shape is structurally identical to
  // the agent batch hook but lives in features/users/avatar-hooks so
  // human-specific affordances (e.g. preferring `HumanMemberDto.avatar_url`
  // when Cindy's backend P0 lands) stay in one place.
  const humanAvatarUrls = useUserAvatarObjectUrls(humanMembers);
  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  // Candidate avatars (the dropdown pool — separate from the
  // enrolled-members map above so cache keys are stable per surface).
  const candidateAgentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const candidateHumanAvatarUrls = useUserAvatarObjectUrls(users);
  const addMember = useAddWorkspaceMember(workspaceId);
  const removeMember = useRemoveWorkspaceMember(workspaceId);
  const removeHumanMember = useRemoveWorkspaceHumanMember(workspaceId);
  const [error, setError] = useState<string | null>(null);

  // Mirror the backend governance gates so members never see dead controls.
  // Agent add/remove and human add are admin+; human remove is owner-only
  // (`DELETE /api/workspaces/:id/members/users/:userId`). Gating is per-kind,
  // not a popover-level boolean, because agents and humans share one
  // selector/list. `membersKey` invalidates on `role_changed`, so these flags
  // re-light live after a promotion — no manual refresh.
  const viewerRole = memberLists?.viewerRole ?? null;
  const canManageAgents = viewerRole === 'owner' || viewerRole === 'admin';
  const canAddHumans = viewerRole === 'owner' || viewerRole === 'admin';
  const canRemoveHumans = viewerRole === 'owner';
  const canAddAny = canManageAgents || canAddHumans;

  const agentMemberIds = useMemo(
    () => new Set(agentMembers.map(m => m.id)),
    [agentMembers],
  );
  const humanMemberIds = useMemo(
    () => new Set(humanMembers.map(h => h.id)),
    [humanMembers],
  );

  // Flat candidate list (members not yet enrolled), filtered to what the
  // viewer may actually add: agents need admin+, humans need owner. Agents
  // listed first, then humans — a stable ordering without a section label.
  const candidates = useMemo<Candidate[]>(() => {
    const list: Candidate[] = [];
    if (canManageAgents) {
      for (const a of agents) {
        if (!agentMemberIds.has(a.id)) list.push({ kind: 'agent', agent: a });
      }
    }
    if (canAddHumans) {
      for (const u of users) {
        if (!humanMemberIds.has(u.id)) list.push({ kind: 'human', user: u });
      }
    }
    return list;
  }, [agents, users, agentMemberIds, humanMemberIds, canManageAgents, canAddHumans]);

  // Flat member list (everyone currently enrolled). Same ordering
  // contract as `candidates`.
  const members = useMemo<Member[]>(() => {
    const list: Member[] = [];
    for (const a of agentMembers) list.push({ kind: 'agent', agent: a });
    for (const u of humanMembers) list.push({ kind: 'human', user: u });
    return list;
  }, [agentMembers, humanMembers]);

  // Encode the kind in the Select value because Radix Select only
  // accepts string values; one onValueChange handler dispatches both
  // mutation shapes.
  const onPick = async (value: string): Promise<void> => {
    if (!value) return;
    setError(null);
    try {
      const input = decodeCandidate(value);
      await addMember.mutateAsync(input);
    } catch (err) {
      setError(formatAddError(err));
    }
  };

  const handleRemove = async (agentId: string): Promise<void> => {
    setError(null);
    try {
      await removeMember.mutateAsync(agentId);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemoveHuman = async (userId: string): Promise<void> => {
    setError(null);
    try {
      await removeHumanMember.mutateAsync(userId);
    } catch (err) {
      setError(formatRemoveHumanError(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Add-member selector — only when the viewer can add at least one
        * kind. Choosing an option fires the mutation and clears the value so
        * the trigger reverts to its placeholder (controlled value="" so
        * picking the same candidate twice is fine). The label narrows to
        * "添加成员" for every admin+ viewer. */}
      {canAddAny ? (
        <Select.Root
          value=""
          onValueChange={v => void onPick(v)}
          disabled={addMember.isPending}
        >
          <Select.Trigger
            aria-label={canAddHumans ? 'Add member' : 'Add agent'}
            className="flex h-8 w-full items-center justify-between gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2.5 text-sm text-text-primary outline-none transition-colors hover:border-[color:var(--border-control-hover)] focus:border-border-focus disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-text-muted"
          >
            <span className="flex items-center gap-1.5">
              <UserPlus className="size-3.5 text-text-muted" />
              <Select.Value
                placeholder={canAddHumans ? 'Add member…' : 'Add agent…'}
              />
            </span>
            <Select.Icon>
              <ChevronDown className="size-3.5 text-text-muted" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              sideOffset={4}
              className="z-[60] max-h-[40vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg-floating shadow-popover"
            >
              <Select.Viewport className="p-1">
                {candidates.length === 0 ? (
                  <div className="px-2 py-2 text-center text-xs italic text-text-muted">
                    All candidates are already in the Workspace
                  </div>
                ) : (
                  candidates.map(c => {
                    const value = candidateValue(c);
                    const handle = c.kind === 'agent' ? c.agent.name : c.user.name;
                    const displayName =
                      c.kind === 'agent'
                        ? c.agent.display_name || c.agent.name
                        : c.user.display_name || c.user.name;
                    return (
                      <Select.Item
                        key={value}
                        value={value}
                        className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
                      >
                        {c.kind === 'agent' ? (
                          <AgentAvatar
                            runtime={c.agent.runtime}
                            size={18}
                            avatarObjectUrl={
                              candidateAgentAvatarUrls.get(c.agent.id) ?? null
                            }
                            alt={displayName}
                          />
                        ) : (
                          <UserAvatar
                            size={18}
                            avatarObjectUrl={
                              candidateHumanAvatarUrls.get(c.user.id) ?? null
                            }
                            alt={displayName}
                          />
                        )}
                        <Select.ItemText>
                          <span className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate font-medium">
                              {displayName}
                            </span>
                            <span className="truncate font-mono text-[11px] text-text-muted">
                              @{handle}
                            </span>
                          </span>
                        </Select.ItemText>
                      </Select.Item>
                    );
                  })
                )}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      ) : null}

      <Section title={`MEMBERS · ${members.length}`}>
        {membersLoading ? (
          <Hint>Loading…</Hint>
        ) : members.length === 0 ? (
          <Hint>No members yet</Hint>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map(m => {
              const id = m.kind === 'agent' ? m.agent.id : m.user.id;
              const handle = m.kind === 'agent' ? m.agent.name : m.user.name;
              const displayName =
                m.kind === 'agent'
                  ? m.agent.display_name || m.agent.name
                  : m.user.display_name || m.user.name;
              return (
                <li
                  key={`${m.kind}:${id}`}
                  className="flex h-8 items-center gap-2 rounded-[var(--chip-radius)] border border-border-subtle bg-bg-base px-2"
                >
                  {m.kind === 'agent' ? (
                    <AgentAvatar
                      runtime={m.agent.runtime}
                      size={20}
                      avatarObjectUrl={agentAvatarUrls.get(m.agent.id) ?? null}
                      alt={displayName}
                    />
                  ) : (
                    <UserAvatar
                      size={20}
                      avatarObjectUrl={humanAvatarUrls.get(m.user.id) ?? null}
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
                  {/* Agent remove is admin+ (DELETE …/members/:agentId,
                    * minRole admin). */}
                  {m.kind === 'agent' && canManageAgents ? (
                    <button
                      type="button"
                      onClick={() => handleRemove(m.agent.id)}
                      disabled={removeMember.isPending}
                      aria-label="Remove"
                      title="Remove member"
                      className="ml-auto flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-60"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                  {/* Human remove is owner-only (DELETE …/members/users/:userId).
                    * The owner row never renders it — UI mirror of the backend
                    * `owner_removal_unsupported`, so removing an owner can't even
                    * be attempted. */}
                  {m.kind === 'human' &&
                  canRemoveHumans &&
                  m.user.role !== 'owner' ? (
                    <button
                      type="button"
                      onClick={() => handleRemoveHuman(m.user.user_id)}
                      disabled={removeHumanMember.isPending}
                      aria-label="Remove"
                      title="Remove member"
                      className="ml-auto flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-60"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {error ? (
        <div className="text-xs text-error">{error}</div>
      ) : null}
    </div>
  );
}

function candidateValue(c: Candidate): string {
  return c.kind === 'agent' ? `agent:${c.agent.id}` : `human:${c.user.id}`;
}

function decodeCandidate(value: string): AddWorkspaceMemberInput {
  const sep = value.indexOf(':');
  if (sep <= 0) throw new Error(`malformed candidate value: ${value}`);
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (kind === 'agent') return { kind: 'agent', agent_id: id };
  if (kind === 'human') return { kind: 'human', user_id: id };
  throw new Error(`unknown candidate kind: ${kind}`);
}

/**
 * One-line user-facing message for workspace add-member errors.
 * Prefer the backend's structured error code when present; fall
 * back to status / generic text otherwise.
 */
function formatAddError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You do not have permission to manage members of this workspace.';
    if (err.status === 404) {
      try {
        const parsed = JSON.parse(err.body) as { error?: string };
        if (parsed.error === 'user not found') return 'This user does not exist or has been deleted.';
        if (parsed.error === 'agent not found') return 'This agent does not exist or has been deleted.';
      } catch {
        /* swallow — fall through */
      }
      return 'This workspace does not exist.';
    }
    if (err.status === 400) return 'Invalid parameters. Please refresh and try again.';
    return `Failed to add member (HTTP ${err.status}).`;
  }
  return 'Failed to add member. Please try again.';
}

/**
 * One-line user-facing message for human-member remove errors. The UI gates
 * the control to owners and hides it on the owner row, so 403 / 400
 * (`owner_removal_unsupported`) should be unreachable — they are mapped
 * anyway as a backstop in case state is stale.
 */
function formatRemoveHumanError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === 'backend_unreachable') return 'Remove failed: cannot reach the backend.';
    if (err.status === 403) return 'You do not have permission to remove this member (owner required).';
    if (err.status === 400) return 'Cannot remove the workspace owner.';
    if (err.status === 404) return 'This member does not exist or has already been removed.';
    return `Failed to remove member (HTTP ${err.status}).`;
  }
  return 'Failed to remove member. Please try again.';
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
        {title}
      </div>
      {children}
    </section>
  );
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-1 text-xs italic text-text-muted">{children}</div>;
}
