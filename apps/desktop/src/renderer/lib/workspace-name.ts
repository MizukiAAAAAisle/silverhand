/**
 * Canonical workspace display-name helpers — ONE source so every picker,
 * filter, and result row renders a workspace the same way (#task:1156).
 *
 * Before this, four copies had drifted: the rail's `displayDmName`, the
 * message-search filter's `formatWorkspaceName`, and the archived-channel
 * filter's `dmScopeLabel` / `archivedRowWorkspaceLabel` — two said `@<agent>`,
 * one said `DM <agent>`. Same filter concept, different labels. Collapsed here.
 *
 * WHY NO `@` ANYWHERE ANYMORE (#task:2044, shiki 2026-08-17): an agent-home
 * workspace is an AGENT SPACE, and since #task:2035 the product also has real
 * direct messages (DirectPair) sitting right next to it in the rail. `@<agent>`
 * and "DM" now belong to the pair; keeping them on the agent space is what made
 * one name mean two different things in a single dropdown. So the agent space
 * reads as the agent's NAME on every surface — the recognition form the rail and
 * titlebar have used since #task:1768 — and this file no longer has a handle-ref
 * variant to pick by accident.
 *
 * The subtlety the `stripDmPrefix` covers: an agent space surfaces under two
 * name shapes. The `WorkspaceListItem` carries a UI `dm-` prefix
 * (`workspaceToListItem`), e.g. `dm-Norman`; the backend archived aggregate
 * returns the bare agent name (`insertAgentHome` sets `name = agent.name`),
 * e.g. `Norman`. Both normalize to the same agent name.
 *
 * The internal identifiers (`kind: 'dm'`, the `dm-` prefix, `dm_agent_id`, the
 * rail section's `persistId="dm"`) are deliberately untouched: they are storage
 * and wire identity, not copy, and renaming `persistId` would silently reset
 * every user's collapse choice.
 */

/** Strip the internal `dm-` list prefix when present; bare names pass through.
 *  Only a leading `dm-` is stripped, never an interior/partial match. */
export function stripDmPrefix(name: string): string {
  return name.startsWith('dm-') ? name.slice(3) : name;
}

/** Canonical agent-space label: the bound agent's name, no `@` and no prefix.
 *  An agent space is 1:1 with an agent, so it reads as that agent everywhere —
 *  the handle form is reserved for the direct pair (#task:2044). */
export function agentSpaceLabel(name: string): string {
  return stripDmPrefix(name);
}

/** Display name for a workspace in any picker / filter / result row: the bare
 *  name for a regular workspace, the agent's name for an agent space. */
export function workspaceDisplayName(workspace: {
  name: string;
  kind: 'regular' | 'dm';
}): string {
  return workspace.kind === 'dm' ? agentSpaceLabel(workspace.name) : workspace.name;
}

/** Recognition label for an agent space when the bound agent is resolved: its
 *  DISPLAY name, which `agentSpaceLabel` cannot reach from a workspace name
 *  alone (#task:1768 — the drift shiki caught was the rail showing the display
 *  name while the titlebar showed the handle). Falls back to the agent's handle,
 *  then to the bare workspace name. */
export function dmRecognitionName(
  workspaceName: string,
  agent: { display_name?: string | null; name?: string | null } | undefined,
): string {
  return agent?.display_name?.trim() || agent?.name || stripDmPrefix(workspaceName);
}
