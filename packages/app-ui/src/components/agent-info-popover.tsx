import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Eraser, Play, Power, RefreshCw, UserMinus } from "lucide-react";
import type { AgentDto } from "@silverhand/shared";
import { useDirectPairs } from "@/features/direct-pairs/hooks";
import {
  canControlDirectAgent,
  directAgentControlState,
} from "@/features/agent-shell/model/direct-agent-control";
import {
  useChannelAgents,
  useChannelAgentRuntime,
  useClearAgentSession,
  useRemoveAgentFromChannel,
  useStartAgent,
  useStopAgent,
} from "@/features/channels/hooks";
import {
  canEditAgentProfile,
  canRemoveAgentFromChannel,
} from "@/features/agent-shell/model/permissions";
import { useConversationById } from "@/features/conversations/use-conversation-by-id";
import { useConversationPaneCapabilities } from "@/features/conversations/pane-capabilities-context";
import {
  useAgentAvailability,
  useAgentRuntimeState,
  projectRosterMembership,
  useAgentPresence,
} from "@/features/agent-shell/hooks/hooks";
import {
  presenceAuthorityFor,
  projectMemberRuntimeStatus,
} from "@/features/agent-shell/model/member-runtime-status";
import {
  PRESENCE_TONE_DOT,
  projectPresence,
  type PresenceDisplay,
} from "@/features/agent-shell/model/presence-projection";
import { useWorkspaceMemberLists } from "@/features/workspaces/hooks";
import { useAgentAvatarObjectUrl } from "@/features/agent-shell/hooks/avatar-hooks";
import { isBackendUnreachable, isUpdateRequired, useViewerUser } from "@/features/session/hooks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentAvatar } from "./agent-avatar";
import { AVATAR_PX } from "./avatar-scale";

interface AgentInfoPopoverProps {
  agent: AgentDto;
  /** The element that triggers the popover (rendered via Radix
   *  `asChild`). */
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** When set, the card carries a presence line + (when crashed) a retry
   *  action. WHICH AUTHORITY answers the line is the placement's, not this
   *  prop's: a roster placement shows the run state of the session serving this
   *  conversation and can also answer `Not here`; a workspace-less DirectPair
   *  shows the agent's global Availability (#task:2039, #task:2123). */
  conversationId?: string | null;
  /** `'click'` (default) opens on click for standalone controls.
   *  `'hover'` opens on pointer-enter and
   *  closes on pointer-leave with a small grace window so the user
   *  can move into the popover content. Used by inline mention pills,
   *  message author/avatar controls, and the member strip. */
  trigger?: "click" | "hover";
  /**
   * Avatar object URL resolved by the parent's batch hook.
   *
   * - `undefined` (omitted) — caller is a standalone surface with no
   *   batch context (settings page, dev tools); fall back to an internal
   *   single-agent `useAgentAvatarObjectUrl` so the popover still shows
   *   the right image.
   * - `null` — parent looked it up and the agent has no avatar (or it
   *   is still loading); render the runtime tint, no fetch.
   * - `string` — use the parent's blob URL directly.
   *
   * Required for high-frequency render sites (timeline message authors,
   * inline `@mentions`, header member chips). Without it, every popover
   * instance would fire its own GET — which destroys the batch-hook
   * contract. PR-2 review caught this and made the prop the canonical
   * path for those callers.
   */
  avatarObjectUrl?: string | null;
}

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 120;

/**
 * Compact agent info card. Shows avatar, display name + handle,
 * runtime/model, presence (the roster's run state in a channel, the agent's
 * global Availability in a workspace-less DirectPair — `PresenceInline`), and an
 * optional retry affordance when the agent has crashed in this conversation.
 *
 * Two trigger modes: click (standalone controls) and hover
 * (inline mentions, message author/avatar, and member strip in conversation header). Hover mode is implemented via
 * controlled `open` rather than a separate Radix HoverCard primitive
 * to keep the dep surface narrow.
 *
 * Single visual contract — the same card renders on every surface
 * (header member chip, message stream avatar/author, inline @mention).
 * Roster management and direct-pair runtime controls resolve their own
 * permissions and state authorities when a `conversationId` is provided.
 * There is no per-call
 * `management` switch (#task:912 review round 8 — the user noted that
 * the chip and the message-stream popover should not diverge).
 */
export function AgentInfoPopover({
  agent,
  children,
  side = "bottom",
  align = "start",
  conversationId,
  trigger = "click",
  avatarObjectUrl,
}: AgentInfoPopoverProps): JSX.Element {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [managementDialogOpen, setManagementDialogOpen] = useState(false);
  // What the SURFACE this card is rendered in can do — the pane's mode
  // projection answers it (#task:2039), so the popover neither infers presence
  // from where it happens to be rendered nor starts a roster read that the
  // placement has no roster for.
  const paneCaps = useConversationPaneCapabilities();
  // Fallback only when the caller is unbatched (`undefined`). The
  // explicit `null` case from a batched parent means "no avatar yet"
  // and must NOT trigger an internal fetch — that was the PR-2 review
  // blocker (every timeline popover otherwise re-fetched per instance).
  // `useAgentAvatarObjectUrl` short-circuits on null input, so passing
  // `null` here is a deliberate no-fetch path.
  const fallbackAvatarObjectUrl = useAgentAvatarObjectUrl(
    avatarObjectUrl === undefined ? agent.avatar_url : null,
  );
  const resolvedAvatarObjectUrl =
    avatarObjectUrl === undefined ? fallbackAvatarObjectUrl : avatarObjectUrl;
  // Single timer reused for both open and close so consecutive
  // pointer transitions cancel each other out cleanly.
  const timerRef = useRef<number | null>(null);
  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => () => clearTimer(), []);

  const scheduleOpen = (): void => {
    if (trigger !== "hover") return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setHoverOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const scheduleClose = (): void => {
    if (trigger !== "hover") return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setHoverOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  const rootProps =
    trigger === "hover"
      ? { open: hoverOpen || managementDialogOpen, onOpenChange: setHoverOpen }
      : {};

  return (
    <Popover.Root {...rootProps}>
      <Popover.Trigger asChild onPointerEnter={scheduleOpen} onPointerLeave={scheduleClose}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}
          data-popover-frame="info"
          className="z-(--z-dialog) w-65 max-w-[calc(100vw-32px)] bg-bg-floating p-3 shadow-popover outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          {/* v3 layout (#task:912 review round 7 → round 9 final):
                avatar | name + ● presence    [↻ ⏻ ⌫]   ← actions top-right
                       | @handle

              The description was removed from this popover entirely
              (round 9 final — the user's words: "profile card 直接不
              展示 description, 头像也跟着变小, 而且 description 长度也不
              太好控制"). Long-form description copy is hard to truncate
              cleanly inside a 260px card — it dragged the avatar / card
              into resizing dances across rounds 7 → 9. The full
              description still lives in the agent profile's
              Capabilities section; this card is intentionally a
              minimal identity preview (avatar / name + presence /
              handle / actions).

              Avatar is 36px to match the compact two-row layout —
              `items-center` aligns the avatar between the name and
              handle rows. Actions stay icon-only top-right. */}
          <div className="flex items-center gap-3">
            <AgentAvatar
              runtime={agent.runtime}
              size={AVATAR_PX.xl}
              avatarObjectUrl={resolvedAvatarObjectUrl}
              alt={agent.display_name || agent.name}
            />
            <div className="min-w-0 flex-1">
              {/* Name + inline presence dot. Presence sits as the
                  semantic state next to the name, and is only shown
                  when the card was opened FROM a conversation. The placement
                  decides which authority answers it (`paneCaps.hasRoster` →
                  the roster's run state, otherwise global Availability),
                  so the card can never contradict the chip it opened from
                  (#task:2123). */}
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold text-text-primary">
                  {agent.display_name || agent.name}
                </span>
                {conversationId ? (
                  <PresenceInline
                    agent={agent}
                    conversationId={conversationId}
                    hasRoster={paneCaps.hasRoster}
                  />
                ) : null}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">@{agent.name}</div>
            </div>
            {/* Top-right icon-only actions. Always rendered when a
                conversationId is in scope; AgentManagementActions
                short-circuits to null when the viewer can't edit
                this agent or the agent isn't a member of this
                conversation, so unauthorized surfaces stay
                informational without callers needing a separate gate
                prop. #task:912 review round 8 — collapsed the prior
                `management` switch so header chips and message-stream
                avatars render the same card. `self-start` overrides
                the row's `items-center` (used to center the avatar
                against the two text rows) so actions still sit in
                the top-right corner instead of riding the row's
                vertical center. */}
            {/* Per-conversation agent management is a ROSTER surface, so the
                placement's capability decides whether it is mounted at all
                (@Cindy, #task:2039 review): this component starts four
                conversation-scoped reads and used to hide itself when the roster
                response came back without a row for the agent — a pair has no
                such row and never will, which made "no controls" a property of
                the data instead of the mode. */}
            {conversationId && paneCaps.hasRoster ? (
              <div className="self-start">
                <AgentManagementActions
                  agent={agent}
                  conversationId={conversationId}
                  onDialogOpenChange={setManagementDialogOpen}
                />
              </div>
            ) : conversationId && !paneCaps.hasRoster ? (
              <div className="self-start">
                <DirectAgentActions
                  agent={agent}
                  conversationId={conversationId}
                  onDialogOpenChange={setManagementDialogOpen}
                />
              </div>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One visual contract for every presence line, whichever authority answered:
 *  the same pip + the same word next to the name. Everything on it comes from the
 *  one projection (`projectPresence`) — the dot colour from the tone, the label
 *  from the word, the accessible name from `a11yLabel` so a crashed session's
 *  folded `Offline` still says failed to a screen reader. Two agents in the same
 *  state never read differently (#task:2128).
 *
 *  Two a11y/hover rules, both from @Cindy's #task:2128 review:
 *   - A crash must NOT emit a `title`: shiki's ruling is "Offline + fault colour,
 *     no tooltip", and the detail sentence for `failed` IS that failure tooltip.
 *     So `failed` shows no hover caption; the failure reaches AT non-visually via
 *     the accessible name below. Other tones keep their scope-detail caption.
 *   - The accessible name rides `role="img"`, not a bare `<span>` + `aria-label`
 *     (a span has no implicit role, so a screen reader may name it from the
 *     visible word alone and drop a crash's "session failed"). `role="img"` names
 *     the whole thing from `a11yLabel` and reads once — the decorative pip and the
 *     visible label are not announced a second time. */
function PresenceLine({ display }: { display: PresenceDisplay }): JSX.Element {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-(length:--text-badge) text-text-muted"
      title={display.tone === "failed" ? undefined : display.detail}
      role="img"
      aria-label={display.a11yLabel}
    >
      <span
        data-status-pip
        className={
          "size-1.5 rounded-(--pill-radius) " +
          PRESENCE_TONE_DOT[display.tone] +
          (display.pulse ? " motion-safe:animate-pulse" : "")
        }
      />
      {display.label}
    </span>
  );
}

/**
 * The agent's presence next to its name (#task:2039, #task:2123).
 *
 * WHICH AUTHORITY ANSWERS IS A PROPERTY OF THE PLACEMENT, and the decision is a
 * named pure function (`presenceAuthorityFor`) switched exhaustively here — this
 * branch is exactly where the two authorities used to be crossed:
 *
 *  - `roster_runtime` (a channel) — the run state of the session serving this
 *    conversation, plus the membership answer (`Not here`) only a roster can
 *    state. This card is opened FROM the member chip, and the chip has always
 *    shown that run state, so reading the agent's global Availability here
 *    produced `Idle` on the chip and `Online` in the card above it — one agent,
 *    two words, both live (#task:2123).
 *  - `global_presence` (a `direct_pair`) — unchanged. There is no membership
 *    question and no conversation-scoped slot; reading a roster row here once
 *    told a user their DM counterpart was `Not here` while it was answering them
 *    (shiki, #task:2039).
 *
 * The switch picks a COMPONENT, not a value, because the choice also decides
 * which reads to start: a DirectPair must not issue the roster reads at all.
 */
function PresenceInline({
  agent,
  conversationId,
  hasRoster,
}: {
  agent: AgentDto;
  conversationId: string;
  hasRoster: boolean;
}): JSX.Element | null {
  switch (presenceAuthorityFor(hasRoster)) {
    case "roster_runtime":
      return <RosterMemberPresence agent={agent} conversationId={conversationId} />;
    case "global_presence":
      return <GlobalPresenceInline agent={agent} />;
  }
}

/**
 * Global presence — the surfaces that ask "can this agent work for me at all",
 * which after #task:2123 means a workspace-less DirectPair and the agent's own
 * profile, never a roster placement.
 */
function GlobalPresenceInline({ agent }: { agent: AgentDto }): JSX.Element | null {
  // Availability (host reachable × agent valid — "can it work for me now") is
  // the primary axis and the only source of Offline; the presence-clock deadline
  // distinguishes Online from Away once available (#task:2049). Reading Offline
  // from a process-liveness bit ALONE was the old bug — a reachable agent that
  // had just replied showed Offline because its runtime had exited. `useAgentPresence`
  // reads Offline solely from availability, so idle now reads Away, not Offline.
  const presence = useAgentPresence(agent.id);
  // `null` = no definite answer yet (availability pending / errored). Draw
  // nothing rather than assert a speculative status.
  if (presence === null) return null;
  return <PresenceLine display={projectPresence({ scope: "global", presence })} />;
}

/**
 * A roster placement's presence line: the SAME state the member chip's dot shows,
 * from the SAME projection (`projectMemberRuntimeStatus`), so the card and the
 * chip it was opened from cannot disagree (#task:2123).
 *
 * BOTH READS ARE THREE-STATE, and neither may be defaulted. Membership answers
 * `unknown` until the roster read is settled-successful (@Cindy, #task:2039) —
 * a pending or cold-errored roster must not impersonate `Not here` — and the
 * runtime read gets the same discipline here: raw `query.data`, because a `= []`
 * default would turn "not answered" into "answered, no row" and assert Idle for
 * every agent in the channel while the read is in flight or failing.
 *
 * The scope of the answering slot rides the DETAIL sentence only. An
 * agent-scoped agent has one session serving every conversation, so "Online in
 * this channel" would be a claim its slot does not support; the word is the same
 * either way, and `projectPresence` owns the distinction (#task:2128).
 */
function RosterMemberPresence({
  agent,
  conversationId,
}: {
  agent: AgentDto;
  conversationId: string;
}): JSX.Element | null {
  const { data: members } = useChannelAgents(conversationId);
  const { data: runtime } = useChannelAgentRuntime(conversationId);
  const status = projectMemberRuntimeStatus({
    membership: projectRosterMembership(members, agent.id),
    runtime,
    agentId: agent.id,
  });
  const display = projectPresence({ scope: "conversation", runtime: status });
  // `null` = `unknown`: the roster read has not settled, so there is no honest
  // word yet (this is the type narrowing too — `unknown` is the only status
  // without a display).
  if (display === null) return null;
  return <PresenceLine display={display} />;
}

function AgentManagementActions({
  agent,
  conversationId,
  onDialogOpenChange,
}: {
  agent: AgentDto;
  conversationId: string;
  onDialogOpenChange: (open: boolean) => void;
}): JSX.Element | null {
  const { data: conversationAgents = [] } = useChannelAgents(conversationId);
  // Raw, like the presence line's: the projection answers `unknown` for an
  // unsettled read, and Stop then stays disabled — the fail-closed direction for
  // a control, and reached without a `= []` that would call it `no_session`.
  const { data: conversationRuntime } = useChannelAgentRuntime(conversationId);
  const start = useStartAgent(conversationId);
  const stop = useStopAgent(conversationId);
  const clearSession = useClearAgentSession(conversationId, agent.session_scope);
  const removeFromChannel = useRemoveAgentFromChannel(conversationId);
  const { data: viewer } = useViewerUser();
  // Resolve the viewer's role in THIS conversation's workspace so the
  // remove gate can honor "workspace owner/admin" without callers having
  // to thread a workspaceId through every popover surface (mentions,
  // message authors, header chips). Both queries are cached and only
  // mount when the popover content opens.
  const conversation = useConversationById(conversationId);
  const { data: memberLists } = useWorkspaceMemberLists(conversation.ref?.workspace_id ?? null);
  const [clearOpen, setClearOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const row = conversationAgents.find((s) => s.agent_id === agent.id);
  // The same projection the presence line reads, so "which row serves this agent
  // here" is decided once for this whole card (#task:2123). This is the CONTROL
  // question, not the display one — "is there a session to stop" — and it reads
  // the answer instead of re-finding the row.
  const runtimeStatus = projectMemberRuntimeStatus({
    membership: "member",
    runtime: conversationRuntime,
    agentId: agent.id,
  });
  const stoppable = runtimeStatus.kind === "session" && runtimeStatus.status !== "idle";
  if (!row) return null;
  const viewerForPermissions =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  // Runtime controls (restart / stop / clear) stay creator-only, mirroring
  // the backend `canEditAgent` gate. Removing from the conversation is a
  // wider governance action — agent owner OR workspace owner/admin
  // (#task:957, plan A: no per-channel owner concept).
  const canManageRuntime = canEditAgentProfile(viewerForPermissions, agent);
  const canRemove = canRemoveAgentFromChannel(viewerForPermissions, agent, memberLists?.viewerRole);
  if (!canManageRuntime && !canRemove) return null;

  const pending = start.isPending || stop.isPending || clearSession.isPending;
  const agentLabel = `@${agent.name}`;
  const convNoun = "channel";
  const setClearDialogOpen = (open: boolean): void => {
    setClearOpen(open);
    onDialogOpenChange(open);
  };
  const setRemoveDialogOpen = (open: boolean): void => {
    setRemoveOpen(open);
    onDialogOpenChange(open);
  };
  const restart = async (): Promise<void> => {
    if (pending) return;
    await stop.mutateAsync({ agentId: agent.id });
    try {
      await start.mutateAsync(agent.id);
    } catch {
      // useStartAgent owns the visible toast; suppress the rejected click promise.
    }
  };
  const stopAgent = (): void => {
    if (pending) return;
    stop.mutate({ agentId: agent.id });
  };
  const clear = async (): Promise<void> => {
    await clearSession.mutateAsync(agent.id);
    setClearDialogOpen(false);
  };
  const remove = async (): Promise<void> => {
    try {
      await removeFromChannel.mutateAsync(agent.id);
      setRemoveDialogOpen(false);
    } catch {
      // useRemoveAgentFromChannel surfaces the toast; keep the dialog
      // open so the user can retry or cancel.
    }
  };

  return (
    <>
      {/* v3 (#task:912 review round 7) + round 8 + round 9: top-right
          icon-only action group. No bottom-bar label buttons — the
          popover stays identity-led and visually light. All icons sit on
          a uniform `gap-0.5` grid (round 9 — the user flagged the prior
          destructive-spacer break against equal spacing; the destructive
          hover-red + error tint already carries the warning, the gap
          doesn't need to). The Restart icon also covers the crashed →
          restart path; round 8 collapsed the standalone RetryRow because
          the same Restart icon is now always available on every popover
          surface. #task:957: the trailing UserMinus removes the agent
          from THIS conversation; it is gated wider than the creator-only
          runtime trio (agent owner OR workspace owner/admin), so a
          non-creator workspace owner sees only this control. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {canManageRuntime ? (
          <>
            <button
              type="button"
              onClick={restart}
              disabled={pending}
              className="inline-flex size-7 items-center justify-center rounded-(--control-radius) text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
              title={`Restart ${agentLabel}`}
              aria-label={`Restart ${agentLabel}`}
            >
              <RefreshCw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={stopAgent}
              disabled={pending || !stoppable}
              className="inline-flex size-7 items-center justify-center rounded-(--control-radius) text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
              title={`Stop ${agentLabel}`}
              aria-label={`Stop ${agentLabel}`}
            >
              <Power className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setClearDialogOpen(true)}
              disabled={pending}
              className="inline-flex size-7 items-center justify-center rounded-(--control-radius) text-error/70 transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:hover:bg-transparent"
              title={`Clear ${agentLabel} session`}
              aria-label={`Clear ${agentLabel} session`}
            >
              <Eraser className="size-3.5" />
            </button>
          </>
        ) : null}
        {canRemove ? (
          <button
            type="button"
            onClick={() => setRemoveDialogOpen(true)}
            disabled={removeFromChannel.isPending}
            className="inline-flex size-7 items-center justify-center rounded-(--control-radius) text-error/70 transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:hover:bg-transparent"
            title={`Remove ${agentLabel} from this ${convNoun}`}
            aria-label={`Remove ${agentLabel} from this ${convNoun}`}
          >
            <UserMinus className="size-3.5" />
          </button>
        ) : null}
      </div>
      <Dialog open={clearOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-error">
              <AlertTriangle className="size-4" />
              Clear session for {agentLabel}
            </DialogTitle>
            <DialogDescription>A new session begins on the next start.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="cancel"
              onClick={() => setClearDialogOpen(false)}
              disabled={clearSession.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={clear}
              disabled={clearSession.isPending}
            >
              {clearSession.isPending ? "Clearing..." : "Clear session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={removeOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-error">
              <AlertTriangle className="size-4" />
              Remove {agentLabel} from this {convNoun}
            </DialogTitle>
            <DialogDescription>
              {agentLabel} will no longer be part of this {convNoun}. You can add it back anytime.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="cancel"
              onClick={() => setRemoveDialogOpen(false)}
              disabled={removeFromChannel.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={remove}
              disabled={removeFromChannel.isPending}
            >
              {removeFromChannel.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DirectAgentActions({
  agent,
  conversationId,
  onDialogOpenChange,
}: {
  agent: AgentDto;
  conversationId: string;
  onDialogOpenChange: (open: boolean) => void;
}): JSX.Element | null {
  const { data: viewer } = useViewerUser();
  const pair = useDirectPairs().find((pair) => pair.conversation_id === conversationId);
  const principal =
    viewer && (isBackendUnreachable(viewer) || isUpdateRequired(viewer)) ? undefined : viewer;
  if (!canControlDirectAgent(principal, agent, pair)) return null;
  return (
    <DirectAgentRuntimeActions
      key={`${conversationId}:${agent.id}`}
      agent={agent}
      conversationId={conversationId}
      onDialogOpenChange={onDialogOpenChange}
    />
  );
}

function DirectAgentRuntimeActions({
  agent,
  conversationId,
  onDialogOpenChange,
}: {
  agent: AgentDto;
  conversationId: string;
  onDialogOpenChange: (open: boolean) => void;
}): JSX.Element {
  const { data: runtime } = useAgentRuntimeState(agent.id);
  const availability = useAgentAvailability(agent.id);
  const start = useStartAgent(conversationId);
  const stop = useStopAgent(conversationId);
  const clearSession = useClearAgentSession(conversationId, agent.session_scope);
  const [clearOpen, setClearOpen] = useState(false);
  const state = directAgentControlState(runtime, availability);
  const pending = start.isPending || stop.isPending || clearSession.isPending;
  const disabled = pending || !state.ready;
  const action = state.startable ? "Start" : "Stop";
  const setClearDialogOpen = (open: boolean): void => {
    setClearOpen(open);
    onDialogOpenChange(open);
  };
  return (
    <>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => {
            if (disabled) return;
            if (state.startable) start.mutate(agent.id);
            else stop.mutate({ agentId: agent.id });
          }}
          disabled={disabled}
          className="inline-flex size-7 items-center justify-center rounded-(--control-radius) text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary disabled:opacity-50 disabled:hover:bg-transparent"
          title={`${action} @${agent.name}`}
          aria-label={`${action} @${agent.name}`}
        >
          {state.startable ? <Play className="size-3.5" /> : <Power className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => setClearDialogOpen(true)}
          disabled={disabled}
          className="inline-flex size-7 items-center justify-center rounded-(--control-radius) text-error/70 transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50 disabled:hover:bg-transparent"
          title={`Clear @${agent.name} session`}
          aria-label={`Clear @${agent.name} session`}
        >
          <Eraser className="size-3.5" />
        </button>
      </div>
      <Dialog open={clearOpen} onOpenChange={setClearDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear session for @{agent.name}</DialogTitle>
            <DialogDescription>
              The next start uses a fresh CLI session across all conversations. MEMORY, notes, and
              queued deliveries are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="cancel" onClick={() => setClearDialogOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                clearSession.mutate(agent.id, { onSuccess: () => setClearDialogOpen(false) });
              }}
            >
              {clearSession.isPending ? "Clearing..." : "Clear session"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
