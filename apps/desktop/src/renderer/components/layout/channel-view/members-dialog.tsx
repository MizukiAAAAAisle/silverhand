/**
 * #task:1687 — the channel members modal, opened from the header's Members
 * button or from the member strip's `+N` chip.
 *
 * It is the one surface that lists a channel's WHOLE roster, so it owns the
 * roster-scoped actions and nothing else:
 *
 *  - per row: remove that member from this channel (the viewer's OWN row shows
 *    Leave instead — a different verb with its own backend gating);
 *  - in the title cluster: `Restart all agents` / `Stop all agents`, moved out of
 *    the channel header (shiki 2026-07-28) with their original glyphs. They are
 *    `DialogCornerButton`s, so they are the close ✕'s twins in every theme
 *    (forza6 poster sticker included) without restating its skin here.
 *  - at the bottom: `Add member`, which opens the SHARED
 *    `AddConversationMemberPopover` (shiki 2026-07-28) and is this modal's ONE
 *    primary action (`primaryAction()` — the CTA token cluster, so its fill is
 *    each theme's own primary colour, never a literal). The modal contributes an
 *    entry, not a second picker: whom the viewer may add stays that component's
 *    per-candidate answer (own agents / other people's / humans), so this
 *    surface never re-derives it and cannot offer a row the route would refuse.
 *    Whether the entry appears follows the same channel-member FLOOR as the
 *    header `+` — the caller passes the workspace only when that holds.
 *
 * Per-agent runtime controls (restart / stop / clear session) intentionally stay
 * in `AgentInfoPopover` — one agent's runtime is identity-card business, and
 * duplicating them per row would put two definitions of the same control in the
 * app (shiki: "for each single agent 的 stop/restart 暂时不进这个 modal").
 *
 * PERMISSION IS HIDE, NOT DISABLE (shiki 2026-07-28: "不要给出按钮但是 disabled
 * 这种状态,backend 当然要守住正确权限"). Every action cell renders only when the
 * viewer may use it, so an absent icon means "not yours to do" and the column
 * never becomes a wall of dead affordances. The per-row authority is the
 * backend's viewer-scoped `member_removability` carrier (#task:1688) — NOT a
 * renderer re-derivation: the human arm depends on the target's workspace role
 * plus three channel-exit guards the client cannot see. It fail-closes to false.
 *
 * Leave being blocked by STATE (channel owner / last member / archived) is the
 * one exception, and it is a narrow one: the viewer's OWN row keeps a disabled
 * Leave whose tooltip states the reason (shiki 2026-07-28: "owner row 的后面跟一个
 * leave 按钮,但是 disabled,hover 给 tip"), replacing the sentence that used to
 * sit at the modal's bottom edge — far from the row it described. The exception
 * is scoped to the viewer explaining their OWN state, where they will actively
 * hunt for the missing action; it does not generalise to per-row permission,
 * which stays hidden. All four `ChannelLeaveBlockedReason` arms flow through it
 * because the trigger is `can_leave === false`, not "I am the owner" — so no arm
 * can produce a disabled cell with nothing to say (`not_member` yields no copy
 * and, being absent from the roster, no row either).
 *
 * No status column: an agent's run state and a human's presence both ride the
 * avatar's corner dot, the same recipe the header chips use (`STATUS_DOT`) —
 * shiki 2026-07-28 removed the column for that reason.
 *
 * Confirmation happens INLINE, appended under the row it belongs to. A dialog
 * inside a dialog loses the "which row am I confirming?" context and walks into
 * the nested-overlay traps; the tinted note + destructive pair is the app-wide
 * confirm shape already used by the channel-settings Leave.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2, LogOut, Plus, Power, RefreshCw, Search, UserMinus } from 'lucide-react';
import type {
  ChannelLeaveBlockedReason,
  ConversationAgentDto,
  ConversationVisibility,
  MemberDto,
} from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogCornerButton,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { SEARCH_FIELD_FRAME } from '@/features/common/ControlInkBorder';
import {
  destructiveAction,
  destructiveCancel,
  DESTRUCTIVE_TRIGGER,
} from '@/features/common/DestructiveAction';
import { primaryAction } from '@/features/common/PrimaryAction';
import {
  useRemoveAgentFromChannel,
  useRemoveHumanFromChannel,
} from '@/features/channels/hooks';
import {
  canRemoveMember,
  memberDtoKey,
  useConversationMembers,
} from '@/features/conversations/useConversationMembers';
import { AddConversationMemberPopover } from '@/features/conversations/AddConversationMemberPopover';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { useUsersById } from '@/features/users/hooks';
import { presenceDotStatus, usePresenceById } from '@/features/presence/hooks';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { STATUS_DOT } from './member-strip';

/** Above this many members the roster stops being scannable at a glance, so the
 *  search field appears. It is the same cap that collapses the header strip into
 *  `+N` — the point at which the roster outgrew one look. */
const MEMBERS_SEARCH_MIN = 8;

/** The row's exit action (Leave / Remove). Bare glyph: muted at rest, error ink
 *  on hover, no fill and no box — the row hover is the only colour surface in
 *  this list, so a second filled square inside it read as two overlapping
 *  hovers (shiki 2026-07-28). */
const ROW_ACTION =
  'inline-flex size-6 items-center justify-center text-text-muted transition-colors hover:text-error disabled:opacity-50';

interface ChannelMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  /** Per-conversation agent rows — the source of each agent's run state dot. */
  conversationAgents: ConversationAgentDto[];
  agentAvatarUrls: Map<string, string | null>;
  /** Restart / stop EVERY agent in this channel. Absent → not rendered (the
   *  viewer may not manage all of them, or the channel is closed / agentless). */
  onRestartAllAgents?: () => void;
  onStopAllAgents?: () => void;
  /** A bulk mutation is in flight — the pair stays visible and goes disabled,
   *  because it is the viewer's OWN click that is settling. */
  bulkAgentPending?: boolean;
  /** Self-leave this channel. Absent → the viewer's row carries no action. */
  onLeave?: () => Promise<void>;
  canLeave?: boolean;
  leaveBlockedReason?: ChannelLeaveBlockedReason | null;
  /** Workspace of this channel, present ONLY when the viewer meets the
   *  add-member FLOOR (a member of a non-closed regular channel) — the same
   *  gate the header `+` uses, so the two entries can't disagree. Absent → no
   *  bottom entry. It is deliberately not a `can_add_member` boolean from the
   *  backend: WHOM the viewer may add is a per-candidate answer (own agents vs
   *  other people's vs humans), and the picker already asks it. */
  addMemberWorkspaceId?: string;
  /** Drives the leave consequence sentence (rejoinable or not). */
  visibility?: ConversationVisibility;
}

/** Human copy for a leave-blocked reason. Mirrors `ChannelSettingsDialog`'s
 *  wording — one blocked state must not read two ways depending on which
 *  surface the viewer opened. */
function leaveBlockedCopy(
  reason: ChannelLeaveBlockedReason | null | undefined,
): string | null {
  switch (reason) {
    case 'channel_owner':
      return "As the owner, you can't leave this channel.";
    case 'last_human_member':
      return "As the last member, you can't leave this channel.";
    case 'channel_archived':
      return 'Restore the channel before leaving.';
    default:
      return null;
  }
}

export function ChannelMembersDialog({
  open,
  onOpenChange,
  channelId,
  conversationAgents,
  agentAvatarUrls,
  onRestartAllAgents,
  onStopAllAgents,
  bulkAgentPending = false,
  onLeave,
  canLeave = false,
  leaveBlockedReason = null,
  addMemberWorkspaceId,
  visibility,
}: ChannelMembersDialogProps): JSX.Element {
  const membersResult = useConversationMembers(channelId);
  const { data: viewer } = useViewerUser();
  const viewerUserId =
    viewer && !isRegistrationRequired(viewer) && !isBackendUnreachable(viewer) && !isUpdateRequired(viewer)
      ? viewer.id
      : null;

  const [query, setQuery] = useState('');
  /** `memberDtoKey` of the row whose confirm is expanded — at most one. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  // Reseat on every open: the roster, the viewer's filter, and any half-open
  // confirm are all stale by the next time the modal is used.
  useEffect(() => {
    if (open) {
      setQuery('');
      setConfirming(null);
      setLeaving(false);
    }
  }, [open]);

  const removeAgent = useRemoveAgentFromChannel(channelId);
  const removeHuman = useRemoveHumanFromChannel(channelId);

  const members = membersResult.status === 'resolved' ? membersResult.members : [];

  const usersById = useUsersById();
  const humanAvatarSources = useMemo(
    () =>
      members
        .filter((m): m is Extract<MemberDto, { kind: 'human' }> => m.kind === 'human')
        // Prefer the member DTO's denormalized avatar; fall back to the users
        // directory the same way the header strip does, so one human is never
        // a placeholder here and a photo there. Both caches are invalidated on
        // a profile write (#task:1701) — either one going stale would resurrect
        // a removed avatar.
        .map(m => ({
          id: m.user_id,
          avatar_url: m.avatar_url ?? usersById.get(m.user_id)?.avatar_url ?? null,
        })),
    [members, usersById],
  );
  const humanAvatarUrls = useUserAvatarObjectUrls(humanAvatarSources);
  const presenceById = usePresenceById();
  const agentStatusById = useMemo(() => {
    const m = new Map<string, ConversationAgentDto['status']>();
    for (const row of conversationAgents) m.set(row.agent_id, row.status);
    return m;
  }, [conversationAgents]);

  // HUMANS first, then AGENTS: the viewer's own row lives in the human group and
  // carries Leave, so it must be the first thing found. (The workspace roster
  // leads with AGENTS on purpose — there, adding an agent is the likely intent.
  // shiki 2026-07-28: "不要统一".)
  const needle = query.trim().toLowerCase();
  const matches = (m: MemberDto): boolean =>
    !needle
    || m.name.toLowerCase().includes(needle)
    || (m.display_name ?? '').toLowerCase().includes(needle);
  const humans = members.filter(m => m.kind === 'human' && matches(m));
  const agents = members.filter(m => m.kind === 'agent' && matches(m));
  // Self pinned to the top of its group; everyone else keeps the backend order.
  const orderedHumans = [
    ...humans.filter(m => m.kind === 'human' && m.user_id === viewerUserId),
    ...humans.filter(m => !(m.kind === 'human' && m.user_id === viewerUserId)),
  ];

  const handleLeave = async (): Promise<void> => {
    if (!onLeave || leaving) return;
    setLeaving(true);
    try {
      await onLeave();
      onOpenChange(false);
    } catch {
      // The caller surfaces the failure; keep the confirm open so Cancel and a
      // retry stay reachable.
      setLeaving(false);
    }
  };

  const handleRemove = async (member: MemberDto): Promise<void> => {
    try {
      if (member.kind === 'agent') {
        await removeAgent.mutateAsync(member.agent_id);
      } else {
        await removeHuman.mutateAsync(member.user_id);
      }
      setConfirming(null);
    } catch {
      // Both hooks own the toast; keep the confirm open for a retry.
    }
  };

  const blockedCopy = onLeave && !canLeave ? leaveBlockedCopy(leaveBlockedReason) : null;
  const showBulk = !!onRestartAllAgents || !!onStopAllAgents;
  const removePending = removeAgent.isPending || removeHuman.isPending;

  const renderRow = (member: MemberDto): JSX.Element => {
    const key = memberDtoKey(member);
    const label = member.display_name?.trim() || member.name;
    const isSelf = member.kind === 'human' && member.user_id === viewerUserId;
    const dot =
      member.kind === 'agent'
        ? (agentStatusById.get(member.agent_id) ?? 'idle')
        : presenceDotStatus(presenceById.get(member.user_id)?.presence);
    const canLeaveHere = isSelf && !!onLeave && canLeave;
    // Leave blocked by STATE gets a disabled Leave on the viewer's own row with
    // the reason as its tooltip (shiki 2026-07-28) — see the header note: this
    // is one row's state explanation, NOT a general "no permission → disabled".
    const leaveBlockedHere = isSelf && !!onLeave && !canLeave && !!blockedCopy;
    const canRemoveHere = !isSelf && canRemoveMember(membersResult.removability, member);
    const expanded = confirming === key;
    // What the confirm has to say, or nothing. `null` for an agent: it is
    // removed and can be added back, and its runtime is handled either way —
    // there is no cost the user needs told (shiki 2026-07-28).
    const confirmCopy = isSelf
      ? visibility === 'private'
        ? "You won't be able to rejoin unless you're added back."
        : 'You can rejoin this channel anytime.'
      : member.kind === 'human'
        ? `@${member.name} loses access to this channel and can be added again later.`
        : null;
    return (
      <li key={key} className="flex flex-col">
        <div
          className="flex min-h-[34px] items-center gap-2.5 rounded-[var(--chip-radius)] px-1.5 py-1 transition-colors hover:bg-[var(--bg-option-hover)]"
          data-member-row={member.kind}
        >
          <span className="relative flex shrink-0 items-center">
            {member.kind === 'agent' ? (
              <AgentAvatar
                runtime={member.runtime}
                size={AVATAR_PX.sm}
                avatarObjectUrl={agentAvatarUrls.get(member.agent_id) ?? null}
                alt={label}
              />
            ) : (
              <UserAvatar
                size={AVATAR_PX.sm}
                avatarObjectUrl={humanAvatarUrls.get(member.user_id) ?? null}
                alt={label}
              />
            )}
            <span
              className={
                'pointer-events-none absolute bottom-0 right-0 size-2 translate-x-1/2 translate-y-1/2 rounded-full border border-bg-floating '
                + STATUS_DOT[dot]
              }
            />
          </span>
          {/* Name budget (shiki 2026-07-28: 名字超长要处理). Both the display
              name and the `@handle` truncate, but NOT proportionally — the
              handle is `shrink-0` with a share cap, so an overlong display
              name eats its own line first and the handle (the thing you act
              on, and what the confirm copy repeats) stays readable. The group
              is `min-w-0`, so neither ever pushes into the action cell. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span
              className="truncate text-sm font-medium text-text-primary"
              title={label}
            >
              {label}
            </span>
            <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-text-muted">
              @{member.name}
            </span>
            {isSelf ? (
              // Radius comes from the chip token, not a literal (shiki
              // 2026-07-28) — `--chip-radius` is 0 in forza6 (hard-cut poster
              // geometry) and 4px in the warm themes, the same token the row
              // above already consumes.
              <span className="shrink-0 rounded-[var(--chip-radius)] border border-border-subtle px-1 text-[10px] text-text-muted">
                you
              </span>
            ) : null}
          </span>
          {/* One fixed-width action cell so every icon aligns and a row without
              an action leaves a gap instead of shifting its neighbours. The
              glyph carries the whole hover — no filled square behind it (shiki
              2026-07-28: 去掉 hover 的 square background), so the row's own
              hover stays the only surface that changes colour. */}
          <span className="flex w-6 shrink-0 items-center justify-end">
            {canLeaveHere ? (
              <button
                type="button"
                onClick={() => setConfirming(expanded ? null : key)}
                disabled={leaving}
                aria-label="Leave channel"
                title="Leave channel"
                className={ROW_ACTION}
              >
                <LogOut className="size-3.5" />
              </button>
            ) : leaveBlockedHere ? (
              // The tooltip hangs on the WRAPPER: a disabled button swallows the
              // pointer, so a `title` on it alone is not reliably shown.
              <span title={blockedCopy ?? undefined} className="inline-flex">
                <button
                  type="button"
                  disabled
                  aria-label="Leave channel"
                  title={blockedCopy ?? undefined}
                  className={`${ROW_ACTION} pointer-events-none opacity-40`}
                >
                  <LogOut className="size-3.5" />
                </button>
              </span>
            ) : canRemoveHere ? (
              <button
                type="button"
                onClick={() => setConfirming(expanded ? null : key)}
                disabled={removePending}
                aria-label={`Remove @${member.name} from this channel`}
                title={`Remove @${member.name} from this channel`}
                className={ROW_ACTION}
              >
                <UserMinus className="size-3.5" />
              </button>
            ) : null}
          </span>
        </div>
        {expanded ? (
          <div className="flex flex-col gap-2.5 px-1.5 pb-1 pt-1.5">
            {/* The warning band appears only when there is something the user
                can't see for themselves: what leaving costs THEM (rejoinable or
                not), or that a removed human keeps the door open. Removing an
                agent gets no band (shiki 2026-07-28) — the runtime detail it
                used to state is this product's normal behaviour, not a
                consequence worth spending a sentence on before a click. */}
            {confirmCopy ? (
              <div className="rounded-[var(--control-radius)] bg-[var(--warning-surface)] px-3 py-2.5">
                <p className="text-sm leading-relaxed text-text-primary">
                  {confirmCopy}
                </p>
              </div>
            ) : null}
            {/* This confirm sits inside the row it acts on, so neither button
                lifts on hover in any theme (shiki 2026-07-28) — the row's own
                hover is already moving under them. Hover still answers by
                colour, and in forza6 the commit sticker's shadow still grows. */}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={leaving || removePending}
                onClick={() => setConfirming(null)}
                {...destructiveCancel(undefined, { motion: 'still' })}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={leaving || removePending}
                onClick={() =>
                  isSelf ? void handleLeave() : void handleRemove(member)
                }
                {...destructiveAction(DESTRUCTIVE_TRIGGER, { motion: 'still' })}
              >
                {/* Label only — the glyph would repeat the row action that
                    opened this confirm (shiki 2026-07-28: 重复). The spinner
                    still shows, being state rather than identity; the Leave
                    variant drops its glyph for the same reason. */}
                {leaving || removePending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                {isSelf ? 'Leave' : 'Remove'}
              </Button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // 360px (shiki 2026-07-28, after 320 read as too tight). A roster is one
        // column of short rows, so a wider shell only buys empty space to the
        // right of every name; the budget for a long name is handled in the row
        // itself, not by widening the modal. The bottom picker matches this
        // width exactly — see below.
        className="max-w-[360px]"
        cornerActions={
          showBulk ? (
            <>
              {onRestartAllAgents ? (
                <DialogCornerButton
                  onClick={onRestartAllAgents}
                  disabled={bulkAgentPending}
                  aria-label="Restart Channel agents"
                  title="Restart Channel agents"
                  className="disabled:opacity-40"
                >
                  {/* Default 2px stroke, same as the cluster's ✕. Thinning the
                      dense glyphs to 1.5 to equalise perceived ink was tried
                      and rejected — shiki 2026-07-28: "1.5 太单薄". What was
                      actually blurring them is the resting opacity this skin
                      no longer applies (see `dialogCornerButtonClass`); stroke
                      weight in this cluster is one number for all three. */}
                  <RefreshCw className="size-4" />
                </DialogCornerButton>
              ) : null}
              {onStopAllAgents ? (
                <DialogCornerButton
                  onClick={onStopAllAgents}
                  disabled={bulkAgentPending}
                  aria-label="Stop Channel agents"
                  title="Stop Channel agents"
                  className="disabled:opacity-40"
                >
                  <Power className="size-4" />
                </DialogCornerButton>
              ) : null}
              {/* Bulk runtime actions and "close this surface" are two different
                  kinds of thing — one hairline keeps them from reading as one
                  group of three. */}
              <span
                aria-hidden
                className="h-4 w-px shrink-0 bg-border-subtle"
              />
            </>
          ) : null
        }
      >
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-1.5">
            Members
            {members.length > 0 ? (
              <span className="text-xs font-medium text-text-muted">
                {members.length}
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {members.length > MEMBERS_SEARCH_MIN ? (
            <label className={SEARCH_FIELD_FRAME}>
              <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden />
              <input
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search by name or @handle"
                className="w-full min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
              />
            </label>
          ) : null}
          <div className="flex max-h-[52vh] flex-col overflow-y-auto">
            {membersResult.status === 'loading' ? (
              <p className="px-1.5 py-3 text-center text-xs italic text-text-muted">
                Loading…
              </p>
            ) : orderedHumans.length === 0 && agents.length === 0 ? (
              <p className="px-1.5 py-3 text-center text-xs italic text-text-muted">
                No matches
              </p>
            ) : (
              <>
                {orderedHumans.length > 0 ? (
                  <>
                    <GroupLabel>HUMANS</GroupLabel>
                    <ul className="flex flex-col">{orderedHumans.map(renderRow)}</ul>
                  </>
                ) : null}
                {agents.length > 0 ? (
                  <>
                    <GroupLabel>AGENTS</GroupLabel>
                    <ul className="flex flex-col">{agents.map(renderRow)}</ul>
                  </>
                ) : null}
              </>
            )}
          </div>
          {addMemberWorkspaceId ? (
            // The roster's last line is how you extend it (shiki 2026-07-28), and
            // it ranks as this modal's ONE primary action: `primaryAction()` on
            // the Button `default` variant, so the fill is the CTA token cluster
            // (`--bg-control-primary` — avocado in forza6, each other theme's own
            // value) and forza6 adds the poster frame + peel. No colour literal
            // and no second recipe. Full width with the label centred, seated
            // OUTSIDE the scroller so it stays reachable with a long roster. The
            // picker is the shared one: candidates and their grading (own agents
            // vs other people's vs humans) come from it, never recomputed here.
            // `align="center"` is what makes the panel flush with the modal
            // (shiki 2026-07-28: popover 宽度要和 Modal 一致): the trigger is
            // full-width inside symmetric padding, so centring a panel of the
            // modal's own width lands its edges on the modal's edges — no
            // padding constant duplicated at this call site.
            <div className="pt-0.5">
              <AddConversationMemberPopover
                workspaceId={addMemberWorkspaceId}
                conversationId={channelId}
                align="center"
                // Opened from inside this Dialog: the Dialog's scroll-lock would
                // otherwise block wheel scroll on the portaled candidate list, so
                // the picker opens modal to reclaim it (#task:1785).
                modal
                trigger={
                  <Button size="sm" {...primaryAction('w-full')}>
                    <Plus className="size-4" aria-hidden />
                    Add member
                  </Button>
                }
              />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GroupLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-1.5 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted">
      {children}
    </div>
  );
}
