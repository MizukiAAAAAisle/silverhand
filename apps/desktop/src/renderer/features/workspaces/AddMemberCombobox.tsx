import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { AVATAR_PX } from '@/components/avatar-scale';
import { SEARCH_FIELD_FRAME } from '@/features/common/ControlInkBorder';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import { useUserAvatarObjectUrls } from '@/features/users/avatar-hooks';
import { cn } from '@/lib/cn';
import {
  candidateDisplayName,
  candidateHandle,
  candidateKey,
  matchesCandidate,
  normalizeMemberQuery,
  type MemberCandidate,
  type MemberCandidateGroup,
} from './member-search';

/**
 * Searchable member picker: a text input that filters a grouped candidate
 * list in a dropdown anchored under it (#task:1680).
 *
 * Why an input and not a `Select`: the candidate pool grows with the agent
 * fleet, and a closed-value Select forces scrolling through it. Typing is
 * the only interaction that scales — so search is the primary affordance
 * and the list is what it narrows.
 *
 * Group order is the caller's (`groups` is rendered verbatim); a group with
 * no matches renders nothing at all — but a group that still has matches
 * keeps its label even when it is the only one left, so the header row
 * doesn't appear and disappear as the query narrows. Keyboard navigation
 * walks the flat concatenation of all groups, so the highlight never lands
 * on a section label.
 *
 * Layering: the dropdown is a plain absolutely-positioned child, NOT a
 * portal/Radix layer. Consumers mount this inside a Radix Popover, and a
 * nested dismissable layer there means a click in the inner list can
 * dismiss the outer popover. Staying in the same layer also keeps the
 * input focused while the list is open, which is the whole point of a
 * search field.
 *
 * Focus discipline (same reasoning as `components/ui/combobox.tsx`): rows
 * `preventDefault` on mousedown so picking one never blurs the input
 * first, and Escape is swallowed while the list is open so the first
 * Escape closes the list rather than the host popover.
 */
export function AddMemberCombobox({
  groups,
  onPick,
  disabled = false,
  ariaLabel,
  emptyHint,
}: {
  groups: readonly MemberCandidateGroup[];
  onPick: (candidate: MemberCandidate) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** Shown when the viewer has no eligible candidates at all. */
  emptyHint: string;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // `@alice` is how a handle is spelled everywhere else in the product, and
  // the placeholder invites it — so the sigil is normalized away before
  // matching (see `normalizeMemberQuery`). Also the empty-state predicate:
  // a bare `@` is "no query yet", not "no matches".
  const normalizedQuery = normalizeMemberQuery(query);

  const matched = useMemo<MemberCandidateGroup[]>(() => {
    return groups
      .map(g => ({
        label: g.label,
        items: normalizedQuery
          ? g.items.filter(c => matchesCandidate(c, normalizedQuery))
          : g.items,
      }))
      .filter(g => g.items.length > 0);
  }, [groups, normalizedQuery]);

  const flat = useMemo(() => matched.flatMap(g => g.items), [matched]);
  // Avatars for what is on screen only — the batch hooks key off the list
  // they are given, so a narrowed query doesn't churn the whole fleet.
  const agentAvatarUrls = useAgentAvatarObjectUrls(
    useMemo(
      () => flat.flatMap(c => (c.kind === 'agent' ? [c.agent] : [])),
      [flat],
    ),
  );
  const humanAvatarUrls = useUserAvatarObjectUrls(
    useMemo(
      () => flat.flatMap(c => (c.kind === 'human' ? [c.user] : [])),
      [flat],
    ),
  );

  // Keep the highlight in range as the list narrows.
  useEffect(() => {
    if (active >= flat.length) setActive(0);
  }, [flat.length, active]);

  // Keep the highlighted row inside the scroll area.
  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (candidate: MemberCandidate): void => {
    onPick(candidate);
    setQuery('');
    setActive(0);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      if (flat.length > 0) setActive(i => (i + 1) % flat.length);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length > 0) setActive(i => (i - 1 + flat.length) % flat.length);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const candidate = flat[active];
      if (candidate) pick(candidate);
      return;
    }
    if (e.key === 'Escape' && open) {
      // Swallow so the host popover stays open on the first Escape.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  let flatIndex = -1;

  return (
    <div className="relative">
      <label
        className={cn(
          SEARCH_FIELD_FRAME,
          disabled ? 'opacity-60' : '',
        )}
      >
        <Search className="size-3.5 shrink-0 text-text-muted" aria-hidden />
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-autocomplete="list"
          value={query}
          disabled={disabled}
          placeholder="Search by name or @handle"
          onChange={e => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // The list lives in the same layer, so a row click keeps focus
          // (rows preventDefault on mousedown); blur therefore only fires
          // when focus really leaves the picker.
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="w-full min-w-0 bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
        />
      </label>

      {open ? (
        <div
          ref={listRef}
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-[var(--z-raised)] max-h-[220px] overflow-y-auto rounded-[var(--select-content-radius)] border border-border bg-bg-floating p-1 shadow-popover"
        >
          {flat.length === 0 ? (
            <div className="px-2 py-2 text-center text-xs italic text-text-muted">
              {normalizedQuery ? 'No matches' : emptyHint}
            </div>
          ) : (
            matched.map(group => (
              <div key={group.label}>
                <div className="px-2 py-1 text-[length:var(--text-badge)] font-medium uppercase tracking-wider text-text-muted">
                  {group.label}
                </div>
                {group.items.map(candidate => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const displayName = candidateDisplayName(candidate);
                  const handle = candidateHandle(candidate);
                  return (
                    <button
                      key={candidateKey(candidate)}
                      type="button"
                      role="option"
                      aria-selected={index === active}
                      data-active={index === active ? 'true' : undefined}
                      // preventDefault so the input never blurs (which
                      // would close the list) before this click lands.
                      onMouseDown={e => e.preventDefault()}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => pick(candidate)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-[var(--select-item-radius)] px-2 py-1.5 text-left',
                        index === active ? 'bg-bg-hover' : '',
                      )}
                    >
                      {candidate.kind === 'agent' ? (
                        <AgentAvatar
                          runtime={candidate.agent.runtime}
                          size={AVATAR_PX.sm}
                          avatarObjectUrl={
                            agentAvatarUrls.get(candidate.agent.id) ?? null
                          }
                          alt={displayName}
                        />
                      ) : (
                        <UserAvatar
                          size={AVATAR_PX.sm}
                          avatarObjectUrl={
                            humanAvatarUrls.get(candidate.user.id) ?? null
                          }
                          alt={displayName}
                        />
                      )}
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {displayName}
                        </span>
                        <span className="truncate font-mono text-[length:var(--text-meta)] text-text-muted">
                          @{handle}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
