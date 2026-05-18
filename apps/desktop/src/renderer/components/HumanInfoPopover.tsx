import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { User as UserIcon } from 'lucide-react';

/**
 * Permissive shape so both `UserDto` (full row, available when the human
 * IS the viewer) and `HumanMemberDto` (chip strip / mention resolution
 * for non-viewer humans, which omits `id` / `created_at` / `avatar_url`)
 * can flow through the same popover. Only the fields actually rendered
 * appear here — adding `id` would force chip callers to invent one, and
 * `created_at` was deliberately dropped (no Joined line per shiki).
 */
export interface HumanInfoTarget {
  name: string;
  display_name: string;
}

interface HumanInfoPopoverProps {
  human: HumanInfoTarget;
  /** The element that triggers the popover (rendered via Radix
   *  `asChild`). */
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  /** `'click'` opens on click for standalone controls. `'hover'`
   *  (default) opens on pointer-enter and closes on pointer-leave with
   *  a small grace window so the user can move into the popover
   *  content. Mirrors `AgentInfoPopover` so agent and human triggers
   *  feel identical. */
  trigger?: 'click' | 'hover';
  /**
   * Avatar object URL resolved by the parent.
   *
   * - `undefined` (omitted) — no avatar URL provided; render the
   *   placeholder. We do NOT fetch internally so high-frequency render
   *   sites (timeline message authors, inline `@mentions`, member
   *   chips) don't fire one GET per instance. v1 single-human installs
   *   wire this from `useViewerAvatarObjectUrl()` on the parent.
   * - `null` — parent looked it up and the human has no avatar (or it
   *   is still loading); render the placeholder.
   * - `string` — use the parent's blob URL directly.
   */
  avatarObjectUrl?: string | null;
}

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 120;

/**
 * Compact human (user) info card — the human counterpart to
 * `AgentInfoPopover`. Shows avatar + display name + handle, nothing
 * else. Intentionally lighter than the agent popover: humans are not
 * processes, so there is no per-conversation presence line, no
 * crashed-retry affordance, no management actions, and no Joined date
 * (per shiki — single-human v1 invariant means "joined" carries no
 * information beyond the registration row itself).
 *
 * Hover mode is implemented via controlled `open` rather than Radix's
 * separate HoverCard primitive to keep the dep surface narrow and
 * match the existing agent popover's interaction grammar.
 */
export function HumanInfoPopover({
  human,
  children,
  side = 'bottom',
  align = 'start',
  trigger = 'hover',
  avatarObjectUrl,
}: HumanInfoPopoverProps): JSX.Element {
  const [hoverOpen, setHoverOpen] = useState(false);
  // Single timer reused for both open and close so consecutive
  // pointer transitions cancel each other out cleanly. Mirrors the
  // agent popover.
  const timerRef = useRef<number | null>(null);
  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  useEffect(() => () => clearTimer(), []);

  const scheduleOpen = (): void => {
    if (trigger !== 'hover') return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setHoverOpen(true), HOVER_OPEN_DELAY_MS);
  };
  const scheduleClose = (): void => {
    if (trigger !== 'hover') return;
    clearTimer();
    timerRef.current = window.setTimeout(() => setHoverOpen(false), HOVER_CLOSE_DELAY_MS);
  };

  const rootProps =
    trigger === 'hover'
      ? { open: hoverOpen, onOpenChange: setHoverOpen }
      : {};

  const label = human.display_name?.trim() || human.name;
  const initial = label.charAt(0).toUpperCase();

  return (
    <Popover.Root {...rootProps}>
      <Popover.Trigger
        asChild
        onPointerEnter={scheduleOpen}
        onPointerLeave={scheduleClose}
      >
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}
          data-popover-frame="info"
          className="z-50 w-[260px] max-w-[calc(100vw-32px)] rounded-md border border-border bg-bg-floating p-3 shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="flex items-start gap-3">
            {avatarObjectUrl ? (
              <span className="inline-block size-9 shrink-0 overflow-hidden rounded-none bg-bg-elevated">
                {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
                <img
                  src={avatarObjectUrl}
                  alt=""
                  className="size-full object-cover"
                />
              </span>
            ) : (
              <span
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-none bg-bg-elevated text-sm font-medium text-text-muted"
                aria-hidden
              >
                {label.length > 0 ? initial : <UserIcon className="size-4" />}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-text-primary">
                {label}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                @{human.name}
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
