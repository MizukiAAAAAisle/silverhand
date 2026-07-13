import { type JSX, type ReactNode } from 'react';
import {
  Activity,
  CheckSquare,
  MessagesSquare,
  Monitor,
  Settings,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Top-level app sections. Outer to the channels/sessions sidebars —
 * picking one swaps what those sidebars (and the main pane) show.
 *
 * `settings` is reachable through the dedicated bottom button rather
 * than the main rail, but it still participates in section selection
 * so the bottom button can highlight when its route is active.
 */
export type AppSection =
  | 'chat'
  | 'activity'
  | 'tasks'
  | 'members'
  | 'computers'
  | 'settings';

interface NavRailProps {
  current: AppSection;
  onChange: (section: AppSection) => void;
  /**
   * Per-section "has new content" flags — a section whose value is `true` gets a
   * single attention dot (no count) on its rail button. Presentational only: the
   * bools are derived upstream from the existing viewer read-models (Chat = the
   * message-unread summary; Activity = the unattended-items list) and clear
   * naturally as that content is observed. The dot rides `--accent` — the app's
   * one unread/brand hue — so it reads as the same "unread" signal the sidebar n
   * badge already uses, not a second colour language (#task:1408).
   */
  dots?: Partial<Record<AppSection, boolean>>;
}

interface NavItem {
  id: AppSection;
  label: string;
  icon: ReactNode;
  /** ⌘<n> global shortcut for this section. Surfaced in the
   *  tooltip so the binding is discoverable; the handler lives in the
   *  renderer's keyboard-shortcuts hook, not here. */
  shortcut: number;
}

const ITEMS: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: <MessagesSquare className="size-4" />, shortcut: 1 },
  { id: 'activity', label: 'Activity', icon: <Activity className="size-4" />, shortcut: 2 },
  { id: 'tasks', label: 'Tasks', icon: <CheckSquare className="size-4" />, shortcut: 3 },
  { id: 'members', label: 'Members', icon: <Users className="size-4" />, shortcut: 4 },
  { id: 'computers', label: 'Computers', icon: <Monitor className="size-4" />, shortcut: 5 },
];

/**
 * Derive the two nav-rail attention dots from the viewer read-models (#task:1408).
 * Pure so the "has new content" contract is testable without a render harness.
 *
 * - `chat` = ANY workspace has unread. Reads the message-unread summary's
 *   `by_workspace` map straight — archived channels are already excluded at the
 *   rollup source (#1403-A), so there is deliberately NO archived re-filter here
 *   (re-filtering would fork a second unread-rule in the renderer).
 * - `activity` = the unattended-items list is non-empty. Activity's `observe()`
 *   drops handled items, so a non-empty list already means "has new" — no
 *   per-item `is_new` needed.
 *
 * Both inputs may be `undefined` while their query is cold → dot off (no false
 * positive before data lands).
 */
export function deriveNavRailDots(input: {
  workspaceUnread: Record<string, number> | undefined;
  activityItemCount: number | undefined;
}): { chat: boolean; activity: boolean } {
  return {
    chat: Object.values(input.workspaceUnread ?? {}).some(count => count > 0),
    activity: (input.activityItemCount ?? 0) > 0,
  };
}

export function NavRail({ current, onChange, dots }: NavRailProps): JSX.Element {
  const settingsSelected = current === 'settings';
  return (
    <nav
      aria-label="App sections"
      className="flex h-full w-[var(--nav-rail-width)] shrink-0 flex-col items-center gap-1 bg-[var(--bg-nav-rail)] py-2"
      style={{
        borderRadius: 'var(--card-radius, 0)',
        boxShadow: 'var(--card-shadow, none)',
        overflow: 'hidden',
      }}
    >
      {ITEMS.map(item => {
        const selected = item.id === current;
        const hasDot = dots?.[item.id] === true;
        return (
          <button
            key={item.id}
            type="button"
            title={`${item.label}  ⌘${item.shortcut}`}
            aria-label={item.label}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(item.id)}
            className={cn(
              // Row-radius routed via `--row-radius` token (#task:912 review
              // round 2). warm/forza6 = 0 (square poster/scan-line); slack-dark
              // = 6px (Slack-style rounded nav button).
              'relative flex size-9 items-center justify-center rounded-[var(--row-radius)] border-2 transition-colors',
              selected
                ? 'border-accent bg-bg-selected text-text-on-selected'
                : 'border-transparent text-[var(--text-nav-rail,var(--text-secondary))] hover:border-accent hover:bg-[var(--bg-nav-rail-hover,rgba(255,255,255,0.7))] hover:text-[var(--text-nav-rail-hover,var(--text-primary))]',
            )}
          >
            {item.icon}
            {hasDot && (
              // Attention dot: no count, top-right corner (icon is centred, so
              // the corner is empty). `--accent` = the app's unread/brand hue.
              // `data-nav-unread-dot` lets a theme reshape it (e.g. forza6's
              // square-sticker language) without touching this layout.
              <span
                data-nav-unread-dot
                aria-hidden
                className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-accent"
              />
            )}
          </button>
        );
      })}

      <button
        type="button"
        title="Settings"
        aria-label="Settings"
        aria-current={settingsSelected ? 'page' : undefined}
        onClick={() => onChange('settings')}
        className={cn(
          // Same `--row-radius` token as nav buttons above (#task:912).
          'mt-auto flex size-9 items-center justify-center rounded-[var(--row-radius)] border-2 transition-colors',
          settingsSelected
            ? 'border-accent bg-bg-selected text-text-on-selected'
            : 'border-transparent text-[var(--text-nav-rail,var(--text-secondary))] hover:border-accent hover:bg-[var(--bg-nav-rail-hover,rgba(255,255,255,0.7))] hover:text-[var(--text-nav-rail-hover,var(--text-primary))]',
        )}
      >
        <Settings className="size-4" />
      </button>
    </nav>
  );
}
