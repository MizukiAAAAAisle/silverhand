export function pickWorkspaceToRestore(
  workspaces: readonly { id: string }[],
  rememberedId: string | null,
): string | null {
  if (workspaces.length === 0) return null;
  if (rememberedId && workspaces.some((w) => w.id === rememberedId)) {
    return rememberedId;
  }
  return workspaces[0]!.id;
}
