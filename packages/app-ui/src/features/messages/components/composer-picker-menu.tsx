import { InlineLoading } from "@/components/layout/inline-loading";
import { Fragment, useEffect, useRef } from "react";
import { HashIcon } from "@/icons";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { type PickerItem, type ChannelSourceStatus } from "../model/composer-picker";

// ── menu ──────────────────────────────────────────────────────────

export function PickerMenu({
  items,
  hiddenCount,
  channelStatus,
  active,
  onPick,
  onHover,
  peopleSections,
  showChannelWorkspace,
  agentAvatarUrls,
  humanAvatarUrls,
}: {
  items: PickerItem[];
  hiddenCount: number;
  /** `#`-only settledness of the channel source. `loading` (some slice pending)
   *  and `partial_error` (a workspace's channels unavailable) stay DISTINCT so the
   *  marker never reports an errored fan-out as "still loading", and neither folds
   *  a partial page into a complete-looking set (#task:2148). Always `complete`
   *  for `@`, which carries its completeness on the send gate, not the render. */
  channelStatus: ChannelSourceStatus;
  active: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
  /** Whether to split rows into "In this channel" / "Other channels" headers on
   *  the `@` picker — the workspace arm against its roster, the viewer arm (a DM)
   *  filing the counterpart agent under "In this channel". Every `#` channel list
   *  is flat (#task:2147). */
  peopleSections: boolean;
  /** Whether a channel row names its workspace — the viewer arm's `#` list spans
   *  workspaces, so same-named channels must stay distinguishable (#task:2148). */
  showChannelWorkspace: boolean;
  agentAvatarUrls: Map<string, string | null>;
  humanAvatarUrls: Map<string, string | null>;
}): JSX.Element {
  // #task:876 (2026-06-03): split header labels per section. We compute the
  // boundary index here (first item with !inConversation) and let the map render a
  // header chip just before that row. Gated on `peopleSections`: a flat arm (any
  // `#`) reports -1 / false so no header ever renders. Channel rows also carry no
  // membership concept, so they never trigger a header even inside a people-
  // sectioned arm.
  //
  // Both headers require a non-empty in-section: the split only means something when
  // something is in this channel. Without it (a roster the viewer sees no in-channel
  // candidate for, or a DM whose counterpart is a human / not owned), the whole list
  // is "other" and a lone "Other channels" header labels nothing — render it flat
  // instead (#task:2147).
  const hasInSection =
    peopleSections && items.some((item) => item.kind !== "channel" && item.inConversation);
  const headerBoundaryIndex = hasInSection
    ? items.findIndex((item) => item.kind !== "channel" && !item.inConversation)
    : -1;
  return (
    <div
      className="absolute bottom-full left-0 mb-1.5 w-64 overflow-hidden rounded-(--select-content-radius) bg-bg-floating shadow-popover"
      data-composer-picker=""
      data-dropdown-frame
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="scrollbar-hide max-h-64 overflow-y-auto p-1" role="listbox">
        {items.map((item, i) => (
          <Fragment key={rowKey(item)}>
            {/* Section header — render BEFORE the row so the boundary
              aligns with the first "other channels" entry. The "In this
              channel" header only renders when that section is non-empty
              AND we haven't already passed it (i === 0 with at least one
              in-channel row). */}
            {i === 0 && hasInSection ? <SectionHeader label="In this channel" /> : null}
            {i === headerBoundaryIndex ? <SectionHeader label="Other channels" /> : null}
            <Row
              item={item}
              active={i === active}
              onPick={() => onPick(item)}
              onHover={() => onHover(i)}
              showChannelWorkspace={showChannelWorkspace}
              agentAvatarUrl={
                item.kind === "agent" ? (agentAvatarUrls.get(item.agent.id) ?? null) : null
              }
              humanAvatarUrl={
                item.kind === "human" ? (humanAvatarUrls.get(item.human.id) ?? null) : null
              }
            />
          </Fragment>
        ))}
      </div>
      {/* Truncation footer (#task:1206). When the display cap dropped
          matched candidates, name the count so truncation isn't silent.
          It sits OUTSIDE the scroll area (sibling under the listbox), so
          it stays visible at any scroll position — the whole point is the
          user with a short query learns more exist. Purely informational:
          not a `role="option"`, not in the keyboard active-index space, no
          hover/click; `aria-hidden` since it's a visual nudge, not a
          selectable result. Muted ink (utility tone), divider only — no
          fill. */}
      {hiddenCount > 0 ? (
        <div
          aria-hidden
          className="border-t border-border-subtle px-3 py-1.5 text-(length:--text-meta) text-text-muted"
        >
          +{hiddenCount} more
        </div>
      ) : null}
      {channelStatus === "loading" ? (
        <div className="border-t border-border-subtle">
          <InlineLoading label="Loading channels" />
        </div>
      ) : channelStatus === "partial_error" ? (
        <div
          role="status"
          className="border-t border-border-subtle px-3 py-1.5 text-(length:--text-meta) text-text-muted"
        >
          Some channels unavailable
        </div>
      ) : null}
    </div>
  );
}

export function SectionHeader({ label }: { label: string }): JSX.Element {
  return (
    <div
      role="presentation"
      className="px-2 pb-1 pt-1.5 text-(length:--text-badge) font-medium uppercase tracking-wider text-text-muted"
    >
      {label}
    </div>
  );
}

export function Row({
  item,
  active,
  onPick,
  onHover,
  showChannelWorkspace,
  agentAvatarUrl,
  humanAvatarUrl,
}: {
  item: PickerItem;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
  showChannelWorkspace: boolean;
  agentAvatarUrl: string | null;
  humanAvatarUrl: string | null;
}): JSX.Element {
  const dimmed = (item.kind === "agent" || item.kind === "human") && !item.inConversation;
  const cls =
    "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left " +
    (active ? "bg-bg-hover text-text-primary" : "text-text-secondary") +
    (dimmed && !active ? " opacity-60" : "");

  const rowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!active) return;
    rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <button
      ref={rowRef}
      type="button"
      role="option"
      aria-selected={active}
      onClick={onPick}
      onMouseMove={onHover}
      className={cls}
    >
      {item.kind === "agent" ? (
        <>
          <AgentAvatar
            runtime={item.agent.runtime}
            size={AVATAR_PX.md}
            avatarObjectUrl={agentAvatarUrl}
            alt={item.agent.display_name || item.agent.name}
          />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-text-primary">
              {item.agent.display_name?.trim() || item.agent.name}
            </span>
            <div className="flex items-center gap-1.5 text-(length:--text-meta) text-text-muted">
              <span className="truncate font-mono">@{item.agent.name}</span>
              <span data-agent-runtime className="shrink-0">
                {item.agent.runtime}
              </span>
            </div>
          </div>
        </>
      ) : item.kind === "human" ? (
        <>
          <UserAvatar
            size={AVATAR_PX.md}
            avatarObjectUrl={humanAvatarUrl}
            alt={item.human.display_name || item.human.name}
          />
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-medium text-text-primary">
              {item.human.display_name?.trim() || item.human.name}
            </span>
            <div className="flex items-center gap-1.5 text-(length:--text-meta) text-text-muted">
              <span className="truncate font-mono">@{item.human.name}</span>
              <span data-participant-kind className="shrink-0">
                human
              </span>
            </div>
          </div>
        </>
      ) : (
        <>
          <HashIcon className="size-4 shrink-0 text-text-muted" />
          {showChannelWorkspace && item.workspaceName ? (
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-sm font-medium text-text-primary">
                {item.channel.title}
              </span>
              <span className="truncate text-(length:--text-meta) text-text-muted">
                {item.workspaceName}
              </span>
            </div>
          ) : (
            <span className="truncate text-sm font-medium text-text-primary">
              {item.channel.title}
            </span>
          )}
        </>
      )}
    </button>
  );
}

export function rowKey(item: PickerItem): string {
  if (item.kind === "agent") return `a:${item.agent.id}`;
  if (item.kind === "human") return `h:${item.human.id}`;
  return `c:${item.channel.id}`;
}
