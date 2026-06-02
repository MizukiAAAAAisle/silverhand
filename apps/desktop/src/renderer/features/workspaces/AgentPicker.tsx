import * as Select from '@radix-ui/react-select';
import { ChevronDown, Trash2, UserPlus } from 'lucide-react';
import { useMemo } from 'react';
import type { AgentDto, UserDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
import { UserAvatar } from '@/components/UserAvatar';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';

interface AgentPickerProps {
  candidates: AgentDto[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  allSelectedText?: string;
  selectId?: string;
}

export type MemberPickerCandidate =
  | { kind: 'agent'; agent: AgentDto }
  | { kind: 'human'; user: UserDto };

interface MemberPickerProps {
  candidates: MemberPickerCandidate[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  allSelectedText?: string;
  selectId?: string;
}

/**
 * Shared member picker. The add-member Select
 * trigger stays anchored at the top so it never drifts off-screen as
 * the selected list grows; selected members render below it as
 * full-width rows (avatar + display name + monospace `@handle` +
 * remove button), and the dropdown offers not-yet-selected candidates
 * with the same row layout. Visually identical to the rows produced
 * by `ManageMembersPopover` and `AddConversationMemberPopover`, which
 * follow the same "input on top, candidates / members below" rule —
 * so users see the same "member chip" vocabulary and the same
 * layout grammar regardless of which surface they encounter it on.
 *
 * The caller still owns filtering the candidate pool. `AgentPicker`
 * remains as the agent-only compatibility wrapper for older surfaces;
 * `MemberPicker` accepts agents and humans for workspace/channel creation.
 */
export function AgentPicker({
  candidates,
  value,
  onChange,
  placeholder = '添加成员…',
  emptyText = '没有可用的成员',
  allSelectedText = '已添加全部成员',
  selectId,
}: AgentPickerProps): JSX.Element {
  const memberCandidates = useMemo<MemberPickerCandidate[]>(
    () => candidates.map(agent => ({ kind: 'agent', agent })),
    [candidates],
  );
  const memberValue = useMemo(() => value.map(id => `agent:${id}`), [value]);
  return (
    <MemberPicker
      candidates={memberCandidates}
      value={memberValue}
      onChange={values =>
        onChange(
          values
            .map(v => decodeMemberKey(v))
            .filter((v): v is { kind: 'agent'; id: string } => v?.kind === 'agent')
            .map(v => v.id),
        )
      }
      placeholder={placeholder}
      emptyText={emptyText}
      allSelectedText={allSelectedText}
      selectId={selectId}
    />
  );
}

export function MemberPicker({
  candidates,
  value,
  onChange,
  placeholder = '添加成员…',
  emptyText = '没有可用的成员',
  allSelectedText = '已添加全部成员',
  selectId,
}: MemberPickerProps): JSX.Element {
  const byKey = new Map(candidates.map(c => [memberKey(c), c]));
  const selectedKeys = value.filter((id, index) => value.indexOf(id) === index);
  const selectedSet = new Set(selectedKeys);
  const available = candidates.filter(c => !selectedSet.has(memberKey(c)));

  // Resolve avatars for the whole candidate pool — selected rows and
  // dropdown items share the same map. The hook caches by
  // `(id, avatar_url)` so the same member rendered in both surfaces
  // only fetches once.
  const agentCandidates = useMemo(
    () => candidates.flatMap(c => (c.kind === 'agent' ? [c.agent] : [])),
    [candidates],
  );
  const humanCandidates = useMemo(
    () => candidates.flatMap(c => (c.kind === 'human' ? [c.user] : [])),
    [candidates],
  );
  const agentAvatars = useAgentAvatarObjectUrls(agentCandidates);
  const humanAvatars = useAgentAvatarObjectUrls(humanCandidates);

  const addMember = (id: string): void => {
    if (!id || selectedSet.has(id)) return;
    onChange([...selectedKeys, id]);
  };

  const removeMember = (id: string): void => {
    onChange(selectedKeys.filter(v => v !== id));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Select.Root
        value=""
        onValueChange={v => {
          if (v) addMember(v);
        }}
        disabled={candidates.length === 0}
      >
        <Select.Trigger
          id={selectId}
          aria-label="添加成员"
          className="flex w-full items-center justify-between gap-2 rounded-[var(--control-radius)] border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus focus:ring-2 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-text-muted"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <UserPlus className="size-3.5 shrink-0 text-text-muted" />
            <Select.Value placeholder={placeholder} />
          </span>
          <Select.Icon>
            <ChevronDown className="size-3.5 text-text-muted" />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content
            position="popper"
            sideOffset={4}
            className="z-[60] max-h-[40vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg-floating shadow-lg"
          >
            <Select.Viewport className="p-1">
              {candidates.length === 0 ? (
                <PickerHint>{emptyText}</PickerHint>
              ) : available.length === 0 ? (
                <PickerHint>{allSelectedText}</PickerHint>
              ) : (
                available.map(candidate => {
                  const key = memberKey(candidate);
                  const displayName = memberDisplayName(candidate);
                  const handle = memberHandle(candidate);
                  return (
                    <Select.Item
                      key={key}
                      value={key}
                      className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
                    >
                      {candidate.kind === 'agent' ? (
                        <AgentAvatar
                          runtime={candidate.agent.runtime}
                          size={18}
                          avatarObjectUrl={
                            agentAvatars.get(candidate.agent.id) ?? null
                          }
                          alt={displayName}
                        />
                      ) : (
                        <UserAvatar
                          size={18}
                          avatarObjectUrl={
                            humanAvatars.get(candidate.user.id) ?? null
                          }
                          alt={displayName}
                        />
                      )}
                      <Select.ItemText>
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate font-medium">
                            {displayName}
                          </span>
                          <span className="truncate font-mono text-[11px] text-text-muted">
                            @{handle}
                          </span>
                        </span>
                      </Select.ItemText>
                    </Select.Item>
                  );
                })
              )}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>

      {selectedKeys.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {selectedKeys.map(id => {
            const candidate = byKey.get(id);
            if (!candidate) {
              // Lost reference (candidates rebuilt without this id) —
              // render a minimal placeholder so the user can still
              // remove the orphan from `value`.
              return (
                <li
                  key={id}
                  className="flex items-center gap-2 rounded-[var(--chip-radius)] border border-border-subtle bg-bg-base px-2 py-1 text-text-muted"
                >
                  <span className="truncate text-sm">{id.slice(0, 8)}</span>
                  <button
                    type="button"
                    onClick={() => removeMember(id)}
                    aria-label={`移除 ${id.slice(0, 8)}`}
                    className="ml-auto flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-text-muted hover:bg-bg-hover hover:text-error"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            }
            const displayName = memberDisplayName(candidate);
            const handle = memberHandle(candidate);
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-[var(--chip-radius)] border border-border-subtle bg-bg-base px-2 py-1"
              >
                {candidate.kind === 'agent' ? (
                  <AgentAvatar
                    runtime={candidate.agent.runtime}
                    size={20}
                    avatarObjectUrl={
                      agentAvatars.get(candidate.agent.id) ?? null
                    }
                    alt={displayName}
                  />
                ) : (
                  <UserAvatar
                    size={20}
                    avatarObjectUrl={
                      humanAvatars.get(candidate.user.id) ?? null
                    }
                    alt={displayName}
                  />
                )}
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {displayName}
                  </span>
                  <span className="truncate font-mono text-[11px] text-text-muted">
                    @{handle}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeMember(id)}
                  aria-label={`移除 @${handle}`}
                  title="移除成员"
                  className="ml-auto flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-text-muted hover:bg-bg-hover hover:text-error"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function memberKey(candidate: MemberPickerCandidate): string {
  return candidate.kind === 'agent'
    ? `agent:${candidate.agent.id}`
    : `human:${candidate.user.id}`;
}

function decodeMemberKey(value: string): { kind: 'agent' | 'human'; id: string } | null {
  const sep = value.indexOf(':');
  if (sep <= 0) return null;
  const kind = value.slice(0, sep);
  const id = value.slice(sep + 1);
  if (kind !== 'agent' && kind !== 'human') return null;
  return { kind, id };
}

function memberDisplayName(candidate: MemberPickerCandidate): string {
  return candidate.kind === 'agent'
    ? candidate.agent.display_name || candidate.agent.name
    : candidate.user.display_name || candidate.user.name;
}

function memberHandle(candidate: MemberPickerCandidate): string {
  return candidate.kind === 'agent'
    ? candidate.agent.name
    : candidate.user.name;
}

function PickerHint({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-2 py-2 text-center text-xs italic text-text-muted">
      {children}
    </div>
  );
}
