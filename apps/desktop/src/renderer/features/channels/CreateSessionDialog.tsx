import { useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
import * as Select from '@radix-ui/react-select';
import { ChevronDown, UserPlus, X } from 'lucide-react';
import type { ChannelKind } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useChannelMembers } from '@/features/agents/hooks';
import { useCreateSession } from './hooks';

interface CreateSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: string | null;
  /** Drives member-picker behaviour. DM auto-adds the DM agent and
   *  hides the picker entirely; regular shows a dropdown + chips. */
  channelKind: ChannelKind | null;
  /** Required when `channelKind === 'dm'` — auto-added as the sole
   *  session member. Ignored for regular channels. */
  dmAgentId: string | null;
  parentSessionId?: string | null;
  parentSessionTitle?: string | null;
  onCreated?: (id: string) => void;
}

export function CreateSessionDialog({
  open,
  onOpenChange,
  channelId,
  channelKind,
  dmAgentId,
  parentSessionId,
  parentSessionTitle,
  onCreated,
}: CreateSessionDialogProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [contextSummary, setContextSummary] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const { data: members = [] } = useChannelMembers(channelId);
  const createSession = useCreateSession(channelId);

  const isChild = !!parentSessionId;
  const isDm = channelKind === 'dm';

  // Default a fresh root session to inheriting every channel member.
  // The channel itself is the membership pool; making the user re-pick
  // would be busywork. They can still drop members via the chip Xs.
  // Child sessions intentionally start empty — their value is a focused
  // subset, so the user picks the contributors deliberately.
  //
  // Only seed once per "open" cycle so a re-fetch of `members` (e.g. a
  // background invalidation) doesn't clobber the user's deselections.
  const seededOnceRef = useRef(false);
  useEffect(() => {
    if (!open) {
      setTitle('');
      setContextSummary('');
      setSelectedAgents(new Set());
      setError(null);
      seededOnceRef.current = false;
      return;
    }
    if (seededOnceRef.current) return;
    if (isChild || isDm) return;
    if (members.length === 0) return; // wait for the query to land
    setSelectedAgents(new Set(members.map(m => m.id)));
    seededOnceRef.current = true;
  }, [open, isChild, isDm, members]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of members) m.set(a.id, a.name);
    return m;
  }, [members]);

  const candidateMembers = useMemo(
    () => members.filter(m => !selectedAgents.has(m.id)),
    [members, selectedAgents],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('请填写会话标题');
      return;
    }
    if (isChild && !contextSummary.trim()) {
      setError('子会话需要填写上下文摘要');
      return;
    }
    // DM sessions are always 1:1 with the DM agent — auto-include them
    // so the user doesn't have to. Falls back to whatever the user
    // explicitly picked if dmAgentId is missing for some reason.
    const memberIds = isDm
      ? dmAgentId
        ? [dmAgentId]
        : []
      : [...selectedAgents];
    try {
      const session = await createSession.mutateAsync({
        title: title.trim(),
        member_agent_ids: memberIds,
        parent_session_id: parentSessionId ?? undefined,
        context_summary: isChild ? contextSummary.trim() : undefined,
      });
      onCreated?.(session.id);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  const removeAgent = (id: string) => {
    setSelectedAgents(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  const addAgent = (id: string) => {
    if (!id) return;
    setSelectedAgents(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isChild ? '新建子会话' : '新建会话'}</DialogTitle>
          <DialogDescription>
            {isChild
              ? `从「${parentSessionTitle ?? 'parent'}」分支出独立讨论。子会话拥有独立上下文。`
              : isDm
                ? `在 DM 频道里开一个新的会话上下文。`
                : '一个会话是一组成员 agent 的协作空间，拥有独立上下文。'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="se-title">标题</Label>
            <Input
              id="se-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder={isChild ? '深入排查 login 502' : '修复 login bug'}
              autoFocus
            />
          </div>

          {isChild ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="se-ctx">上下文摘要</Label>
              <Input
                id="se-ctx"
                value={contextSummary}
                onChange={e => setContextSummary(e.target.value)}
                placeholder="父会话里讨论到的 / 子会话需要知道的关键信息"
              />
              <span className="text-xs text-text-muted">
                作为子会话第一条 system 消息发给成员。
              </span>
            </div>
          ) : null}

          {isDm ? (
            <DmMemberHint dmAgentName={dmAgentId ? nameById.get(dmAgentId) ?? null : null} />
          ) : (
            <RegularMemberPicker
              members={members}
              selected={selectedAgents}
              candidates={candidateMembers}
              nameById={nameById}
              onAdd={addAgent}
              onRemove={removeAgent}
            />
          )}

          {error ? <div className="text-xs text-error">{error}</div> : null}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={createSession.isPending}>
              {createSession.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DmMemberHint({ dmAgentName }: { dmAgentName: string | null }): JSX.Element {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-floating px-3 py-2 text-xs text-text-secondary">
      {dmAgentName
        ? `DM 会话会自动包含 @${dmAgentName}，无需选择成员。`
        : 'DM 会话会自动包含频道对应的 agent，无需选择成员。'}
    </div>
  );
}

function RegularMemberPicker({
  members,
  selected,
  candidates,
  nameById,
  onAdd,
  onRemove,
}: {
  members: { id: string; name: string }[];
  selected: Set<string>;
  candidates: { id: string; name: string; runtime: string }[];
  nameById: Map<string, string>;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}): JSX.Element {
  if (members.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>成员（频道内的 agent）</Label>
        <span className="text-xs text-text-muted">
          这个频道还没有 agent 成员。先去 Members 面板加。
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="se-add-member">
        成员
        <span className="ml-1 text-text-muted">
          ({selected.size} / {members.length})
        </span>
      </Label>

      {selected.size > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {[...selected].map(id => (
            <SelectedChip key={id} name={nameById.get(id) ?? id.slice(0, 8)} onRemove={() => onRemove(id)} />
          ))}
        </div>
      ) : null}

      {/* Same shadcn-style Radix Select as ManageMembersPopover so the
        * member-picker UX stays consistent across surfaces. Picking an
        * option fires onAdd and clears value back to placeholder. */}
      <Select.Root
        value=""
        onValueChange={v => {
          if (v) onAdd(v);
        }}
      >
        <Select.Trigger
          id="se-add-member"
          aria-label="添加成员"
          className="flex w-full items-center justify-between gap-2 rounded-md border border-border-subtle bg-bg-base px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors hover:border-border focus:border-border-focus focus:ring-2 focus:ring-border-focus disabled:cursor-not-allowed disabled:opacity-60 data-[placeholder]:text-text-muted"
        >
          <span className="flex items-center gap-1.5">
            <UserPlus className="size-3.5 text-text-muted" />
            <Select.Value
              placeholder={
                selected.size === 0 ? '选择要加入的 agent…' : '继续添加 agent…'
              }
            />
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
                  已添加全部 agent
                </div>
              ) : (
                candidates.map(a => (
                  <Select.Item
                    key={a.id}
                    value={a.id}
                    className="flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm text-text-primary outline-none data-[highlighted]:bg-bg-hover"
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
