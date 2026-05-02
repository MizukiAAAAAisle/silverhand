import type { JSX } from 'react';
import { Monitor } from 'lucide-react';
import { SidebarRow, SidebarSection } from './sidebar-shared';

export function ComputersPanel(): JSX.Element {
  return (
    <SidebarSection label="COMPUTERS" count={1}>
      <SidebarRow
        icon={<Monitor className="size-3.5" />}
        title="this machine"
        status="active"
        selected
      />
    </SidebarSection>
  );
}
