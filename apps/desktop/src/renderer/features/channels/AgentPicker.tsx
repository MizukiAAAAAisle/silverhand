import * as Select from '@radix-ui/react-select';
import { ChevronDown, UserPlus, X } from 'lucide-react';
import type { AgentDto } from '@silverhand/shared';

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
 * Shared channel/session agent picker: selected agents render as
 * removable chips, while the Select only offers not-yet-selected agents.
 * The caller owns filtering the candidate pool (all agents for channel
 * creation, channel members for session creation).
 */
export function AgentPicker({
  candidates,
  value,
  onChange,
  placeholder = '添加 agent…',
  emptyText = '没有可用的 agent',
  allSelectedText = '已添加全部 agent',
  selectId,
}: AgentPickerProps): JSX.Element {
  const byId = new Map(candidates.map(a => [a.id, a]));
  const selectedIds = value.filter((id, index) => value.indexOf(id) === index);
  const selectedSet = new Set(selectedIds);
  const available = candidates.filter(a => !selectedSet.has(a.id));

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
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map(id => {
            const agent = byId.get(id);
            const name = agent?.name ?? id.slice(0, 8);
            return (
              <SelectedChip
                key={id}
                name={name}
                onRemove={() => removeAgent(id)}
              />
            );
          })}
        </div>
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
          className="flex w-full items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus focus:ring-2 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-text-muted"
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
                available.map(a => (
                  <Select.Item
                    key={a.id}
                    value={a.id}
                    className="flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
                  >
                    <Select.ItemText>@{a.name}</Select.ItemText>
                    <span className="ml-auto text-[10px] text-text-muted">
                      {a.runtime}
                    </span>
                  </Select.Item>
                ))
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

function SelectedChip({
  name,
  onRemove,
}: {
  name: string;
  onRemove: () => void;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-accent-base bg-accent-soft px-2 py-0.5 text-xs text-text-primary">
      @{name}
      <button
        type="button"
        onClick={onRemove}
        className="text-text-muted hover:text-text-primary"
        aria-label={`移除 @${name}`}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
