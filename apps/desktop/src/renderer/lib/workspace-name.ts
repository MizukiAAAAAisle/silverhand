/**
 * The one workspace label that is NOT the workspace's own name.
 *
 * This module used to hold four: `stripDmPrefix`, `agentSpaceLabel` and
 * `workspaceDisplayName` existed because `workspaceToListItem` minted an agent
 * space's name with a `dm-` prefix, so every surface had to strip it back off
 * (#task:1156 collapsed four drifted copies of that stripping into one).
 * #task:2066 retired the prefix at the mint, which made all three pure identity
 * functions on `workspace.name` — a wrapper that reads like a decision but makes
 * none, and whose real effect was to imply that rendering a workspace name
 * directly was the unsafe path. Deleted; pickers, filters, and result rows now
 * render `workspace.name`.
 *
 * Why that is enough for an agent space: its stored name IS the bound agent's
 * handle (`insertAgentHome` sets `name = agent.name`), and neither side can
 * drift — an agent's handle is immutable (`agent-repo.update` writes
 * `display_name`, never `name`) and a rename cannot reach an agent-home row
 * (`updateMutableMetadata`'s NAME-writing branches match only containers with no
 * owner agent; the description-only branch carries no such guard, and needs
 * none — it writes no part of the naming namespace).
 *
 * WHY NO `@` ANYWHERE (#task:2044, shiki 2026-08-17): an agent-home workspace is
 * an AGENT SPACE, and since #task:2035 the product also has real direct messages
 * (DirectPair) sitting right next to it in the rail. `@<agent>` and "DM" belong
 * to the pair; keeping them on the agent space is what made one name mean two
 * things in a single dropdown. The agent space reads as the agent's NAME on
 * every surface — the recognition form the rail and titlebar have used since
 * #task:1768.
 *
 * Still deliberately untouched: the rail section's `persistId="dm"` is storage
 * identity, not copy — renaming it would silently reset every user's collapse
 * choice. (`dm_agent_id`, the other name on that list, is gone: #task:2078 put the
 * field back on its one true name, `owner_agent_id`.)
 */

/**
 * Recognition label for an agent space when the bound agent is RESOLVED: its
 * display name, which the workspace name cannot supply (#task:1768 — the drift
 * shiki caught was the rail showing the display name while the titlebar showed
 * the handle). This is the one place a label still beats `workspace.name`,
 * because `display_name` is mutable while the handle baked into the workspace
 * name is not. Falls back to the agent's handle, then to the workspace name.
 */
export function agentSpaceRecognitionName(
  workspaceName: string,
  agent: { display_name?: string | null; name?: string | null } | undefined,
): string {
  return agent?.display_name?.trim() || agent?.name || workspaceName;
}
