import { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { Plus } from 'lucide-react';
import type { AgentDto, MemberDto, UserDto, WorkspaceRole } from '@silverhand/shared';
import { ApiError } from '@/lib/api';
import { MemberCandidatePicker } from '../workspaces/MemberCandidatePicker';
import type {
  MemberCandidate,
  MemberCandidateGroup,
} from '../workspaces/member-search';
import { useWorkspaceMemberLists } from '../workspaces/hooks';
import { useConversationMembers } from './useConversationMembers';
import { useAddConversationMember } from './useAddConversationMember';
import { useAgents } from '@/features/agents/hooks';
import { useUsers } from '@/features/users/hooks';

export interface AddConversationMemberPopoverProps {
  workspaceId: string;
  conversationId: string;
}

/** The picker's own props: the two ids plus how it is opened. The PICKER is the
 *  reusable part — its per-candidate grading (see below) must never be
 *  re-derived by a second surface — while the trigger is the surface's own
 *  affordance. */
interface AddConversationMemberPopoverOptions
  extends AddConversationMemberPopoverProps {
  /** Replaces the default `+` chip. The node is the Radix trigger itself
   *  (`asChild`), so the consumer owns its glyph, label and box — the members
   *  modal opens the SAME picker from a full-width "Add member" row at its
   *  bottom (shiki 2026-07-28) rather than shipping a second candidate list. */
  trigger?: React.ReactNode;
  /** Which trigger edge the panel aligns to. `end` suits the header chip row
   *  (the `+` is the row's last item); `center` is what the members modal uses,
   *  where the trigger spans the modal's content width inside symmetric padding
   *  — a centred panel of the modal's own width then sits flush with the modal
   *  (shiki 2026-07-28), without this file or the caller restating the dialog's
   *  padding. */
  align?: 'start' | 'center' | 'end';
  /** Open as a MODAL popover. Needed when the trigger lives inside a Radix
   *  Dialog (the members modal): the Dialog wraps its content in
   *  `react-remove-scroll`, which blocks wheel/touch scroll everywhere OUTSIDE
   *  its subtree — and this panel is PORTALED to the body, so its candidate
   *  list could not be scrolled with a wheel/trackpad (#task:1785). A modal
   *  popover puts its own content on top of the scroll-lock stack, so the list
   *  scrolls again. The header `+` opens the panel outside any dialog, where no
   *  lock exists, so it stays non-modal to avoid locking page scroll for a
   *  low-key affordance. */
  modal?: boolean;
  /** Panel width (a Tailwind width class). Defaults to the compact
   *  `w-[260px]` that suits the header `+` chip (shiki #task:1923 — the
   *  360px it used to share with the modal was too wide for a low-key
   *  affordance). The members modal passes `w-[360px]` to stay flush with
   *  its own `max-w-[360px]` — the same coupling `align="center"` relies on
   *  (shiki 2026-08-09: the two header entries may differ in width). */
  widthClass?: string;
}

/**
 * The conversation member picker, plus the trigger that opens it — by default
 * the `+` chip trailing the conversation-header member strip.
 *
 * The default trigger sits flush in the chip row with no resting fill — only a
 * subtle hover background — so it reads as a low-key affordance rather
 * than competing with the avatar chips beside it. A consumer may pass its own
 * `trigger` (the members modal's bottom "Add member" row): the picker is the
 * part that must not be duplicated, because a second candidate list would mean
 * a second answer to "who may I add".
 *
 * Inside, the popover lists every eligible member that is NOT yet in this
 * conversation.
 *
 * Who may write this roster is TWO independent factors on the route
 * (#task:1683), and the surface mirrors them in the same order:
 *
 *  1. the FLOOR — membership of THIS conversation, target-independent. That
 *     is the caller's `gate.allowMutations`, so by the time this component
 *     renders the floor is already met; owning an agent is never a way into a
 *     channel you are not in.
 *  2. the TARGET — graded by kind, and for an agent by OWNERSHIP:
 *     - the viewer's OWN agents: any member of this conversation may add
 *       them, whether or not they are in the workspace yet (a non-member gets
 *       auto-enrolled, which is its creator's call anyway).
 *     - someone else's agent, and every human: workspace `admin` governance,
 *       so those two pools appear for admins/owners only. Governance is the
 *       ROSTER, not enrollment — a foreign agent that is not in the workspace
 *       yet is nobody's to bring but its creator's, which is why the admin
 *       agent pool is workspace members plus the viewer's own.
 *
 * Ownership is never re-derived here — it is the pool from
 * `useAgents({ scope: 'owned' })`, the backend's single authority for "mine".
 *
 * Agents join from ANY computer (#task:1600 — cross-computer membership; a
 * guest member's L2 seeds on its own computer), so no pool is ever filtered
 * by host. Members are first-class regardless of kind, so the row treats
 * them uniformly: avatar + display name + `@handle` on a single line, with
 * the avatar component picked by kind.
 *
 * Caller is responsible for the conversation-shaped guards (DM channel,
 * closed conversation, non-member viewer). The route enforces every guard
 * again as defense-in-depth, but narrowing the pools keeps the surface
 * intentional: no row here is one the server would refuse.
 */
export function AddConversationMemberPopover({
  workspaceId,
  conversationId,
  trigger,
  align = 'end',
  modal = false,
  widthClass = 'w-[260px]',
}: AddConversationMemberPopoverOptions): JSX.Element {
  return (
    <Popover.Root modal={modal}>
      <Popover.Trigger asChild>
        {trigger ?? (
          <button
            type="button"
            aria-label="Add member to this conversation"
            title="Add member"
            data-member-chip="add"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-[var(--control-radius)] border-0 bg-transparent p-0 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary focus-outline"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={6}
          collisionPadding={8}
          data-popover-frame="info"
          // Width is `widthClass` (default compact `w-[260px]`; the modal
          // passes `w-[360px]` to stay flush with its own edges — see the prop
          // doc). The two header entries are allowed to differ: the member-strip
          // `+` is a low-key affordance, the modal's row aligns to the modal.
          className={`${widthClass} z-[var(--z-dialog)] rounded-md border border-border bg-bg-floating p-3 shadow-popover outline-none`}
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
  // The floor (membership of this conversation) is the caller's gate; what is
  // left here is the TARGET grading: `admin` opens the people roster and other
  // people's agents, ownership (`scope: 'owned'` — the backend's single
  // authority for "mine") opens the viewer's own agents (#task:1683).
  const viewerRole = memberLists.data?.viewerRole ?? null;
  const canAddOthers = canAddForeignConversationMembers(viewerRole);
  const humans = useUsers();
  const ownedAgents = useAgents({ scope: 'owned' });
  const conversationMembers = useConversationMembers(conversationId);
  const addMember = useAddConversationMember(conversationId, workspaceId);

  const [error, setError] = useState<string | null>(null);

  const wsAgents: AgentDto[] = memberLists.data?.agents ?? [];
  const wsHumans: UserDto[] = memberLists.data?.humans ?? [];
  const pickableHumans = useMemo(() => {
    if (!canAddOthers) return [];
    const workspaceIds = new Set(wsHumans.map(u => u.id));
    const externalHumans = (humans.data ?? []).filter(u => !workspaceIds.has(u.id));
    return [...wsHumans, ...externalHumans];
  }, [canAddOthers, wsHumans, humans.data]);
  const pickableAgents = useMemo(
    () => computePickableAgents(wsAgents, ownedAgents.data ?? [], viewerRole),
    [wsAgents, ownedAgents.data, viewerRole],
  );

  // Set of `agent:<id>` / `human:<id>` for current conversation members. Used
  // to narrow the pools to "not yet in conversation".
  const inConversation = useMemo(() => {
    const set = new Set<string>();
    if (conversationMembers.status === 'resolved') {
      for (const m of conversationMembers.members) set.add(memberKey(m));
    }
    return set;
  }, [conversationMembers]);

  // Candidate pool for the picker, grouped agents-then-humans and narrowed to
  // who is NOT yet in this conversation. Query narrowing is the picker's job,
  // not ours — a kind with no candidates drops out so its header never sits
  // above an empty list. Mirrors the workspace picker's AGENTS / HUMANS groups.
  const groups = useMemo<MemberCandidateGroup[]>(
    () =>
      [
        {
          label: 'AGENTS',
          items: pickableAgents
            .filter(a => !inConversation.has(`agent:${a.id}`))
            .map(a => ({ kind: 'agent' as const, agent: a })),
        },
        {
          label: 'HUMANS',
          items: pickableHumans
            .filter(u => !inConversation.has(`human:${u.id}`))
            .map(u => ({ kind: 'human' as const, user: u })),
        },
      ].filter(g => g.items.length > 0),
    [pickableAgents, pickableHumans, inConversation],
  );

  const onPick = async (c: MemberCandidate): Promise<void> => {
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
    || (canAddOthers && !humans.data)
    || !ownedAgents.data
    || conversationMembers.status === 'loading';

  return (
    <MemberCandidatePicker
      mode="inline"
      groups={groups}
      onPick={c => void onPick(c)}
      rowsDisabled={addMember.isPending}
      autoFocus
      ariaLabel="Add member"
      emptyHint={
        isLoading
          ? 'Loading…'
          : canAddOthers
            ? 'Everyone is already in this conversation'
            : 'You have no agents left to add'
      }
      footer={
        error ? (
          <div role="alert" className="text-xs text-error">
            {error}
          </div>
        ) : null
      }
    />
  );
}

// ── Helpers ──────────────────────────────────────────────────────

function memberKey(m: MemberDto): string {
  return m.kind === 'agent' ? `agent:${m.agent_id}` : `human:${m.user_id}`;
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
        // A backstop, not a live state: a human caller no longer reaches this
        // code on this route — a candidate outside the workspace is enrolled by
        // this very action (shiki's design, reaffirmed 2026-07-28), and a caller
        // without that authority is refused `agent_not_owned` earlier in
        // `addConversationMember`. It survives only for a non-human principal
        // (the CLI), so the line states the rule rather than prescribing the
        // manual step the product does for you.
        return 'Only the person who created this agent can bring it into the workspace.';
      case 'agent_not_owned':
        // #task:1683 — the picker offers a plain member only their own agents,
        // so this is a backstop for a stale pool. Two targets land here and the
        // remedy differs, which is why `admin` is stated CONDITIONALLY (Cindy,
        // #task:1682 review): a workspace admin governs the roster, but NOT
        // enrollment — an agent that is not in this workspace yet is refused
        // `agent_not_owned` for an admin too (`conversation-member.ts` →
        // `addWorkspaceAgentMember`'s creator gate). Naming admin flatly would
        // send the user to someone who hits the same 403; the creator is the
        // one exit that holds in both cases, so it comes first.
        return "You can only add agents you created. Someone else's needs its creator, or a workspace admin once it is in this workspace.";
      case 'host_attach_pending':
        return 'Its computer is not connected yet.';
      case 'candidate_not_found':
        return 'This candidate no longer exists.';
      case 'handle_ambiguous':
        return 'Several candidates share this handle.';
      case 'conversation_member_add_unsupported':
        return 'Members can be added to a channel or a thread, not a DM.';
      case 'conversation_closed':
        return "This conversation is closed. Members can't be added.";
      default:
        break;
    }
    if (err.status === 403)
      return "You don't have permission to add members here.";
    if (err.status === 404) return 'This conversation no longer exists.';
    return `Can't add the member (HTTP ${err.status}).`;
  }
  return "Can't add the member. Try again.";
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

/**
 * Whether this viewer may put someone OTHER than their own agents on this
 * roster — every human, and agents somebody else created. That half of
 * `addConversationMember` is still workspace `admin` governance (#task:1683);
 * the own-agent half needs no role at all, only membership of this
 * conversation, which the caller has already established.
 */
export function canAddForeignConversationMembers(
  viewerRole: WorkspaceRole | null,
): boolean {
  return viewerRole === 'owner' || viewerRole === 'admin';
}

/**
 * Pickable agents for this conversation, graded by the target rather than by
 * the surface (#task:1683):
 *
 *  - any member of this conversation may add the agents they CREATED — in the
 *    workspace already or not, since a non-member gets auto-enrolled and that
 *    is the creator's call. So the whole `ownedAgents` pool is offered.
 *  - `admin`/`owner` additionally govern the roster, so every workspace agent
 *    is offered whoever created it (a pure roster action, nothing enrolled).
 *
 * A plain member is therefore NOT offered someone else's agent — the server
 * answers that with 403 `agent_not_owned`, so it would be a dead row.
 * Ownership is not re-derived here: it is expressed by the pool this receives,
 * from `useAgents({ scope: 'owned' })`.
 *
 * The membership FLOOR is deliberately absent from this signature — it is
 * target-independent and belongs to the call site (`gate.allowMutations`), and
 * folding it in here would let a role or an owned agent look like a way into a
 * channel the viewer is not in.
 *
 * #task:1600 — cross-computer membership: no pool is narrowed by the
 * workspace's storage computer (guest members are legal; their L2 seeds on
 * their own daemon), which is why this helper takes NO host argument.
 * Falsifier-tested in `AddConversationMemberPopover.test.ts`.
 */
export function computePickableAgents(
  wsAgents: AgentDto[],
  ownedAgents: AgentDto[],
  viewerRole: WorkspaceRole | null,
): AgentDto[] {
  if (!canAddForeignConversationMembers(viewerRole)) return ownedAgents;
  const workspaceIds = new Set(wsAgents.map(a => a.id));
  return [...wsAgents, ...ownedAgents.filter(a => !workspaceIds.has(a.id))];
}
