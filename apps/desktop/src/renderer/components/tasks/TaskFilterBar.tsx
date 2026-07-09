import {
  forwardRef,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Check,
  ChevronDown,
  PenLine,
  RotateCcw,
  Search,
  User,
} from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { cn } from '@/lib/cn';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { ChannelIcon } from '@/components/ChannelIcon';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useRovingList } from '@/features/tasks/taskFilterKeyboard';
import {
  applyWorkspaceCascade,
  personFilterKey,
  taskFiltersEqual,
  type PersonFilter,
  type PersonOption,
  type TaskFilters,
} from '@/features/tasks/taskFilters';

/**
 * Unified task filter bar — one row that replaces the old channel/
 * conversation chip strip. Holds the non-status narrowing (channel,
 * assignee, creator) so the kanban columns stay purely a status axis
 * (Todo / In progress / In review / Done / Closed — `closed` is a status,
 * not a separate visibility dimension; design #task:769 / #task:770).
 *
 * Theme adaptation (Cindy acceptance): triggers are control surfaces
 * (`--control-radius` + `--control-border-width`); dropdown panels carry
 * `role="listbox"` / option rows `role="option"` and route radius through
 * `--select-content-radius` / `--select-item-radius`; selected state
 * reuses `--accent`. No hardcoded radius/border literals, so forza6 stays
 * square + hard-edged automatically.
 */
export interface ChannelOption {
  id: string;
  /** Owning workspace id — the workspace→channel cascade scopes and clears
   *  channel options by this (shiki #task:1387). Presentation still groups by
   *  data source (`group`), not by this id. */
  workspaceId: string;
  /** Primary line — always the channel TITLE. This is a channel picker, so
   *  the row reads as the channel; the source (workspace / DM agent) goes in
   *  `sublabel` (shiki #task:1165). */
  label: string;
  /** Data-source group for the dropdown's section split (#task:1165):
   *  'dm' = the channel comes from a DM workspace, 'workspace' = a regular
   *  workspace channel. Grouping is a PRESENTATION axis only — the filter
   *  value stays a plain channel id. */
  group: 'dm' | 'workspace';
  /** Secondary line = the source: the workspace name for a regular channel,
   *  `@<agent>` for a DM channel. This is what disambiguates an agent's
   *  multiple DM channels (same title space, distinct titles, shared
   *  `@agent` subtitle). */
  sublabel?: string;
}

/** A workspace offered by the upstream workspace filter (#task:1387). Both
 *  regular workspaces and DMs are selectable (shiki review: match the
 *  message-search workspace filter, which lists DMs too). `kind` + `dmAgentId`
 *  drive the canonical {@link WorkspaceIcon} — a serif "W" for a regular
 *  workspace, the bound agent's avatar for a DM. */
export interface WorkspaceOption {
  id: string;
  label: string;
  kind: 'regular' | 'dm';
  /** The bound agent for a DM workspace (icon renders that agent's avatar);
   *  null for a regular workspace. */
  dmAgentId: string | null;
}

/** A conversation considered for the channel-filter dropdown, normalized
 *  from whatever read model the caller has on hand. */
export interface ChannelFilterCandidate {
  id: string;
  /** Owning workspace id — carried through to `ChannelOption.workspaceId`
   *  for the workspace→channel cascade (#task:1387). */
  workspaceId: string;
  title: string;
  kind: 'channel' | 'dm_channel';
  archived_at: number | null;
  /** True when the owning workspace is a DM workspace — drives the data-source
   *  group even though the conversation kind is plain 'channel'. */
  fromDmWorkspace?: boolean;
  /** Secondary line = the source (workspace name, or `@<agent>` for a DM). */
  sublabel?: string;
}

/**
 * Single source of truth for *which* conversations are valid channel-filter
 * options. The eligibility rules — never offer an archived channel, dedup by
 * id, and map to the dropdown's `ChannelOption` shape — live here ONLY, so the
 * task pane (TasksSection) and the workspace task drawer (WorkspaceTasksDrawer)
 * cannot drift. Callers own their own *scope* (which candidates to feed in)
 * and their own *ordering* (sort the result); those are legitimate
 * per-surface differences. Eligibility and option shape are not.
 *
 * Insertion order is preserved, so a caller that pre-sorts its candidates
 * gets that order back.
 */
export function buildChannelFilterOptions(
  candidates: Iterable<ChannelFilterCandidate>,
): ChannelOption[] {
  const byId = new Map<string, ChannelOption>();
  for (const c of candidates) {
    if (c.archived_at !== null) continue;
    if (byId.has(c.id)) continue;
    const isDm = c.fromDmWorkspace || c.kind === 'dm_channel';
    byId.set(c.id, {
      id: c.id,
      workspaceId: c.workspaceId,
      label: c.title,
      group: isDm ? 'dm' : 'workspace',
      ...(c.sublabel !== undefined ? { sublabel: c.sublabel } : {}),
    });
  }
  return [...byId.values()];
}

/** The `#` glyph for channel-filter dropdown rows — a sticker-variant
 *  {@link ChannelIcon} so it picks up the theme's `#` sticker recipe, the same
 *  identity `#` as ChannelsSidebar. The compact filter TRIGGER uses the
 *  utility variant instead (no sticker hook → can't inflate; #task:1437). The
 *  source (workspace / DM agent) is conveyed by the subtitle, not the icon
 *  (shiki #task:1165). */
function ChannelGlyph(): JSX.Element {
  return <ChannelIcon variant="sticker" />;
}

export interface TaskFilterBarProps {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  /** Reset target. Clear shows only when `filters` differ from this and
   *  resets every dimension (workspace / channel / assignee / creator) back
   *  to it. Global passes DEFAULT_TASK_FILTERS; the drawer passes its
   *  current-channel default, so Clear restores the drawer's entry
   *  context rather than jumping to All (Cindy review). */
  baselineFilters: TaskFilters;
  /** Upstream cascade axis (#task:1387). Empty → the workspace filter hides,
   *  so a single-workspace deployment doesn't grow a pointless control. */
  workspaceOptions: WorkspaceOption[];
  channelOptions: ChannelOption[];
  /** Label for the "no channel filter" row, e.g. "All channels". */
  allChannelsLabel: string;
  assigneeOptions: PersonOption[];
  creatorOptions: PersonOption[];
  /** Whether the fetched set has any unassigned task — gates the
   *  "No assignee" option so it doesn't show when every task is claimed
   *  (would read as a stray pseudo-person otherwise; shiki feedback). */
  hasUnassigned: boolean;
  className?: string;
}

export function TaskFilterBar({
  filters,
  onChange,
  baselineFilters,
  workspaceOptions,
  channelOptions,
  allChannelsLabel,
  assigneeOptions,
  creatorOptions,
  hasUnassigned,
  className,
}: TaskFilterBarProps): JSX.Element {
  const dirty = !taskFiltersEqual(filters, baselineFilters);

  // Cascade (#task:1387): the channel filter shows only channels of the
  // selected workspace; at "All workspaces" it shows the full grouped set
  // (current behaviour). Selecting a workspace also drops a channel that no
  // longer belongs to it — never an orphan channel that yields an empty board.
  const visibleChannelOptions = useMemo(
    () =>
      filters.workspaceId
        ? channelOptions.filter(o => o.workspaceId === filters.workspaceId)
        : channelOptions,
    [channelOptions, filters.workspaceId],
  );
  const channelWorkspaceId = useMemo(() => {
    const byId = new Map(channelOptions.map(o => [o.id, o.workspaceId]));
    return (channelId: string): string | null => byId.get(channelId) ?? null;
  }, [channelOptions]);

  return (
    <div
      data-task-filter-bar
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {workspaceOptions.length > 0 ? (
        <WorkspaceFilter
          options={workspaceOptions}
          value={filters.workspaceId}
          onChange={workspaceId =>
            onChange(applyWorkspaceCascade(filters, workspaceId, channelWorkspaceId))
          }
        />
      ) : null}
      <ChannelFilter
        options={visibleChannelOptions}
        allChannelsLabel={allChannelsLabel}
        value={filters.channelId}
        onChange={channelId => onChange({ ...filters, channelId })}
      />
      <PersonFilterControl
        icon={<User className="size-3.5" />}
        label="Assignee"
        anyLabel="ALL"
        options={assigneeOptions}
        allowUnassigned={hasUnassigned}
        value={filters.assignee}
        onChange={assignee => onChange({ ...filters, assignee })}
      />
      <PersonFilterControl
        icon={<PenLine className="size-3.5" />}
        label="From"
        anyLabel="ALL"
        options={creatorOptions}
        value={filters.creator}
        onChange={creator => onChange({ ...filters, creator })}
      />
      {dirty ? (
        <button
          type="button"
          onClick={() => onChange(baselineFilters)}
          aria-label="Reset filters"
          title="Reset filters"
          className={cn(
            // Reset affordance: icon-only, no label. Idle is a bare muted
            // glyph; hover paints a square box behind it — radius follows
            // `--control-radius` (forza6 squares it to 0, warm rounds) and
            // the fill is the theme hover token, so it adapts per theme
            // (shiki #task:795).
            'inline-flex items-center justify-center rounded-[var(--control-radius)] p-1.5',
            'text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary',
          )}
        >
          <RotateCcw className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

// ── Shared trigger + panel shells ──────────────────────────────────

/** Icon edge (px) for the WORKSPACE filter trigger. The plain lucide glyphs
 *  (`User`, `PenLine`) render at `size-3.5` = 14px and the channel `#` uses
 *  `ChannelIcon` at `md` (also 14px); `WorkspaceIcon` takes a numeric `size`,
 *  so it consumes this value to sit at the same height. Kept == 14 (the
 *  control density) so no trigger glyph drifts taller than the row
 *  (#task:1437 / #task:1438). */
const TRIGGER_GLYPH_PX = 14;

const FilterTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: ReactNode;
    active: boolean;
  }
>(function FilterTrigger({ icon, active, children, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-active={active || undefined}
      className={cn(
        'flex max-w-[200px] items-center gap-1.5 rounded-[var(--control-radius)]',
        'border-[length:var(--control-border-width)] px-2 py-1 text-[11px] transition-colors',
        // Hover always paints the theme's control hover border
        // (`--border-control-hover`: forza6 near-black ink / warm
        // accent / slack-dark `--border` 10% white). Note this is a
        // CONTROL-surface hover token, not the row-state token —
        // slack-dark intentionally sets `--border-row-hover:
        // transparent` (sidebar bg veil expresses hover there), and
        // we don't want that to bleed into control triggers where the
        // border is the only hover signal (#task:912 review round 3).
        'hover:border-[color:var(--border-control-hover)]',
        active
          ? // Non-default value → theme selected-row fill (forza6 festive
            // lime) + on-selected ink + the selected-row border colour
            // (`--border-row-selected`, same near-black as hover) so the
            // chip reads as a framed poster sticker, not a borderless fill
            // (shiki #task:790).
            'border-[color:var(--border-row-selected)] bg-[var(--bg-row-selected)] text-[color:var(--text-on-selected)]'
          : 'border-border-subtle bg-bg-primary text-text-secondary hover:text-text-primary',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'shrink-0',
          active ? 'text-[color:var(--text-on-selected)]' : 'text-text-muted',
        )}
      >
        {icon}
      </span>
      <span className="truncate">{children}</span>
      <ChevronDown
        className={cn(
          'size-3 shrink-0',
          active ? 'text-[color:var(--text-on-selected)]' : 'text-text-muted',
        )}
      />
    </button>
  );
});

function FilterPanel({
  id,
  activeDescendant,
  onKeyDown,
  children,
}: {
  id?: string;
  activeDescendant?: string;
  onKeyDown?: (e: KeyboardEvent) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Popover.Portal>
      <Popover.Content
        align="start"
        sideOffset={4}
        role="listbox"
        id={id}
        aria-activedescendant={activeDescendant}
        onKeyDown={onKeyDown}
        data-task-filter-panel
        data-dropdown-frame
        className="z-[70] max-h-[50vh] min-w-[180px] overflow-y-auto rounded-[var(--select-content-radius)] bg-bg-floating p-1 shadow-popover outline-none"
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

function OptionRow({
  selected,
  neutral = false,
  active = false,
  id,
  optionRef,
  onHover,
  onSelect,
  children,
}: {
  selected: boolean;
  /** This row is the "no filter" default (ALL / All channels). When it's
   *  the current value it gets a muted check but NOT the lime active fill
   *  — lime in this surface means "a filter is applied", which would
   *  contradict the plain (inactive) trigger for the ALL state (shiki +
   *  Cindy #task:790). */
  neutral?: boolean;
  /** Keyboard roving highlight (#task:1257). Utility signal only, so it
   *  reuses the neutral `--bg-option-hover` fill (same as mouse hover), never
   *  the brand lime — that stays reserved for the applied-filter selection. */
  active?: boolean;
  id?: string;
  optionRef?: (el: HTMLButtonElement | null) => void;
  onHover?: () => void;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  const activeSelected = selected && !neutral;
  return (
    <button
      ref={optionRef}
      id={id}
      type="button"
      role="option"
      aria-selected={selected}
      data-active-option={active || undefined}
      onMouseMove={onHover}
      onClick={onSelect}
      className={cn(
        // Hover = pale-lime preview FILL only, no border. Routes through
        // the shared `--bg-option-hover` semantic token (forza6 → #E6F68A
        // pale lime, warm → cool-neutral hover) — the same "selectable
        // option hover" vocabulary the Proxy runtime cards use, so the two
        // surfaces stay in lock-step. The transparent border is kept only
        // to reserve layout space (no hover colour) so rows don't shift
        // (shiki #task:790).
        'flex w-full items-center gap-2 rounded-[var(--select-item-radius)] px-2 py-1.5 text-left text-xs transition-colors',
        'border border-transparent hover:bg-[var(--bg-option-hover)] hover:text-text-primary',
        // A real (non-default) current value = the app-wide selected-row
        // vocabulary (festive lime fill + on-selected ink), NOT the magenta
        // `accent-soft` tint. The ALL/All-channels default row stays plain
        // text even when current (shiki #task:790: ALL was reading pink).
        // Keyboard-highlighted (but not the current value) → neutral hover
        // fill, so mouse and keyboard share one visual language.
        activeSelected
          ? 'bg-[var(--bg-row-selected)] text-[color:var(--text-on-selected)]'
          : active
            ? 'bg-[var(--bg-option-hover)] text-text-primary'
            : 'text-text-secondary',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? (
        <Check
          className={cn(
            'size-3.5 shrink-0',
            // Real selection → on-selected ink on the lime fill; the
            // neutral default current row → a muted check (no pink, no
            // lime) so it reads as "current" without the active look.
            activeSelected ? 'text-[color:var(--text-on-selected)]' : 'text-text-muted',
          )}
        />
      ) : null}
    </button>
  );
}

// ── Channel (searchable) ───────────────────────────────────────────

function ChannelFilter({
  options,
  allChannelsLabel,
  value,
  onChange,
}: {
  options: ChannelOption[];
  allChannelsLabel: string;
  value: string | null;
  onChange: (id: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = value ? options.find(o => o.id === value) ?? null : null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      o =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);
  // Order the options — regular-workspace channels first, then DMs — so the
  // flat list reads in a stable grouping. No section HEADERS: each row's
  // sublabel already names its source (workspace / @agent), so a "Workspaces"
  // header over channel rows was both redundant and semantically wrong
  // (shiki #task:1387 review — the label named workspaces but the rows are
  // channels). The ALL row stays at the top.
  const sections = useMemo(
    () =>
      [
        { key: 'workspace' as const, label: 'Workspaces' },
        { key: 'dm' as const, label: 'DMs' },
      ]
        .map(s => ({ ...s, items: filtered.filter(o => o.group === s.key) }))
        .filter(s => s.items.length > 0),
    [filtered],
  );

  // Flat, in-render-order option list for roving keyboard nav (#task:1257):
  // the ALL row at index 0, then every section's items (Workspaces then DMs),
  // matching the visual order below so arrow keys walk the list as it reads.
  const flatOptions = useMemo(() => sections.flatMap(s => s.items), [sections]);
  const optionIndex = useMemo(() => {
    const m = new Map<string, number>();
    flatOptions.forEach((o, i) => m.set(o.id, i + 1)); // +1: ALL occupies 0
    return m;
  }, [flatOptions]);
  const listId = useId();
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  const roving = useRovingList({
    count: flatOptions.length + 1,
    open,
    resetKey: query,
    onSelect: index => {
      if (index === 0) onChange(null);
      else {
        const o = flatOptions[index - 1];
        if (o) onChange(o.id);
      }
      setOpen(false);
    },
  });

  const renderOption = (o: ChannelOption): JSX.Element => {
    const index = optionIndex.get(o.id) ?? -1;
    return (
      <OptionRow
        key={o.id}
        selected={value === o.id}
        active={roving.activeIndex === index}
        id={optionId(index)}
        optionRef={el => roving.registerItem(index, el)}
        onHover={() => roving.setActiveIndex(index)}
        onSelect={() => {
          onChange(o.id);
          setOpen(false);
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-text-muted">
            <ChannelGlyph />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{o.label}</span>
            {o.sublabel ? (
              <span className="truncate text-[10px] text-text-muted">
                {o.sublabel}
              </span>
            ) : null}
          </span>
        </span>
      </OptionRow>
    );
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <FilterTrigger
          // Utility-variant `#` (no `data-channel-icon` sticker hook) — the
          // sidebar sticker's border/padding would inflate this past the 14px
          // sibling glyphs in forza6 (#task:1437). `md` = 14px, matching the
          // workspace trigger's TRIGGER_GLYPH_PX. Dropdown rows use the
          // sticker variant.
          icon={<ChannelIcon variant="utility" density="md" />}
          active={value !== null}
          aria-label="Channel"
        >
          {selected?.label ?? allChannelsLabel}
        </FilterTrigger>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          data-task-filter-panel
          data-dropdown-frame
          className="z-[70] flex max-h-[50vh] w-[240px] flex-col rounded-[var(--select-content-radius)] bg-bg-floating p-1 shadow-popover outline-none"
        >
          <div className="flex items-center gap-1.5 border-b border-border-subtle px-2 pb-1.5 pt-1">
            <Search className="size-3.5 shrink-0 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={roving.onKeyDown}
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-activedescendant={optionId(roving.activeIndex)}
              placeholder="Search channels…"
              className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div
            role="listbox"
            id={listId}
            className="mt-1 min-h-0 flex-1 overflow-y-auto"
          >
            <OptionRow
              selected={value === null}
              neutral
              active={roving.activeIndex === 0}
              id={optionId(0)}
              optionRef={el => roving.registerItem(0, el)}
              onHover={() => roving.setActiveIndex(0)}
              onSelect={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {allChannelsLabel}
            </OptionRow>
            {flatOptions.map(renderOption)}
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11px] italic text-text-muted">
                No matches
              </p>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── Workspace (upstream cascade axis) ──────────────────────────────

function WorkspaceFilter({
  options,
  value,
  onChange,
}: {
  options: WorkspaceOption[];
  value: string | null;
  onChange: (id: string | null) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // Agent context for the DM branch of WorkspaceIcon — a DM workspace reads as
  // its bound agent's avatar (same as the message-search workspace filter and
  // the rail, #task:1192). Fetched here in the leaf so neither task surface has
  // to plumb agent data through.
  const { data: agents = [] } = useAgents();
  const agentsById = useMemo<ReadonlyMap<string, AgentDto>>(
    () => new Map(agents.map(a => [a.id, a])),
    [agents],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);

  // Grouped like the search workspace filter (#task:1387 shiki review):
  // regular Workspaces first, then DMs. Both kinds are selectable — the
  // cascade matches on `task.workspace_id`, so a DM workspace filters exactly
  // like a regular one.
  const sections = useMemo(
    () =>
      [
        { key: 'regular' as const, label: 'Workspaces' },
        { key: 'dm' as const, label: 'DMs' },
      ]
        .map(s => ({ ...s, items: options.filter(o => o.kind === s.key) }))
        .filter(s => s.items.length > 0),
    [options],
  );
  const flatOptions = useMemo(() => sections.flatMap(s => s.items), [sections]);
  const optionIndex = useMemo(() => {
    const m = new Map<string, number>();
    flatOptions.forEach((o, i) => m.set(o.id, i + 1)); // +1: ALL occupies 0
    return m;
  }, [flatOptions]);

  const listId = useId();
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  const roving = useRovingList({
    count: flatOptions.length + 1,
    open,
    onSelect: index => {
      if (index === 0) onChange(null);
      else {
        const o = flatOptions[index - 1];
        if (o) onChange(o.id);
      }
      setOpen(false);
    },
  });

  const selected = value ? flatOptions.find(o => o.id === value) ?? null : null;
  // `triggerSize` scales the trigger icon down to the shared control-glyph
  // box (#task:1437); the dropdown rows keep the default 16px so they read at
  // the same workspace-identity size as the rail.
  const iconFor = (o: WorkspaceOption, triggerSize?: number): JSX.Element => (
    <WorkspaceIcon
      kind={o.kind}
      dmAgentId={o.dmAgentId}
      agentsById={agentsById}
      dmAgentAvatarUrls={agentAvatarUrls}
      {...(triggerSize !== undefined ? { size: triggerSize } : {})}
    />
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <FilterTrigger
          // Resting/ALL: the generic workspace glyph (serif "W"); a selection:
          // that workspace's own icon (avatar for a DM). Both sized to the
          // shared trigger-glyph box so this trigger matches its siblings'
          // height (#task:1437).
          icon={
            selected ? (
              iconFor(selected, TRIGGER_GLYPH_PX)
            ) : (
              <WorkspaceIcon kind="regular" dmAgentId={null} size={TRIGGER_GLYPH_PX} />
            )
          }
          active={value !== null}
          aria-label="Workspace"
        >
          {selected?.label ?? 'ALL'}
        </FilterTrigger>
      </Popover.Trigger>
      <FilterPanel
        id={listId}
        activeDescendant={optionId(roving.activeIndex)}
        onKeyDown={roving.onKeyDown}
      >
        <OptionRow
          selected={value === null}
          neutral
          active={roving.activeIndex === 0}
          id={optionId(0)}
          optionRef={el => roving.registerItem(0, el)}
          onHover={() => roving.setActiveIndex(0)}
          onSelect={() => {
            onChange(null);
            setOpen(false);
          }}
        >
          ALL
        </OptionRow>
        {sections.map(section => (
          <div key={section.key}>
            <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
              {section.label}
            </div>
            {section.items.map(o => {
              const index = optionIndex.get(o.id) ?? -1;
              return (
                <OptionRow
                  key={o.id}
                  selected={value === o.id}
                  active={roving.activeIndex === index}
                  id={optionId(index)}
                  optionRef={el => roving.registerItem(index, el)}
                  onHover={() => roving.setActiveIndex(index)}
                  onSelect={() => {
                    onChange(o.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0">{iconFor(o)}</span>
                    <span className="truncate">{o.label}</span>
                  </span>
                </OptionRow>
              );
            })}
          </div>
        ))}
      </FilterPanel>
    </Popover.Root>
  );
}

// ── Person (assignee / creator) ────────────────────────────────────

function PersonFilterControl({
  icon,
  label,
  anyLabel,
  options,
  allowUnassigned = false,
  value,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  anyLabel: string;
  options: PersonOption[];
  allowUnassigned?: boolean;
  value: PersonFilter;
  onChange: (next: PersonFilter) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const selectedName = options.find(
    o => personFilterKey({ kind: 'person', person: o.person }) === personFilterKey(value),
  )?.name;
  // Value half of the trigger label. The trigger always renders
  // `${label}:${valuePart}` (e.g. "Assignee:ALL" / "From:@cindy") so the
  // dimension stays legible even at the default "ALL" state (shiki
  // #task:790) — the label is no longer carried by the icon alone.
  const valuePart =
    value.kind === 'any'
      ? anyLabel
      : value.kind === 'unassigned'
        ? 'No assignee'
        : // Humans and agents are both first-class participants, so both
          // render with `@` (shiki) — only the unmentionable `system`
          // creator (filtered out of the option list) lacks one.
          selectedName
          ? `@${selectedName}`
          : 'Selected';

  const choose = (next: PersonFilter): void => {
    onChange(next);
    setOpen(false);
  };

  // Roving keyboard nav (#task:1257). The option order below is fixed —
  // ALL, then optional No-assignee, then each person — so the row index is
  // positional; `actions` mirrors that order 1:1 for Enter-to-commit.
  const listId = useId();
  const optionId = (index: number): string => `${listId}-opt-${index}`;
  const anyIndex = 0;
  const unassignedIndex = allowUnassigned ? 1 : -1;
  const optionsBase = allowUnassigned ? 2 : 1;
  const actions: (() => void)[] = [
    () => choose({ kind: 'any' }),
    ...(allowUnassigned ? [() => choose({ kind: 'unassigned' })] : []),
    ...options.map(o => () => choose({ kind: 'person', person: o.person })),
  ];
  const roving = useRovingList({
    count: actions.length,
    open,
    onSelect: index => actions[index]?.(),
  });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <FilterTrigger icon={icon} active={value.kind !== 'any'} aria-label={label}>
          {`${label}:${valuePart}`}
        </FilterTrigger>
      </Popover.Trigger>
      <FilterPanel
        id={listId}
        activeDescendant={optionId(roving.activeIndex)}
        onKeyDown={roving.onKeyDown}
      >
        <OptionRow
          selected={value.kind === 'any'}
          neutral
          active={roving.activeIndex === anyIndex}
          id={optionId(anyIndex)}
          optionRef={el => roving.registerItem(anyIndex, el)}
          onHover={() => roving.setActiveIndex(anyIndex)}
          onSelect={() => choose({ kind: 'any' })}
        >
          {anyLabel}
        </OptionRow>
        {allowUnassigned ? (
          <OptionRow
            selected={value.kind === 'unassigned'}
            active={roving.activeIndex === unassignedIndex}
            id={optionId(unassignedIndex)}
            optionRef={el => roving.registerItem(unassignedIndex, el)}
            onHover={() => roving.setActiveIndex(unassignedIndex)}
            onSelect={() => choose({ kind: 'unassigned' })}
          >
            No assignee
          </OptionRow>
        ) : null}
        {options.map((o, i) => {
          const key = personFilterKey({ kind: 'person', person: o.person });
          const index = optionsBase + i;
          return (
            <OptionRow
              key={key}
              selected={value.kind === 'person' && personFilterKey(value) === key}
              active={roving.activeIndex === index}
              id={optionId(index)}
              optionRef={el => roving.registerItem(index, el)}
              onHover={() => roving.setActiveIndex(index)}
              onSelect={() => choose({ kind: 'person', person: o.person })}
            >
              {`@${o.name}`}
            </OptionRow>
          );
        })}
        {options.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] italic text-text-muted">
            None yet
          </p>
        ) : null}
      </FilterPanel>
    </Popover.Root>
  );
}
