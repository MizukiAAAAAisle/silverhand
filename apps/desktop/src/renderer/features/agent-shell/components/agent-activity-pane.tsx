import { useEffect, useMemo, useState } from "react";
import type {
  AgentDto,
  AgentRuntimeParticipation,
  AgentRuntimeSeatDto,
  AgentRuntimeStateDto,
  ConversationPlacementKind,
} from "@silverhand/shared";
import { cn } from "@/lib/cn";
import { sidebarRowStateClass } from "@/components/layout/sidebar-shared";
import { ConversationGlyph } from "@/components/ConversationGlyph";
import { AgentActivityTimeline, AgentStreamActivityTimeline } from "./agent-activity-timeline";

interface AgentActivityPaneProps {
  agentId: string;
  sessionScope: AgentDto["session_scope"];
  state: AgentRuntimeStateDto | undefined;
}

interface RosterGroups {
  active: AgentRuntimeParticipation[];
  recent: AgentRuntimeParticipation[];
}

/**
 * Partition the runtime roster into the two groups the Activity rail shows.
 *
 *  - `active` → not closed AND status `active` | `starting`
 *  - `recent` → everything else that survived the allowlist (idle / crashed
 *               / closed)
 *
 * Exported for the roster contract test.
 */
export function partitionRoster(
  rows: ReadonlyArray<AgentRuntimeParticipation>,
  seats: ReadonlyArray<AgentRuntimeSeatDto>,
): RosterGroups {
  const channels = rows;
  const active: AgentRuntimeParticipation[] = [];
  const recent: AgentRuntimeParticipation[] = [];
  for (const r of channels) {
    const seat = seats.find((s) =>
      s.scope.kind === "conversation"
        ? s.scope.conversation_id === r.conversation_id
        : s.focus?.kind === "conversation" && s.focus.conversation_id === r.conversation_id,
    );
    if (r.closed_at === null && (seat?.status === "active" || seat?.status === "starting")) {
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
  return groups.active[0]?.conversation_id ?? groups.recent[0]?.conversation_id ?? null;
}

/**
 * Agent scope has one stream; conversation scope retains its conversation rail.
 */
export function AgentActivityPane(props: AgentActivityPaneProps): JSX.Element {
  return props.sessionScope === "agent" ? (
    <AgentStreamActivityTimeline agentId={props.agentId} />
  ) : (
    <ConversationActivityPane {...props} />
  );
}

function ConversationActivityPane({
  agentId,
  state,
}: AgentActivityPaneProps): JSX.Element {
  const rows = state?.visible_participations ?? [];
  const seats = state?.seats ?? [];
  const groups = useMemo(() => partitionRoster(rows, seats), [rows, seats]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep a valid selection as the roster changes (poll refresh, agent
  // switch): if nothing is selected or the selection dropped out of the
  // allowlist, fall back to the default.
  useEffect(() => {
    const present = new Set([...groups.active, ...groups.recent].map((r) => r.conversation_id));
    if (!selectedId || !present.has(selectedId)) {
      setSelectedId(defaultSelection(groups));
    }
  }, [groups, selectedId]);

  const selected =
    [...groups.active, ...groups.recent].find((r) => r.conversation_id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        data-agent-activity
        className="flex w-56 shrink-0 flex-col border-r border-border-subtle bg-bg-base"
      >
        <div className="flex-1 overflow-y-auto px-1.5 py-2">
          {groups.active.length === 0 && groups.recent.length === 0 ? (
            <p className="px-2 py-6 text-center text-(length:--text-meta) text-text-muted">
              Not in any channel.
            </p>
          ) : (
            <>
              <RosterGroup
                label="Active"
                rows={groups.active}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
              <RosterGroup
                label="Recent"
                rows={groups.recent}
                selectedId={selectedId}
                onSelect={setSelectedId}
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
}: {
  label: string;
  rows: AgentRuntimeParticipation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <div className="mb-0.5">
      <p className="px-2 pb-0.5 pt-1 font-mono text-(length:--text-badge) uppercase tracking-wider text-text-muted">
        {label}
      </p>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <RosterItem
            key={row.conversation_id}
            row={row}
            selected={row.conversation_id === selectedId}
            onSelect={onSelect}
            live={label === "Active"}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Row identity for a mixed participation roster: the CONVERSATION's PLACEMENT
 * decides the glyph. A `workspace` placement is a channel and wears `#`
 * whatever its roster policy is — an agent space's fixed-roster channel is
 * still a channel (#task:1373) — while a workspace-less placement (a
 * `direct_pair`) is addressed at a person or an agent, so it wears `@`.
 *
 * This replaces a roster-keyed verdict (#task:2077). The #task:2069 / #task:2070
 * reasoning still holds where it was made — among workspace-placed rows
 * `agent_home ⇒ fixed`, so the CONTAINER word added nothing and its removal was
 * right. What was wrong is the other direction: `fixed` was then treated as a
 * SUFFICIENT condition for "private line", and the counter-example is the very
 * one that reasoning cites — an agent home's `dm_channel` is fixed-rostered and
 * is a channel. Roster answers a capability question (can members change);
 * identity is placement's to answer.
 *
 * No default arm, and two different guards keep it honest. At COMPILE time the
 * exhaustive switch forces the next placement added to the union to be handled
 * here, rather than silently defaulting to `@` and mis-labeling. At RUNTIME a
 * wire value outside this build's alphabet (an older client than the server)
 * returns `undefined`, which {@link ConversationGlyph} rejects with a throw — so
 * the runtime guard is that throw, not this switch. That intentionally DIVERGES
 * from `pane-mode.ts`, which fail-safes an unknown placement to `unsupported`: a
 * pane has a graceful unknown state, an identity glyph does not, so it fails loud
 * rather than mis-label.
 */
function placementGlyphKind(placement: ConversationPlacementKind): "channel" | "dm" {
  switch (placement) {
    case "workspace":
      return "channel";
    case "direct_pair":
      return "dm";
  }
}

function RosterItem({
  row,
  selected,
  onSelect,
  live,
}: {
  row: AgentRuntimeParticipation;
  selected: boolean;
  onSelect: (id: string) => void;
  live: boolean;
}): JSX.Element {
  // A CONVERSATION-level verdict on conversation-level facts — see
  // {@link placementGlyphKind} for why the key is the placement, not the roster.
  const glyphKind = placementGlyphKind(row.conversation_placement_kind);
  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={() => onSelect(row.conversation_id)}
        aria-current={selected ? "true" : undefined}
        data-row-selected={selected || undefined}
        className={cn(
          "sidebar-row-border flex w-full items-center gap-1.5 border py-1 pl-2 pr-7 text-left",
          sidebarRowStateClass(selected),
        )}
      >
        <ConversationGlyph
          kind={glyphKind}
          className={selected ? "text-text-nav-selected" : "text-text-muted"}
        />
        <span className="min-w-0 flex-1 truncate text-xs">{row.channel_title}</span>
        {live ? (
          <span
            data-status-pip
            aria-label="active"
            className="size-1.5 shrink-0 rounded-(--pill-radius) bg-success"
          />
        ) : null}
      </button>
    </li>
  );
}
