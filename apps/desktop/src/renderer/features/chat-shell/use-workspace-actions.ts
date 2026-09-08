import { useState } from "react";
import { useNav } from "@/router";
import type { useWorkspaces } from "@/features/workspaces/hooks";
import {
  resolveWorkspaceSettingsTarget,
  workspaceDeletionDestination,
} from "@/features/workspaces/workspace-settings-target";

export function useWorkspaceActions(
  workspaces: NonNullable<ReturnType<typeof useWorkspaces>["data"]>,
  selectedWorkspaceId: string | null,
) {
  const nav = useNav();

  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);

  const [createChannelWorkspaceId, setCreateChannelWorkspaceId] = useState<string | null>(null);

  const [workspaceSettingsId, setWorkspaceSettingsId] = useState<string | null>(null);

  const settingsWorkspace = resolveWorkspaceSettingsTarget(workspaces, workspaceSettingsId);

  const createChannelWorkspace =
    createChannelWorkspaceId === null
      ? null
      : (workspaces.find((w) => w.id === createChannelWorkspaceId) ?? null);

  const handleWorkspaceDeleted = (deletedId: string): void => {
    const destination = workspaceDeletionDestination(workspaces, deletedId, selectedWorkspaceId);
    switch (destination.kind) {
      case "stay":
        return;
      case "workspace":
        nav.toWorkspace(destination.workspaceId);
        return;
      case "chat":
        nav.toChat();
        return;
    }
  };

  return {
    createWorkspaceOpen,
    setCreateWorkspaceOpen,
    createChannelWorkspaceId,
    setCreateChannelWorkspaceId,
    workspaceSettingsId,
    setWorkspaceSettingsId,
    settingsWorkspace,
    createChannelWorkspace,
    handleWorkspaceDeleted,
  };
}
