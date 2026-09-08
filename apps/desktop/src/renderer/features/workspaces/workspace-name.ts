export function agentSpaceRecognitionName(
  workspaceName: string,
  agent: { display_name?: string | null; name?: string | null } | undefined,
): string {
  return agent?.display_name?.trim() || agent?.name || workspaceName;
}
