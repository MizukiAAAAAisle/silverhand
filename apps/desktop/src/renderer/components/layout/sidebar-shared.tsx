import {
  forwardRef,
  useCallback,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { BellOff, ChevronDown, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useSidebarBranchDrag } from "./sidebar-branch-drag";

export function SidebarChevron({ expanded }: { expanded: boolean }): JSX.Element {
  return (
    <ChevronDown
      aria-hidden
      data-sidebar-section-caret
      className={cn(
        "size-3 shrink-0 transition-transform duration-150",
        expanded ? "rotate-0" : "-rotate-90",
      )}
    />
  );
}

export async function copyConversationName(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(name);
    toast.success("Name copied");
  } catch {
    toast.error("Couldn't copy the name");
  }
}

const SECTION_KEY_PREFIX = "silverhand:layout.sidebar-section.";

function readExpanded(persistId: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(SECTION_KEY_PREFIX + persistId);
    if (raw === "1") return true;
    if (raw === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function persistExpanded(persistId: string, value: boolean): void {
  try {
    localStorage.setItem(SECTION_KEY_PREFIX + persistId, value ? "1" : "0");
  } catch {
    /* private mode / quota — in-memory state still wins */
  }
}

export function useSidebarSectionExpanded(
  persistId: string | undefined,
  defaultExpanded: boolean,
): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() =>
    persistId === undefined ? defaultExpanded : readExpanded(persistId, defaultExpanded),
  );
  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      if (persistId !== undefined) persistExpanded(persistId, next);
      return next;
    });
  }, [persistId]);
  return [expanded, toggle];
}

/**
 * Regular top level offset
 */
export const OUTER_GLYPH_INSET = "pl-2";
/**
 * Tree nested children offset
 */
export const NESTED_GLYPH_INSET = "pl-3";

export function sidebarRowStateClass(selected: boolean | undefined): string {
  return selected
    ? "navigation-row border-accent bg-bg-nav-selected text-text-nav-selected"
    : "navigation-row border-transparent text-text-secondary hover:border-accent hover:bg-bg-nav-hover hover:text-text-primary";
}

interface SectionProps {
  label: string;
  labelClassName?: string;
  icon?: ReactNode;
  count?: number;
  onAdd?: () => void;
  action?: ReactNode;
  /** When true, the header acts as a toggle and the body collapses.
   *  Defaults to false to preserve callers that expect always-open. */
  collapsible?: boolean;
  /** Initial expanded state for collapsible sections. Defaults to true.
   *  With `persistId` set this is only the first-run value. */
  defaultExpanded?: boolean;
  persistId?: string;
  collapsedContent?: ReactNode;
  children: ReactNode;
}

export function SidebarBranchLayout({
  header,
  children,
}: {
  header: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  const drag = useSidebarBranchDrag();

  return (
    <section className="group/sectionscope mb-2 flex flex-col gap-1">
      {header}
      {children ? (
        <ul className={cn("space-y-1", drag?.isDragging && "hidden")}>{children}</ul>
      ) : null}
    </section>
  );
}

export function SidebarSection({
  label,
  labelClassName,
  icon,
  count,
  onAdd,
  action,
  collapsible = false,
  defaultExpanded = true,
  persistId,
  collapsedContent,
  children,
}: SectionProps): JSX.Element {
  const [expanded, toggleExpanded] = useSidebarSectionExpanded(
    collapsible ? persistId : undefined,
    defaultExpanded,
  );
  const showBody = !collapsible || expanded;
  // Collapsed, but the open conversation lives in here: keep that one row (see
  // `collapsedContent`). Same `<ul>` as the body, so the surviving row sits where it
  // always sat instead of being re-homed into a second kind of list.
  const body = showBody ? children : collapsedContent;

  return (
    <SidebarBranchLayout
      header={
        <SidebarSectionHeader
          label={label}
          labelClassName={labelClassName}
          icon={icon}
          count={count}
          onAdd={onAdd}
          action={action}
          collapsible={collapsible}
          expanded={expanded}
          onToggle={() => toggleExpanded()}
        />
      }
    >
      {body}
    </SidebarBranchLayout>
  );
}

interface SectionHeaderProps {
  label: string;
  labelClassName?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  icon?: ReactNode;
  count?: number;
  onAdd?: () => void;
  action?: ReactNode;
  collapsible?: boolean;
  /** Current expanded state (only meaningful when `collapsible`). */
  expanded?: boolean;
  onToggle?: () => void;
}

/** Collapse state belongs to the caller; this header only presents it. */
export function SidebarSectionHeader({
  label,
  labelClassName,
  leading,
  trailing,
  icon,
  count,
  onAdd,
  action,
  collapsible = false,
  expanded = true,
  onToggle,
}: SectionHeaderProps): JSX.Element {
  const drag = useSidebarBranchDrag();

  // Keep menu actions visible while keyboard-focused or portaled menus are open.
  const actionReveal = cn(
    "flex items-center",
    collapsible &&
      icon !== undefined && [
        "opacity-0 transition-opacity",
        "group-hover/sectionheader:opacity-100 group-focus-visible/sectionheader:opacity-100",
        "[&:has(:focus-visible)]:opacity-100 [&:has([data-state=open])]:opacity-100",
      ],
  );

  const headerInner = (
    <span className="flex min-w-0 items-center gap-2">
      {collapsible ? (
        <SidebarChevron expanded={expanded && !drag?.isDragging} />
      ) : icon ? (
        <span
          data-sidebar-section-icon
          className="inline-flex shrink-0 items-center text-text-muted"
        >
          {icon}
        </span>
      ) : null}
      {leading}
      <span className={cn("truncate", labelClassName)}>{label}</span>
      {trailing}
      {typeof count === "number" ? (
        <span data-sidebar-count className="shrink-0 font-medium text-text-muted/70">
          {count}
        </span>
      ) : null}
    </span>
  );

  const actions =
    action ??
    (onAdd ? (
      <Button variant="ghost" size="icon" onClick={onAdd} aria-label={`add ${label}`}>
        <Plus className="size-3.5" />
      </Button>
    ) : null);

  const actionSlot = actions ? (
    <span
      className={actionReveal}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {actions}
    </span>
  ) : null;

  return (
    <header
      data-sidebar-group-heading={collapsible ? "" : undefined}
      className={cn(
        "text-sm leading-4 font-medium",
        collapsible ? "tracking-wide text-text-primary" : "tracking-wider text-text-muted",
      )}
    >
      {collapsible ? (
        <div
          {...drag?.attributes}
          {...drag?.listeners}
          ref={drag?.setActivatorNodeRef}
          role="button"
          tabIndex={0}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.code !== "Enter") {
              drag?.listeners?.onKeyDown?.(event);
            }
            if (event.defaultPrevented || event.target !== event.currentTarget) {
              return;
            }

            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onToggle?.();
            }
          }}
          className={cn(
            "group/sectionheader sidebar-row-gutter flex h-7 min-w-0 items-center justify-between",
            "cursor-pointer text-left",
            drag && "touch-none",
            drag?.isDragging && "cursor-grabbing",
            OUTER_GLYPH_INSET,
          )}
          aria-expanded={expanded && !drag?.isDragging}
          aria-label={label}
        >
          {headerInner}
          {actionSlot}
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <span className="flex min-w-0 flex-1 items-center px-2 h-6">{headerInner}</span>
          {actionSlot}
        </div>
      )}
    </header>
  );
}

export type UnreadBadgeTier = "loud" | "quiet";

export function UnreadBadge({
  count,
  tier = "loud",
  inverted = false,
  className,
}: {
  count: number;
  tier?: UnreadBadgeTier;
  /** Selected/primary row: swap fill and ink so the pill reads on the fill. */
  inverted?: boolean;
  className?: string;
}): JSX.Element | null {
  if (count <= 0) return null;
  const skin =
    tier === "quiet"
      ? "border border-border text-text-secondary"
      : inverted
        ? "bg-bg-floating text-[var(--unread)]"
        : "bg-[var(--unread)] text-text-on-accent";
  return (
    <span
      data-sidebar-unread
      data-unread-tier={tier}
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center",
        "rounded-(--pill-radius) px-1 text-(length:--text-badge) tabular-nums",
        tier === "quiet" ? "font-medium" : "font-semibold",
        skin,
        className,
      )}
      aria-label={`${count} unread`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function MutedMarker(): JSX.Element {
  return <BellOff className="size-3 shrink-0 opacity-60" role="img" aria-label="Muted" />;
}

interface RowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "title"> {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  selected?: boolean;
  status?: "active" | "idle" | "crashed" | null;
  /** Unread count pill on the right edge. Falsy / 0 hides it. */
  badge?: number;
  /** Loudness of {@link badge} — see {@link UnreadBadgeTier}. Mute renders no
   *  badge, so a muted row passes no `badge` at all. */
  badgeTier?: UnreadBadgeTier;
  /** Two-line layout: title on top, subtitle stacked below (instead of
   *  inline beside it). Used by richer rows (COMPUTERS: name + lifecycle
   *  label + badge) that don't fit on one line. Default `false` keeps the
   *  compact single-line row every other sidebar relies on. */
  stacked?: boolean;
  onClick?: () => void;
}

const STATUS_DOT: Record<NonNullable<RowProps["status"]>, string> = {
  active: "bg-success",
  idle: "bg-text-muted/40",
  crashed: "bg-error",
};

export const SidebarRow = forwardRef<HTMLButtonElement, RowProps>(function SidebarRow(
  {
    icon,
    title,
    subtitle,
    selected,
    status,
    badge,
    badgeTier,
    stacked,
    onClick,
    className,
    ...buttonProps
  }: RowProps,
  ref,
): JSX.Element {
  return (
    <li>
      <button
        ref={ref}
        {...buttonProps}
        type="button"
        onClick={onClick}
        className={cn(
          "sidebar-row-border flex w-full items-center gap-2 border px-2",
          "text-left text-sm leading-4 transition-colors",
          stacked ? "py-2" : "py-1.5",
          sidebarRowStateClass(selected),
          className,
        )}
      >
        {icon ? (
          <span className="inline-flex shrink-0 items-center leading-none">{icon}</span>
        ) : null}
        <span
          className={cn(
            "flex min-w-0 flex-1",
            stacked ? "flex-col gap-0.5" : "gap-1.5",
            badge && badge > 0 && !selected && "font-semibold text-text-primary",
          )}
        >
          <span className="truncate">{title}</span>
          {stacked ? (
            <span
              className={cn(
                "truncate text-xs",
                selected ? "text-text-nav-selected" : "text-text-muted",
              )}
            >
              {subtitle ?? " "}
            </span>
          ) : subtitle ? (
            <span
              className={cn(
                "truncate text-xs",
                selected ? "text-text-nav-selected" : "text-text-muted",
              )}
            >
              {subtitle}
            </span>
          ) : null}
        </span>
        {badge && badge > 0 ? (
          <UnreadBadge count={badge} tier={badgeTier} inverted={selected} />
        ) : status ? (
          <span
            data-status-pip
            className={cn("size-1.5 rounded-(--pill-radius)", STATUS_DOT[status])}
          />
        ) : null}
      </button>
    </li>
  );
});

interface ConversationRowLayoutProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "title" | "children" | "className"
> {
  /** `true` iff this row is the open conversation — the ONE selection object in
   *  the tree (`conversationSelectionTier`). Paints the row AND sets the
   *  `data-row-selected` theme hook. */
  selected: boolean;
  /** Which glyph column the row sits on — see {@link OUTER_GLYPH_INSET}. A
   *  conversation nested under its workspace takes `nested`; the same
   *  conversation in STARRED takes `outer`, because there the group is its
   *  parent. It is a prop precisely because one row species appears on both. */
  column: "nested" | "outer";
  /** Paint the grab cursor so the row reads as draggable. Set by a sortable
   *  wrapper only — drag is always available (a drop is what flips the list to
   *  manual), but a row rendered outside the sortable group (STARRED's
   *  collapsed reveal) has nothing to reorder. The drag listeners live on the
   *  parent `<li>`, never here. */
  draggable?: boolean;
  /** Native tooltip on the name button — for a row whose visible title is not the
   *  whole story (STARRED shows `title — parent`). */
  title?: string;
  onSelect: () => void;
  /** What rides ON the row, inside the name button: identity glyph, title,
   *  markers, trailing badge. */
  children: ReactNode;
}

export const ConversationRowLayout = forwardRef<HTMLDivElement, ConversationRowLayoutProps>(
  function ConversationRowLayout(
    { selected, column, draggable, title, onSelect, children, ...rest },
    ref,
  ): JSX.Element {
    return (
      <div
        ref={ref}
        // Injected trigger props go on FIRST so the row's own identity
        // (`data-row-selected`, `className`) can never be clobbered by a wrapper.
        {...rest}
        data-row-selected={selected || undefined}
        className={cn(
          "sidebar-row-border flex h-8 w-full items-stretch border pr-2",
          column === "nested" ? NESTED_GLYPH_INSET : OUTER_GLYPH_INSET,
          sidebarRowStateClass(selected),
          draggable && "cursor-grab select-none active:cursor-grabbing",
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          title={title}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[13px] font-normal leading-4"
        >
          {children}
        </button>
      </div>
    );
  },
);
