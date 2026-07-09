import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type {
  AgentRuntimeConversation,
  AgentRuntimeStateDto,
} from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { ConversationGlyph } from '@/components/ConversationGlyph';
import { AgentActivityTimeline } from './AgentActivityTimeline';

interface AgentActivityPaneProps {
  agentId: string;
  state: AgentRuntimeStateDto | undefined;
  /** Jump the main view to this conversation (open in chat). */
  onOpenConversation?: (s: AgentRuntimeConversation) => void;
}

interface RosterGroups {
  active: AgentRuntimeConversation[];
  recent: AgentRuntimeConversation[];
}

/**
 * Partition the runtime roster into the two groups the Activity rail shows.
 *
 * Allowlist `conversation_kind IN ('channel','dm_channel')` (mirrors the
 * `agent-read.ts` visible-channel predicate) — a reply-cluster thread
 * shares its parent channel's agent session, so its activity already
 * lands under the parent channel id (backend #task:1186). Using an
 * allowlist (not a denylist) keeps us safe against any unexpected /
 * future conversation kind that surfaces here.
 *
 *  - `active` → not closed AND status `active` | `starting`
 *  - `recent` → everything else that survived the allowlist (idle / crashed
 *               / closed)
 *
 * Exported for the roster contract test.
 */
export function partitionRoster(
  rows: ReadonlyArray<AgentRuntimeConversation>,
): RosterGroups {
  const channels = rows.filter(
    r =>
      r.conversation_kind === 'channel' || r.conversation_kind === 'dm_channel',
  );
  const active: AgentRuntimeConversation[] = [];
  const recent: AgentRuntimeConversation[] = [];
  for (const r of channels) {
    if (r.closed_at === null && (r.status === 'active' || r.status === 'starting')) {
      active.push(r);
    } else {
      recent.push(r);
    }
  }
  return { active, recent };
}

/** First selectable conversation id: prefer an active one, else the first
 *  recent, else null. */
function defaultSelection(groups: RosterGroups): string | null {
  return (
    groups.active[0]?.conversation_id ??
    groups.recent[0]?.conversation_id ??
    null
  );
}

/**
 * Agent Panel → "Activity" section. Master-detail: a conversation rail on
 * the left (the channels/DMs this agent is in, the old "Runtime" roster
 * repurposed as navigation), a per-`(agent, conversation)` execution
 * timeline on the right.
 */
export function AgentActivityPane({
  agentId,
  state,
  onOpenConversation,
}: AgentActivityPaneProps): JSX.Element {
  const rows = state?.visible_conversation_agents ?? [];
  const groups = useMemo(() => partitionRoster(rows), [rows]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep a valid selection as the roster changes (poll refresh, agent
  // switch): if nothing is selected or the selection dropped out of the
  // allowlist, fall back to the default.
  useEffect(() => {
    const present = new Set(
      [...groups.active, ...groups.recent].map(r => r.conversation_id),
    );
    if (!selectedId || !present.has(selectedId)) {
      setSelectedId(defaultSelection(groups));
    }
  }, [groups, selectedId]);

  const selected =
    [...groups.active, ...groups.recent].find(
      r => r.conversation_id === selectedId,
    ) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* master: conversation rail */}
      <aside className="flex w-[224px] shrink-0 flex-col border-r border-border-subtle bg-bg-base">
        <div className="flex-1 overflow-y-auto px-1.5 py-2">
          {groups.active.length === 0 && groups.recent.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] text-text-muted">
              Not in any channel yet.
            </p>
          ) : (
            <>
              <RosterGroup
                label="Active"
                rows={groups.active}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpen={onOpenConversation}
              />
              <RosterGroup
                label="Recent"
                rows={groups.recent}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onOpen={onOpenConversation}
              />
            </>
          )}
        </div>
      </aside>

      {/* detail: timeline */}
      {selected ? (
        <AgentActivityTimeline
          key={selected.conversation_id}
          conversationId={selected.conversation_id}
          agentId={agentId}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
          Select a channel to see its activity.
        </div>
      )}
    </div>
  );
}

function RosterGroup({
  label,
  rows,
  selectedId,
  onSelect,
  onOpen,
}: {
  label: string;
  rows: AgentRuntimeConversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpen?: (s: AgentRuntimeConversation) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="mb-0.5">
      <p className="px-2 pb-0.5 pt-1 font-mono text-[9.5px] uppercase tracking-wider text-text-muted">
        {label}
      </p>
      <ul className="flex flex-col">
        {rows.map(row => (
          <RosterItem
            key={row.conversation_id}
            row={row}
            selected={row.conversation_id === selectedId}
            onSelect={onSelect}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
}

function RosterItem({
  row,
  selected,
  onSelect,
  onOpen,
}: {
  row: AgentRuntimeConversation;
  selected: boolean;
  onSelect: (id: string) => void;
  onOpen?: (s: AgentRuntimeConversation) => void;
}): JSX.Element {
  const live = row.closed_at === null && (row.status === 'active' || row.status === 'starting');
  const isDm =
    row.conversation_kind === 'dm_channel' || row.workspace_kind === 'agent_home';
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => onSelect(row.conversation_id)}
        aria-current={selected ? 'true' : undefined}
        data-row-selected={selected || undefined}
        className={cn(
          // Content-area list row (NOT inside aside[data-sidebar]), so it
          // drives forza6 colours via the global row-state tokens directly —
          // `border-accent` would resolve to brand pink and clash with the
          // lime selection ground. `sidebar-row-border` carries the per-theme
          // border width (forza6 = 2px). No `transition-colors`: selection is
          // a discrete committed state, instant switch (#task:1162).
          'sidebar-row-border flex w-full items-center gap-1.5 border py-1 pl-2 pr-7 text-left',
          // Foreground pairs with the `--bg-row-selected` fill via
          // `text-text-on-selected` (same row vocabulary as ChannelsSidebar /
          // WorkspacesPanel): forza6 = ink-on-lime, warm = text-primary,
          // slack = white. The `.text-text-on-selected` border/shadow CSS is
          // `aside[data-sidebar]`-scoped, so on this content-area row the class
          // is purely the colour utility — border/bg stay the inline tokens.
          selected
            ? 'border-[var(--border-row-selected,var(--accent))] bg-[var(--bg-row-selected,var(--bg-selected))] font-semibold text-text-on-selected'
            : 'border-transparent text-text-secondary hover:border-[var(--border-row-hover,var(--accent))] hover:text-text-primary',
        )}
      >
        {/* Conversation roster row identity. The `data-channel-icon` sticker
            hook (forza6 paints the ink-bordered `#`/`@` chip; the
            `data-row-selected` ancestor adds the heavier lift on the lime
            selected row) is owned by ConversationGlyph, not hand-written here
            (#task:1438). On a selected row the glyph flips to
            `--text-on-selected` so it stays legible on the fill. */}
        <ConversationGlyph
          kind={isDm ? 'dm' : 'channel'}
          className={selected ? 'text-text-on-selected' : 'text-text-muted'}
        />
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {row.channel_title}
        </span>
        {live ? (
          <span
            data-status-pip
            aria-label="active"
            className="size-1.5 shrink-0 rounded-full bg-success"
          />
        ) : null}
      </button>
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(row)}
          title="Open in chat"
          aria-label="Open in chat"
          className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 place-items-center p-1 text-text-muted transition-colors hover:text-text-primary group-hover/row:grid"
        >
          <ArrowUpRight className="size-3.5" />
        </button>
      ) : null}
    </li>
  );
}
