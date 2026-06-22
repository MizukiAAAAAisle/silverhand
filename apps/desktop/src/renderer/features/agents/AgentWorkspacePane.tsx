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
 * `layout` + `header`, serves both views so they can't drift:
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
  header,
}: {
  agentId: string;
  source: AgentWorkspaceSource;
  layout: AgentWorkspaceLayout;
  header: React.ReactNode;
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
      header={header}
    />
  );
}

interface AgentWorkspacePaneProps {
  agentId: string;
  /** The agent's host_id, used to gate the "Reveal in Finder" affordance.
   *  We don't have an absolute fs path on the wire anymore (the daemon
   *  owns paths, the wire only carries virtual ones); the gate stays as
   *  a visibility hint for the local-host case. */
  hostId: string;
  /** True when the user owns the agent's host AND that host is the
   *  local desktop session — only then can `showItemInFolder` reach a
   *  meaningful absolute path. We don't currently surface a "reveal"
   *  for the new pane (no absolute path on the wire); kept on the prop
   *  surface for forward-compat. */
  canRevealPath: boolean;
}

/**
 * #task:811 — the members-page view of the agent's **home** workspace files
 * (`~/.silverhand/agents/<id>/`). A thin home preset over
 * `AgentWorkspaceContainer`: home source, wide two-column layout.
 *
 * Why the browser speaks a virtual-path namespace (not the old categorised
 * snapshot): the old single-shot route baked the renderer's
 * `system_prompt`/`MEMORY`/`notes` buckets into the wire, locking the UI. The
 * tree/file pair speaks one path namespace rooted at the dir; new files just
 * appear in the tree, no wire churn.
 */
export function AgentWorkspacePane({
  agentId,
  // hostId / canRevealPath kept on the surface for forward-compat — an
  // absolute-path "reveal" affordance can come back when the wire grows a
  // "where on disk is this?" field. For now the daemon owns paths and the
  // renderer never sees them.
  hostId: _hostId,
  canRevealPath: _canRevealPath,
}: AgentWorkspacePaneProps): JSX.Element {
  return (
    <AgentWorkspaceContainer
      agentId={agentId}
      source={{ kind: 'home' }}
      layout="full"
      header={
        <>
          Agent home — <span className="font-mono">system_prompt.md</span> is
          global identity; <span className="font-mono">MEMORY.md</span> +{' '}
          <span className="font-mono">notes/</span> are this workspace's memory.
        </>
      }
    />
  );
}
