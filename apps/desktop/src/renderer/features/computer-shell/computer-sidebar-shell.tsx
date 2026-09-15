import type { JSX } from "react";
import { DirectorySidebar } from "@/components/layout/directory-shell";
import { Monitor, Plus } from "lucide-react";
import type { HostDto } from "@silverhand/shared";
import { Button } from "@/components/ui/button";
import { computerCopy } from "@/features/computer-shell/model/computer-copy";
import { useHostStatusQuery } from "@/features/computer-shell/hooks/hooks";
import {
  describeHostStatus,
  type HostStatusTone,
} from "@/features/computer-shell/model/host-status-presentation";
import { SidebarRow, SidebarSection } from "@/components/layout/sidebar-shared";

export interface ComputerSidebarShellProps {
  hosts: HostDto[];
  localHostId: string | null;
  isLoading: boolean;
  selectedHostId: string | null;
  onSelectHost: (id: string) => void;
  onAddComputer?: () => void;
}

export function ComputerSidebarShell({
  hosts,
  localHostId,
  isLoading,
  selectedHostId,
  onSelectHost,
  onAddComputer,
}: ComputerSidebarShellProps): JSX.Element {
  const sorted = sortHostsForSidebar(
    hosts.filter((host) => host.status === "active" || host.status === "revoked"),
    localHostId,
  );

  return (
    <DirectorySidebar>
      <SidebarSection
        label="COMPUTERS"
        icon={<Monitor className="size-3.5" />}
        count={sorted.length}
        collapsible
        defaultExpanded
        persistId="computer-directory"
        actionAlwaysVisible
        action={
          onAddComputer ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onAddComputer}
              aria-label={computerCopy.addComputer}
              title={computerCopy.addComputer}
            >
              <Plus className="size-3.5" />
            </Button>
          ) : undefined
        }
      >
        {sorted.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-text-muted">
            {isLoading ? "Loading…" : "No computers yet."}
          </li>
        ) : (
          sorted.map((host) => (
            <ComputerRow
              key={host.id}
              host={host}
              isSelected={host.id === selectedHostId}
              onSelect={() => onSelectHost(host.id)}
            />
          ))
        )}
      </SidebarSection>
    </DirectorySidebar>
  );
}

/**
 * Tone → sidebar status-pip color. The detail view maps the same
 * `HostStatusTone` to its own dot palette (`TONE_DOT_CLASS`); the rail
 * only has the three-color pip vocabulary (`active`/`idle`/`crashed`), so
 * collapse onto it: online is green (`active`), offline is muted (`idle`),
 * and a connected-but-unreachable/errored host is red (`crashed`) —
 * something is wrong and worth a glance.
 */
const TONE_TO_PIP: Record<HostStatusTone, "active" | "idle" | "crashed"> = {
  accent: "active",
  success: "active",
  warning: "crashed",
  error: "crashed",
  muted: "idle",
};

/**
 * One computer row. Availability comes from the shared per-host status
 * query + `describeHostStatus`, identical to the detail-view hero, so the
 * two surfaces never show different words for the same state. Revoked
 * computers skip the live query (no daemon to ask) and show the terminal
 * lifecycle label with no pip.
 */
function ComputerRow({
  host,
  isSelected,
  onSelect,
}: {
  host: HostDto;
  isSelected: boolean;
  onSelect: () => void;
}): JSX.Element {
  // Lifecycle bucketing reads the backend-owned `status` enum; never
  // re-derive it from raw timestamps. Pending is filtered out upstream
  // (modal-scoped draft), so a row is either `active` or `revoked` here.
  const isRevoked = host.status === "revoked";
  const isAppManaged = host.provisioning_source === "app_install";

  // Live availability — one request on mount, then event-driven via
  // host-connection-sync. Disabled for revoked (terminal, nothing live).
  const statusQuery = useHostStatusQuery(host.id, { enabled: !isRevoked });
  const view = statusQuery.data ? describeHostStatus(statusQuery.data) : null;

  const availabilityLabel = isRevoked ? computerCopy.lifecycleRevoked : (view?.label ?? null);
  const pip = isRevoked ? null : view ? TONE_TO_PIP[view.tone] : null;

  return (
    <SidebarRow
      stacked
      icon={<Monitor className="size-3.5" />}
      title={host.display_label ?? host.name}
      subtitle={
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <span className="truncate">{availabilityLabel ?? " "}</span>
          {isAppManaged ? <AppManagedBadge /> : null}
        </span>
      }
      selected={isSelected}
      status={pip}
      onClick={onSelect}
    />
  );
}

function AppManagedBadge(): JSX.Element {
  return (
    <span
      data-computer-app-managed
      className="rounded-(--control-radius) border border-border-subtle px-1 text-(length:--text-badge) font-semibold uppercase tracking-wide"
    >
      {computerCopy.appManaged}
    </span>
  );
}

/**
 * Local-first ordering: the user's own computer always anchors the
 * top of the list; everything else falls back to a label-ordered
 * stable sort. Exported as a pure function so a unit test pins the
 * sort without spinning up React Query.
 */
export function sortHostsForSidebar(hosts: HostDto[], localHostId: string | null): HostDto[] {
  return [...hosts].sort((a, b) => {
    if (a.id === localHostId) {
      return -1;
    }

    if (b.id === localHostId) {
      return 1;
    }

    const aLabel = (a.display_label ?? a.name).toLowerCase();
    const bLabel = (b.display_label ?? b.name).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}
