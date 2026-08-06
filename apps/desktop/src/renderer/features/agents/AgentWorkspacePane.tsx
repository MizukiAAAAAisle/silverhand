import { useQueryClient } from '@tanstack/react-query';
import {
  AgentWorkspaceBrowser,
  useWorkspaceSelection,
  type AgentWorkspaceLayout,
} from './AgentWorkspaceBrowser';
import {
  useAgentWorkspaceFile,
  useAgentWorkspaceTree,
  type AgentWorkspaceSource,
} from './hooks';

/**
 * The bridge between a data source and the source-blind `AgentWorkspaceBrowser`
 * (#task:1191): owns the scoped tree/file queries + selection, hands the
 * resolved results to the renderer. One container, parameterized by `source` +
 * `layout`, serves both views so they can't drift:
 *  - full members page → `source = home`, `layout = 'full'`;
 *  - chat side panel → `source = workspace(currentWorkspaceId)`, `layout =
 *    'compact'`.
 * Selection lives in the shared `useWorkspaceSelection` hook, so adding a
 * second view didn't duplicate the auto-select / drop-on-disappear effects.
 */
export function AgentWorkspaceContainer({
  agentId,
  source,
  layout,
}: {
  agentId: string;
  source: AgentWorkspaceSource;
  layout: AgentWorkspaceLayout;
}): JSX.Element {
  const treeQuery = useAgentWorkspaceTree(agentId, source);
  // Two-column (full) always wants a file in its ever-present preview pane;
  // the compact drill-in must start at the file list (Cindy #task:1191 P1).
  const { selectedPath, setSelectedPath } = useWorkspaceSelection(
    treeQuery.data,
    { autoSelectFirstFile: layout === 'full' },
  );
  const fileQuery = useAgentWorkspaceFile(agentId, source, selectedPath);
  const qc = useQueryClient();
  const onRefresh = () =>
    qc.invalidateQueries({ queryKey: ['agents', agentId, 'workspace'] });

  return (
    <AgentWorkspaceBrowser
      treeQuery={treeQuery}
      fileQuery={fileQuery}
      selectedPath={selectedPath}
      onSelect={setSelectedPath}
      onRefresh={onRefresh}
      layout={layout}
    />
  );
}

interface AgentWorkspacePaneProps {
  agentId: string;
}

/**
 * #task:811 — the members-page view of the agent's **home** workspace files
 * (its L1 identity dir). A thin home preset over
 * `AgentWorkspaceContainer`: home source, wide two-column layout.
 *
 * No physical coordinate is named here on purpose: the home dir lives under
 * the agent's computer slot (`resolveComputerSlotPaths(...).agents` in
 * `@silverhand/shared`) and the renderer never builds a path. The flat
 * `~/.silverhand/agents/<id>/` shape is a migration source only.
 *
 * Why the browser speaks a virtual-path namespace (not the old categorised
 * snapshot): the old single-shot route baked the renderer's
 * `system_prompt`/`MEMORY`/`notes` buckets into the wire, locking the UI. The
 * tree/file pair speaks one path namespace rooted at the dir; new files just
 * appear in the tree, no wire churn.
 */
export function AgentWorkspacePane({
  agentId,
}: AgentWorkspacePaneProps): JSX.Element {
  return (
    <AgentWorkspaceContainer
      agentId={agentId}
      source={{ kind: 'home' }}
      layout="full"
    />
  );
}
