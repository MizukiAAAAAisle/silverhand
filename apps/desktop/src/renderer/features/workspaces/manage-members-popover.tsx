import { WorkspaceMembersSkeleton } from "./workspace-members-skeleton";
import { useMemo, useState, type ReactNode } from "react";
import { UserMinus } from "lucide-react";
import type { AgentDto, WorkspaceRole } from "@silverhand/shared";
import { useNav } from "@/router";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { ApiError } from "@/lib/api";
import { parseApiErrorBody } from "@/lib/api-error-message";
import { useAgents } from "@/features/agent-shell/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { useUsers } from "@/features/users/hooks";
import { MemberCandidatePicker } from "./member-candidate-picker";
import type { MemberCandidate, MemberCandidateGroup } from "./member-search";
import {
  useAddWorkspaceMember,
  useWorkspaceMemberLists,
  useRemoveWorkspaceMember,
  useRemoveWorkspaceHumanMember,
  type WorkspaceHumanMember,
} from "./hooks";

type Candidate = MemberCandidate;

type Member = { kind: "agent"; agent: AgentDto } | { kind: "human"; user: WorkspaceHumanMember };

/** Membership controls retain per-kind, per-verb governance from the workspace roster. */
export function WorkspaceMembersPanel({
  workspaceId,
  onNavigate,
}: {
  workspaceId: string;
  /** Called right before navigating to a member's page — lets the host (e.g. the
   *  settings modal) dismiss itself so the destination isn't opened behind it. */
  onNavigate?: () => void;
}): JSX.Element {
  const nav = useNav();
  const { data: memberLists, isLoading: membersLoading } = useWorkspaceMemberLists(workspaceId);
  const agentMembers = memberLists?.agents ?? [];
  const humanMembers = memberLists?.humans ?? [];
  const agentAvatarUrls = useAgentAvatarObjectUrls(agentMembers);
  // Human avatars use the user-specific batch hook (multi-human audit
  // 2026-06-03 #task:857 P0.8). The shape is structurally identical to
  // the agent batch hook but lives in features/users/avatar-hooks so
  // human-specific affordances (e.g. preferring `HumanMemberDto.avatar_url`
  // when Cindy's backend P0 lands) stay in one place.
  const humanAvatarUrls = useUserAvatarObjectUrls(humanMembers);
  // Agents narrowed by the backend contract, not client-side: `?scope=owned`
  // returns only agents this viewer created (`GET /api/agents`, #task:1256),
  // and "whose agent is mine" is defined there so desktop and CLI agree.
  const { data: agents = [] } = useAgents({ scope: "owned" });
  const { data: users = [] } = useUsers();
  const addMember = useAddWorkspaceMember(workspaceId);
  const removeMember = useRemoveWorkspaceMember(workspaceId);
  const removeHumanMember = useRemoveWorkspaceHumanMember(workspaceId);
  const [error, setError] = useState<string | null>(null);

  // Mirror the backend governance gates so members never see dead controls.
  // The gates are per-kind AND per-verb, because the authority differs
  // (#task:1681, #task:1683): putting an agent in and taking it back out are
  // both its creator's call, so ANY workspace member may add their own agents
  // and remove those same agents (`scope=owned` decides whose, on both verbs);
  // `admin` keeps the whole agent roster, inviting a person is admin+, and
  // removing a person is owner-only. `membersKey` invalidates on
  // `role_changed`, so these flags re-light live after a promotion.
  const viewerRole = memberLists?.viewerRole ?? null;
  const canAddOwnAgents = viewerRole !== null;
  const canAddHumans = viewerRole === "owner" || viewerRole === "admin";
  const canRemoveHumans = viewerRole === "owner";
  const canAddAny = canAddOwnAgents || canAddHumans;

  const ownedAgentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);
  const canRemoveAgent = (agentId: string): boolean =>
    canRemoveWorkspaceAgent(viewerRole, ownedAgentIds, agentId);

  const agentMemberIds = useMemo(() => new Set(agentMembers.map((m) => m.id)), [agentMembers]);
  const humanMemberIds = useMemo(() => new Set(humanMembers.map((h) => h.id)), [humanMembers]);

  // Candidate pool, grouped, agents first (shiki 2026-07-27): every human,
  // plus ONLY the agents the viewer created. Someone else's agent is not
  // third-party-addable — you add the human and they bring their own agents.
  // The creator narrowing lives in the `scope=owned` query above, so a
  // workspace role only decides which *kinds* may be added, never *whose*
  // agents: any member gets the agent group, only admins get the human group.
  const candidateGroups = useMemo<MemberCandidateGroup[]>(() => {
    const agentItems: Candidate[] = canAddOwnAgents
      ? agents
          .filter((a) => !agentMemberIds.has(a.id))
          .map((a) => ({ kind: "agent" as const, agent: a }))
      : [];
    const humanItems: Candidate[] = canAddHumans
      ? users
          .filter((u) => !humanMemberIds.has(u.id))
          .map((u) => ({ kind: "human" as const, user: u }))
      : [];
    return [
      { label: "AGENTS", items: agentItems },
      { label: "HUMANS", items: humanItems },
    ];
  }, [agents, users, agentMemberIds, humanMemberIds, canAddOwnAgents, canAddHumans]);

  // Flat member list (everyone currently enrolled). Agents first, then
  // humans — same ordering contract as the picker, without its labels.
  const members = useMemo<Member[]>(() => {
    const list: Member[] = [];
    for (const a of agentMembers) list.push({ kind: "agent", agent: a });
    for (const u of humanMembers) list.push({ kind: "human", user: u });
    return list;
  }, [agentMembers, humanMembers]);

  const onPick = async (candidate: Candidate): Promise<void> => {
    setError(null);
    try {
      await addMember.mutateAsync(
        candidate.kind === "agent"
          ? { kind: "agent", agent_id: candidate.agent.id }
          : { kind: "human", user_id: candidate.user.id },
      );
    } catch (err) {
      setError(formatAddError(err));
    }
  };

  const handleRemove = async (agentId: string): Promise<void> => {
    setError(null);
    try {
      await removeMember.mutateAsync(agentId);
    } catch (err) {
      setError(formatRemoveAgentError(err));
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

  // Navigate to a member's page. Dismiss the host (settings modal) first so the
  // destination doesn't open behind it. Bare-click only: the remove button
  // stops propagation so its click never reaches the row.
  const handleOpenMember = (m: Member): void => {
    onNavigate?.();
    if (m.kind === "agent") {
      nav.toMembers(m.agent.id);
    } else {
      nav.toMembersUser(m.user.user_id);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Add-member picker — only when the viewer can add at least one kind.
       * Picking a row fires the mutation immediately and clears the query,
       * so enrolling several members in a row is type-Enter-type-Enter.
       * A plain member can only add their own agents, so both the label and
       * the empty hint say agents rather than members. */}
      {canAddAny ? (
        <MemberCandidatePicker
          mode="floating"
          groups={candidateGroups}
          onPick={(c) => void onPick(c)}
          disabled={addMember.isPending}
          ariaLabel={canAddHumans ? "Add member" : "Add agent"}
          emptyHint={
            canAddHumans
              ? "Everyone is already in this workspace"
              : "You have no agents left to add"
          }
        />
      ) : null}

      <Section title={`MEMBERS ${members.length}`}>
        {membersLoading ? (
          <WorkspaceMembersSkeleton />
        ) : members.length === 0 ? (
          <Hint>No members yet</Hint>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map((m) => {
              const id = m.kind === "agent" ? m.agent.id : m.user.id;
              const handle = m.kind === "agent" ? m.agent.name : m.user.name;
              const displayName =
                m.kind === "agent"
                  ? m.agent.display_name || m.agent.name
                  : m.user.display_name || m.user.name;
              return (
                <li
                  key={`${m.kind}:${id}`}
                  data-member-row
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenMember(m)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      handleOpenMember(m);
                    }
                  }}
                  title={`Open ${displayName}`}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-(--chip-radius) border-(length:--control-border-width) border-border-subtle bg-bg-base px-2 text-left transition-colors hover:border-text-primary focus-visible:border-text-primary focus-visible:outline-none"
                >
                  {m.kind === "agent" ? (
                    <AgentAvatar
                      runtime={m.agent.runtime}
                      size={AVATAR_PX.sm}
                      avatarObjectUrl={agentAvatarUrls.get(m.agent.id) ?? null}
                      alt={displayName}
                    />
                  ) : (
                    <UserAvatar
                      size={AVATAR_PX.sm}
                      avatarObjectUrl={humanAvatarUrls.get(m.user.id) ?? null}
                      alt={displayName}
                    />
                  )}
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {displayName}
                    </span>
                    <span className="truncate font-mono text-(length:--text-meta) text-text-muted">
                      @{handle}
                    </span>
                  </span>
                  {/* Agent remove (DELETE …/members/:agentId): admin+ for the
                   * whole roster, and any member for an agent they created —
                   * the symmetric half of enrolling it (#task:1683). */}
                  {m.kind === "agent" && canRemoveAgent(m.agent.id) ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemove(m.agent.id);
                      }}
                      disabled={removeMember.isPending}
                      aria-label="Remove"
                      title="Remove member"
                      className="ml-auto flex size-6 items-center justify-center rounded-(--chip-radius) text-text-muted hover:text-error disabled:opacity-60"
                    >
                      <UserMinus className="size-3.5" />
                    </button>
                  ) : null}
                  {/* Human remove is owner-only (DELETE …/members/users/:userId).
                   * The owner row never renders it — UI mirror of the backend
                   * `owner_removal_unsupported`, so removing an owner can't even
                   * be attempted. */}
                  {m.kind === "human" && canRemoveHumans && m.user.role !== "owner" ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleRemoveHuman(m.user.user_id);
                      }}
                      disabled={removeHumanMember.isPending}
                      aria-label="Remove"
                      title="Remove member"
                      className="ml-auto flex size-6 items-center justify-center rounded-(--chip-radius) text-text-muted hover:text-error disabled:opacity-60"
                    >
                      <UserMinus className="size-3.5" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {error ? <div className="text-xs text-error">{error}</div> : null}
    </div>
  );
}

/**
 * One-line user-facing message for workspace add-member errors.
 * Prefer the backend's structured error code when present; fall
 * back to status / generic text otherwise.
 */
function formatAddError(err: unknown): string {
  if (err instanceof ApiError) {
    const { code, detail } = parseApiErrorBody(err.body);
    // #task:1681 — the picker only offers the viewer's own agents, so this is
    // a backstop for a stale pool. It states the rule because the generic 403
    // line below would read as "you lack a role", which is the wrong diagnosis:
    // enrollment is creator-only, and NO role substitutes for it. The remedy
    // names the creator rather than a step the reader may not be able to take
    // (adding that creator to the workspace is itself `admin` governance), and
    // never an admin, who collects the identical refusal here (#task:1683).
    if (code === "agent_not_owned") {
      return "You can only add agents you created. Someone else's can be brought in only by its creator.";
    }
    if (err.status === 403)
      return "You do not have permission to manage members of this workspace.";
    if (err.status === 404) {
      if (detail === "user not found") return "This user does not exist or has been deleted.";
      if (detail === "agent not found") return "This agent does not exist or has been deleted.";
      return "This workspace does not exist.";
    }
    if (err.status === 400) return "Invalid parameters. Please refresh and try again.";
    return `Failed to add member (HTTP ${err.status}).`;
  }
  return "Failed to add member. Please try again.";
}

/**
 * One-line user-facing message for agent-member remove errors. The control is
 * gated to admins and to the viewer's own agents, so `agent_not_owned` is a
 * backstop for a stale pool — it still gets its own line, because the generic
 * 403 would read as "you lack a role", which is the wrong diagnosis
 * (#task:1683).
 */
function formatRemoveAgentError(err: unknown): string {
  if (err instanceof ApiError) {
    const { code } = parseApiErrorBody(err.body);
    if (code === "agent_not_owned") {
      return "You can only remove agents you created. Ask a workspace admin for the others.";
    }
    if (err.kind === "backend_unreachable") return "Remove failed: cannot reach the backend.";
    if (err.status === 403) return "You do not have permission to remove this member.";
    if (err.status === 404) return "This member does not exist or has already been removed.";
    return `Failed to remove member (HTTP ${err.status}).`;
  }
  return "Failed to remove member. Please try again.";
}

/**
 * One-line user-facing message for human-member remove errors. The UI gates
 * the control to owners and hides it on the owner row, so 403 / 400
 * (`owner_removal_unsupported`) should be unreachable — they are mapped
 * anyway as a backstop in case state is stale.
 */
function formatRemoveHumanError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === "backend_unreachable") return "Remove failed: cannot reach the backend.";
    if (err.status === 403)
      return "You do not have permission to remove this member (owner required).";
    if (err.status === 400) return "Cannot remove the workspace owner.";
    if (err.status === 404) return "This member does not exist or has already been removed.";
    return `Failed to remove member (HTTP ${err.status}).`;
  }
  return "Failed to remove member. Please try again.";
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="text-(length:--text-badge) font-medium uppercase tracking-wider text-text-muted">
        {title}
      </div>
      {children}
    </section>
  );
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-1 text-xs italic text-text-muted">{children}</div>;
}

/**
 * Whether this viewer may remove THIS agent from the workspace — the mirror of
 * `DELETE /api/workspaces/:id/members/:agentId` (#task:1683). Two arms, OR'd,
 * exactly as the route has them:
 *
 *  - `admin`/`owner` govern the whole agent roster, including agents they could
 *    never have enrolled themselves;
 *  - any member may retract an agent they CREATED, because whoever may put one
 *    in must be able to take it back out without an admin.
 *
 * Ownership is the `scope=owned` id set, not a client-side derivation, and a
 * viewer of unknown role (no workspace membership resolved yet) gets nothing:
 * the row simply has no remove affordance until the role is known.
 */
export function canRemoveWorkspaceAgent(
  viewerRole: WorkspaceRole | null,
  ownedAgentIds: ReadonlySet<string>,
  agentId: string,
): boolean {
  if (viewerRole === null) return false;
  if (viewerRole === "owner" || viewerRole === "admin") return true;
  return ownedAgentIds.has(agentId);
}
