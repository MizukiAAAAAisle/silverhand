/**
 * `#task:808` slice 4 — host list for the Computers nav section.
 *
 * Renders ALL hosts the viewer owns (not just `kind === 'local'`),
 * so when remote-host support lands no UI change is required — shiki:
 * "功能应是 hosts 主语的通用功能，不是 local only". Sorting:
 *   1. local host first (anchor — the user almost always starts here),
 *   2. then by `display_label ?? name` (case-insensitive) for stable
 *      ordering across renders.
 *
 * **Inputs come as props.** Data ownership lives in the parent (`App`)
 * so the right-pane `HostDetailView` can resolve the selected host
 * from the same in-memory list — single source of truth across the
 * master/detail split, no double React Query subscription, no comment
 * needed about deduping.
 *
 * Per-row status pip is intentionally absent in v1: pre-fetching every
 * host's `/status` would burn N concurrent RPCs on mount with no
 * benefit (the user clicks a row to drill in, where the detail view
 * does its own fetch). The local host is the only exception — we read
 * its attachment state from the already-loaded backend-info snapshot
 * and surface `active | idle` so the user can see "the local helper is
 * running" without opening detail. Other hosts will pick up the same
 * affordance when `useHostStatusQuery` is opt-in batched (deferred —
 * Q7.b).
 */
import type { JSX } from 'react';
import { Globe, Monitor } from 'lucide-react';
import type { HostDto } from '@silverhand/shared';
import { SidebarRow, SidebarSection } from './sidebar-shared';

export interface ComputersPanelProps {
  hosts: HostDto[];
  localHostId: string | null;
  /** Whether the local-host websocket is currently attached. Drives the
   *  local row's status pip (`active` vs `idle`). During the brief
   *  backend-info loading window the parent passes `false`, which
   *  collapses to `idle` — acceptable since the query resolves on app
   *  boot and the flicker is invisible in practice. */
  localAttached: boolean;
  /** True while the hosts query has not yet resolved. Drives the
   *  empty-state copy. */
  isLoading: boolean;
  selectedHostId: string | null;
  onSelectHost: (id: string) => void;
}

export function ComputersPanel({
  hosts,
  localHostId,
  localAttached,
  isLoading,
  selectedHostId,
  onSelectHost,
}: ComputersPanelProps): JSX.Element {
  const sorted = sortHostsForSidebar(hosts, localHostId);

  return (
    <SidebarSection label="COMPUTERS" count={sorted.length}>
      {sorted.length === 0 ? (
        <li className="px-2 py-1.5 text-xs text-text-muted">
          {isLoading ? 'Loading…' : 'No computers yet.'}
        </li>
      ) : (
        sorted.map(host => {
          const isLocal = host.id === localHostId;
          const Icon = isLocal ? Monitor : Globe;
          return (
            <SidebarRow
              key={host.id}
              icon={<Icon className="size-3.5" />}
              title={host.display_label ?? host.name}
              subtitle={isLocal ? 'this computer' : host.kind}
              selected={host.id === selectedHostId}
              // Cheap local-only signal — full per-host status pip lives
              // in the detail view's pill. Other hosts get no pip in v1
              // to avoid N status RPCs on mount.
              status={
                isLocal
                  ? localAttached
                    ? 'active'
                    : 'idle'
                  : null
              }
              onClick={() => onSelectHost(host.id)}
            />
          );
        })
      )}
    </SidebarSection>
  );
}

/**
 * Local-first ordering: the user's own computer always anchors the
 * top of the list; everything else falls back to a label-ordered
 * stable sort. Exported as a pure function so a unit test pins the
 * sort without spinning up React Query.
 */
export function sortHostsForSidebar(
  hosts: HostDto[],
  localHostId: string | null,
): HostDto[] {
  return [...hosts].sort((a, b) => {
    if (a.id === localHostId) return -1;
    if (b.id === localHostId) return 1;
    const aLabel = (a.display_label ?? a.name).toLowerCase();
    const bLabel = (b.display_label ?? b.name).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
}
