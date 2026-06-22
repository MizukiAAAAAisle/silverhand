import { type ComponentType, type SVGProps } from 'react';
import { Activity, CalendarClock, FolderTree, Plug, User } from 'lucide-react';
import { cn } from '@/lib/cn';

export type AgentSection = 'profile' | 'workspace' | 'mcp' | 'activity' | 'schedules';

interface SectionItem {
  id: AgentSection;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  hint: string;
}

export const AGENT_SECTIONS: ReadonlyArray<SectionItem> = [
  {
    id: 'profile',
    label: 'Profile',
    icon: User,
    hint: 'Identity, runtime, model.',
  },
  {
    id: 'schedules',
    label: 'Schedules',
    icon: CalendarClock,
    hint: 'Cron / interval / one-shot wakeups.',
  },
  {
    id: 'workspace',
    label: 'Workspace',
    icon: FolderTree,
    hint: 'L1 system prompt, MEMORY, notes.',
  },
  {
    id: 'mcp',
    label: 'MCP',
    icon: Plug,
    hint: 'Profile MCP servers — raw config + summary.',
  },
  {
    id: 'activity',
    label: 'Activity',
    icon: Activity,
    hint: 'Per-channel execution trace.',
  },
];

interface AgentSidebarProps {
  active: AgentSection;
  onChange: (section: AgentSection) => void;
}

/**
 * Vertical section nav for the agent panel. Mirrors the workspace /
 * channel sidebar pattern (icon + label rows, hover tint) but tones
 * the selection state down: the agent panel isn't a primary navigation
 * surface, so we pick a quieter "selected" affordance — a thin accent
 * left bar plus a slightly stronger text weight, instead of the
 * full inverse fill the chat sidebars use. The user is here to read,
 * not to navigate constantly.
 *
 * Width is intentionally tight (160 px) — labels are short, and a
 * narrower rail leaves more room for the content surface.
 */
export function AgentSidebar({ active, onChange }: AgentSidebarProps): JSX.Element {
  return (
    <aside
      aria-label="Agent sections"
      className="flex h-full w-[160px] shrink-0 flex-col gap-0.5 border-r border-border-subtle bg-bg-floating px-1.5 py-2"
    >
      {AGENT_SECTIONS.map(item => {
        const selected = item.id === active;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onChange(item.id)}
            title={item.hint}
            data-panel-control="nav-button"
            className={cn(
              // Quietest possible "selected": a soft fill + bolder text.
              // No accent bar, no border — the agent panel isn't a main
              // navigation surface, so the indicator should sit underneath
              // the content, not compete with it. forza6 specialization
              // (lime ground + 2px black border) lives in
              // forza6-components.css, scoped via the parent aside's
              // `aria-label="Agent sections"`. Radius comes from the
              // global `[data-panel-control]` rule (token-driven).
              'flex h-8 items-center gap-2 px-2 text-left text-[12px] transition-colors',
              selected
                ? 'bg-bg-hover/60 text-text-primary'
                : 'text-text-muted hover:bg-bg-hover/40 hover:text-text-primary',
            )}
          >
            <Icon
              className="size-3.5 shrink-0"
              strokeWidth={selected ? 2.25 : 2}
            />
            <span className={cn('truncate', selected ? 'font-medium' : '')}>
              {item.label}
            </span>
          </button>
        );
      })}
    </aside>
  );
}
