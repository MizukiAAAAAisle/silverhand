import type { HostDto } from '@silverhand/shared';
import { HostDetailView } from '@/features/hosts/HostDetailView';
import { DirectoryPlaceholder } from '@/components/layout/DirectoryShell';

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
      {loading ? 'Loading computers…' : 'Select a computer to see its details'}
    </DirectoryPlaceholder>
  );
}
