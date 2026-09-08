import { useState, type ReactElement, type JSX } from "react";
import { LogOut } from "lucide-react";
import { AppContextMenu, AppContextMenuItem } from "@/components/menus/AppContextMenu";
import { useWorkspaceMemberLists } from "@/features/workspaces/hooks";
import { canLeaveWorkspace } from "@/features/workspaces/workspace-permissions";
import { LeaveWorkspaceConfirmDialog } from "@/features/workspaces/LeaveWorkspaceConfirmDialog";
import { WorkspaceMuteMenuItem } from "./ChannelAttentionSurfaces";

/**
 * The container row's right-click menu — the container species' menu, mounted on
 * the tree's header rows (`WorkspaceRow`). Conversations carry their own menu
 * (`FavoriteRow` / `ChannelRow`), so this one has a single consumer today. It
 * stays a component because the structure — which capabilities appear, in what
 * order, and the "no capability ⇒ no menu at all" rule — is the part that must
 * not fork; callers supply only the resolved capabilities/handlers.
 *
 * NO STAR (shiki, 2026-08-08): containers have no star, so this menu has no such
 * item to gate. Star belongs to conversations and means exactly one thing —
 * MOVE the row into the global STARRED list. Container order is `f(mode, rank)`.
 * Why the container reading was retired: docs/app-layout.md §4.5 (#task:1900).
 */
export function WorkspaceContextMenu({
  trigger,
  muteWorkspaceId,
  leaveWorkspace,
}: {
  trigger: ReactElement;
  /** The workspace whose mute suppressor this row can flip, or `null` when the
   *  row has none: an agent space is structurally un-mutable (its conversations
   *  are directed-grade — there is no ambient traffic to silence, and the DB
   *  trigger forbids the row), and an archived workspace is not being listened to
   *  in the first place. Resolved by the caller. */
  muteWorkspaceId?: string | null;
  /** The workspace this row can self-leave, or `null` when Leave has no place
   *  here. The caller offers it on the SAME structural footing as mute (active
   *  regular workspace) so the menu shell always carries the always-present Mute
   *  item and can never render empty. The owner-rejection role gate is NOT the
   *  caller's job — it resolves lazily inside `WorkspaceLeaveMenuItem`, which
   *  hides itself for the owner (whose exit is Delete) or a still-loading role.
   *  Leaving an archived workspace routes through Settings instead. */
  leaveWorkspace?: { id: string; name: string } | null;
}): JSX.Element {
  const [confirmingLeave, setConfirmingLeave] = useState(false);

  // A row with no capability at all would render an empty menu, so it gets no
  // context menu.
  if (!muteWorkspaceId && !leaveWorkspace) return trigger;

  return (
    <>
      <AppContextMenu trigger={trigger}>
        {muteWorkspaceId ? <WorkspaceMuteMenuItem workspaceId={muteWorkspaceId} /> : null}
        {leaveWorkspace ? (
          <WorkspaceLeaveMenuItem
            workspaceId={leaveWorkspace.id}
            onSelect={() => setConfirmingLeave(true)}
          />
        ) : null}
      </AppContextMenu>
      {leaveWorkspace ? (
        <LeaveWorkspaceConfirmDialog
          open={confirmingLeave}
          onOpenChange={setConfirmingLeave}
          workspaceId={leaveWorkspace.id}
          workspaceName={leaveWorkspace.name}
        />
      ) : null}
    </>
  );
}

/**
 * The Leave item, self-contained like `WorkspaceMuteMenuItem`: it resolves the
 * viewer's role from the members query (shared cache with Settings) and gates
 * itself on `canLeaveWorkspace`. It renders NOTHING — not a disabled item —
 * when the role is owner (whose exit is Delete) or still loading: leave is
 * role-conditional, so hide-until-eligible is the fail-closed default (the
 * inverse of mute, which is always applicable and so shows disabled while
 * loading). The query fires only when the menu opens, since Radix mounts the
 * menu content lazily.
 */
function WorkspaceLeaveMenuItem({
  workspaceId,
  onSelect,
}: {
  workspaceId: string;
  onSelect: () => void;
}): JSX.Element | null {
  const { data } = useWorkspaceMemberLists(workspaceId);
  if (!canLeaveWorkspace(data?.viewerRole ?? null)) return null;

  return (
    <AppContextMenuItem icon={<LogOut className="size-3.5" />} onSelect={onSelect}>
      Leave workspace
    </AppContextMenuItem>
  );
}
