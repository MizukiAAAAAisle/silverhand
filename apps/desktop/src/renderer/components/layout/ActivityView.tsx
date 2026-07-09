import { useMemo, useState } from 'react';
import {
  Activity as ActivityIcon,
  AlertTriangle,
  Check,
  MessageCircle,
  MessagesSquare,
} from 'lucide-react';
import type { ActivityItemDto, ActivityPreviewSender, AgentDto } from '@silverhand/shared';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { ChannelIcon } from '@/components/ChannelIcon';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import type { AgentAvatarSource } from '@/features/agents/avatar-hooks';
import {
  useActivity,
  useClearActivityItem,
  useMarkActivityAllRead,
} from '@/features/attention/hooks';
import { activityItemSource } from '@/features/attention/observe';
import { ListRowsSkeleton } from './ListRowsSkeleton';
import type { MessageJumpTarget } from '@/features/channels/useMessageJumpController';

/**
 * Activity — the human's "queue waiting on me" (#task:1227). Read-side
 * projection of `listActivity`: the server returns the list already filtered
 * (§6), per-(viewer,message) de-duped (§7) and salience-sorted (§13.2). The
 * renderer renders it AS-IS and never re-scores; the three filter chips slice it
 * purely client-side.
 *
 * v1 UI scope = GLOBAL: one list spanning every workspace. Each row is a LIST
 * CARD in the Saved-item visual language — NOT an alert feed: no left icon box,
 * no left salience rail, items spaced apart, themed border, forza6 poster hover
 * via the shared `data-list-row` hook. Salience is carried by the two sections
 * (Requires attention / Subscribed), not by a per-row border. Location reads
 * through real identity icons on the where-line (workspace + channel).
 *
 * Row structure is SOURCE-FIRST (server-resolved fields only; never a
 * client-stitched message cache), now ICON-LED so location reads at a glance:
 *   - row 1 = WHERE: workspace icon + name · channel icon + conversation `title`.
 *     The icons are the canonical identity primitives (`WorkspaceIcon`; `Hash`
 *     with the `data-channel-icon` theme hook), NOT raw glyphs — so forza6 paints
 *     them as its `W`/`#` posters instead of generic lucide shapes. The old
 *     "Channel/Mention/Thread" text label is dropped: real icons + the thread
 *     glyph (row 2) + the sender (row 3) carry that signal now.
 *   - row 2 = SUBJECT: thread → a thread glyph + `thread_root_preview` (the root
 *     summary it belongs under); else → `preview` (the message excerpt).
 *   - row 3 = THREAD reply: `preview` (the triggering reply), shown only when
 *     row 2 already carries the thread root summary. The sender (avatar +
 *     display_name) lands here once the backend resolves `preview_sender` on the
 *     anchor message (additive DTO field).
 *
 * Clearing (§5.3 source_ref-out) — by EXPLICIT fields, never by parsing `id`,
 * and routed through one chokepoint (`activityItemSource`):
 *   - mention / agent_failed (directed) → mark the `notification_id` read.
 *   - unread (ambient)                  → advance the stream cursor via an
 *     EXPLICIT stream-head clear (#task:1231 phase B; knowingly tail-swallows, §2).
 *   Each row exposes a hover-✓ that clears WITHOUT navigating, and the header
 *   "Mark all read" batches the currently-visible list in one `observe()` call
 *   (directed by id, ambient by stream-head — a batch never converts a directed
 *   dismiss into a stream clear). Navigating to a source still clears it too
 *   (directed on click; ambient via open-time mark-read).
 *
 * `kind=task` is intentionally NOT in Activity v1:
 * an `in_review && member` projection is a standing mirror of the task panel's
 * In-review column, not a transient attention event — it has no other home only
 * mentions/unread do, so tasks stay in the task panel. Task re-enters Activity in
 * v2 ONLY via a real event source (notification-backed `task_needs_review`,
 * read-cleared), never a status mirror. See `docs/activity-lifecycle-v1.md`.
 */

type FilterKey = 'all' | 'mention' | 'thread';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mention', label: 'Mentions' },
  { key: 'thread', label: 'Threads' },
];

/** Namespaced key for a sender's avatar object-url map. `preview_sender`'s
 *  identity is `{kind, id}` — users and agents are separate tables, so a bare
 *  `id` could collide and cross-wire two avatars. Runtime lookup in
 *  `agentsById` still uses the raw agent id (that map is agent-only). */
function senderKey(s: { kind: 'user' | 'agent'; id: string }): string {
  return `${s.kind}:${s.id}`;
}

function matchesFilter(item: ActivityItemDto, key: FilterKey): boolean {
  switch (key) {
    case 'all':
      return true;
    case 'mention':
      return item.kind === 'mention';
    case 'thread':
      // A "Thread" item is anything located in a reply cluster, regardless of
      // kind — overlapping facet, not a partition (a thread @me matches both
      // Mentions and Threads). Single-select, so the user views one lens.
      return item.thread_root_id != null;
  }
}

/** Row-1 channel identity glyph — the canonical themed primitive for where the
 *  item lives, driven by explicit DTO fields (never guessed from copy):
 *    - `channel`    → `Hash` carrying the `data-channel-icon` theme hook (forza6
 *      repaints it as a `#` poster, matching the sidebar/header `#`).
 *    - `dm_channel` → a message-circle (DM identity is really the agent, already
 *      shown by the workspace icon; this is the conversation-side marker).
 *    - `agent_failed` → a warning glyph (error-tinted) — it has no normal channel
 *      context, and the warning must survive the dropped text label.
 *  An if-chain (not an exhaustive switch on `kind`) so it stays decoupled from
 *  whether the shared `kind` union still carries the now-removed `task`. */
function ChannelGlyph({ item }: { item: ActivityItemDto }): JSX.Element {
  if (item.kind === 'agent_failed') {
    return <AlertTriangle className="size-3.5 shrink-0 text-error" />;
  }
  if (item.conversation_kind === 'dm_channel') {
    return <MessageCircle className="size-3.5 shrink-0 text-text-muted" />;
  }
  return <ChannelIcon variant="sticker" className="text-text-muted" />;
}

/** The sender's avatar for a message line. The DTO gives a resolved
 *  `{kind, id, display_name, avatar_url}`; the renderer only picks the avatar
 *  component by `kind` and never re-infers identity:
 *    - an uploaded avatar (`avatar_url` → resolved object URL) renders as the
 *      image in either component (both are square, object-cover).
 *    - no image → user falls back to the neutral person glyph; an agent falls
 *      back to its runtime BRAND tile (claude/codex/…), so it reads the same as
 *      everywhere else in the app. Runtime comes from the GLOBAL agent map (by
 *      the explicit sender id), not from a per-workspace member cache; an agent
 *      missing there (or no runtime) degrades to the neutral glyph. */
function SenderAvatar({
  sender,
  objectUrl,
  agentsById,
}: {
  sender: ActivityPreviewSender;
  objectUrl: string | null;
  agentsById: ReadonlyMap<string, AgentDto>;
}): JSX.Element {
  if (sender.kind === 'agent') {
    const runtime = agentsById.get(sender.id)?.runtime;
    if (runtime) {
      return (
        <AgentAvatar
          runtime={runtime}
          size={AVATAR_PX.xs}
          avatarObjectUrl={objectUrl}
          alt={sender.display_name}
        />
      );
    }
  }
  return (
    <UserAvatar size={AVATAR_PX.xs} avatarObjectUrl={objectUrl} alt={sender.display_name} />
  );
}

/** A source message line: `<avatar> <display_name>: <content>`. The sender
 *  prefix is shown only when `sender` is present (NULL for `agent_failed` /
 *  system) — then the line is just the content. The name is body-scale + muted
 *  (a subordinate label, never a heading) so it doesn't steal the content's role
 *  as subject. */
function SenderMessageLine({
  sender,
  objectUrl,
  agentsById,
  content,
  className,
}: {
  sender: ActivityPreviewSender | null;
  objectUrl: string | null;
  agentsById: ReadonlyMap<string, AgentDto>;
  content: string | null;
  className?: string;
}): JSX.Element {
  return (
    <div className={'mt-1 flex items-center gap-2 ' + (className ?? '')}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {sender ? (
          <>
            <SenderAvatar
              sender={sender}
              objectUrl={objectUrl}
              agentsById={agentsById}
            />
            <span className="min-w-0 max-w-[45%] shrink-0 truncate text-sm font-normal text-text-secondary">
              {sender.display_name}:
            </span>
          </>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {content}
        </span>
      </div>
    </div>
  );
}

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

/** Per-workspace identity for a row's workspace icon + disambiguating name.
 *  `kind` / `dmAgentId` feed the canonical {@link WorkspaceIcon} (regular →
 *  themed `W`; DM → the bound agent's avatar). */
export interface ActivityWorkspaceRef {
  name: string;
  kind: 'regular' | 'dm';
  dmAgentId: string | null;
}

interface ActivityViewProps {
  /** workspace_id → identity (name + icon inputs). A global list spans every
   *  workspace, so each row shows its workspace icon and a name that
   *  disambiguates same-named channels across workspaces. */
  workspaceRefById: ReadonlyMap<string, ActivityWorkspaceRef>;
  /** agent_id → agent, for the DM workspace icon (the bound agent's avatar). */
  agentsById: ReadonlyMap<string, AgentDto>;
  /** Jump to a message source — the parent owns view routing (flips to channel
   *  view, selects workspace + channel, scrolls + flashes). Cross-workspace
   *  stable: the target carries its own `workspaceId`. */
  onJump: (target: MessageJumpTarget) => void;
}

export function ActivityView({
  workspaceRefById,
  agentsById,
  onJump,
}: ActivityViewProps): JSX.Element {
  const { data, isLoading, isError } = useActivity();
  const [filter, setFilter] = useState<FilterKey>('all');
  const markAllRead = useMarkActivityAllRead();

  const items = data?.items ?? [];

  // Resolve each row's sender avatar once, batched + cross-workspace (leaf
  // avatar components never fetch — PR-2). Keyed off the FULL list so a filter
  // switch doesn't tear down + refetch; the hook is generic over
  // {id, avatar_url} and serves both user and agent senders. display_name is
  // server-guaranteed non-empty, so the fallback glyph path only ever lacks an
  // IMAGE, never a label.
  const senderSources = useMemo(
    () =>
      items
        .map(it => it.preview_sender)
        .filter((s): s is ActivityPreviewSender => s != null)
        // Namespace the key by {kind, id} so a user/agent id collision can't
        // cross-wire avatars. The hook keys its result map by the
        // `id` we pass, so we pass the namespaced key here AND look up by it.
        .map(s => ({ id: senderKey(s), avatar_url: s.avatar_url })),
    [items],
  );
  const senderAvatarUrls = useAgentAvatarObjectUrls(senderSources);

  // DM workspace icons resolve through the SAME canonical `WorkspaceIcon` as the
  // rail / search / archived surfaces — so their uploaded agent avatars must be
  // resolved too, else the DM branch silently degrades to the runtime brand and
  // Activity becomes the only half-canonical surface. Batched over the stable
  // DM-agent set, mirroring `Sidebar`'s `dmAvatarSources`.
  const dmAvatarSources = useMemo<AgentAvatarSource[]>(() => {
    const out: AgentAvatarSource[] = [];
    for (const ref of workspaceRefById.values()) {
      if (ref.kind !== 'dm' || !ref.dmAgentId) continue;
      const agent = agentsById.get(ref.dmAgentId);
      if (!agent) continue;
      out.push({ id: agent.id, avatar_url: agent.avatar_url });
    }
    return out;
  }, [workspaceRefById, agentsById]);
  const dmAgentAvatarUrls = useAgentAvatarObjectUrls(dmAvatarSources);

  // Per-chip counts off the full (unfiltered) list, so each chip answers "how
  // many of this kind wait on me".
  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, mention: 0, thread: 0 };
    for (const it of items) {
      c.all += 1;
      if (it.kind === 'mention') c.mention += 1;
      if (it.thread_root_id != null) c.thread += 1;
    }
    return c;
  }, [items]);

  const filtered = useMemo(
    () => items.filter(it => matchesFilter(it, filter)),
    [items, filter],
  );
  const directed = filtered.filter(it => it.salience === 'directed');
  const ambient = filtered.filter(it => it.salience === 'ambient');

  // "Mark all read" clears the VISIBLE (filtered) list, so the label names that
  // scope to stay honest under a filter: "Mark all read" only when nothing is
  // filtered out, else "Mark mentions/threads read". Behavior is unchanged — the
  // label just tells the truth about what the click clears.
  const markAllLabel =
    filter === 'all'
      ? 'Mark all read'
      : `Mark ${FILTERS.find(f => f.key === filter)?.label.toLowerCase()} read`;

  return (
    <main
      className="flex h-full flex-1 flex-col bg-bg-chat"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      <header className="flex h-[var(--titlebar-height)] shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <ActivityIcon className="size-3.5 text-accent" />
        <span className="font-serif text-sm font-semibold text-text-primary">
          Activity
        </span>
        <span className="text-xs text-text-muted">{counts.all}</span>
      </header>

      {/* Filter chips + Mark-all share one toolbar: Mark-all's scope follows the
          active filter, so co-location keeps that coupling legible. No bottom
          divider — chip spacing + section labels carry the hierarchy. Selected
          chips use the theme selection token, never a semantic hue (they must not
          steal the items' volume budget). */}
      <div className="flex shrink-0 items-center gap-1.5 px-4 py-2">
        {FILTERS.map(f => {
          const on = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={
                'inline-flex items-center gap-1.5 border-[length:var(--control-border-width)] rounded-[var(--chip-radius)] px-2.5 py-1 text-xs font-medium transition-colors ' +
                (on
                  ? 'border-[color:var(--border-control-hover)] bg-[var(--bg-row-selected)] text-text-primary'
                  : 'border-border bg-bg-floating text-text-muted hover:border-[color:var(--border-control-hover)] hover:text-text-primary')
              }
            >
              {f.label}
              <span className={on ? 'opacity-100' : 'opacity-60'}>{counts[f.key]}</span>
            </button>
          );
        })}
        {/* Mark all read — clears the visible filtered list only (never a hidden
            item; `markAllLabel` names the scope). Routes each item via
            `activityItemSource`; the list empties as its own feedback (no toast).
            Quiet utility action (ink border, not a primary fill) so it doesn't
            compete with the chips beside it. */}
        {filtered.length > 0 ? (
          <button
            type="button"
            onClick={() => markAllRead.mutate(filtered)}
            disabled={markAllRead.isPending}
            className="ml-auto inline-flex items-center gap-1.5 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-2 py-1 text-xs font-medium text-text-muted transition-colors hover:border-[color:var(--border-control-hover)] hover:text-text-primary disabled:opacity-50"
          >
            <Check className="size-3" />
            {markAllLabel}
          </button>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {isLoading ? (
          <ListRowsSkeleton />
        ) : isError ? (
          // Distinct from the empty state — a failed load must not read as an
          // empty queue.
          <div className="flex flex-col items-center gap-1.5 py-16 text-center">
            <span className="font-serif text-base font-semibold text-text-secondary">
              Couldn't load Activity
            </span>
            <span className="text-sm text-text-muted">Check your connection and retry</span>
          </div>
        ) : filtered.length === 0 ? (
          items.length === 0 ? (
            // The whole queue is empty — genuinely caught up.
            <div className="flex flex-col items-center gap-1.5 py-16 text-center">
              <span className="font-serif text-base font-semibold text-text-secondary">
                All caught up
              </span>
            </div>
          ) : (
            // Items exist but the active filter excludes them; don't imply the
            // whole queue is empty.
            <div className="flex flex-col items-center gap-1.5 py-16 text-center">
              <span className="font-serif text-base font-semibold text-text-secondary">
                No {FILTERS.find(f => f.key === filter)?.label.toLowerCase()}
              </span>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-5">
            {directed.length > 0 ? (
              <ActivitySection
                label="Requires attention"
                items={directed}
                workspaceRefById={workspaceRefById}
                agentsById={agentsById}
                dmAgentAvatarUrls={dmAgentAvatarUrls}
                senderAvatarUrls={senderAvatarUrls}
                onJump={onJump}
              />
            ) : null}
            {ambient.length > 0 ? (
              <ActivitySection
                label="Subscribed"
                items={ambient}
                workspaceRefById={workspaceRefById}
                agentsById={agentsById}
                dmAgentAvatarUrls={dmAgentAvatarUrls}
                senderAvatarUrls={senderAvatarUrls}
                onJump={onJump}
              />
            ) : null}
          </div>
        )}
      </div>
    </main>
  );
}

function ActivitySection({
  label,
  items,
  workspaceRefById,
  agentsById,
  dmAgentAvatarUrls,
  senderAvatarUrls,
  onJump,
}: {
  label: string;
  items: ActivityItemDto[];
  workspaceRefById: ReadonlyMap<string, ActivityWorkspaceRef>;
  agentsById: ReadonlyMap<string, AgentDto>;
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
  senderAvatarUrls: ReadonlyMap<string, string | null>;
  onJump: (target: MessageJumpTarget) => void;
}): JSX.Element {
  return (
    <section>
      <div className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </div>
      <ul className="space-y-2">
        {items.map(item => (
          <ActivityRow
            key={item.id}
            item={item}
            workspace={workspaceRefById.get(item.workspace_id)}
            agentsById={agentsById}
            dmAgentAvatarUrls={dmAgentAvatarUrls}
            senderAvatarUrls={senderAvatarUrls}
            onJump={onJump}
          />
        ))}
      </ul>
    </section>
  );
}

function ActivityRow({
  item,
  workspace,
  agentsById,
  dmAgentAvatarUrls,
  senderAvatarUrls,
  onJump,
}: {
  item: ActivityItemDto;
  workspace?: ActivityWorkspaceRef;
  agentsById: ReadonlyMap<string, AgentDto>;
  dmAgentAvatarUrls: ReadonlyMap<string, string | null>;
  senderAvatarUrls: ReadonlyMap<string, string | null>;
  onJump: (target: MessageJumpTarget) => void;
}): JSX.Element {
  const clearItem = useClearActivityItem();

  // Navigation needs a message anchor; agent_failed has none (pure read_at).
  const canJump = item.message_id != null;
  const jump = () => {
    if (item.message_id == null) return;
    onJump({
      workspaceId: item.workspace_id,
      channelId: item.conversation_id,
      threadRootId: item.thread_root_id,
      messageId: item.message_id,
    });
  };

  const isThread = item.thread_root_id != null;
  // The triggering message (`preview`) and its `preview_sender` always pair:
  //   - thread WITH a root summary → row 2 = thread glyph + `thread_root_preview`
  //     (no sender — v1 shows no root author); row 3 = the reply (`preview`) with
  //     its sender.
  //   - otherwise (mainline / mention / thread missing a root preview) → the
  //     `preview` line IS the last row and carries the sender; no separate row 3.
  // Server-resolved fields only, never a client-stitched message cache.
  const hasRootLine = isThread && item.thread_root_preview != null;
  const sender = item.preview_sender;
  const senderObjectUrl = sender
    ? senderAvatarUrls.get(senderKey(sender)) ?? null
    : null;
  // The §5.3 source_ref-out for this item, resolved through the single routing
  // chokepoint (`activityItemSource`, keyed on KIND not salience):
  //   - mention / agent_failed → by `notification_id`
  //   - unread (incl DM positional, which is salience:'directed') → stream-head
  //     clear (may carry a thread root)
  // null only for a malformed item — then the row offers no ✓.
  const clearSource = activityItemSource(item);

  // Dense row-1 count metadata. Sits RIGHT AFTER the channel title (an
  // attention count belongs with the stream it counts, not floated to the far
  // edge) and carries a soft-accent fill so the unread signal reads at a glance
  // — louder than the old borderless neutral, but a step below the sidebar's
  // full-accent pill so the dense header line stays scannable (#task:1269
  // item 2).
  const countEl =
    item.unread_count != null && item.unread_count > 0 ? (
      <span className="shrink-0 rounded-[var(--control-radius)] bg-accent-soft px-1.5 py-px text-xs font-medium leading-tight tabular-nums text-accent">
        {item.unread_count > 99 ? '99+' : item.unread_count} new
      </span>
    ) : null;

  const handleRowClick = () => {
    if (!canJump) return;
    // Only a notification-backed item is cleared on open: opening the source
    // doesn't auto-read its notification, so clear it explicitly. A stream-backed
    // item (any `unread`, INCLUDING DM positional) is cleared by navigation's
    // open-time mark-read, so clearing again here would be a redundant second
    // path. Deriving this from `clearSource.kind` (not the item's kind/salience)
    // keeps the decision in lockstep with the routing chokepoint.
    if (clearSource?.kind === 'notification') {
      clearItem.mutate(clearSource);
    }
    jump();
  };

  return (
    <li>
      {/* List card in the Saved-item language: themed border + bg-floating
          ground + `--row-radius`; forza6 repaints it as a 0-radius poster with
          ink-border + drop-shadow + lift hover via the shared `data-list-row`
          hook (no per-row left rail). A row hover is a utility signal → ink
          border, never the brand hue. */}
      <div
        role={canJump ? 'button' : undefined}
        tabIndex={canJump ? 0 : undefined}
        onClick={handleRowClick}
        onKeyDown={e => {
          if (canJump && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            handleRowClick();
          }
        }}
        data-list-row
        className={
          'group flex items-start gap-3 rounded-[var(--row-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-4 py-3 transition-colors ' +
          (canJump ? 'cursor-pointer hover:border-[color:var(--border-control-hover)]' : '')
        }
      >
        <div className="min-w-0 flex-1">
          {/* row 1 — WHERE: workspace icon + name · channel icon + title.
              Canonical identity primitives (themed `WorkspaceIcon` +
              `data-channel-icon` `#`) replace the old type text label; forza6
              repaints them as its posters. */}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
            {workspace ? (
              <>
                <WorkspaceIcon
                  kind={workspace.kind}
                  dmAgentId={workspace.dmAgentId}
                  agentsById={agentsById}
                  dmAgentAvatarUrls={dmAgentAvatarUrls}
                />
                <span className="min-w-0 shrink truncate text-text-secondary">
                  {workspace.name}
                </span>
                <span aria-hidden className="text-text-muted/60">
                  ·
                </span>
              </>
            ) : null}
            <ChannelGlyph item={item} />
            <span className="min-w-0 shrink truncate text-text-secondary">
              {item.title}
            </span>
            {/* "N new" rides right after the title — an aggregate about THIS
                stream, kept next to its subject rather than floated to the row
                edge (the timestamp owns the far-right). */}
            {countEl}
          </div>

          {/* row 2 — thread root summary (thread glyph marks it as the root
              message), OR the triggering message line with its sender when
              there is no separate root. The root is CONTEXT, so it's recessed
              to muted ink (cohesive with its muted glyph) — the reply below is
              the focus and keeps primary ink (#task:1269 item 3). */}
          {hasRootLine ? (
            <div className="mt-1 flex items-center gap-2">
              <MessagesSquare
                aria-hidden
                className="size-3.5 shrink-0 text-text-muted"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-text-muted">
                {item.thread_root_preview}
              </span>
            </div>
          ) : (
            <SenderMessageLine
              sender={sender}
              objectUrl={senderObjectUrl}
              agentsById={agentsById}
              content={item.preview ?? item.title}
            />
          )}

          {/* row 3 — the thread reply (`preview`) with its sender, shown only
              when row 2 already carries the thread root summary. */}
          {hasRootLine ? (
            <SenderMessageLine
              sender={sender}
              objectUrl={senderObjectUrl}
              agentsById={agentsById}
              content={item.preview}
              className="mt-0.5"
            />
          ) : null}
        </div>

        {/* Timestamp pairs with the where-line, so it stays TOP-right (the row is
            items-start). */}
        <span className="shrink-0 text-[11px] text-text-muted">
          {relTime(item.timestamp)}
        </span>
        {clearSource ? (
          // Hover-only source-routed clear (via `clearSource`: directed → by
          // notification_id; ambient → explicit stream-head clear, §9.10) — clears
          // WITHOUT navigating (hover ≠ read). A row-level action: `self-center`
          // floats it to the whole item's vertical center regardless of text-row
          // count; width is always reserved (opacity, not display) so hover-reveal
          // never reflows the row.
          <button
            type="button"
            title="Mark as read"
            aria-label="Mark as read"
            onClick={e => {
              e.stopPropagation();
              clearItem.mutate(clearSource);
            }}
            className="grid size-7 shrink-0 self-center place-items-center rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating text-text-secondary opacity-0 transition-opacity hover:border-[color:var(--border-control-hover)] hover:text-text-primary group-hover:opacity-100"
          >
            <Check className="size-4" />
          </button>
        ) : null}
      </div>
    </li>
  );
}
