import { MembersSkeleton } from "../channel-list-skeletons";
/** Member roster and management content for channel settings.
 * Removal permission comes from the viewer-scoped server carrier; self-leave
 * retains its blocked reason. Row confirmations are local to the mounted roster.
 */
import { useMemo, useState } from "react";
import { LeaveIcon, RemoveMemberIcon, SpinnerIcon } from "@/icons";
import type {
  ChannelLeaveBlockedReason,
  ConversationAgentRuntimeDto,
  ConversationVisibility,
  MemberDto,
} from "@silverhand/shared";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useRemoveAgentFromChannel, useRemoveHumanFromChannel } from "@/features/channels/hooks";
import {
  canRemoveMember,
  memberDtoKey,
  useConversationMembers,
} from "@/features/conversations/use-conversation-members";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { useUsersById } from "@/features/users/hooks";
import { presenceDotStatus, usePresenceById } from "@/features/users/presence";
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
  useViewerUser,
} from "@/features/session/hooks";
import { STATUS_DOT } from "@/components/status-dot";
import { projectMemberRuntimeStatus } from "@/features/agents/model/member-runtime-status";
import { PRESENCE_TONE_DOT, projectPresence } from "@/features/agents/model/presence-projection";
import { t } from "@/lib/i18n";

/** The row's exit action (Leave / Remove). Bare glyph: muted at rest, error ink
 *  on hover, no fill and no box — the row hover is the only colour surface in
 *  this list, so a second filled square inside it reads as two overlapping
 *  hovers. */
const ROW_ACTION =
  "inline-flex size-6 items-center justify-center text-text-muted transition-colors hover:text-error disabled:opacity-50";

export interface ChannelMembersContentProps {
  query: string;
  channelId: string;
  /** Per-conversation agent rows — the source of each agent's run state dot.
   *  Raw `query.data`: `undefined` = the read has not settled, and a row then
   *  draws no dot rather than claiming Idle. */
  agentRuntime: readonly ConversationAgentRuntimeDto[] | undefined;
  agentAvatarUrls: Map<string, string | null>;
  /** Self-leave this channel. Absent → the viewer's row carries no action. */
  onLeave?: () => Promise<void>;
  canLeave?: boolean;
  leaveBlockedReason?: ChannelLeaveBlockedReason | null;
  /** Drives the leave consequence sentence (rejoinable or not). */
  visibility?: ConversationVisibility;
}

/** Human copy for a leave-blocked reason. Mirrors `ChannelSettingsDetails`'s
 *  wording — one blocked state must not read two ways depending on which
 *  surface the viewer opened. */
function leaveBlockedCopy(reason: ChannelLeaveBlockedReason | null | undefined): string | null {
  switch (reason) {
    case "channel_owner":
      return t("conversationShell.asTheOwnerYou");
    case "last_human_member":
      return t("conversationShell.asTheLastMember");
    case "channel_archived":
      return t("conversationShell.restoreTheChannelBefore");
    default:
      return null;
  }
}

/**
 * The roster itself — search, the HUMANS / AGENTS groups, per-row exit action
 * with its inline confirm. The settings panel owns successful leave navigation.
 *
 * Width-adaptive: `conversation-surface` names the query container, so the
 * groups go side by side once THIS surface is wide (see `chrome.css`). Extra
 * width buys more GROUP COLUMNS, never a wider row — a roster row stays one
 * narrow column of short names.
 */
export function ChannelMembersContent({
  query,
  channelId,
  agentRuntime,
  agentAvatarUrls,
  onLeave,
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

  /** `memberDtoKey` of the row whose confirm is expanded — at most one. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

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
  const needle = query.trim().replace(/^@/, "").toLowerCase();
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
        ? t("conversationShell.youWontBeAble")
        : t("conversationShell.youCanRejoinThis")
      : member.kind === "human"
        ? t("conversationShell.removeMemberDetail", { name: member.name })
        : null;
    return (
      <li key={key} className="flex flex-col">
        <div
          className="flex min-h-8.5 items-center gap-2.5 rounded-(--chip-radius) px-1.5 py-1 transition-colors hover:bg-(--bg-hover)"
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
            <span className="max-w-[45%] shrink-0 truncate font-mono text-(length:--text-meta) text-text-muted">
              @{member.name}
            </span>
            {isSelf ? (
              // Radius comes from the chip token, not a literal — `--chip-radius`
              // is 0 in poster (hard-cut poster geometry) and 4px in the warm
              // themes, the same token the row above already consumes.
              <span className="shrink-0 rounded-(--chip-radius) border border-border-subtle px-1 text-(length:--text-badge) text-text-muted">
                {t("conversationShell.you")}
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
                aria-label={t("conversationShell.leaveChannel")}
                title={t("conversationShell.leaveChannel")}
                className={ROW_ACTION}
              >
                <LeaveIcon className="size-3.5" />
              </button>
            ) : leaveBlockedHere ? (
              // The tooltip hangs on the WRAPPER: a disabled button swallows the
              // pointer, so a `title` on it alone is not reliably shown.
              <span title={blockedCopy ?? undefined} className="inline-flex">
                <button
                  type="button"
                  disabled
                  aria-label={t("conversationShell.leaveChannel")}
                  title={blockedCopy ?? undefined}
                  className={`${ROW_ACTION} pointer-events-none opacity-40`}
                >
                  <LeaveIcon className="size-3.5" />
                </button>
              </span>
            ) : canRemoveHere ? (
              <button
                type="button"
                onClick={() => setConfirming(expanded ? null : key)}
                disabled={removePending}
                aria-label={t("conversationShell.removeMember", { name: member.name })}
                title={t("conversationShell.removeMember", { name: member.name })}
                className={ROW_ACTION}
              >
                <RemoveMemberIcon className="size-3.5" />
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
              <div className="rounded-(--control-radius) bg-(--warning-surface) px-3 py-2.5">
                {/* `break-words`: this sentence quotes the `@handle`, and a
                    handle is one unbreakable run of up to
                    `ENTITY_NAME_MAX_LENGTH` characters — wider than this
                    column, with no space or hyphen for the line breaker to
                    use. Everywhere else a handle appears it truncates; here it
                    must stay whole, so the wrap opportunity has to be forced. */}
                <p className="wrap-break-word text-sm leading-relaxed text-text-primary">
                  {confirmCopy}
                </p>
              </div>
            ) : null}
            {/* This confirm sits inside the row it acts on. */}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="cancel"
                size="xs"
                disabled={leaving || removePending}
                onClick={() => setConfirming(null)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive-outline"
                size="xs"
                disabled={leaving || removePending}
                onClick={() => (isSelf ? void handleLeave() : void handleRemove(member))}
              >
                {/* Label only — the glyph would repeat the row action that
                    opened this confirm. The spinner still shows, being state
                    rather than identity. */}
                {leaving || removePending ? (
                  <SpinnerIcon className="size-3.5 animate-spin" />
                ) : null}
                {isSelf ? t("conversationShell.leave") : t("conversationShell.remove")}
              </Button>
            </div>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <div className="conversation-surface flex flex-col gap-2">
      <div className="flex flex-col">
        {membersResult.status === "loading" ? (
          <MembersSkeleton />
        ) : orderedHumans.length === 0 && agents.length === 0 ? (
          <p className="px-1.5 py-3 text-center text-xs italic text-text-muted">
            {t("conversationShell.noMatches")}
          </p>
        ) : (
          // One column when narrow, HUMANS | AGENTS side by side once this
          // surface is wide (rule in `chrome.css`).
          <div data-members-groups>
            {orderedHumans.length > 0 ? (
              <section>
                <GroupLabel>{t("conversationShell.humans")}</GroupLabel>
                <ul className="flex flex-col">{orderedHumans.map(renderRow)}</ul>
              </section>
            ) : null}
            {agents.length > 0 ? (
              <section>
                <GroupLabel>{t("conversationShell.agents")}</GroupLabel>
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
    <div className="px-1.5 pb-1 pt-2.5 text-(length:--text-badge) font-semibold uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}
