import {
  forwardRef,
  useCallback,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { BellOff, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

/**
 * "Copy name" for a conversation row. Shared because a starred channel now has TWO
 * row surfaces (#task:1888 — global STARRED and, when unstarred, its parent's list)
 * and the same action must report itself identically on both; two copies of these
 * two strings is how toast copy drifts.
 */
export async function copyConversationName(name: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(name);
    toast.success('Name copied');
  } catch {
    toast.error("Couldn't copy the name");
  }
}

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
 * passes a literal or a value derived from one stable entity id.
 *
 * Exported (#task:1889) because the merged sidebar's WORKSPACE HEADER is a
 * collapse toggle too, persisted per workspace under the same vocabulary
 * (`persistId = 'ws.<workspaceId>'`) — a second collapse-storage convention for
 * the same chrome affordance is how the two would drift apart. The setter is a
 * plain toggle: every write to this storage comes from a user opening or closing
 * a section, so the stored bit always means intent (#task:1901).
 */
export function useSidebarSectionExpanded(
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

/**
 * The sidebar's TWO glyph columns (#task:1889, shiki's Slack reference).
 *
 *   outer:   tool rows, the group headers, and everything a GROUP holds
 *            directly — container header rows and STARRED / DIRECT MESSAGES rows
 *   nested:  the channels under a container header
 *
 * One 16px step, and only one. The tree is four levels deep by structure, but
 * indenting each level would spend the whole narrow column on whitespace and
 * make the list read as a staircase (shiki: 「否则层级太多」, 2026-08-08). So the
 * question is which single distinction gets the step, and it goes to the one
 * where POSITION IS THE ONLY CUE LEFT: a group header is already a label by
 * typography (uppercase, tracked, muted, smaller, trailing count), but a
 * workspace row and a channel row are the same size, weight, colour and height,
 * and both are clickable — with them on one column a workspace and its nine
 * channels read as one flat run, and where one workspace's children end is
 * carried by the leading glyph alone. Indenting the channels turns each
 * workspace's children into a block whose edges ARE the boundary.
 *
 * The cost, accepted: tool rows, group headers, container header rows and STARRED
 * rows all share the outer column, and the same channel sits further out in
 * STARRED than under its parent. That is just "indent = depth" — in STARRED the
 * row's parent IS the group.
 *
 * There is still no permanent chevron GUTTER: since #task:1948 a collapsible row
 * keeps its identity glyph in the outer column and states its collapse in a small
 * caret TRAILING the label, inside the box it already occupies — so the affordance
 * is always visible without a column being spent on it (the candidate rejected in
 * #task:1889 was a LEADING triangle in its own column, which would have pushed
 * every channel another 12px in; docs/app-layout.md §3). The caret is drawn by
 * CAPABILITY, not by container species — every row that owns an `aria-expanded`
 * carries one (group headers AND the container header rows), and a leaf row — a
 * channel, STARRED, a direct line — never does, because its glyph is not a hinge.
 *
 * The section margin and the per-theme row border (`--sidebar-row-border-width`)
 * are already in the box, so only the indent step is these classes' job — a
 * hardcoded absolute x would be wrong in any theme that changes the border.
 *
 * The outer column is 8px (shiki 2026-08-10, up from 4px) — the two values move
 * TOGETHER, because the 16px step above is the invariant, not either absolute x.
 */
export const OUTER_GLYPH_INSET = 'pl-2';
export const NESTED_GLYPH_INSET = 'pl-6';

/**
 * The shared selected/hover recipe for a sidebar row — channel and container
 * rows, favorites, and the Search/Saved/Archived rail all share it, so it lives
 * in one place instead of drifting across five copies. Identity only: it paints
 * border + fill + text state; the consumer still owns layout (row border, sizing,
 * glyph inset). Selected = accent frame over the selected fill; unselected =
 * neutral, gaining an accent frame + row-hover ink on hover. The `--bg-row-hover`
 * fallback is `transparent` — every theme sets the token, so a theme that ever
 * forgot it would degrade to no hover fill, never a loud literal colour.
 *
 * Binary on purpose: exactly one strong highlight in the sidebar, no faint /
 * ambient second tier (#task:1254). `text-text-on-selected` is also the hook the
 * per-theme border contract keys on
 * (`aside[data-sidebar] .sidebar-row-border.text-text-on-selected` →
 * `--border-row-selected`), so it must stay on the selected row ALONE.
 *
 * STARRED used to paint from its own copy of this (`railRowTierClass`, #task:1957
 * folded it in): same two class strings, but its hover fallback was a literal
 * `rgba(255,255,255,0.7)` — the loud degradation this docblock argues against.
 * A conversation must look identical inside and outside STARRED, so there is one
 * function.
 */
export function sidebarRowStateClass(selected: boolean | undefined): string {
  return selected
    ? 'border-accent bg-[var(--bg-row-selected,var(--bg-selected))] text-text-on-selected'
    : 'border-transparent text-text-secondary hover:border-accent hover:bg-[var(--bg-row-hover,transparent)] hover:text-text-primary';
}

interface SectionProps {
  label: string;
  /** Optional leading icon (lucide or any ReactNode). Renders before the
   *  label as a small section anchor — used by Members panel to give
   *  AGENTS / HUMANS a visual identity (#task:917 v6.8). Kept theme-
   *  neutral; consumers pass plain lucide icons and themes decide
   *  whether to paint them further. Skip when the section's content
   *  already carries identity (channel `#` chips, computer Monitor
   *  glyphs).
   *
   *  On a COLLAPSIBLE section the glyph stays put and the collapse state rides
   *  in a caret trailing the label (#task:1948), so this slot is identity only
   *  and the header sits on the section glyph column (#task:1889). Pass a 14px
   *  glyph so it centres in the 16px slot. */
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

export function SidebarSection({
  label,
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
    <section className="group/sectionscope px-1.5 pb-3">
      <SidebarSectionHeader
        label={label}
        icon={icon}
        count={count}
        onAdd={onAdd}
        action={action}
        collapsible={collapsible}
        expanded={expanded}
        onToggle={() => toggleExpanded()}
      />
      {body ? <ul className="space-y-1">{body}</ul> : null}
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
  // A COLLAPSIBLE section that carries an icon is a tree container row (shiki's
  // Slack reference, #task:1889): the icon slot keeps the section's IDENTITY and
  // the collapse STATE rides in a trailing caret (see `caret`), so the header sits
  // on the section glyph column with the tool rows instead of paying a separate
  // chevron gutter — which is what lets Search / Saved / Archived line up with
  // STARRED / WORKSPACES / DM.
  //
  // Both collapsible callers (STARRED, WORKSPACES / DM) pass an icon, so the
  // icon-less fallback below has no consumer today; it stays as the API's
  // answer for a collapsible section that has no glyph to swap.
  const swapGlyph = collapsible && icon !== undefined;

  // The right-side actions (sort menu, `+`) of a TREE GROUP are hover-revealed,
  // not permanent (shiki, 2026-08-08): three sections' worth of always-on chrome
  // competed with the rows for the eye, and these are arrange-once controls. The
  // reveal scope is the WHOLE group — header or any child — because the sort menu
  // is what you reach for while reading the list, not while reading the label; the
  // `group/sectionscope` marker therefore lives on `SidebarSection`'s `<section>`,
  // which is why this only applies to the tree groups (the panels that render a
  // permanent `+` keep it).
  //
  // `[&:has(:focus-visible)]` and NOT `focus-within`: Chromium focuses a button on
  // mousedown, so `focus-within` would pin the actions on after any click. The same
  // trap is why the caret below keys off `group-focus-visible`, not `group-focus`.
  // `[&:has([data-state=open])]` keeps them up while their own menu is open — by
  // then the pointer has left the group.
  const actionReveal = swapGlyph
    ? 'flex items-center transition-opacity opacity-0 ' +
      'group-hover/sectionscope:opacity-100 [&:has(:focus-visible)]:opacity-100 ' +
      '[&:has([data-state=open])]:opacity-100'
    : 'flex items-center';
  // The collapse affordance, #task:1948. A PERMANENT state hint, not a button:
  // until now the only sign that a section collapsed was a disclosure triangle
  // that replaced the identity glyph on hover, so "this can be collapsed" was
  // invisible until you already pointed at it (shiki, comparing against a
  // reference sidebar with always-on chevrons: 「组头前那个 chevron 直接说明这一段
  // 能收起来」). It is deliberately NOT the permanent triangle that was rejected in
  // #task:1889 (docs/app-layout.md §3): that one wanted its OWN column, which
  // would have pushed every channel 12px further into an already narrow list.
  // This one trails the label inside the existing box and costs no column.
  //
  // Loudness: it inherits the header's muted ink and rests at 70% — the volume
  // this header already uses for its count (`text-text-muted/70`), so the hint
  // sits one step under the label instead of introducing a third value. It lifts
  // to full muted while the pointer is on the header, which is now the header's
  // hover feedback: no background, no border, no ink change on the label itself
  // (shiki, 2026-08-08 — a group header is a label, not a row).
  //
  // ONE glyph rotating, not two glyphs swapping: `aria-hidden` because the
  // button's `aria-expanded` already states it, and the rotation is what carries
  // the state visually, so the caret must not also be a second hit area.
  const caret = (
    <span
      aria-hidden
      data-sidebar-section-caret
      className={
        'inline-flex shrink-0 items-center opacity-70 transition-opacity ' +
        'group-hover/section:opacity-100 group-focus-visible/sectiontoggle:opacity-100'
      }
    >
      <ChevronDown
        className={
          'size-3 transition-transform duration-150 ' +
          (expanded ? 'rotate-0' : '-rotate-90')
        }
      />
    </span>
  );
  // lucide's caret pair is the icon-less fallback's affordance (see `swapGlyph`);
  // the panels' own headers (Members / Computers / Settings) are not collapsible
  // at all and render icon + label with no disclosure glyph.
  const fallbackChevron = expanded ? (
    <ChevronDown className="size-3.5" />
  ) : (
    <ChevronRight className="size-3.5" />
  );

  const headerInner = swapGlyph ? (
    <span className="flex min-w-0 items-center gap-2">
      {/* The identity glyph STAYS PUT now (#task:1948). It used to cross-fade into
          a disclosure triangle on hover, which needed a two-layer wrapper where
          the theme hook had to sit on the inner element — forza6 paints
          `[data-sidebar-section-icon]` at `opacity: .7`, i.e. the same
          specificity as Tailwind's `group-hover:opacity-0`, so with the hook on
          the animated element the theme won and both glyphs showed at once
          (shiki: forza6 下 hover 时两个图标重叠, 2026-08-08). With state moved to
          the caret there is no fade left to lose that race, and the section keeps
          exactly one glyph per job: identity in the slot, state in the caret. */}
      <span
        data-sidebar-section-icon
        className="inline-flex size-4 shrink-0 items-center justify-center"
      >
        {icon}
      </span>
      <span className="truncate">
        {label}
        {typeof count === 'number' ? (
          <span className="ml-1 text-text-muted/70">{count}</span>
        ) : null}
      </span>
      {caret}
    </span>
  ) : (
    <span className="flex items-center gap-1">
      {collapsible ? (
        <span className="text-text-muted">{fallbackChevron}</span>
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
    <header
      className={
        // The GROUP rung of the sidebar's two-rung type ladder: `font-bold` here
        // against `font-medium` on every ROW (workspace / channel / STARRED / the
        // Search-Saved-Archived entries), and `text-text-muted` against a row's
        // `text-text-secondary` — weight AND ink both separate the two levels
        // (shiki, 2026-08-10). Ink deliberately goes DOWN as weight goes up: muted
        // is chrome ink, and it is the pair that stays visibly apart in all four
        // themes, whereas primary-vs-secondary collapses inside forza6's sidebar
        // (both are pinned to near-black there). Size stays 12px — a label is not
        // content (shiki: 「分组标题…保持 12」).
        'mb-1 flex items-stretch justify-between text-xs font-bold tracking-wider text-text-muted ' +
        (swapGlyph ? 'group/section' : '')
      }
    >
      {collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          className={
            'group/sectiontoggle flex flex-1 items-center h-6 text-left ' +
            // A GROUP HEADER is a label, not a row. Its only hover feedback is the
            // caret lifting to full muted — no background, no border, no ink change
            // on the label (shiki, 2026-08-08). Hence `sidebar-row-gutter`, which
            // reserves the row stroke for column alignment but carries none of the
            // row state paint (`.sidebar-row-border:hover` is a lime fill in
            // forza6). The icon-less fallback is off the tree column, so it keeps
            // its own padding + hover ink.
            (swapGlyph
              ? 'sidebar-row-gutter ' + OUTER_GLYPH_INSET
              : 'px-2 hover:text-text-secondary')
          }
          aria-expanded={expanded}
        >
          {headerInner}
        </button>
      ) : (
        <span className="flex flex-1 items-center px-2 h-6">{headerInner}</span>
      )}
      {action ? (
        <span className={actionReveal}>{action}</span>
      ) : onAdd ? (
        <span className={actionReveal}>
          <Button variant="ghost" size="icon" onClick={onAdd} aria-label={`add ${label}`}>
            <Plus className="size-3.5" />
          </Button>
        </span>
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
 * `text-[length:var(--text-badge)]/leading-[16px]` with no `aria-label` while the other three were
 * `text-[length:var(--text-badge)]/h-4` — so a second (quiet) tier would have been copied four times
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
        ? 'bg-bg-floating text-[var(--unread)]'
        : 'bg-[var(--unread)] text-text-on-accent';
  return (
    <span
      data-sidebar-unread
      data-unread-tier={tier}
      className={
        'inline-flex h-4 min-w-[1rem] shrink-0 items-center justify-center rounded-[var(--pill-radius)] px-1 text-[length:var(--text-badge)] tabular-nums ' +
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
 * The persistent "this is muted" marker (shiki 2026-08-07, #task:1870). Shared by
 * the home rail's workspace row, its STARRED twin, and — since shiki 2026-08-09 —
 * the channel rows (`WorkspaceChannels` / `FavoritesPanel`), so a muted workspace
 * and a muted channel read identically and no consumer redraws the glyph.
 *
 * The marker is the SOLE mute signal on every row: an existence marker, not a
 * dimming. Dimming was tried on the channel rows and rejected — a muted row that
 * drops to the muted ink reads as de-emphasised or "not shown", not silenced, and
 * the rail never had a comparison group to make "dimmer" legible in the first
 * place (dogfood: shiki could not tell which workspace was muted; then, on the
 * channel rows, asked to keep the name at full colour). It sits BESIDE the count
 * slot rather than replacing it: a directed mention legitimately pierces mute, so
 * muted-and-loud is a real state, not a contradiction.
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
 * the consumer's status slot. The rail places it beside the count; the channel
 * rows place it beside the name (shiki 2026-08-09), like the workspace row.
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
          // The rest of the nav tree pins the SAME 16px as `leading-4`
          // (#task:1946, shiki `2uEqqwZpm372oo-D`) — grep both forms.
          // `stacked` rows are two lines, so they need more vertical
          // padding than the compact single-line default.
          'sidebar-row-border flex w-full items-center gap-2 border px-2 text-left text-sm leading-[16px] transition-colors ' +
          (stacked ? 'py-2 ' : 'py-1.5 ') +
          sidebarRowStateClass(selected) +
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
          <span data-status-pip className={'size-1.5 rounded-[var(--pill-radius)] ' + STATUS_DOT[status]} />
        ) : null}
      </button>
    </li>
  );
});

interface ConversationRowLayoutProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title' | 'children' | 'className'> {
  /** `true` iff this row is the open conversation — the ONE selection object in
   *  the tree (`conversationSelectionTier`). Paints the row AND sets the
   *  `data-row-selected` theme hook. */
  selected: boolean;
  /** Which glyph column the row sits on — see {@link OUTER_GLYPH_INSET}. A
   *  conversation nested under its workspace takes `nested`; the same
   *  conversation in STARRED takes `outer`, because there the group is its
   *  parent. It is a prop precisely because one row species appears on both. */
  column: 'nested' | 'outer';
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

/**
 * One conversation row's layout — the skeleton behind the in-tree `ChannelRow`
 * and the STARRED `FavoriteRow`. It owns the row box (height, the per-theme
 * border, the glyph column, the selection/hover paint) and the full-width name
 * button; the consumer owns the content and its own wrappers (context menu,
 * sortable `<li>`).
 *
 * Scope is the CONVERSATION rung, which is why it is named for the entity and not
 * for the tree: both consumers render open- or fixed-roster conversations and nothing
 * else. **The container header row deliberately stays out** — it is a
 * different rung (`h-7`, `sidebar-row-gutter` instead of the state-painted
 * `sidebar-row-border`, its own ink) and it needs siblings BESIDE the name button
 * (caret, hover actions). Stretching this layout over it would turn it into a
 * switch on entity species, which is how a shared primitive starts hurting whoever
 * adopts it next; the row it would save is one `<div>`.
 *
 * `SidebarRow` is the OTHER row family and stays separate: a flat list's row is a
 * single `<button>` with auto height, so it has no container to place siblings in
 * and no glyph column to choose.
 *
 * MUST stay a `forwardRef` that spreads the rest of its props onto the row `<div>`:
 * both consumers hand this element to `AppContextMenu`, i.e. to a Radix
 * `Trigger asChild`, which opens the menu by cloning the element with its own
 * `ref` + `onContextMenu`/pointer handlers. A plain function component drops both
 * SILENTLY — right-click just stops working, with nothing failing at the type level
 * (#task:1957 regression, shiki 2026-08-10: 「抽离了 ConversationRow 之后 context
 * menu 丢了」). `title` / `children` / `className` are excluded from the spread
 * because this layout owns them.
 */
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
        className={
          'sidebar-row-border flex h-8 w-full items-stretch border pr-2 ' +
          (column === 'nested' ? NESTED_GLYPH_INSET : OUTER_GLYPH_INSET) +
          ' ' +
          // No `transition-colors`: selected/hover switch instantly (#task:1162).
          // Selected is a discrete, already-committed state — fading it over 150ms
          // is what read as the leaving-row "flicker" (and the entering row "slow to
          // light up"). A discrete state must commit instantly; only hover (a
          // pointer-driven continuous affordance) ever earned the fade, and the cost
          // of keeping it (the whole drag-time colour-freeze apparatus) wasn't worth
          // it. Hover now switches instantly too.
          sidebarRowStateClass(selected) +
          (draggable ? ' cursor-grab select-none active:cursor-grabbing' : '')
        }
      >
        {/* The name button grows to fill the row, so the whole width is clickable.
            `font-medium` is the ROW rung of the sidebar's type ladder (`font-bold`
            belongs to the section LABEL, never to a row — shiki 2026-08-10); the
            matching ink, `text-text-secondary`, arrives on the container from
            `sidebarRowStateClass`. `leading-4` pins the 16px line box so the 16px
            identity glyph and the title share one vertical centre (#task:1946). */}
        <button
          type="button"
          onClick={onSelect}
          title={title}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-medium leading-4"
        >
          {children}
        </button>
      </div>
    );
  },
);
