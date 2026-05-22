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
  count?: number;
  onAdd?: () => void;
  action?: ReactNode;
  /** When true, the header acts as a toggle and the body collapses.
   *  Defaults to false to preserve callers that expect always-open. */
  collapsible?: boolean;
  /** Initial expanded state for collapsible sections. Defaults to true. */
  defaultExpanded?: boolean;
  /** Override the header text styling. Defaults to the compact
   *  `text-[11px] font-medium tracking-wider text-text-muted` look used
   *  by Members / Computers panels. WorkspacesPanel passes a larger
   *  `text-sm` variant for the DM / WORKSPACES / ARCHIVED groups. */
  headerClass?: string;
  children: ReactNode;
}

const DEFAULT_HEADER_CLASS =
  'text-[11px] font-medium tracking-wider text-text-muted';

export function SidebarSection({
  label,
  count,
  onAdd,
  action,
  collapsible = false,
  defaultExpanded = true,
  headerClass = DEFAULT_HEADER_CLASS,
  children,
}: SectionProps): JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const showBody = !collapsible || expanded;

  const headerInner = (
    <span className="flex items-center gap-1">
      {collapsible ? (
        expanded ? (
          <ChevronDown className="size-3 text-text-muted" />
        ) : (
          <ChevronRight className="size-3 text-text-muted" />
        )
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
    <section className="px-1.5 pb-3">
      <header className={`flex items-stretch justify-between ${headerClass}`}>
        {collapsible ? (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="flex flex-1 items-center px-2 py-1 text-left hover:text-text-secondary"
            aria-expanded={expanded}
          >
            {headerInner}
          </button>
        ) : (
          <span className="flex flex-1 items-center px-2 py-1">{headerInner}</span>
        )}
        {action ? (
          action
        ) : onAdd ? (
          <Button variant="ghost" size="icon" onClick={onAdd} aria-label={`add ${label}`}>
            <Plus className="size-3.5" />
          </Button>
        ) : null}
      </header>
      {showBody ? <ul className="space-y-0.5">{children}</ul> : null}
    </section>
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
          'sidebar-row-border flex w-full items-center gap-2 border px-2 py-1.5 text-left text-sm transition-colors ' +
          (selected
            ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
            : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,rgba(255,255,255,0.7))] hover:text-text-primary') +
          (className ? ` ${className}` : '')
        }
      >
        {icon ? <span className="shrink-0 text-text-muted">{icon}</span> : null}
        <span className={
          'flex min-w-0 flex-1 items-baseline gap-1.5 ' +
          (badge && badge > 0 && !selected ? 'font-semibold text-text-primary' : '')
        }>
          <span className="truncate">{title}</span>
          {subtitle ? (
            <span className="truncate text-xs text-text-muted">{subtitle}</span>
          ) : null}
        </span>
        {badge && badge > 0 ? (
          <span
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
          <span className={'size-1.5 rounded-full ' + STATUS_DOT[status]} />
        ) : null}
      </button>
    </li>
  );
});
