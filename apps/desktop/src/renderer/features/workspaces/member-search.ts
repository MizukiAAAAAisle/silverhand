import type { AgentDto, UserDto } from '@silverhand/shared';

export type MemberCandidate =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'human'; user: UserDto };

export interface MemberCandidateGroup {
  /** Uppercase section label, e.g. `AGENTS`. */
  label: string;
  /** Eligible candidates, already narrowed by the caller's rules. */
  items: readonly MemberCandidate[];
}

export function candidateKey(c: MemberCandidate): string {
  return c.kind === 'agent' ? `agent:${c.agent.id}` : `human:${c.user.id}`;
}

export function candidateDisplayName(c: MemberCandidate): string {
  return c.kind === 'agent'
    ? c.agent.display_name || c.agent.name
    : c.user.display_name || c.user.name;
}

export function candidateHandle(c: MemberCandidate): string {
  return c.kind === 'agent' ? c.agent.name : c.user.name;
}

/**
 * Normalize a member-search query to what the stored fields look like.
 *
 * The picker advertises "search by name or @handle", and `@handle` is how a
 * handle is written everywhere else in the product — mentions, CLI flags,
 * chat. But no field stores the sigil, so a raw `includes` would make the
 * advertised spelling match nothing. One leading `@` is therefore stripped.
 *
 * Only one: `@@x` keeps its second `@` and simply finds nothing, which is
 * the honest answer for a handle that cannot exist. A bare `@` normalizes to
 * the empty string and so reads as "no query yet" — the full list stays up
 * while the user types the rest of the handle, instead of blinking to "no
 * matches" on the first keystroke.
 */
export function normalizeMemberQuery(query: string): string {
  const trimmed = query.trim();
  const withoutSigil = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return withoutSigil.toLowerCase();
}

/**
 * Substring match on handle and display name — same semantics as the
 * composer's mention picker so search behaves the same everywhere. `query`
 * must already be through `normalizeMemberQuery`; an empty query matches
 * everything, so callers can skip filtering entirely.
 */
export function matchesCandidate(c: MemberCandidate, query: string): boolean {
  if (!query) return true;
  return (
    candidateHandle(c).toLowerCase().includes(query)
    || candidateDisplayName(c).toLowerCase().includes(query)
  );
}
