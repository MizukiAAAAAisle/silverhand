/**
 * WHICH CONTAINER a conversation-side Tasks tab opens the board for
 * (#task:2041 Phase B).
 *
 * A conversation's Tasks surface must describe one of the two placements the
 * product has, and a bag of nullable coordinates (`workspaceId?`,
 * `conversationId?`) can only describe one: a `direct_pair` has NO workspace, so
 * a null `workspaceId` used to gate the entry off entirely — which is why a DM
 * had no Tasks entry at all (shiki, dogfood 2026-08-17, item ③).
 *
 * So the context is a DISCRIMINATED container identity, not a bag of nullables:
 *
 *  - `workspace_channel` — a workspace, optionally focused on one of its
 *    channels. The channel may legitimately be absent (Activity's bare state),
 *    which is a narrowing question, not a missing container;
 *  - `direct_pair` — one direct line. Its conversation id is the whole
 *    coordinate; there is no workspace to carry and none is invented.
 *
 * PURE: no queries, no navigation. The caller resolves the facts, this decides.
 */

import { DEFAULT_TASK_FILTERS, type TaskFilters } from "@/features/task-shell/model/task-filters";
import type { ConversationPaneMode } from "@/features/conversations/pane-mode";

export type TaskBoardContainer =
  | {
      kind: "workspace_channel";
      workspaceId: string;
      /** The channel the tab was opened from, or null when the position has a
       *  workspace but no selected channel. */
      conversationId: string | null;
    }
  | {
      kind: "direct_pair";
      conversationId: string;
    };

/**
 * The Tasks-board container a conversation PANE belongs to, derived from the one
 * placement projection every other affordance reads (`ConversationPaneMode`) —
 * never re-sniffed from `workspace_id`.
 *
 * Returns `null` for exactly the positions that HAVE no board container, and this
 * `null` is the SOLE gate for the conversation's Tasks affordance: the tab strip
 * only offers a Tasks tab when a container forms, so a placement that cannot form
 * one shows no Tasks surface at all (rather than a selectable tab that reveals
 * Chat beneath it). The two null cases:
 *
 *  - `unsupported` — a placement this build has no mode for (an older renderer
 *    against a newer server). Fails safe, same as {@link paneCapabilities}.
 *  - `workspace_channel` with NO workspace id — an old/corrupt carrier. An
 *    empty/absent id is not an identity, and a board must not fetch a filter for a
 *    workspace that does not exist. FAIL-CLOSED to `null`, not a container anchored
 *    on `''`.
 *
 * A `direct_message` always forms a `direct_pair` (its conversation id is the
 * whole coordinate; no workspace is invented). PURE: no queries, no navigation.
 */
export function taskBoardContainerForPane(
  paneMode: ConversationPaneMode,
  facts: {
    conversationId: string;
  },
): TaskBoardContainer | null {
  switch (paneMode.kind) {
    case "direct_message":
      return {
        kind: "direct_pair",
        conversationId: facts.conversationId,
      };
    case "workspace_channel":
      return paneMode.workspaceId
        ? {
            kind: "workspace_channel",
            workspaceId: paneMode.workspaceId,
            conversationId: facts.conversationId,
          }
        : null;
    case "unsupported":
      return null;
  }
}

/**
 * The board narrowing a container opens with — also the surface's reset target.
 *
 * Both arms narrow on axes the board read already has: the workspace arm keeps
 * its `workspace + channel` anchoring (#task:1432), and the pair arm narrows on
 * the conversation axis alone, which is what a single direct line IS on the wire
 * (`channel_id` = `t.conversation_id`). No pseudo-workspace is minted for it: the
 * pair has no workspace, and a filter that claimed one would either exclude the
 * very tasks it opened for (`t.workspace_id = ?` never matches NULL) or point at
 * a workspace the viewer did not open.
 *
 * The pair arm also sets the `direct_messages` container axis, so the board opens
 * ON the container it belongs to. That value is never produced by the global
 * scope dropdown — DM is not a selectable scope (contract §5) — so it uniquely
 * marks the LOCKED direct_pair context: the filter bar hides the scope trigger
 * and the channel picker entirely (there is no other scope to switch to, and the
 * trigger must not double as a placement display) and keeps only the
 * Assignee / From narrowing. The `channelId` is still set to the pair
 * conversation because that is the wire coordinate the board narrows on
 * (`channel_id` = `t.conversation_id`); it is not read back into a selectable
 * channel control here (#task:2041).
 */
export function taskContainerBaseline(container: TaskBoardContainer): TaskFilters {
  if (container.kind === "direct_pair") {
    return {
      ...DEFAULT_TASK_FILTERS,
      container: "direct_messages",
      channelId: container.conversationId,
    };
  }
  return {
    ...DEFAULT_TASK_FILTERS,
    workspaceId: container.workspaceId,
    channelId: container.conversationId,
  };
}

/**
 * A container's VALUE as one string — the memo key for anything derived from it.
 *
 * The container is an identity, but it is assembled from query rows, and a
 * refetch that returns equal facts still returns fresh objects. A consumer that
 * keyed on the object's identity would therefore re-derive on every carrier
 * refetch; for the tab's baseline that means re-applying the entry narrowing
 * and silently discarding the one the viewer set while it was open. Keying on
 * the value makes "the container changed" mean what it says.
 *
 * The key is the identity COORDINATE only — no presented text. A pair is its
 * conversation id; a workspace arm is its workspace id + focused channel. A
 * counterpart or workspace RENAME is not an identity change, so it must not
 * reset the tab's filters (there is no board-header consumer of the name since
 * the drawer header was removed, #task:2124).
 *
 * A JSON-encoded discriminated tuple: the arm tag is the first element so the
 * two arms can never collide on a shared id, and JSON escaping keeps a field
 * value that contains the delimiter (or a quote) from bleeding across a
 * boundary. Source-visible on purpose — an earlier version joined with a literal
 * NUL byte, which made Git and rg treat this TypeScript file as binary and broke
 * diff / grep / review.
 */
export function taskContainerKey(container: TaskBoardContainer): string {
  return container.kind === "direct_pair"
    ? JSON.stringify(["pair", container.conversationId])
    : JSON.stringify(["ws", container.workspaceId, container.conversationId ?? ""]);
}
