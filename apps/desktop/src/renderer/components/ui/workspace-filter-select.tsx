import { useMemo } from 'react';
import * as Select from '@radix-ui/react-select';
import { ChevronDown } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { WorkspaceIcon } from '@/components/WorkspaceIcon';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import type { WorkspaceListItem } from '@/features/workspaces/hooks';
import { workspaceDisplayName } from '@/lib/workspace-name';
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from '@/components/ui/filter-select';

/**
 * Shared "filter by workspace" dropdown. One component, one data source
 * (`WorkspaceListItem[]`), one item design — Agent Spaces group then Workspaces,
 * each row a `WorkspaceIcon` (agent space → agent avatar, regular → serif W) +
 * the canonical `workspaceDisplayName`. ArchivedChannelsPanel and SavedListView
 * both render through THIS so the two workspace filters are identical rather than
 * each deriving an ad-hoc `{id, name}` list off its own rows (shiki #task:1258:
 * match Archived's item design + data source). Built on the Radix-Select
 * primitive (`filter-select.tsx`), so keyboard nav / focus ring / Esc-Enter and
 * per-theme radius come for free.
 */
export type WorkspaceFilterValue = 'all' | `workspace:${string}`;

/** The selected workspace id, or `null` for the "all" sentinel. */
export function workspaceFilterId(value: WorkspaceFilterValue): string | null {
  return value.startsWith('workspace:')
    ? value.slice('workspace:'.length)
    : null;
}

export function WorkspaceFilterSelect({
  value,
  workspaces,
  onChange,
  allLabel = 'All workspaces',
  allIcon,
  showArchivedSuffix = false,
  ariaLabel = 'Workspace filter',
}: {
  value: WorkspaceFilterValue;
  /** Full list; filtered to regular + DM workspaces internally. */
  workspaces: WorkspaceListItem[];
  onChange: (value: WorkspaceFilterValue) => void;
  allLabel?: string;
  /** Icon for the "all" row + the trigger when nothing is scoped. */
  allIcon: JSX.Element;
  /** Tag DM/regular rows whose workspace is itself archived (Archived panel). */
  showArchivedSuffix?: boolean;
  ariaLabel?: string;
}): JSX.Element {
  const { data: agents = [] } = useAgents();
  const filterable = useMemo(
    () => workspaces.filter(w => w.kind === 'regular' || w.kind === 'dm'),
    [workspaces],
  );
  const dms = filterable.filter(w => w.kind === 'dm');
  const regular = filterable.filter(w => w.kind === 'regular');
  const agentsById = useMemo(
    () => new Map(agents.map(a => [a.id, a])),
    [agents],
  );
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const selected = workspaceFilterLabel(
    value,
    filterable,
    agentsById,
    agentAvatarUrls,
    allLabel,
    allIcon,
  );

  return (
    <Select.Root value={value} onValueChange={v => onChange(v as WorkspaceFilterValue)}>
      <Select.Trigger aria-label={ariaLabel} className={FILTER_SELECT_TRIGGER_CLASS}>
        <span className="flex min-w-0 items-center gap-1.5">
          {selected.icon}
          <span className="truncate">{selected.label}</span>
        </span>
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-dropdown-frame
          className={FILTER_SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            <FilterSelectItem value="all" icon={allIcon}>
              {allLabel}
            </FilterSelectItem>
            {/* Agent spaces lead, mirroring SearchPanel/Archived order so every
                workspace-filter dropdown reads the same. */}
            {dms.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                  Agent Spaces
                </Select.Label>
                {dms.map(workspace => (
                  <FilterSelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        kind="dm"
                        dmAgentId={workspace.dm_agent_id}
                        agentsById={agentsById}
                        dmAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                    suffix={
                      showArchivedSuffix && workspace.archived_at !== null
                        ? 'archived workspace'
                        : undefined
                    }
                  >
                    {workspaceDisplayName(workspace)}
                  </FilterSelectItem>
                ))}
              </Select.Group>
            ) : null}
            {regular.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                  Workspaces
                </Select.Label>
                {regular.map(workspace => (
                  <FilterSelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        kind="regular"
                        dmAgentId={null}
                        dmAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                    suffix={
                      showArchivedSuffix && workspace.archived_at !== null
                        ? 'archived workspace'
                        : undefined
                    }
                  >
                    {workspaceDisplayName(workspace)}
                  </FilterSelectItem>
                ))}
              </Select.Group>
            ) : null}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function workspaceFilterLabel(
  value: WorkspaceFilterValue,
  workspaces: WorkspaceListItem[],
  agentsById: Map<string, AgentDto>,
  agentAvatarUrls: Map<string, string | null>,
  allLabel: string,
  allIcon: JSX.Element,
): { label: string; icon: JSX.Element } {
  if (value === 'all') return { label: allLabel, icon: allIcon };
  const id = value.slice('workspace:'.length);
  const workspace = workspaces.find(w => w.id === id);
  if (!workspace) {
    return {
      label: 'Workspace',
      icon: (
        <WorkspaceIcon kind="regular" dmAgentId={null} dmAgentAvatarUrls={agentAvatarUrls} />
      ),
    };
  }
  return workspace.kind === 'dm'
    ? {
        label: workspaceDisplayName(workspace),
        icon: (
          <WorkspaceIcon
            kind="dm"
            dmAgentId={workspace.dm_agent_id}
            agentsById={agentsById}
            dmAgentAvatarUrls={agentAvatarUrls}
          />
        ),
      }
    : {
        label: workspace.name,
        icon: (
          <WorkspaceIcon kind="regular" dmAgentId={null} dmAgentAvatarUrls={agentAvatarUrls} />
        ),
      };
}
