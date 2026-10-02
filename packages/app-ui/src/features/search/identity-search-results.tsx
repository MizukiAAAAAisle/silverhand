import { useAgentAvatarObjectUrls } from "@/features/agents/hooks/avatar-hooks";
import { useDirectPairs } from "@/features/direct-pairs/hooks";
import { useNav } from "@/router";
import { SearchResultItem } from "@/features/search/search-result-item";
import type { AgentDto, SearchIdentities } from "@silverhand/shared";

const EMPTY_AVATARS: ReadonlyMap<string, string | null> = new Map();
const NO_AGENTS: ReadonlyMap<string, AgentDto> = new Map();

export function IdentitySearchResults({ identities }: { identities: SearchIdentities }) {
  const nav = useNav();
  const pairs = useDirectPairs();
  const humanAvatars = useAgentAvatarObjectUrls(identities.humans.results);
  const agentAvatars = useAgentAvatarObjectUrls(identities.agents.results);
  // 方向 B: one "Human & Agents" group (the avatar already distinguishes kind).
  // Humans lead, then agents.
  const candidates = [...identities.humans.results, ...identities.agents.results];
  const total = identities.humans.total + identities.agents.total;
  const truncated = identities.humans.truncated || identities.agents.truncated;

  if (candidates.length === 0) return null;

  return (
    <section className="mb-5" aria-label="Human & Agents">
      <header className="mb-2 flex items-center gap-2 px-1 text-(length:--text-meta) font-medium uppercase leading-none tracking-wider text-text-muted">
        <span>Human &amp; Agents</span>
        <span>{total}</span>
      </header>
      <ul className="space-y-2">
        {candidates.map((candidate) => {
          const target = { kind: candidate.kind, id: candidate.id };
          return (
            <li key={`${candidate.kind}:${candidate.id}`}>
              <SearchResultItem
                item={{ kind: "identity", candidate }}
                query=""
                agentsById={NO_AGENTS}
                ownerAgentAvatarUrls={EMPTY_AVATARS}
                agentAvatarUrls={agentAvatars}
                userAvatarUrls={humanAvatars}
                onClick={() => {
                  const existing = pairs.find(
                    (pair) =>
                      pair.counterpart.kind === target.kind && pair.counterpart.id === target.id,
                  );
                  if (existing) nav.toDirect(existing.conversation_id);
                  else nav.toDirectDraft(target);
                }}
              />
            </li>
          );
        })}
      </ul>
      {truncated ? (
        <p className="mt-2 text-xs text-text-muted">
          Showing {candidates.length} of {total}. Refine the name to find more.
        </p>
      ) : null}
    </section>
  );
}
