import type { AgentDto, UserDto } from "@silverhand/shared";
import {
  candidateDisplayName,
  candidateKey,
  matchesCandidate,
  normalizeMemberQuery,
  type MemberCandidate,
} from "@/features/workspaces/member-search";

export interface IdentitySearchGroup {
  kind: "human" | "agent";
  label: string;
  items: MemberCandidate[];
  total: number;
}

/** Content coordinates do not describe identities; never silently ignore them. */
export function includesIdentityResults(filter: {
  workspace: string;
  sender: string;
  time: string;
}) {
  return filter.workspace === "all" && filter.sender === "all" && filter.time === "all";
}

/** Inputs are the existing server-authorized directories, never message authors. */
export function identitySearchGroups(
  query: string,
  users: readonly UserDto[],
  agents: readonly AgentDto[],
  viewerId: string | null,
): IdentitySearchGroup[] {
  const needle = normalizeMemberQuery(query);
  if (!needle || !viewerId) return [];
  const candidates: MemberCandidate[] = [
    ...users
      .filter((user) => user.id !== viewerId)
      .map((user): MemberCandidate => ({ kind: "human", user })),
    ...agents
      .filter((agent) => agent.session_scope === "agent")
      .map((agent): MemberCandidate => ({ kind: "agent", agent })),
  ];
  const matches = candidates.filter((candidate) => matchesCandidate(candidate, needle));
  matches.sort(
    (a, b) =>
      candidateDisplayName(a).localeCompare(candidateDisplayName(b)) ||
      candidateKey(a).localeCompare(candidateKey(b)),
  );
  return (["human", "agent"] as const).map((kind) => {
    const rows = matches.filter((candidate) => candidate.kind === kind);
    return {
      kind,
      label: kind === "human" ? "Humans" : "Agents",
      items: rows.slice(0, 20),
      total: rows.length,
    };
  });
}
