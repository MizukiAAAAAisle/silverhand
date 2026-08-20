import type { SortGroup } from '@silverhand/shared';
import { isAgentSpace, type WorkspaceOwnership } from './workspace-ownership';

/**
 * The workspace rail's persisted sort scope — the renderer's ONLY remaining
 * container word, and the reason this module still exists.
 *
 * It used to be `workspace-kind.ts` and own the renderer's container-kind
 * vocabulary: a decoder for the stored word (deleted with its last feeder,
 * #task:2069/#task:2070) and a `WorkspaceUiKind` alias of the published union
 * (deleted with ITS last consumer, #task:2078 — the container-identity question
 * now lives on the ownership axis, `./workspace-ownership.ts`). What is left is
 * not a kind at all: it is a storage token, which is exactly why it must not be
 * filed next to the axis it used to look like.
 */

/**
 * The rail's hard group for one container.
 *
 * The workspace rail is one sortable list (`list_key='workspaces'`) whose groups
 * ARE `SortGroup` values: the group travels to the server both as the mode scope
 * (`user_list_sort_mode.scope`) and as the manual-rank group
 * (`POST .../reorder`).
 *
 * **Terminal state since #task:2045 Delta 4** (this was a bridge that mapped an
 * agent space to the legacy `'dm'` token): the token is now `'agent_space'` on all
 * three carriers at once — `SortGroupSchema`, the backend's rail grouping, and the
 * stored `user_list_sort_mode.scope` rows (migration v86). The rename was safe to
 * do in place rather than as a widened both-spellings union because API epoch 4 is
 * unreleased; a union would have made two tokens mean one group forever.
 *
 * The old token's real hazard, for whoever revisits this: the rail's two sort
 * tables are keyed differently (`user_list_sort_mode` by SCOPE,
 * `user_sort_entry` by ENTITY), so renaming the token without migrating the rows
 * silently resets the mode while the manual ranks survive — "my order is still
 * there but no longer applied". Any future rename of a `SortGroup` member has to
 * carry the same migration.
 *
 * Unrelated collision, for whoever greps `'dm'`: that word still names a real
 * DirectPair CONVERSATION (`ConversationGlyph`, unread, pane descriptors) and the
 * rail's localStorage collapse key (`persistId="dm"`, #task:2035 — a storage
 * identity, deliberately NOT renamed by Delta 4). Neither is a container word.
 */
export function railSortGroupOf(workspace: WorkspaceOwnership): RailSortGroup {
  return isAgentSpace(workspace) ? 'agent_space' : 'regular';
}

/** The rail's two group keys, as the SUBSET of `SortGroup` they must remain. Via
 *  `Extract` rather than spelled out, so any future rename of either member lands
 *  here as a type error (the token leaves `SortGroupSchema` ⇒ this stops
 *  containing it ⇒ `railSortGroupOf`'s body no longer typechecks) instead of as a
 *  silent divergence between the renderer and the stored rows. That tripwire is
 *  what turned Delta 4 into a compiler-enumerated change. */
export type RailSortGroup = Extract<SortGroup, 'agent_space' | 'regular'>;
