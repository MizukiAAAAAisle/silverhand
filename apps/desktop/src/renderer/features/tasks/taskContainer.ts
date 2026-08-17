/**
 * WHICH CONTAINER a conversation-side Tasks entry opens the board for
 * (#task:2041 Phase B).
 *
 * Before this, the entry lived in the titlebar and its context was assembled
 * from two nullable coordinates (`selectedWorkspace?.id`, `selectedChannelId`).
 * That shape can only describe one of the two placements the product now has: a
 * `direct_pair` has NO workspace, so the assembly's `workspaceId` was null and
 * the whole entry was gated off — which is why a DM had no Tasks entry at all
 * (shiki, dogfood 2026-08-17, item ③).
 *
 * So the entry's context is a DISCRIMINATED container identity, not a bag of
 * nullables:
 *
 *  - `workspace_channel` — a workspace, optionally focused on one of its
 *    channels. The channel may legitimately be absent (Activity's bare state),
 *    which is a narrowing question, not a missing container;
 *  - `direct_pair` — one direct line. Its conversation id is the whole
 *    coordinate; there is no workspace to carry and none is invented.
 *
 * PURE: no queries, no navigation. App resolves the facts, this decides.
 */

import {
  DEFAULT_TASK_FILTERS,
  type TaskFilters,
} from '@/features/tasks/taskFilters';

export type TaskBoardContainer =
  | {
      kind: 'workspace_channel';
      workspaceId: string;
      /** For the drawer's header label. Null while the name has not resolved —
       *  the container is still valid, only unlabelled. */
      workspaceName: string | null;
      /** The channel the entry was opened from, or null when the position has a
       *  workspace but no selected channel. */
      conversationId: string | null;
    }
  | {
      kind: 'direct_pair';
      conversationId: string;
      /** The counterpart's presented label, for the drawer's header. */
      label: string;
    };

/**
 * The container the current chat position belongs to, or `null` when this
 * position has none (no workspace and no open pair — bare `/chat`, a pre-mint
 * draft, the rails that are not conversations).
 *
 * The pair arm is checked FIRST and does not consult the workspace: a
 * `direct_pair` route carries no workspace by design (#task:2035), and a
 * workspace left over in App state from the previous selection is not this
 * conversation's container. Choosing by "whichever coordinate happens to be
 * non-null" is exactly how a DM would inherit a channel's board.
 */
export function taskContainerForPosition(position: {
  /** The open direct line, when the route is on one. */
  directPair: { conversationId: string; label: string } | null;
  /** The selected workspace, when the route is on the workspace arm. */
  workspace: { id: string; name: string | null } | null;
  /** The selected conversation within that workspace, if any. */
  conversationId: string | null;
}): TaskBoardContainer | null {
  if (position.directPair !== null) {
    return {
      kind: 'direct_pair',
      conversationId: position.directPair.conversationId,
      label: position.directPair.label,
    };
  }
  if (position.workspace !== null) {
    return {
      kind: 'workspace_channel',
      workspaceId: position.workspace.id,
      workspaceName: position.workspace.name,
      conversationId: position.conversationId,
    };
  }
  return null;
}

/**
 * The board narrowing a container opens with — also the drawer's reset target.
 *
 * Both arms narrow on axes the board read already has: the workspace arm keeps
 * its `workspace + channel` anchoring (#task:1432), and the pair arm narrows on
 * the conversation axis alone, which is what a single direct line IS on the wire
 * (`channel_id` = `t.conversation_id`). No pseudo-workspace is minted for it: the
 * pair has no workspace, and a filter that claimed one would either exclude the
 * very tasks it opened for (`t.workspace_id = ?` never matches NULL) or point at
 * a workspace the viewer did not open.
 *
 * The pair arm also sets the `direct_messages` container axis, so the drawer
 * opens ON the container it belongs to. That value is never produced by the
 * global scope dropdown — DM is not a selectable scope (contract §5) — so it
 * uniquely marks the LOCKED direct_pair context: the filter bar hides the scope
 * trigger and the channel picker entirely (there is no other scope to switch to,
 * and the trigger must not double as a placement display) and keeps only the
 * Assignee / From narrowing. The `channelId` is still set to the pair
 * conversation because that is the wire coordinate the board narrows on
 * (`channel_id` = `t.conversation_id`); it is not read back into a selectable
 * channel control here (#task:2041).
 */
export function taskContainerBaseline(
  container: TaskBoardContainer,
): TaskFilters {
  if (container.kind === 'direct_pair') {
    return {
      ...DEFAULT_TASK_FILTERS,
      container: 'direct_messages',
      channelId: container.conversationId,
    };
  }
  return {
    ...DEFAULT_TASK_FILTERS,
    workspaceId: container.workspaceId,
    channelId: container.conversationId,
  };
}

/** The container's name for the drawer header, or null when there is nothing
 *  resolved to show (the header then reads plain "Tasks" rather than an empty
 *  separator). */
export function taskContainerLabel(
  container: TaskBoardContainer,
): string | null {
  return container.kind === 'direct_pair'
    ? container.label
    : container.workspaceName;
}

/**
 * A container's VALUE as one string — the memo key for anything derived from it.
 *
 * The container is an identity, but it is assembled from query rows, and a
 * refetch that returns equal facts still returns fresh objects. A consumer that
 * keyed on the object's identity would therefore re-derive on every carrier
 * refetch; for the drawer's baseline that means re-applying the entry narrowing
 * and silently discarding the one the viewer set while it was open. Keying on
 * the value makes "the container changed" mean what it says.
 *
 * The label is part of the key: it is presented text, so a counterpart rename is
 * a real change to what the header shows.
 *
 * A JSON-encoded discriminated tuple: the arm tag is the first element so the
 * two arms can never collide on a shared id, and JSON escaping keeps a field
 * value that contains the delimiter (or a quote) from bleeding across a
 * boundary. Source-visible on purpose — an earlier version joined with a literal
 * NUL byte, which made Git and rg treat this TypeScript file as binary and broke
 * diff / grep / review.
 */
export function taskContainerKey(container: TaskBoardContainer): string {
  return container.kind === 'direct_pair'
    ? JSON.stringify(['pair', container.conversationId, container.label])
    : JSON.stringify([
        'ws',
        container.workspaceId,
        container.workspaceName ?? '',
        container.conversationId ?? '',
      ]);
}
