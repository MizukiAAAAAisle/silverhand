import { useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
import type { AgentDto, ChannelKind } from '@silverhand/shared';
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
import { AgentPicker } from './AgentPicker';
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
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
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
      setSelectedAgents([]);
      setError(null);
      seededOnceRef.current = false;
      return;
    }
    if (seededOnceRef.current) return;
    if (isChild || isDm) return;
    if (members.length === 0) return; // wait for the query to land
    setSelectedAgents(members.map(m => m.id));
    seededOnceRef.current = true;
  }, [open, isChild, isDm, members]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of members) m.set(a.id, a.name);
    return m;
  }, [members]);

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
      : selectedAgents;
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
              onChange={setSelectedAgents}
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
  onChange,
}: {
  members: AgentDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
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
          ({selected.length} / {members.length})
        </span>
      </Label>

      <AgentPicker
        selectId="se-add-member"
        candidates={members}
        value={selected}
        onChange={onChange}
        placeholder={
          selected.length === 0 ? '选择要加入的 agent…' : '继续添加 agent…'
        }
        allSelectedText="已添加全部 agent"
      />
    </div>
  );
}
