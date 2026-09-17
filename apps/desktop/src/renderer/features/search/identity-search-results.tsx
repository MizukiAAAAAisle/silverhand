import { CollectionItemCard } from "@/components/layout/collection-item-card";
import { AgentAvatar } from "@/components/agent-avatar";
import { UserAvatar } from "@/components/user-avatar";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useDirectPairs } from "@/features/direct-pairs/hooks";
import { useNav } from "@/router";
import {
  candidateDisplayName,
  candidateHandle,
  candidateKey,
} from "@/features/workspaces/member-search";
import type { IdentitySearchGroup } from "./identity-results";

export function IdentitySearchResults({ groups }: { groups: IdentitySearchGroup[] }) {
  const nav = useNav();
  const pairs = useDirectPairs();
  const humanAvatars = useAgentAvatarObjectUrls(
    groups.flatMap((group) => group.items.flatMap((c) => (c.kind === "human" ? [c.user] : []))),
  );
  const agentAvatars = useAgentAvatarObjectUrls(
    groups.flatMap((group) => group.items.flatMap((c) => (c.kind === "agent" ? [c.agent] : []))),
  );

  return (
    <div className="space-y-5">
      {groups
        .filter((group) => group.total > 0)
        .map((group) => (
          <section key={group.kind} className="mb-5" aria-label={group.label}>
            <header className="mb-2 flex items-center gap-2 px-1 text-(length:--text-meta) font-medium uppercase leading-none tracking-wider text-text-muted">
              <span>{group.label}</span>
              <span>{group.total}</span>
            </header>
            <ul className="space-y-2">
              {group.items.map((candidate) => {
                const identity = candidate.kind === "human" ? candidate.user : candidate.agent;
                const target = { kind: candidate.kind, id: identity.id };
                return (
                  <li key={candidateKey(candidate)}>
                    <CollectionItemCard
                      as="button"
                      type="button"
                      className="flex w-full items-center gap-3 px-3 py-3 text-left"
                      onClick={() => {
                        const existing = pairs.find(
                          (pair) =>
                            pair.counterpart.kind === target.kind &&
                            pair.counterpart.id === target.id,
                        );
                        if (existing) nav.toDirect(existing.conversation_id);
                        else nav.toDirectDraft(target);
                      }}
                    >
                      {candidate.kind === "human" ? (
                        <UserAvatar size={28} avatarObjectUrl={humanAvatars.get(identity.id)} />
                      ) : (
                        <AgentAvatar
                          size={28}
                          runtime={candidate.agent.runtime}
                          avatarObjectUrl={agentAvatars.get(identity.id)}
                        />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-text-primary">
                          {candidateDisplayName(candidate)}
                        </span>
                        <span className="block truncate text-xs text-text-muted">
                          @{candidateHandle(candidate)}
                        </span>
                      </span>
                    </CollectionItemCard>
                  </li>
                );
              })}
            </ul>
            {group.total > group.items.length ? (
              <p className="mt-2 text-xs text-text-muted">
                Showing {group.items.length} of {group.total}. Refine the name to find more.
              </p>
            ) : null}
          </section>
        ))}
    </div>
  );
}
