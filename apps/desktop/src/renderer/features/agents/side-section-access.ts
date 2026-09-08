export type AgentSideSection = "activity" | "profile" | "workspace" | "schedules";

export function visibleAgentSideSections(canViewFiles: boolean, canManageSchedules: boolean) {
  const sections: AgentSideSection[] = ["activity", "profile"];

  if (canViewFiles) {
    sections.push("workspace");
  }

  if (canManageSchedules) {
    sections.push("schedules");
  }

  return sections;
}

export function resolveAgentSideSection(
  selected: AgentSideSection,
  visible: readonly AgentSideSection[],
): AgentSideSection {
  return visible.includes(selected) ? selected : "activity";
}
