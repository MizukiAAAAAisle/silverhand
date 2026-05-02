import { type JSX, type ReactNode } from 'react';
import { MessagesSquare, Monitor, Settings, Users } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Top-level app sections. Outer to the channels/sessions sidebars —
 * picking one swaps what those sidebars (and the main pane) show.
 *
 * `settings` is reachable through the dedicated bottom button rather
 * than the main rail, but it still participates in section selection
 * so the bottom button can highlight when its route is active.
 */
export type AppSection = 'chat' | 'members' | 'computers' | 'settings';

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
  { id: 'members', label: 'Members', icon: <Users className="size-4" /> },
  { id: 'computers', label: 'Computers', icon: <Monitor className="size-4" /> },
];

export function NavRail({ current, onChange }: NavRailProps): JSX.Element {
  const settingsSelected = current === 'settings';
  return (
    <nav
      aria-label="App sections"
      className="flex h-full w-[var(--nav-rail-width)] shrink-0 flex-col items-center gap-1 bg-[var(--bg-nav-rail)] py-2"
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
              'flex size-9 items-center justify-center border-2 transition-colors',
              selected
                ? 'border-accent bg-bg-selected text-text-on-selected'
                : 'border-transparent text-text-secondary hover:border-accent hover:bg-white/70 hover:text-text-primary',
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
          'mt-auto flex size-9 items-center justify-center border-2 transition-colors',
          settingsSelected
            ? 'border-accent bg-bg-selected text-text-on-selected'
            : 'border-transparent text-text-secondary hover:border-accent hover:bg-white/70 hover:text-text-primary',
        )}
      >
        <Settings className="size-4" />
      </button>
    </nav>
  );
}
