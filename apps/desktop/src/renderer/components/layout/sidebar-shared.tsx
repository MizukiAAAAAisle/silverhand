import {
  forwardRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SectionProps {
  label: string;
  /** Optional leading icon (lucide or any ReactNode). Renders before the
   *  label as a small section anchor — used by Members panel to give
   *  AGENTS / HUMANS a visual identity (#task:917 v6.8). Kept theme-
   *  neutral; consumers pass plain lucide icons and themes decide
   *  whether to paint them further. Skip when the section's content
   *  already carries identity (channel `#` chips, computer Monitor
   *  glyphs). */
  icon?: ReactNode;
  count?: number;
  onAdd?: () => void;
  action?: ReactNode;
  /** When true, the header acts as a toggle and the body collapses.
   *  Defaults to false to preserve callers that expect always-open. */
  collapsible?: boolean;
  /** Initial expanded state for collapsible sections. Defaults to true. */
  defaultExpanded?: boolean;
  children: ReactNode;
}

export function SidebarSection({
  label,
  icon,
  count,
  onAdd,
  action,
  collapsible = false,
  defaultExpanded = true,
  children,
}: SectionProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const showBody = !collapsible || expanded;

  return (
    <section className="px-1.5 pb-3">
      <SidebarSectionHeader
        label={label}
        icon={icon}
        count={count}
        onAdd={onAdd}
        action={action}
        collapsible={collapsible}
        expanded={expanded}
        onToggle={() => setExpanded(v => !v)}
      />
      {showBody ? <ul className="space-y-0.5">{children}</ul> : null}
    </section>
  );
}

interface SectionHeaderProps {
  label: string;
  icon?: ReactNode;
  count?: number;
  onAdd?: () => void;
  action?: ReactNode;
  collapsible?: boolean;
  /** Current expanded state (only meaningful when `collapsible`). */
  expanded?: boolean;
  onToggle?: () => void;
}

/**
 * The section-header row, extracted so non-`SidebarSection` surfaces (the
 * channel sidebar's fixed header, #task:1146) get the IDENTICAL treatment —
 * muted tracking-wider label + count on the left, an `action` slot (or `+`
 * add button) on the right. Stateless: collapse state is owned by the caller.
 */
export function SidebarSectionHeader({
  label,
  icon,
  count,
  onAdd,
  action,
  collapsible = false,
  expanded = true,
  onToggle,
}: SectionHeaderProps): JSX.Element {
  const headerInner = (
    <span className="flex items-center gap-1">
      {collapsible ? (
        expanded ? (
          <ChevronDown className="size-3 text-text-muted" />
        ) : (
          <ChevronRight className="size-3 text-text-muted" />
        )
      ) : null}
      {icon ? (
        <span data-sidebar-section-icon className="inline-flex shrink-0 items-center text-text-muted">
          {icon}
        </span>
      ) : null}
      <span>
        {label}
        {typeof count === 'number' ? (
          <span className="ml-1 text-text-muted/70">{count}</span>
        ) : null}
      </span>
    </span>
  );

  return (
    <header className="mb-1 flex items-stretch justify-between text-[12px] font-medium tracking-wider text-text-muted">
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 items-center px-2 h-6 text-left hover:text-text-secondary"
          aria-expanded={expanded}
        >
          {headerInner}
        </button>
      ) : (
        <span className="flex flex-1 items-center px-2 h-6">{headerInner}</span>
      )}
      {action ? (
        action
      ) : onAdd ? (
        <Button variant="ghost" size="icon" onClick={onAdd} aria-label={`add ${label}`}>
          <Plus className="size-3.5" />
        </Button>
      ) : null}
    </header>
  );
}

interface RowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'title'> {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  selected?: boolean;
  status?: 'active' | 'idle' | 'crashed' | null;
  /** Unread count pill on the right edge. Falsy / 0 hides it. */
  badge?: number;
  /** Two-line layout: title on top, subtitle stacked below (instead of
   *  inline beside it). Used by richer rows (COMPUTERS: name + lifecycle
   *  label + badge) that don't fit on one line. Default `false` keeps the
   *  compact single-line row every other sidebar relies on. */
  stacked?: boolean;
  onClick?: () => void;
}

const STATUS_DOT: Record<NonNullable<RowProps['status']>, string> = {
  active: 'bg-success',
  idle: 'bg-text-muted/40',
  crashed: 'bg-error',
};

export const SidebarRow = forwardRef<HTMLButtonElement, RowProps>(function SidebarRow({
  icon,
  title,
  subtitle,
  selected,
  status,
  badge,
  stacked,
  onClick,
  className,
  ...buttonProps
}: RowProps, ref): JSX.Element {
  return (
    <li>
      <button
        ref={ref}
        {...buttonProps}
        type="button"
        onClick={onClick}
        className={
          // `leading-[16px]` matches the icon container's literal-px
          // height (16px avatar via AgentAvatar / HumanRowIcon). Without
          // it `text-sm`'s ~20px line-height would inflate the icon
          // wrapper's line-box past the avatar, leaving the avatar and
          // the title text on subtly different vertical centers
          // (#task:912 review round 5: shiki measured icon-wrapper 16×20
          // vs avatar 16×16, name height 17.5 → ~2px misalignment).
          // `stacked` rows are two lines, so they need more vertical
          // padding than the compact single-line default.
          'sidebar-row-border flex w-full items-center gap-2 border px-2 text-left text-sm leading-[16px] transition-colors ' +
          (stacked ? 'py-2 ' : 'py-1.5 ') +
          (selected
            ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
            : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary') +
          (className ? ` ${className}` : '')
        }
      >
        {icon ? (
          // `leading-none` neutralizes any inherited line-height on the
          // wrapper so its height collapses to its content (the 16×16
          // avatar/glyph). Belt-and-braces with `leading-[16px]` on the
          // button so the wrapper is pinned to 16px regardless of any
          // future line-height change above.
          <span className="inline-flex shrink-0 items-center leading-none text-text-muted">{icon}</span>
        ) : null}
        <span className={
          'flex min-w-0 flex-1 ' +
          (stacked ? 'flex-col gap-0.5 ' : 'gap-1.5 ') +
          (badge && badge > 0 && !selected ? 'font-semibold text-text-primary' : '')
        }>
          <span className="truncate">{title}</span>
          {stacked ? (
            // Stacked rows ALWAYS reserve the subtitle line so every row in
            // the group is the same height — a computer with no lifecycle
            // label (an active user-added one; per the two-axis lexicon
            // "active carries no standalone label") must not collapse to a
            // shorter single-line row beside the local "this computer" row
            // (shiki dogfood: inconsistent heights). The nbsp holds the
            // line box when there's no subtitle; this is also the slot
            // per-row availability (Online / Offline) fills once enabled.
            <span className="truncate text-xs text-text-muted">
              {subtitle ?? ' '}
            </span>
          ) : subtitle ? (
            <span className="truncate text-xs text-text-muted">{subtitle}</span>
          ) : null}
        </span>
        {badge && badge > 0 ? (
          <span
            data-sidebar-unread
            className={
              'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ' +
              (selected
                ? 'bg-bg-floating text-accent'
                : 'bg-accent text-text-on-accent')
            }
            aria-label={`${badge} unread`}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : status ? (
          <span data-status-pip className={'size-1.5 rounded-full ' + STATUS_DOT[status]} />
        ) : null}
      </button>
    </li>
  );
});
