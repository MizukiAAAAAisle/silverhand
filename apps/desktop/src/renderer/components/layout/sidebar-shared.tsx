import {
  forwardRef,
  useCallback,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { BellOff, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Namespace for persisted section-collapse state (#task:1632). The prefix
 * lives HERE, not at the call sites: consumers pass a short `persistId`
 * (`'starred'`, `'dm'`, …) and can neither collide with another layout key
 * nor fork the naming convention. Same `silverhand:layout.*` family and the
 * same `'1'|'0'` encoding as `useSidebarPane`'s per-sidebar visibility, so
 * "how the device owner likes the chrome" stays one storage vocabulary.
 *
 * Device-scoped by design, and deliberately NOT identity-bound: a collapsed
 * section reveals nothing about who was signed in, so it survives logout with
 * the rest of the chrome ergonomics (see `clearViewerLocalState` in
 * features/me/hooks.ts). This is the localStorage-eligible family — unlike
 * list sort mode / rank, which is viewer-scoped server state
 * (docs/list-sort-v1.md) and must not fork per surface.
 */
const SECTION_KEY_PREFIX = 'silverhand:layout.sidebar-section.';

function readExpanded(persistId: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(SECTION_KEY_PREFIX + persistId);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function persistExpanded(persistId: string, value: boolean): void {
  try {
    localStorage.setItem(SECTION_KEY_PREFIX + persistId, value ? '1' : '0');
  } catch {
    /* private mode / quota — in-memory state still wins */
  }
}

/**
 * Collapse state for one sidebar section. With a `persistId` the toggle is
 * written through to localStorage and re-read on mount, so it survives an app
 * restart; without one the state is session-local (the previous behavior, kept
 * for sections whose collapse isn't worth remembering).
 *
 * `defaultExpanded` is the FIRST-RUN value only — once the user has toggled the
 * section, the stored choice wins. Read lazily in the initializer so the first
 * paint is already in the restored state (no expanded→collapsed flash).
 * `persistId` is treated as fixed for the section's lifetime; every caller
 * passes a literal.
 */
function useSectionExpanded(
  persistId: string | undefined,
  defaultExpanded: boolean,
): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() =>
    persistId === undefined
      ? defaultExpanded
      : readExpanded(persistId, defaultExpanded),
  );
  const toggle = useCallback(() => {
    setExpanded(prev => {
      const next = !prev;
      if (persistId !== undefined) persistExpanded(persistId, next);
      return next;
    });
  }, [persistId]);
  return [expanded, toggle];
}

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
  /** Initial expanded state for collapsible sections. Defaults to true.
   *  With `persistId` set this is only the first-run value. */
  defaultExpanded?: boolean;
  /** When set, the collapse state persists across app restarts under
   *  `silverhand:layout.sidebar-section.<persistId>`. Short and stable — it
   *  is the storage identity of this section, so renaming it resets every
   *  user's choice. Omit for session-only collapse. */
  persistId?: string;
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
  persistId,
  children,
}: SectionProps): JSX.Element {
  const [expanded, toggleExpanded] = useSectionExpanded(
    collapsible ? persistId : undefined,
    defaultExpanded,
  );
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
        onToggle={toggleExpanded}
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

/**
 * Loudness of an unread count badge (#task:1870). NOT three eligibilities —
 * one badge, three volumes, resolved from the viewer's effective attention mode
 * for that conversation/workspace:
 *   - `loud`  (All messages)   = filled `--accent` pill, the attention beacon.
 *   - `quiet` (Mentions only)  = hairline ring + neutral ink, NO fill. The fact
 *     is kept, the volume drops one step; reuses the Activity `+N new` count
 *     vocabulary rather than inventing a second recipe.
 *   - silent  (Mute)           = no badge at all — callers render nothing, which
 *     is why there is no `silent` member here (a badge that renders nothing is a
 *     branch, not a tier).
 *
 * Utility-vs-semantic budget: `quiet` deliberately spends NO saturated hue — the
 * accent fill is the one thing that separates "look here" from "for reference".
 */
export type UnreadBadgeTier = 'loud' | 'quiet';

/**
 * The ONE unread count pill for every sidebar surface (home rail workspace rows,
 * STARRED rows, channel rows). Extracted in #task:1870: the recipe had been
 * hand-copied at four call sites and had already drifted — the channel row was
 * `text-[9px]/leading-[16px]` with no `aria-label` while the other three were
 * `text-[10px]/h-4` — so a second (quiet) tier would have been copied four times
 * over a divergent base.
 *
 * `inverted` is the selected-row form: on a filled selection the accent pill
 * would fight the selection fill, so fill and ink swap. Layout (margins,
 * placement in the row's status slot) stays with the CONSUMER; this component
 * only owns the badge's own identity — per the shared-hook rule, a component that
 * also dictates spacing breaks the next consumer.
 *
 * `data-sidebar-unread` is the theme painting hook (forza6 repaints the pill as a
 * square poster sticker); `data-unread-tier` lets a theme scope its treatment to
 * one volume without re-deriving the tier from colours.
 */
export function UnreadBadge({
  count,
  tier = 'loud',
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
    tier === 'quiet'
      ? 'border border-border text-text-secondary'
      : inverted
        ? 'bg-bg-floating text-accent'
        : 'bg-accent text-text-on-accent';
  return (
    <span
      data-sidebar-unread
      data-unread-tier={tier}
      className={
        'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-full px-1 text-[10px] tabular-nums ' +
        // Quiet drops the weight too: hairline + regular weight is one coherent
        // step down, not a ring bolted onto a loud pill.
        (tier === 'quiet' ? 'font-medium ' : 'font-semibold ') +
        skin +
        (className ? ` ${className}` : '')
      }
      aria-label={`${count} unread`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

/**
 * The rail's persistent "this workspace is muted" marker (shiki 2026-08-07,
 * #task:1870). Shared by the home rail row and its STARRED twin because STARRED
 * is a starred workspace's EXCLUSIVE home — a marker only the rail knew how to
 * draw would silently vanish the moment you starred a muted workspace.
 *
 * ADDITIVE, not subtractive: a channel row expresses silence by dropping to the
 * muted ink, which works there because the neighbouring loud rows are the
 * comparison group. The rail has no such group — its rows are already quiet when
 * nothing is happening, so "dimmer" is isomorphic to "nothing new" and only an
 * existence marker can say "silenced" (dogfood: shiki could not tell which
 * workspace was muted). It sits BESIDE the count slot rather than replacing it:
 * a directed mention legitimately pierces mute, so muted-and-loud is a real
 * state, not a contradiction.
 *
 * Ink: no colour of its own — it inherits the row's `currentColor` and dims it.
 * That is what keeps it correct in all three themes AND on the selected row
 * (where the row's ink is `--text-on-selected`, so a fixed grey would sit wrong
 * on the fill), and it keeps the glyph on the row's own hover transition instead
 * of jumping colour families. `opacity-60` over the rail's resting
 * `--text-secondary` lands at ≈40% ink — the "very faint" end shiki asked for,
 * level with `--text-faint`, this renderer's third-tier text step.
 *
 * Identity only, per the shared-component rule: placement and spacing belong to
 * the consumer's status slot.
 */
export function MutedMarker(): JSX.Element {
  return (
    <BellOff
      className="size-3 shrink-0 opacity-60"
      role="img"
      aria-label="Muted"
    />
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
  badgeTier,
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
          <UnreadBadge count={badge} tier={badgeTier} inverted={selected} />
        ) : status ? (
          <span data-status-pip className={'size-1.5 rounded-full ' + STATUS_DOT[status]} />
        ) : null}
      </button>
    </li>
  );
});
