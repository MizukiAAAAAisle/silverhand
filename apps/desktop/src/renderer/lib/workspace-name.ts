/**
 * Canonical workspace display-name helpers — ONE source so every picker,
 * filter, and result row renders a workspace the same way (#task:1156).
 *
 * Before this, four copies had drifted: the rail's `displayDmName`, the
 * message-search filter's `formatWorkspaceName`, and the archived-channel
 * filter's `dmScopeLabel` / `archivedRowWorkspaceLabel` — two said `@<agent>`,
 * one said `DM <agent>`. Same filter concept, different labels. Collapsed here.
 *
 * The workspace RAIL no longer uses these: it shows a DM as the agent's raw
 * display name, no `@` (`WorkspacesPanel`, #task:1768) — the rail is a
 * recognition surface, while these helpers serve handle-ref surfaces (pickers,
 * filters, search results) that keep `@<agent>`.
 *
 * The subtlety the `stripDmPrefix` covers: a DM workspace surfaces under two
 * name shapes. The `WorkspaceListItem` carries a UI `dm-` prefix
 * (`workspaceToListItem`), e.g. `dm-Norman`; the backend archived aggregate
 * returns the bare agent name (`insertAgentHome` sets `name = agent.name`),
 * e.g. `Norman`. Both normalize to the same agent handle.
 */

/** Strip the internal `dm-` list prefix when present; bare names pass through.
 *  Only a leading `dm-` is stripped, never an interior/partial match. */
export function stripDmPrefix(name: string): string {
  return name.startsWith('dm-') ? name.slice(3) : name;
}

/** Canonical DM workspace label: `@<agent>`. A DM is 1:1 with an agent, so it
 *  reads as a handle everywhere it appears. */
export function dmWorkspaceLabel(name: string): string {
  return `@${stripDmPrefix(name)}`;
}

/** Display name for a workspace in any picker / filter / result row: the bare
 *  name for a regular workspace, `@<agent>` for a DM. */
export function workspaceDisplayName(workspace: {
  name: string;
  kind: 'regular' | 'dm';
}): string {
  return workspace.kind === 'dm' ? dmWorkspaceLabel(workspace.name) : workspace.name;
}
