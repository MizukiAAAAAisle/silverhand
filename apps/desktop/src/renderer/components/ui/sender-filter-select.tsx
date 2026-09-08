import { useMemo } from "react";
import * as Select from "@radix-ui/react-select";
import { ChevronDown, Search as SearchIcon } from "lucide-react";
import type { AgentDto, UserDto } from "@silverhand/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { AuthorAvatarView } from "@/components/chat/author-avatar-view";
import { UNRESOLVED_AGENT_LABEL } from "@/components/chat/author-presentation";
import { useAgentAvatarObjectUrls } from "@/features/agent-shell/hooks/avatar-hooks";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import {
  FilterSelectItem,
  FILTER_SELECT_TRIGGER_CLASS,
  FILTER_SELECT_CONTENT_CLASS,
} from "@/components/ui/filter-select";
import { formatUserDisplayName, getCurrentUserId, type UserNameResolver } from "@/lib/current-user";

/**
 * Shared "filter by sender" dropdown — one control, one item design: Humans
 * (viewer first) then Agents, each row wearing its own identity primitive
 * (`UserAvatar` / `AgentAvatar`). SearchPanel and SavedListView both render
 * through THIS rather than each keeping a private copy (#task:2062; Search had
 * the original, Saved would have been the second).
 *
 * The control does NOT fetch its own options: callers pass `agents` / `users` /
 * `userResolver`. The option domain is a product decision per surface (Saved's
 * comes from the server directory read faces, shiki 2026-08-18 "服务端"), and a
 * self-fetching control would freeze all callers onto one domain — the
 * per-channel actor list in `ChannelAttachmentsPanel` is a THIRD domain, so it
 * deliberately keeps its own value type and is not merged here.
 *
 * Single-select this version (shiki 2026-08-18 "这版先单选"), so the value is one
 * of three shapes and `'all'` is a renderer-only sentinel: on the wire the two
 * scoped shapes become two mutually-exclusive optionals (`user_id` / `agent_id`)
 * and `'all'` sends neither — "no sender filter" and "filtered to someone" stay
 * structurally distinguishable.
 */
export type SenderFilterValue = "all" | `user:${string}` | `agent:${string}`;

/** Wire params for the selection — `{}` for the "all" sentinel. */
export function parseSenderFilter(value: SenderFilterValue): {
  userId?: string;
  agentId?: string;
} {
  if (value.startsWith("user:")) return { userId: value.slice("user:".length) };
  if (value.startsWith("agent:")) return { agentId: value.slice("agent:".length) };
  return {};
}

/**
 * URL round-trip for the sender axis (`?sender=agent:<id>`, #task:2114). The
 * param IS the value encoding — one vocabulary, so a link and a picked option
 * can never mean different things — and it lives here rather than in the router
 * because this module owns the union: the router only knows "present and
 * non-empty" and hands the raw string to {@link senderFilterFromParam}.
 *
 * `'all'` has no param (absence IS "no sender filter", mirroring the wire
 * shape above), and an unparseable value yields `null` so a hand-edited or
 * stale link degrades to "no sender filter" instead of a dead selection.
 */
export function senderFilterToParam(value: SenderFilterValue): string | undefined {
  return value === "all" ? undefined : value;
}

export function senderFilterFromParam(raw: string | null): SenderFilterValue | null {
  if (!raw) return null;
  for (const prefix of ["user:", "agent:"] as const) {
    if (raw.startsWith(prefix) && raw.length > prefix.length) {
      return raw as SenderFilterValue;
    }
  }
  return null;
}

/**
 * The sender selection that names ONE principal, from the endpoint vocabulary a
 * conversation coordinate speaks (`human` / `agent`) — a `direct_pair`'s
 * counterpart is the only place today that has to cross those two spellings
 * (#task:2114). Mapping it here keeps the `human` → `user:` translation in the
 * module that defines both sides of it.
 */
export function senderFilterForEndpoint(kind: "human" | "agent", id: string): SenderFilterValue {
  return kind === "agent" ? `agent:${id}` : `user:${id}`;
}

export function SenderFilterSelect({
  value,
  agents,
  users,
  userResolver,
  onChange,
  ariaLabel = "Sender filter",
}: {
  value: SenderFilterValue;
  agents: AgentDto[];
  users: UserDto[];
  userResolver: UserNameResolver;
  onChange: (value: SenderFilterValue) => void;
  ariaLabel?: string;
}): JSX.Element {
  const agentAvatarUrls = useAgentAvatarObjectUrls(agents);
  const userAvatarUrls = useUserAvatarObjectUrls(users);
  const selected = senderFilterLabel(value, agents, userResolver, agentAvatarUrls, userAvatarUrls);
  // Sort humans: viewer always first (when known), then alphabetic by
  // display name so the selector is stable.
  const viewerId = getCurrentUserId();
  const sortedUsers = useMemo(() => {
    const copy = [...users];
    copy.sort((a, b) => {
      if (viewerId && a.id === viewerId) return -1;
      if (viewerId && b.id === viewerId) return 1;
      const left = (a.display_name || a.name).toLowerCase();
      const right = (b.display_name || b.name).toLowerCase();
      return left.localeCompare(right);
    });
    return copy;
  }, [users, viewerId]);

  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as SenderFilterValue)}>
      <Select.Trigger aria-label={ariaLabel} className={FILTER_SELECT_TRIGGER_CLASS}>
        <span className="flex min-w-0 items-center gap-1.5">
          {selected.icon}
          <span className="truncate">{selected.label}</span>
        </span>
        <Select.Icon>
          <ChevronDown className="size-3.5 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          sideOffset={4}
          data-dropdown-frame
          className={FILTER_SELECT_CONTENT_CLASS}
        >
          <Select.Viewport className="p-1">
            <FilterSelectItem value="all" icon={<SearchIcon className="size-3.5" />}>
              All senders
            </FilterSelectItem>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                Humans
              </Select.Label>
              {sortedUsers.length === 0 ? (
                // Empty is a LOAD WINDOW, not a state, so it offers no option
                // at all (#task:2063): `GET /api/users` returns the unfiltered
                // human roster and the viewer is itself a `users` row, so this
                // list can only be empty before it resolves. The old fallback
                // synthesized `user:${viewerId ?? 'self'}` — with the viewer
                // still unresolved that is a literal `user:self`, an option
                // whose id names no sender (the server answers it with an empty
                // list, no error) sitting under an "Unknown user" label. A
                // picker option's value must always come from a real directory
                // row, so this arm mirrors the Agents group below: one quiet
                // row, nothing selectable.
                //
                // The COPY may not say "no humans" (#task:2065, @Paul): both
                // callers read `const { data: users = [] } = useUsers()`, and
                // that default washes `undefined` — pending ∪ error — into a
                // legal empty set, so this row is the load window AND the
                // read-failure face wearing one face. Neither may claim the
                // roster is empty, which it provably never is. It says only
                // what both windows share: the list is not here.
                <div className="px-2 py-1.5 text-xs italic text-text-muted">Unavailable</div>
              ) : (
                sortedUsers.map((user) => (
                  <FilterSelectItem
                    key={user.id}
                    value={`user:${user.id}`}
                    icon={
                      <UserAvatar
                        size={AVATAR_PX.xs}
                        avatarObjectUrl={userAvatarUrls.get(user.id) ?? null}
                        alt={user.display_name || user.name}
                      />
                    }
                    suffix={user.id === viewerId ? "you" : undefined}
                  >
                    {user.display_name || user.name}
                  </FilterSelectItem>
                ))
              )}
            </Select.Group>
            <Select.Group>
              <Select.Label className="px-2 pb-1 pt-2 text-[length:var(--text-badge)] font-semibold uppercase tracking-wider text-text-muted">
                Agents
              </Select.Label>
              {agents.length === 0 ? (
                // Deliberately NOT the Humans row's wording: an Agent list of
                // `[]` IS a reachable steady state (a workspace can really have
                // no agents), so this row is allowed to assert absence and stays
                // verbatim (#task:2065, @Paul). Same shape, different claim —
                // "both groups are empty-ish" is not a reason to unify them.
                <div className="px-2 py-1.5 text-xs italic text-text-muted">No agents</div>
              ) : (
                agents.map((agent) => (
                  <FilterSelectItem
                    key={agent.id}
                    value={`agent:${agent.id}`}
                    icon={
                      <AgentAvatar
                        runtime={agent.runtime}
                        size={AVATAR_PX.xs}
                        avatarObjectUrl={agentAvatarUrls.get(agent.id) ?? null}
                        alt={agent.display_name?.trim() || agent.name}
                      />
                    }
                    suffix={agent.runtime}
                  >
                    {agent.display_name?.trim() || agent.name}
                  </FilterSelectItem>
                ))
              )}
            </Select.Group>
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function senderFilterLabel(
  value: SenderFilterValue,
  agents: AgentDto[],
  userResolver: UserNameResolver,
  agentAvatarUrls?: Map<string, string | null>,
  userAvatarUrls?: Map<string, string | null>,
): { label: string; icon: JSX.Element } {
  if (value.startsWith("user:")) {
    const userId = value.slice("user:".length);
    // No unresolved arm here, on purpose: a human has no delete path today, so
    // the selected id is still a roster row and `formatUserDisplayName`'s own
    // id fallback is unreachable from this control. It is also the byline's
    // resolver — narrowing it for this picker would change author names on
    // every message (#task:2065).
    const label = formatUserDisplayName(userId, userResolver);
    return {
      label,
      icon: (
        <UserAvatar
          size={AVATAR_PX.xs}
          avatarObjectUrl={userAvatarUrls?.get(userId) ?? null}
          alt={label}
        />
      ),
    };
  }
  if (value.startsWith("agent:")) {
    const agentId = value.slice("agent:".length);
    const agent = agents.find((a) => a.id === agentId);
    if (!agent) {
      // The selection outlived its directory row — the agent was deleted, or
      // the viewer lost the workspace that made it visible. Either way the
      // filter is STILL applied to that id (the server keeps answering for it,
      // #task:2061), so this degrades the identity, not the filter.
      //
      // `Unknown agent`, never "Deleted agent": `useAgents()` lists the
      // `canViewAgent` ACL set, so a miss proves only that the id no longer
      // resolves HERE — the stronger claim belongs to the faces the server
      // proved gone (`presentCounterpart`). This is exactly a byline's
      // `unresolved` author, so both the label and the neutral square come FROM
      // that seam (imported, not re-typed — the borrowed word is the whole
      // licence for the weaker claim) rather than inventing a third vocabulary,
      // and never the raw uuid, which names a sender to nobody.
      return {
        label: UNRESOLVED_AGENT_LABEL,
        icon: (
          <AuthorAvatarView
            avatar={{ variant: "neutral-agent" }}
            size={AVATAR_PX.xs}
            label={UNRESOLVED_AGENT_LABEL}
          />
        ),
      };
    }
    const label = `@${agent.display_name?.trim() || agent.name}`;
    return {
      label,
      icon: (
        <AgentAvatar
          runtime={agent.runtime}
          size={AVATAR_PX.xs}
          avatarObjectUrl={agentAvatarUrls?.get(agentId) ?? null}
          alt={label}
        />
      ),
    };
  }
  return { label: "All senders", icon: <SearchIcon className="size-3.5" /> };
}
