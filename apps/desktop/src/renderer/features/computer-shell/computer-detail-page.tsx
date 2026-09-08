import type { HostDto } from "@silverhand/shared";
import { HostDetailView } from "@/features/computer-shell/components/host-detail-view";
import { DirectoryPlaceholder } from "@/components/layout/directory-shell";

export function ComputerDetailPage({
  host,
  loading,
}: {
  host: HostDto | null;
  loading: boolean;
}): JSX.Element {
  return host ? (
    <HostDetailView key={host.id} host={host} />
  ) : (
    <DirectoryPlaceholder>
      {loading ? "Loading computers…" : "Select a computer"}
    </DirectoryPlaceholder>
  );
}
