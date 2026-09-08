import { useMemo } from "react";
import * as Select from "@radix-ui/react-select";
import { ChevronDown } from "lucide-react";
import type { AgentDto } from "@silverhand/shared";
import { WorkspaceIcon } from "@/components/WorkspaceIcon";
import { useAgents } from "@/features/agent-shell/hooks/hooks";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import type { WorkspaceListItem } from "@/features/workspaces/hooks";
import { isAgentSpace } from "@/features/workspaces/workspace-ownership";
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from "@/components/ui/filter-select";

/**
 * Shared "filter by workspace" dropdown. One component, one data source
 * (`WorkspaceListItem[]`), one item design — Agent Spaces group then Workspaces,
 * each row a `WorkspaceIcon` (agent space → its agent's avatar, people-owned →
 * serif W) + the workspace's own name. ArchivedChannelsPanel and SavedListView
 * both render through THIS so the two workspace filters are identical rather than
 * each deriving an ad-hoc `{id, name}` list off its own rows (shiki #task:1258:
 * match Archived's item design + data source). Built on the Radix-Select
 * primitive (`filter-select.tsx`), so keyboard nav / focus ring / Esc-Enter and
 * per-theme radius come for free.
 */
export type WorkspaceFilterValue = "all" | `workspace:${string}`;

/** The selected workspace id, or `null` for the "all" sentinel. */
export function workspaceFilterId(value: WorkspaceFilterValue): string | null {
  return value.startsWith("workspace:") ? value.slice("workspace:".length) : null;
}

export function WorkspaceFilterSelect({
  value,
  workspaces,
  onChange,
  allLabel = "All workspaces",
  allIcon,
  showArchivedSuffix = false,
  ariaLabel = "Workspace filter",
}: {
  value: WorkspaceFilterValue;
  /** Full list — every workspace the viewer can see is offered. */
  workspaces: WorkspaceListItem[];
  onChange: (value: WorkspaceFilterValue) => void;
  allLabel?: string;
  /** Icon for the "all" row + the trigger when nothing is scoped. */
  allIcon: JSX.Element;
  /** Tag rows whose workspace is itself archived (Archived panel). */
  showArchivedSuffix?: boolean;
  ariaLabel?: string;
}): JSX.Element {
  const { data: agents = [] } = useAgents();
  // Every visible workspace is offered: the `kind === 'regular' || kind ===
  // 'agent_space'` pre-filter that used to sit here admitted the whole set (the
  // union WAS the alphabet), so it fenced nothing and went out with the kind
  // (#task:2078).
  const agentSpaces = workspaces.filter((w) => isAgentSpace(w));
  const peopleOwned = workspaces.filter((w) => !isAgentSpace(w));
  const agentsById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const selected = workspaceFilterLabel(
    value,
    workspaces,
    agentsById,
    agentAvatarUrls,
    allLabel,
    allIcon,
  );

  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as WorkspaceFilterValue)}>
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
            {agentSpaces.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                  Agent Spaces
                </Select.Label>
                {agentSpaces.map((workspace) => (
                  <FilterSelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        ownerAgentId={workspace.owner_agent_id}
                        agentsById={agentsById}
                        ownerAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                    suffix={
                      showArchivedSuffix && workspace.archived_at !== null
                        ? "archived workspace"
                        : undefined
                    }
                  >
                    {workspace.name}
                  </FilterSelectItem>
                ))}
              </Select.Group>
            ) : null}
            {peopleOwned.length > 0 ? (
              <Select.Group>
                <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                  Workspaces
                </Select.Label>
                {peopleOwned.map((workspace) => (
                  <FilterSelectItem
                    key={workspace.id}
                    value={`workspace:${workspace.id}`}
                    icon={
                      <WorkspaceIcon
                        ownerAgentId={workspace.owner_agent_id}
                        ownerAgentAvatarUrls={agentAvatarUrls}
                      />
                    }
                    suffix={
                      showArchivedSuffix && workspace.archived_at !== null
                        ? "archived workspace"
                        : undefined
                    }
                  >
                    {workspace.name}
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
  if (value === "all") return { label: allLabel, icon: allIcon };
  const id = value.slice("workspace:".length);
  const workspace = workspaces.find((w) => w.id === id);
  if (!workspace) {
    // The selected id no longer resolves (the workspace went away while the
    // filter held it). The trigger must still render something, so this is a
    // PLACEHOLDER, not a claim about ownership — a generic word and the neutral
    // badge, never the vanished workspace's identity.
    return {
      label: "Workspace",
      icon: <WorkspaceIcon ownerAgentId={null} ownerAgentAvatarUrls={agentAvatarUrls} />,
    };
  }
  // One label either way (the row's own name); only the identity glyph
  // differs — an agent space wears its agent's face, a people-owned workspace the
  // serif "W", and `WorkspaceIcon` picks that off the ownership arc itself.
  return {
    label: workspace.name,
    icon: (
      <WorkspaceIcon
        ownerAgentId={workspace.owner_agent_id}
        agentsById={agentsById}
        ownerAgentAvatarUrls={agentAvatarUrls}
      />
    ),
  };
}
