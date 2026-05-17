import { useMemo, useState, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import * as Select from '@radix-ui/react-select';
import { ChevronDown, Trash2, UserPlus } from 'lucide-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { useAgents } from '@/features/agents/hooks';
import { useAgentAvatarObjectUrls } from '@/features/agents/avatar-hooks';
import {
  useAddWorkspaceMember,
  useWorkspaceMembers,
  useRemoveWorkspaceMember,
} from './hooks';

interface ManageMembersPopoverProps {
  workspaceId: string;
  /** The clickable element that triggers the popover (rendered as the
   *  Radix Trigger via `asChild`, so callers control the visual). */
  children: ReactNode;
}

/**
 * Anchored member-management surface for a workspace — shadcn-style.
 * Top: a selector that immediately enrolls the picked agent; below
 * that, AGENTS lists current agent members (with remove), HUMANS is
 * a stub section (no human-member concept in the data model yet).
 *
 * Replaces the previous modal `ManageMembersDialog` so the action
 * stays anchored to its trigger in the titlebar.
 */
export function ManageMembersPopover({
  workspaceId,
  children,
}: ManageMembersPopoverProps): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="z-50 w-[260px] rounded-md border border-border bg-bg-floating p-3 shadow-lg outline-none"
        >
          <PopoverBody workspaceId={workspaceId} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Split body out so the React-Query hooks below only mount once the
// popover actually opens (Radix unmounts Content when closed).
function PopoverBody({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data: members = [], isLoading: membersLoading } =
    useWorkspaceMembers(workspaceId);
  const memberAvatarUrls = useAgentAvatarObjectUrls(members);
  const { data: agents = [] } = useAgents();
  const addMember = useAddWorkspaceMember(workspaceId);
  const removeMember = useRemoveWorkspaceMember(workspaceId);
  const [error, setError] = useState<string | null>(null);

  const memberIds = useMemo(() => new Set(members.map(m => m.id)), [members]);
  const candidates = agents.filter(a => !memberIds.has(a.id));

  const handleAdd = async (agentId: string): Promise<void> => {
    setError(null);
    try {
      await addMember.mutateAsync(agentId);
    } catch (err) {
      setError(String(err));
    }
  };

  const handleRemove = async (agentId: string): Promise<void> => {
    setError(null);
    try {
      await removeMember.mutateAsync(agentId);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Add-member selector. Choosing an option fires the mutation
        * and clears the value so the trigger reverts to its placeholder
        * (controlled value="" so picking the same agent twice is fine). */}
      <Select.Root
        value=""
        onValueChange={v => {
          if (v) void handleAdd(v);
        }}
        disabled={addMember.isPending}
      >
        <Select.Trigger
          aria-label="添加成员"
          className="flex w-full items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus focus:ring-2 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-text-muted"
        >
          <span className="flex items-center gap-1.5">
            <UserPlus className="size-3.5 text-text-muted" />
            <Select.Value placeholder="添加成员…" />
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
                <div className="px-2 py-2 text-center text-xs italic text-text-muted">
                  所有 agent 都已经在 Workspace 里
                </div>
              ) : (
                candidates.map(a => (
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

      <Section title={`AGENTS · ${members.length}`}>
        {membersLoading ? (
          <Hint>加载中…</Hint>
        ) : members.length === 0 ? (
          <Hint>还没有 agent 成员</Hint>
        ) : (
          <ul className="flex flex-col gap-1">
            {members.map(m => (
              <li
                key={m.id}
                className="flex items-center gap-2 rounded-md border border-border-subtle bg-bg-base px-2 py-1"
              >
                <AgentAvatar
                  runtime={m.runtime}
                  size={20}
                  avatarObjectUrl={memberAvatarUrls.get(m.id) ?? null}
                  alt={m.display_name || m.name}
                />
                <span className="text-sm font-medium text-text-primary">
                  @{m.name}
                </span>
                <span className="text-[10px] text-text-muted">{m.runtime}</span>
                <button
                  type="button"
                  onClick={() => handleRemove(m.id)}
                  disabled={removeMember.isPending}
                  aria-label="移除"
                  title="移除成员"
                  className="ml-auto flex size-6 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-error disabled:opacity-60"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="HUMANS · 0">
        <Hint>暂无人类成员（尚未支持）</Hint>
      </Section>

      {error ? (
        <div className="text-xs text-error">{error}</div>
      ) : null}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-text-muted">
        {title}
      </div>
      {children}
    </section>
  );
}

function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <div className="px-1 text-xs italic text-text-muted">{children}</div>;
}
