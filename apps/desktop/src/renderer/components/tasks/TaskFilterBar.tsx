import {
  forwardRef,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  AtSign,
  Check,
  ChevronDown,
  Hash,
  MessageSquareText,
  PenLine,
  Search,
  User,
  X,
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
  label: string;
  /** Drives the leading icon so the dropdown matches the project's
   *  conversation icon vocabulary (Hash/AtSign/MessageSquareText) instead
   *  of literal #/@/↳ characters (shiki feedback). Defaults to 'channel'. */
  kind?: 'channel' | 'dm' | 'thread';
  /** Secondary line (e.g. parent channel for a thread). */
  sublabel?: string;
}

/** Conversation-kind → icon, mirroring AgentConversationActivityList so
 *  every surface speaks one icon vocabulary. */
function ChannelKindIcon({
  kind,
}: {
  kind: ChannelOption['kind'];
}): JSX.Element {
  if (kind === 'dm') return <AtSign className="size-3.5" />;
  if (kind === 'thread') return <MessageSquareText className="size-3.5" />;
  return <Hash className="size-3.5" />;
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
        anyLabel="Anyone"
        options={assigneeOptions}
        allowUnassigned={hasUnassigned}
        value={filters.assignee}
        onChange={assignee => onChange({ ...filters, assignee })}
      />
      <PersonFilterControl
        icon={<PenLine className="size-3.5" />}
        label="Creator"
        anyLabel="Anyone"
        options={creatorOptions}
        value={filters.creator}
        onChange={creator => onChange({ ...filters, creator })}
      />
      {dirty ? (
        <button
          type="button"
          onClick={() => onChange(baselineFilters)}
          className="flex items-center gap-1 rounded-[var(--chip-radius)] px-1.5 py-1 text-[11px] text-text-muted transition-colors hover:text-text-primary"
        >
          <X className="size-3" />
          Clear
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
        active
          ? 'border-accent bg-bg-primary text-accent'
          : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-border hover:text-text-primary',
        className,
      )}
      {...props}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate">{children}</span>
      <ChevronDown className="size-3 shrink-0 text-text-muted" />
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
        className="z-[70] max-h-[50vh] min-w-[180px] overflow-y-auto rounded-[var(--select-content-radius)] border border-border bg-bg-floating p-1 shadow-lg outline-none"
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

function OptionRow({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        // Row-state border contract (§3.5.1): default transparent edge,
        // hover paints `--border-row-hover` (forza6 near-black / warm
        // accent) — the same poster-sticker hover language as sidebar
        // rows, instead of a lime `--bg-hover` fill (shiki feedback).
        // Selected keeps the accent-soft fill + check so it still reads
        // as the committed choice.
        'flex w-full items-center gap-2 rounded-[var(--select-item-radius)] px-2 py-1.5 text-left text-xs transition-colors',
        'border border-transparent hover:border-[color:var(--border-row-hover)] hover:text-text-primary',
        selected ? 'bg-accent-soft text-text-primary' : 'text-text-secondary',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
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
          icon={<ChannelKindIcon kind={selected?.kind} />}
          active={value !== null}
        >
          {selected?.label ?? allChannelsLabel}
        </FilterTrigger>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          data-task-filter-panel
          className="z-[70] flex max-h-[50vh] w-[240px] flex-col rounded-[var(--select-content-radius)] border border-border bg-bg-floating p-1 shadow-lg outline-none"
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
              onSelect={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              {allChannelsLabel}
            </OptionRow>
            {filtered.map(o => (
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
                    <ChannelKindIcon kind={o.kind} />
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
  const valueLabel =
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
        <FilterTrigger icon={icon} active={value.kind !== 'any'}>
          {value.kind === 'any' ? label : valueLabel}
        </FilterTrigger>
      </Popover.Trigger>
      <FilterPanel>
        <OptionRow selected={value.kind === 'any'} onSelect={() => choose({ kind: 'any' })}>
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
