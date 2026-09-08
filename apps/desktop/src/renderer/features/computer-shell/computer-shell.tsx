import { useEffect, useState } from "react";
import { useBackendInfoSnapshot, useHostsQuery } from "@/features/computer-shell/hooks/hooks";
import { NewComputerDialog } from "@/features/computer-shell/components/new-computer-dialog";
import { DirectoryShell, type DirectoryLifecycle } from "@/components/layout/directory-shell";
import { ComputerSidebarShell } from "./computer-sidebar-shell";
import { ComputerDetailPage } from "./computer-detail-page";
import { resolveComputerSelection } from "./selection";

export function ComputerShell({ mounted, visible }: DirectoryLifecycle): JSX.Element {
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [newComputerOpen, setNewComputerOpen] = useState(false);

  const hostsQuery = useHostsQuery();
  const backendInfoQuery = useBackendInfoSnapshot();
  const hosts = hostsQuery.data?.hosts ?? [];
  const localHostId = backendInfoQuery.data?.local_host_id ?? null;
  const selectedHost = hosts.find((host) => host.id === selectedHostId) ?? null;

  useEffect(() => {
    const next = resolveComputerSelection(
      hosts.map((host) => host.id),
      selectedHostId,
      localHostId,
    );

    if (next !== selectedHostId) {
      setSelectedHostId(next);
    }
  }, [hosts, localHostId, selectedHostId]);

  return (
    <>
      <DirectoryShell
        name="computers"
        mounted={mounted}
        visible={visible}
        sidebar={
          <ComputerSidebarShell
            hosts={hosts}
            localHostId={localHostId}
            isLoading={hostsQuery.isLoading}
            selectedHostId={selectedHostId}
            onSelectHost={setSelectedHostId}
            onAddComputer={() => setNewComputerOpen(true)}
          />
        }
      >
        <ComputerDetailPage host={selectedHost} loading={hostsQuery.isLoading} />
      </DirectoryShell>
      <NewComputerDialog
        open={newComputerOpen}
        onOpenChange={setNewComputerOpen}
        onCreated={setSelectedHostId}
      />
    </>
  );
}
