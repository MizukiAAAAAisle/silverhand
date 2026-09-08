/**
 * The channel roster, in two hosts that share no shell — a modal and a
 * conversation tab — around the one roster body, so a row can't say two
 * different things depending on where it was opened. The bulk agent cluster is
 * the modal corner's, hence modal-only; per-agent runtime controls stay in
 * `AgentInfoPopover` so one agent's runtime has a single definition.
 *
 * PERMISSION IS HIDE, NOT DISABLE: every action cell renders only when the
 * viewer may use it. The per-row authority is the backend's viewer-scoped
 * `member_removability` carrier, never a renderer re-derivation — the human arm
 * depends on the target's workspace role plus channel-exit guards the client
 * cannot see. It fail-closes to false.
 *
 * The one exception is the viewer's OWN Leave blocked by STATE (owner / last
 * member / archived): that row keeps a disabled Leave whose tooltip states the
 * reason, because the viewer will hunt for their own missing action. It does not
 * generalise to per-row permission. The trigger is `can_leave === false`, so
 * every `ChannelLeaveBlockedReason` arm flows through and no arm can yield a
 * disabled cell with nothing to say (`not_member` has no copy and no row).
 *
 * Add member contributes an ENTRY, not a second picker: whom the viewer may add
 * is `AddConversationMemberPopover`'s per-candidate answer, so this surface
 * can't offer a row the route would refuse. The entry appears only when the
 * caller passes a workspace, which follows the same channel-member floor as the
 * header `+`.
 *
 * Confirmation is INLINE under its row: a dialog inside a dialog loses "which
 * row am I confirming?" and walks into the nested-overlay traps.
 */
import { useMemo, useState } from "react";
import { Loader2, LogOut, Plus, Power, RefreshCw, Search, UserMinus } from "lucide-react";
import type {
  ChannelLeaveBlockedReason,
  ConversationAgentRuntimeDto,
  ConversationVisibility,
  MemberDto,
} from "@silverhand/shared";
import {
  Dialog,
  DialogContent,
  DialogCornerButton,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/AgentAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { SEARCH_FIELD_FRAME } from "@/features/common/ControlInkBorder";
import {
  destructiveAction,
  destructiveCancel,
  DESTRUCTIVE_TRIGGER,
} from "@/features/common/DestructiveAction";
import { primaryAction } from "@/features/common/PrimaryAction";
import { useRemoveAgentFromChannel, useRemoveHumanFromChannel } from "@/features/channels/hooks";
import {
  canRemoveMember,
  memberDtoKey,
  useConversationMembers,
} from "@/features/conversations/useConversationMembers";
import { AddConversationMemberPopover } from "@/features/conversations/AddConversationMemberPopover";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { useUsersById } from "@/features/users/hooks";
import { presenceDotStatus, usePresenceById } from "@/features/presence/hooks";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from "@/features/me/hooks";
import { STATUS_DOT } from "@/components/status-dot";
import { projectMemberRuntimeStatus } from "@/features/agent-shell/model/member-runtime-status";
import {
  PRESENCE_TONE_DOT,
  projectPresence,
} from "@/features/agent-shell/model/presence-projection";

/** Above this many members the roster stops being scannable at a glance, so the
 *  search field appears. It is the same cap that collapses the header strip into
 *  `+N` — the point at which the roster outgrew one look. */
const MEMBERS_SEARCH_MIN = 8;

/** The row's exit action (Leave / Remove). Bare glyph: muted at rest, error ink
 *  on hover, no fill and no box — the row hover is the only colour surface in
 *  this list, so a second filled square inside it reads as two overlapping
 *  hovers. */
const ROW_ACTION =
  "inline-flex size-6 items-center justify-center text-text-muted transition-colors hover:text-error disabled:opacity-50";

interface ChannelMembersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string;
  /** Per-conversation agent rows — the source of each agent's run state dot.
   *  Raw `query.data`: `undefined` = the read has not settled, and a row then
   *  draws no dot rather than claiming Idle. */
  agentRuntime: readonly ConversationAgentRuntimeDto[] | undefined;
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
   *  Add-member entry. It is deliberately not a `can_add_member` boolean from
   *  the backend: WHOM the viewer may add is a per-candidate answer (own agents
   *  vs other people's vs humans), and the picker already asks it. */
  addMemberWorkspaceId?: string;
  /** Drives the leave consequence sentence (rejoinable or not). */
  visibility?: ConversationVisibility;
}

/** Human copy for a leave-blocked reason. Mirrors `ChannelSettingsDialog`'s
 *  wording — one blocked state must not read two ways depending on which
 *  surface the viewer opened. */
function leaveBlockedCopy(reason: ChannelLeaveBlockedReason | null | undefined): string | null {
  switch (reason) {
    case "channel_owner":
      return "As the owner, you can't leave this channel.";
    case "last_human_member":
      return "As the last member, you can't leave this channel.";
    case "channel_archived":
      return "Restore the channel before leaving.";
    default:
      return null;
  }
}

/** The roster surface's own inputs — everything except the modal's chrome
 *  (`open` / `onOpenChange`) and the bulk agent cluster that rides its corner.
 *  The Add-member entry is the HOST's, seated at the top of each host, so it is
 *  not one of these inputs. */
type ChannelMembersContentProps = Omit<
  ChannelMembersDialogProps,
  | "open"
  | "onOpenChange"
  | "onRestartAllAgents"
  | "onStopAllAgents"
  | "bulkAgentPending"
  | "addMemberWorkspaceId"
> & {
  /** Called after a successful self-leave, so a host that is a transient shell
   *  can dismiss itself. The modal passes `onOpenChange(false)`; the tab host
   *  passes nothing — the roster it was showing is simply gone. */
  onLeft?: () => void;
};

/**
 * The Add-member entry, shared by both hosts so WHOM you may add (the picker's
 * per-candidate answer) and the fail-closed floor stay defined once. The roster
 * body does not own it — each host composes it at its own top; only the
 * trigger's width and the panel's anchoring are the host's.
 */
export function ChannelAddMemberEntry({
  workspaceId,
  conversationId,
  triggerWidthClass,
  align,
  popoverWidthClass,
  modal = false,
}: {
  workspaceId: string;
  conversationId: string;
  /** Extra classes for the trigger Button — the host's width budget. */
  triggerWidthClass?: string;
  align?: "start" | "center" | "end";
  popoverWidthClass?: string;
  modal?: boolean;
}): JSX.Element {
  return (
    <AddConversationMemberPopover
      workspaceId={workspaceId}
      conversationId={conversationId}
      align={align}
      widthClass={popoverWidthClass}
      modal={modal}
      trigger={
        <Button size="sm" {...primaryAction(triggerWidthClass)}>
          <Plus className="size-4" aria-hidden />
          Add member
        </Button>
      }
    />
  );
}

/**
 * The Members roster as a MODAL — the shell only: `Dialog`, the title with its
 * count, and the bulk restart/stop corner cluster. The roster itself is
 * {@link ChannelMembersContent}, which the conversation Members tab mounts under
 * its own container; the two hosts share no shell.
 */
export function ChannelMembersDialog({
  open,
  onOpenChange,
  onRestartAllAgents,
  onStopAllAgents,
  bulkAgentPending = false,
  addMemberWorkspaceId,
  ...content
}: ChannelMembersDialogProps): JSX.Element {
  // The count in the title is chrome, so the shell reads it itself rather than
  // taking it back out of the roster. Same cached query — no second fetch.
  const membersResult = useConversationMembers(content.channelId);
  const memberCount = membersResult.status === "resolved" ? membersResult.members.length : 0;
  const showBulk = !!onRestartAllAgents || !!onStopAllAgents;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // A roster is one column of short rows, so a wider shell would only buy
        // empty space right of every name; a long name is budgeted in the row.
        // The Add-member trigger matches this width exactly.
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
                  {/* One stroke weight for all three glyphs in this cluster,
                      matching the close ✕. */}
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
              <span aria-hidden className="h-4 w-px shrink-0 bg-border-subtle" />
            </>
          ) : null
        }
      >
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-1.5">
            Members
            {memberCount > 0 ? (
              <span className="text-xs font-medium text-text-muted">{memberCount}</span>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        {addMemberWorkspaceId ? (
          <ChannelAddMemberEntry
            workspaceId={addMemberWorkspaceId}
            conversationId={content.channelId}
            triggerWidthClass="w-full"
            align="center"
            popoverWidthClass="w-[360px]"
            // `modal` so the picker's portaled list reclaims wheel scroll from
            // the Dialog's scroll-lock.
            modal
          />
        ) : null}
        {/* The modal caps the roster's height; the roster itself only asks to
            fill whatever box it is given. */}
        <div className="flex max-h-[52vh] min-h-0 flex-col">
          <ChannelMembersContent {...content} onLeft={() => onOpenChange(false)} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The roster itself — search, the HUMANS / AGENTS groups, per-row exit action
 * with its inline confirm, and the Add-member entry. Host-agnostic: it takes no
 * title, no close, no `open`, and never asks which host mounted it.
 *
 * Width-adaptive: `conversation-surface` names the query container, so the
 * groups go side by side once THIS surface is wide (see `global.css`). Extra
 * width buys more GROUP COLUMNS, never a wider row — a roster row stays one
 * narrow column of short names.
 */
export function ChannelMembersContent({
  channelId,
  agentRuntime,
  agentAvatarUrls,
  onLeave,
  onLeft,
  canLeave = false,
  leaveBlockedReason = null,
  visibility,
}: ChannelMembersContentProps): JSX.Element {
  const membersResult = useConversationMembers(channelId);
  const { data: viewer } = useViewerUser();
  const viewerUserId =
    viewer &&
    !isRegistrationRequired(viewer) &&
    !isBackendUnreachable(viewer) &&
    !isUpdateRequired(viewer)
      ? viewer.id
      : null;

  const [query, setQuery] = useState("");
  /** `memberDtoKey` of the row whose confirm is expanded — at most one. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  // No open-keyed reseat: this surface's state IS its mount in both hosts. The
  // modal's `DialogContent` has no `forceMount`, so closing it unmounts the
  // roster; removing the tab unmounts it too.

  const removeAgent = useRemoveAgentFromChannel(channelId);
  const removeHuman = useRemoveHumanFromChannel(channelId);

  const members = membersResult.status === "resolved" ? membersResult.members : [];

  const usersById = useUsersById();
  const humanAvatarSources = useMemo(
    () =>
      members
        .filter((m): m is Extract<MemberDto, { kind: "human" }> => m.kind === "human")
        // Prefer the member DTO's denormalized avatar; fall back to the users
        // directory the same way the header strip does, so one human is never
        // a placeholder here and a photo there. Both caches are invalidated on
        // a profile write — either one going stale would resurrect
        // a removed avatar.
        .map((m) => ({
          id: m.user_id,
          avatar_url: m.avatar_url ?? usersById.get(m.user_id)?.avatar_url ?? null,
        })),
    [members, usersById],
  );
  const humanAvatarUrls = useUserAvatarObjectUrls(humanAvatarSources);
  const presenceById = usePresenceById();

  // HUMANS first, then AGENTS: the viewer's own row lives in the human group and
  // carries Leave, so it must be the first thing found. The workspace roster
  // leads with AGENTS on purpose and the two are deliberately not unified —
  // there, adding an agent is the likely intent.
  const needle = query.trim().toLowerCase();
  const matches = (m: MemberDto): boolean =>
    !needle ||
    m.name.toLowerCase().includes(needle) ||
    (m.display_name ?? "").toLowerCase().includes(needle);
  const humans = members.filter((m) => m.kind === "human" && matches(m));
  const agents = members.filter((m) => m.kind === "agent" && matches(m));
  // Self pinned to the top of its group; everyone else keeps the backend order.
  const orderedHumans = [
    ...humans.filter((m) => m.kind === "human" && m.user_id === viewerUserId),
    ...humans.filter((m) => !(m.kind === "human" && m.user_id === viewerUserId)),
  ];

  const handleLeave = async (): Promise<void> => {
    if (!onLeave || leaving) return;
    setLeaving(true);
    try {
      await onLeave();
      onLeft?.();
    } catch {
      // The caller surfaces the failure; keep the confirm open so Cancel and a
      // retry stay reachable.
      setLeaving(false);
    }
  };

  const handleRemove = async (member: MemberDto): Promise<void> => {
    try {
      if (member.kind === "agent") {
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
  const removePending = removeAgent.isPending || removeHuman.isPending;

  const renderRow = (member: MemberDto): JSX.Element => {
    const key = memberDtoKey(member);
    const label = member.display_name?.trim() || member.name;
    const isSelf = member.kind === "human" && member.user_id === viewerUserId;
    // One projection for the agent arm: membership is given by the
    // row's existence in this roster, so only the runtime read can be unsettled,
    // and `null` there means "draw no dot" rather than a status. The agent dot
    // takes its colour from the shared tone map and carries the presence as an
    // accessible name — there is no status column, so a crashed session's fault
    // would otherwise be colour-only. The human arm keeps its own presence dot.
    const presenceDot: { colorClass: string; a11yLabel: string | null; pulse: boolean } | null =
      member.kind === "agent"
        ? (() => {
            const display = projectPresence({
              scope: "conversation",
              runtime: projectMemberRuntimeStatus({
                membership: "member",
                runtime: agentRuntime,
                agentId: member.agent_id,
              }),
            });
            return display === null
              ? null
              : {
                  colorClass: PRESENCE_TONE_DOT[display.tone],
                  a11yLabel: display.a11yLabel,
                  pulse: display.pulse,
                };
          })()
        : {
            colorClass: STATUS_DOT[presenceDotStatus(presenceById.get(member.user_id)?.presence)],
            a11yLabel: null,
            pulse: false,
          };
    const canLeaveHere = isSelf && !!onLeave && canLeave;
    // Leave blocked by STATE gets a disabled Leave on the viewer's own row with
    // the reason as its tooltip — see the header note: this is one row's state
    // explanation, NOT a general "no permission → disabled".
    const leaveBlockedHere = isSelf && !!onLeave && !canLeave && !!blockedCopy;
    const canRemoveHere = !isSelf && canRemoveMember(membersResult.removability, member);
    const expanded = confirming === key;
    // What the confirm has to say, or nothing. `null` for an agent: it is
    // removed and can be added back, and its runtime is handled either way —
    // there is no cost the user needs told.
    const confirmCopy = isSelf
      ? visibility === "private"
        ? "You won't be able to rejoin unless you're added back."
        : "You can rejoin this channel anytime."
      : member.kind === "human"
        ? `@${member.name} loses access to this channel and can be added again later.`
        : null;
    return (
      <li key={key} className="flex flex-col">
        <div
          className="flex min-h-[34px] items-center gap-2.5 rounded-[var(--chip-radius)] px-1.5 py-1 transition-colors hover:bg-[var(--bg-option-hover)]"
          data-member-row={member.kind}
        >
          <span className="relative flex shrink-0 items-center">
            {member.kind === "agent" ? (
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
            {presenceDot === null ? null : (
              <span
                role={presenceDot.a11yLabel ? "img" : undefined}
                aria-label={presenceDot.a11yLabel ?? undefined}
                className={
                  "pointer-events-none absolute bottom-0 right-0 size-2 translate-x-1/2 translate-y-1/2 rounded-full border border-bg-floating " +
                  presenceDot.colorClass +
                  (presenceDot.pulse ? " motion-safe:animate-pulse" : "")
                }
              />
            )}
          </span>
          {/* Name budget: both the display name and the `@handle` truncate, but
              NOT proportionally — the handle is `shrink-0` with a share cap, so
              an overlong display name eats its own line first and the handle
              (the thing you act on, and what the confirm copy repeats) stays
              readable. The group is `min-w-0`, so neither ever pushes into the
              action cell. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium text-text-primary" title={label}>
              {label}
            </span>
            <span className="max-w-[45%] shrink-0 truncate font-mono text-[length:var(--text-meta)] text-text-muted">
              @{member.name}
            </span>
            {isSelf ? (
              // Radius comes from the chip token, not a literal — `--chip-radius`
              // is 0 in forza6 (hard-cut poster geometry) and 4px in the warm
              // themes, the same token the row above already consumes.
              <span className="shrink-0 rounded-[var(--chip-radius)] border border-border-subtle px-1 text-[length:var(--text-badge)] text-text-muted">
                you
              </span>
            ) : null}
          </span>
          {/* One fixed-width action cell so every icon aligns and a row without
              an action leaves a gap instead of shifting its neighbours. The
              glyph carries the whole hover — no filled square behind it, so the
              row's own hover stays the only surface that changes colour. */}
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
                agent gets no band — nothing about it departs from this
                product's normal behaviour. */}
            {confirmCopy ? (
              <div className="rounded-[var(--control-radius)] bg-[var(--warning-surface)] px-3 py-2.5">
                {/* `break-words`: this sentence quotes the `@handle`, and a
                    handle is one unbreakable run of up to
                    `ENTITY_NAME_MAX_LENGTH` characters — wider than this
                    column, with no space or hyphen for the line breaker to
                    use. Everywhere else a handle appears it truncates; here it
                    must stay whole, so the wrap opportunity has to be forced. */}
                <p className="break-words text-sm leading-relaxed text-text-primary">
                  {confirmCopy}
                </p>
              </div>
            ) : null}
            {/* This confirm sits inside the row it acts on, so neither button
                lifts on hover in any theme — the row's own hover is already
                moving under them. Hover still answers by colour, and in forza6
                the commit sticker's shadow still grows. */}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={leaving || removePending}
                onClick={() => setConfirming(null)}
                {...destructiveCancel(undefined, { motion: "still" })}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={leaving || removePending}
                onClick={() => (isSelf ? void handleLeave() : void handleRemove(member))}
                {...destructiveAction(DESTRUCTIVE_TRIGGER, { motion: "still" })}
              >
                {/* Label only — the glyph would repeat the row action that
                    opened this confirm. The spinner still shows, being state
                    rather than identity. */}
                {leaving || removePending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {isSelf ? "Leave" : "Remove"}
              </Button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="conversation-surface flex min-h-0 flex-1 flex-col gap-2">
      {members.length > MEMBERS_SEARCH_MIN ? (
        <label data-input="" className={SEARCH_FIELD_FRAME}>
          <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or @handle"
            className="w-full min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
        </label>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {membersResult.status === "loading" ? (
          <p className="px-1.5 py-3 text-center text-xs italic text-text-muted">Loading…</p>
        ) : orderedHumans.length === 0 && agents.length === 0 ? (
          <p className="px-1.5 py-3 text-center text-xs italic text-text-muted">No matches</p>
        ) : (
          // One column when narrow, HUMANS | AGENTS side by side once this
          // surface is wide (rule in `global.css`).
          <div data-members-groups>
            {orderedHumans.length > 0 ? (
              <section>
                <GroupLabel>HUMANS</GroupLabel>
                <ul className="flex flex-col">{orderedHumans.map(renderRow)}</ul>
              </section>
            ) : null}
            {agents.length > 0 ? (
              <section>
                <GroupLabel>AGENTS</GroupLabel>
                <ul className="flex flex-col">{agents.map(renderRow)}</ul>
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function GroupLabel({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-1.5 pb-1 pt-2.5 text-[length:var(--text-badge)] font-semibold uppercase tracking-[0.1em] text-text-muted">
      {children}
    </div>
  );
}
