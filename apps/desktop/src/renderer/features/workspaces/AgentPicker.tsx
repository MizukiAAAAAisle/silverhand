import * as Select from '@radix-ui/react-select';
import { ChevronDown, Trash2, UserPlus } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';
import { AgentAvatar } from '@/components/AgentAvatar';
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

/**
 * Shared channel/conversation agent picker. Selected agents render as
 * full-width rows (avatar + display name + monospace `@handle` + remove
 * button); the Select dropdown offers not-yet-selected candidates with
 * the same row layout — visually identical to the rows produced by
 * `ManageMembersPopover` and `AddConversationMemberPopover`, so users
 * see the same "member chip" vocabulary regardless of which surface
 * they encounter it on.
 *
 * The caller still owns filtering the candidate pool (all agents for
 * workspace creation, the workspace's agent members for channel
 * creation). v1 is agent-only — humans join post-creation through the
 * member-add popover; the picker name reflects that.
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
  const byId = new Map(candidates.map(a => [a.id, a]));
  const selectedIds = value.filter((id, index) => value.indexOf(id) === index);
  const selectedSet = new Set(selectedIds);
  const available = candidates.filter(a => !selectedSet.has(a.id));

  // Resolve avatars for the whole candidate pool — selected rows and
  // dropdown items share the same map. The hook caches by
  // `(id, avatar_url)` so the same agent rendered in both surfaces only
  // fetches once.
  const avatars = useAgentAvatarObjectUrls(candidates);

  const addAgent = (id: string): void => {
    if (!id || selectedSet.has(id)) return;
    onChange([...selectedIds, id]);
  };

  const removeAgent = (id: string): void => {
    onChange(selectedIds.filter(v => v !== id));
  };

  return (
    <div className="flex flex-col gap-1.5">
      {selectedIds.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {selectedIds.map(id => {
            const agent = byId.get(id);
            if (!agent) {
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
                    onClick={() => removeAgent(id)}
                    aria-label={`移除 ${id.slice(0, 8)}`}
                    className="ml-auto flex size-6 items-center justify-center rounded-[var(--chip-radius)] text-text-muted hover:bg-bg-hover hover:text-error"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              );
            }
            const displayName = agent.display_name || agent.name;
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-[var(--chip-radius)] border border-border-subtle bg-bg-base px-2 py-1"
              >
                <AgentAvatar
                  runtime={agent.runtime}
                  size={20}
                  avatarObjectUrl={avatars.get(agent.id) ?? null}
                  alt={displayName}
                />
                <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {displayName}
                  </span>
                  <span className="truncate font-mono text-[11px] text-text-muted">
                    @{agent.name}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeAgent(id)}
                  aria-label={`移除 @${agent.name}`}
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

      <Select.Root
        value=""
        onValueChange={v => {
          if (v) addAgent(v);
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
                available.map(a => {
                  const displayName = a.display_name || a.name;
                  return (
                    <Select.Item
                      key={a.id}
                      value={a.id}
                      className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
                    >
                      <AgentAvatar
                        runtime={a.runtime}
                        size={18}
                        avatarObjectUrl={avatars.get(a.id) ?? null}
                        alt={displayName}
                      />
                      <Select.ItemText>
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate font-medium">
                            {displayName}
                          </span>
                          <span className="truncate font-mono text-[11px] text-text-muted">
                            @{a.name}
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
    </div>
  );
}

function PickerHint({ children }: { children: string }): JSX.Element {
  return (
    <div className="px-2 py-2 text-center text-xs italic text-text-muted">
      {children}
    </div>
  );
}
