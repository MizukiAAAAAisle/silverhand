import * as HoverCard from '@radix-ui/react-hover-card';
import {
  cloneElement,
  isValidElement,
  useEffect,
  useState,
  type AnimationEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { isRefHoverDebugEnabled, logRefHoverDebug } from '@/lib/refHoverDebug';

/**
 * Hover-triggered popover used by inline reference chips.
 *
 * Opens after a 500ms grace so brief flick-throughs (mouse moving past
 * a paragraph) don't paint a popover at all. After the grace, the
 * caller decides whether to render real content or a skeleton — the
 * caller already owns the data fetch via React Query, so this
 * component is intentionally dumb.
 *
 * Visible-state contract (set by the user, see `mtRX9X1H93dDVDKw`):
 *   - 0–500ms hover  → popover NOT visible. Fetch races in the
 *                       background (callers mount their queries
 *                       eagerly), so by the time the popover opens
 *                       the cache is usually warm.
 *   - ≥ 500ms, data ready → render content directly.
 *   - ≥ 500ms, still loading → render skeleton (NO spinner — that
 *                              was explicitly ruled out in design).
 *
 * `closeDelay={120}` gives the user a brief window to move from chip
 * → popover so the popover doesn't snap shut between them. Defaults
 * here mirror radix recommendations for hover-card "open delay" UX.
 */
export interface HoverPopoverProps {
  trigger: ReactNode;
  /** Real popover body (caller resolved data). */
  content: ReactNode;
  /** Optional skeleton — shown when content is null/undefined and
   *  the popover has already opened past the 500ms grace. Pass a
   *  caller-styled placeholder; we don't impose a default look so
   *  task vs conversation popovers can size themselves. */
  skeleton?: ReactNode;
  /** Whether the data the caller passes via `content` is ready. When
   *  false, the popover shows `skeleton` instead. */
  isContentReady: boolean;
  /** Optional override of the standard 500ms grace. Only the test
   *  harness uses this — production callers should leave it default. */
  openDelayMs?: number;
  /** Optional debug label and context for temporary flicker diagnostics. */
  debug?: HoverPopoverDebugInfo;
}

export interface HoverPopoverDebugInfo {
  kind: 'conversation' | 'task';
  label: string;
  state: string;
  details?: Record<string, unknown>;
}

interface TriggerDebugProps {
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
}

export function HoverPopover({
  trigger,
  content,
  skeleton,
  isContentReady,
  openDelayMs = 500,
  debug,
}: HoverPopoverProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const debugEnabled = isRefHoverDebugEnabled() && debug != null;

  const logDebug = (
    event: string,
    extra?: Record<string, unknown>,
  ): void => {
    if (!debugEnabled || !debug) return;
    logRefHoverDebug(event, {
      component: 'HoverPopover',
      kind: debug.kind,
      label: debug.label,
      state: debug.state,
      open,
      isContentReady,
      ...debug.details,
      ...extra,
    });
  };

  const triggerForRender =
    debugEnabled && isValidElement<TriggerDebugProps>(trigger)
      ? cloneElement(trigger as ReactElement<TriggerDebugProps>, {
          onPointerEnter: event => {
            logDebug('trigger:pointer-enter', {
              pointerType: event.pointerType,
            });
            trigger.props.onPointerEnter?.(event);
          },
          onPointerLeave: event => {
            logDebug('trigger:pointer-leave', {
              pointerType: event.pointerType,
            });
            trigger.props.onPointerLeave?.(event);
          },
        })
      : trigger;

  const handleOpenChange = (nextOpen: boolean): void => {
    logDebug('root:open-change', { nextOpen });
    setOpen(nextOpen);
  };

  const handleContentPointerEnter = (
    event: PointerEvent<HTMLDivElement>,
  ): void => {
    logDebug('content:pointer-enter', { pointerType: event.pointerType });
  };

  const handleContentPointerLeave = (
    event: PointerEvent<HTMLDivElement>,
  ): void => {
    logDebug('content:pointer-leave', { pointerType: event.pointerType });
  };

  const handleContentAnimationStart = (
    event: AnimationEvent<HTMLDivElement>,
  ): void => {
    logDebug('content:animation-start', { animationName: event.animationName });
  };

  const handleContentAnimationEnd = (
    event: AnimationEvent<HTMLDivElement>,
  ): void => {
    logDebug('content:animation-end', { animationName: event.animationName });
  };

  useEffect(() => {
    logDebug('render-state', {});
  });

  return (
    <HoverCard.Root
      open={open}
      onOpenChange={handleOpenChange}
      openDelay={openDelayMs}
      closeDelay={120}
    >
      <HoverCard.Trigger asChild>{triggerForRender}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-[80] w-[260px] max-w-[calc(100vw-32px)] rounded-md border border-border bg-bg-floating p-3 text-xs text-text-primary shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
          onPointerEnter={handleContentPointerEnter}
          onPointerLeave={handleContentPointerLeave}
          onAnimationStart={handleContentAnimationStart}
          onAnimationEnd={handleContentAnimationEnd}
        >
          {isContentReady ? content : skeleton ?? <DefaultSkeleton />}
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

/**
 * Three muted-bar shimmer that any caller can use when they don't
 * want to roll their own skeleton. Width pattern (full / 60% / 40%)
 * suggests a title + meta line layout without committing to one.
 */
function DefaultSkeleton(): JSX.Element {
  return (
    <div className="space-y-1.5" aria-hidden>
      <div className="h-3 w-full animate-pulse rounded bg-bg-elevated" />
      <div className="h-3 w-3/5 animate-pulse rounded bg-bg-elevated" />
      <div className="h-3 w-2/5 animate-pulse rounded bg-bg-elevated" />
    </div>
  );
}
