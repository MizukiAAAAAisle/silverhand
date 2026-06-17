import {
  forwardRef,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  Check,
  ChevronDown,
  Hash,
  PenLine,
  RotateCcw,
  Search,
  User,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import {
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

/** A conversation considered for the channel-filter dropdown, normalized
 *  from whatever read model the caller has on hand. */
export interface ChannelFilterCandidate {
  id: string;
  title: string;
  kind: 'channel' | 'dm_channel' | 'thread';
  archived_at: number | null;
  /** True when the owning workspace is a DM workspace — drives the data-source
   *  group even though the conversation kind is plain 'channel'. */
  fromDmWorkspace?: boolean;
  /** Secondary line = the source (workspace name, or `@<agent>` for a DM). */
  sublabel?: string;
}

/**
 * Single source of truth for *which* conversations are valid channel-filter
 * options. The eligibility rules — skip legacy fossil threads
 * (`kind === 'thread'`), never offer an archived channel, dedup by id, and
 * map to the dropdown's `ChannelOption` shape — live here ONLY, so the task
 * pane (TasksSection) and the workspace task drawer (WorkspaceTasksDrawer)
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
    if (c.kind === 'thread') continue;
    if (c.archived_at !== null) continue;
    if (byId.has(c.id)) continue;
    const isDm = c.fromDmWorkspace || c.kind === 'dm_channel';
    byId.set(c.id, {
      id: c.id,
      label: c.title,
      group: isDm ? 'dm' : 'workspace',
      ...(c.sublabel !== undefined ? { sublabel: c.sublabel } : {}),
    });
  }
  return [...byId.values()];
}

/** Leading icon for every channel-filter row and the trigger. This is a
 *  channel picker, so the icon is uniformly the `#` glyph — carrying the
 *  `data-channel-icon` hook so it picks up the sidebar's `#` sticker recipe
 *  (forza6), the same `#` icon as ChannelsSidebar. The source (workspace /
 *  DM agent) is conveyed by the subtitle, not the icon (shiki #task:1165). */
function ChannelGlyph(): JSX.Element {
  return <Hash data-channel-icon className="size-3.5" />;
}

export interface TaskFilterBarProps {
  filters: TaskFilters;
  onChange: (next: TaskFilters) => void;
  /** Reset target. Clear shows only when `filters` differ from this and
   *  resets every dimension (channel / assignee / creator) back to it.
   *  Global passes DEFAULT_TASK_FILTERS; the drawer passes its
   *  current-channel default, so Clear restores the drawer's entry
   *  context rather than jumping to All (Cindy review). */
  baselineFilters: TaskFilters;
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
  channelOptions,
  allChannelsLabel,
  assigneeOptions,
  creatorOptions,
  hasUnassigned,
  className,
}: TaskFilterBarProps): JSX.Element {
  const dirty = !taskFiltersEqual(filters, baselineFilters);

  return (
    <div
      data-task-filter-bar
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      <ChannelFilter
        options={channelOptions}
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

function FilterPanel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Popover.Portal>
      <Popover.Content
        align="start"
        sideOffset={4}
        role="listbox"
        data-task-filter-panel
        data-dropdown-frame
        className="z-[70] max-h-[50vh] min-w-[180px] overflow-y-auto rounded-[var(--select-content-radius)] bg-bg-floating p-1 shadow-lg outline-none"
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

function OptionRow({
  selected,
  neutral = false,
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
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  const activeSelected = selected && !neutral;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
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
        activeSelected
          ? 'bg-[var(--bg-row-selected)] text-[color:var(--text-on-selected)]'
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
  // Split the (already group-then-alpha sorted) options into their data-
  // source sections so each gets a header. Order is fixed: Workspaces then
  // DMs (#task:1165). The ALL row stays ungrouped at the top.
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

  const renderOption = (o: ChannelOption): JSX.Element => (
    <OptionRow
      key={o.id}
      selected={value === o.id}
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
          icon={<ChannelGlyph />}
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
          className="z-[70] flex max-h-[50vh] w-[240px] flex-col rounded-[var(--select-content-radius)] bg-bg-floating p-1 shadow-lg outline-none"
        >
          <div className="flex items-center gap-1.5 border-b border-border-subtle px-2 pb-1.5 pt-1">
            <Search className="size-3.5 shrink-0 text-text-muted" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search channels…"
              className="w-full bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
            />
          </div>
          <div role="listbox" className="mt-1 min-h-0 flex-1 overflow-y-auto">
            <OptionRow
              selected={value === null}
              neutral
              onSelect={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {allChannelsLabel}
            </OptionRow>
            {sections.map(section => (
              <div key={section.key}>
                <div className="px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-text-muted">
                  {section.label}
                </div>
                {section.items.map(renderOption)}
              </div>
            ))}
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

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <FilterTrigger icon={icon} active={value.kind !== 'any'} aria-label={label}>
          {`${label}:${valuePart}`}
        </FilterTrigger>
      </Popover.Trigger>
      <FilterPanel>
        <OptionRow
          selected={value.kind === 'any'}
          neutral
          onSelect={() => choose({ kind: 'any' })}
        >
          {anyLabel}
        </OptionRow>
        {allowUnassigned ? (
          <OptionRow
            selected={value.kind === 'unassigned'}
            onSelect={() => choose({ kind: 'unassigned' })}
          >
            No assignee
          </OptionRow>
        ) : null}
        {options.map(o => {
          const key = personFilterKey({ kind: 'person', person: o.person });
          return (
            <OptionRow
              key={key}
              selected={value.kind === 'person' && personFilterKey(value) === key}
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
