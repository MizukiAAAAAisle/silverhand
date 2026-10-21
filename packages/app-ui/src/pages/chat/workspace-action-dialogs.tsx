import { useNav } from "@/router";
import { CreateWorkspaceDialog } from "@/features/workspaces/create-workspace-dialog";
import { CreateChannelDialog } from "@/features/workspaces/create-channel-dialog";
import { WorkspaceSettingsDialog } from "@/features/workspaces/workspace-settings-dialog";
import { workspaceCapabilities } from "@/features/workspaces/workspace-capabilities";
import type { WorkspaceActions } from "./use-workspace-actions";

/** The dialogs the Chats sidebar and its panels open. */
export function WorkspaceActionDialogs({ actions }: { actions: WorkspaceActions }): JSX.Element {
  const nav = useNav();

  return (
    <>
      <CreateWorkspaceDialog
        open={actions.createWorkspaceOpen}
        onOpenChange={actions.setCreateWorkspaceOpen}
        onCreated={({ workspaceId, channelId }) => nav.toChannel(workspaceId, channelId)}
      />
      <CreateChannelDialog
        open={actions.createChannelWorkspaceId !== null}
        onOpenChange={(open) => {
          if (!open) {
            actions.setCreateChannelWorkspaceId(null);
          }
        }}
        workspaceId={actions.createChannelWorkspace?.id ?? null}
        capabilities={workspaceCapabilities(actions.createChannelWorkspace)}
        onCreated={(id) => {
          if (actions.createChannelWorkspaceId) {
            nav.toChannel(actions.createChannelWorkspaceId, id);
          }
        }}
      />
      <WorkspaceSettingsDialog
        key={actions.workspaceSettingsId ?? "closed"}
        open={actions.workspaceSettingsId !== null && actions.settingsWorkspace !== null}
        onOpenChange={(open) => {
          if (!open) {
            actions.setWorkspaceSettingsId(null);
          }
        }}
        workspaceId={actions.settingsWorkspace?.id ?? null}
        workspaceName={actions.settingsWorkspace?.name ?? null}
        capabilities={workspaceCapabilities(actions.settingsWorkspace)}
        archivedAt={actions.settingsWorkspace?.archived_at ?? null}
        onDeleted={() => {
          if (actions.workspaceSettingsId) {
            actions.handleWorkspaceDeleted(actions.workspaceSettingsId);
          }
        }}
      />
    </>
  );
}
