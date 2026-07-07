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
}

interface NavItem {
  id: AppSection;
  label: string;
  icon: ReactNode;
}

const ITEMS: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: <MessagesSquare className="size-4" /> },
  { id: 'activity', label: 'Activity', icon: <Activity className="size-4" /> },
  { id: 'tasks', label: 'Tasks', icon: <CheckSquare className="size-4" /> },
  { id: 'members', label: 'Members', icon: <Users className="size-4" /> },
  { id: 'computers', label: 'Computers', icon: <Monitor className="size-4" /> },
];

export function NavRail({ current, onChange }: NavRailProps): JSX.Element {
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
        return (
          <button
            key={item.id}
            type="button"
            title={item.label}
            aria-label={item.label}
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(item.id)}
            className={cn(
              // Row-radius routed via `--row-radius` token (#task:912 review
              // round 2). warm/forza6 = 0 (square poster/scan-line); slack-dark
              // = 6px (Slack-style rounded nav button).
              'flex size-9 items-center justify-center rounded-[var(--row-radius)] border-2 transition-colors',
              selected
                ? 'border-accent bg-bg-selected text-text-on-selected'
                : 'border-transparent text-[var(--text-nav-rail,var(--text-secondary))] hover:border-accent hover:bg-[var(--bg-nav-rail-hover,rgba(255,255,255,0.7))] hover:text-[var(--text-nav-rail-hover,var(--text-primary))]',
            )}
          >
            {item.icon}
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
