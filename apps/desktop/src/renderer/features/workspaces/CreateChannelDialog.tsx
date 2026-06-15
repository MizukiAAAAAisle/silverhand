import { useState, useEffect, useMemo, useRef, type FormEvent } from 'react';
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
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerUser,
} from '@/features/me/hooks';
import { MemberPicker, type MemberPickerCandidate } from './AgentPicker';
import { useCreateChannel, useWorkspaceMemberLists } from './hooks';

// Stable empty member object so the useEffect dependency on `members` doesn't
// create a new reference every render when the query hasn't resolved yet.
const EMPTY_MEMBERS = { agents: [], humans: [] } as const;

interface SeedMembersInput {
  members: { agents: ReadonlyArray<{ id: string }>; humans: ReadonlyArray<{ id: string }> };
  viewerUserId: string;
}

/**
 * Pure helper that decides which agent / human ids to auto-seed into
 * the "new channel" picker. Exported separately for unit testing
 * (Cindy #task:890): the caller is responsible for gating on
 * `viewerUserId !== null`; if the viewer is unknown we must NOT seed,
 * because filtering against null would leak the viewer into
 * `selectedHumans` and the downstream candidate list excludes them
 * (creating a re-render orphan tag). Once the viewer id is in hand,
 * the seed is "every workspace member except me".
 */
export function computeChannelSeedSelection(input: SeedMembersInput): {
  agents: string[];
  humans: string[];
} {
  return {
    agents: input.members.agents.map(m => m.id),
    humans: input.members.humans
      .filter(m => m.id !== input.viewerUserId)
      .map(m => m.id),
  };
}

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** Drives member-picker behaviour. DM and regular workspaces diverge in
   *  several places (agent strip, sub-channel affordances, member
   *  management). */
  workspaceKind: string | null;
  onCreated?: (id: string) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceKind,
  onCreated,
}: CreateChannelDialogProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedHumans, setSelectedHumans] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: members = EMPTY_MEMBERS } = useWorkspaceMemberLists(workspaceId);
  const createChannel = useCreateChannel(workspaceId);
  const viewer = useViewerUser();
  const viewerUserId =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
      ? viewer.data.id
      : null;

  const isDm = workspaceKind === 'dm';

  // Default a fresh root channel to inheriting every workspace member.
  // The workspace itself is the membership pool; making the user re-pick
  // would be busywork. They can still drop members via the chip Xs.
  //
  // Only seed once per "open" cycle so a re-fetch of `members` (e.g. a
  // background invalidation) doesn't clobber the user's deselections.
  const seededOnceRef = useRef(false);
  useEffect(() => {
    if (open) return;
    setTitle('');
    setSelectedAgents([]);
    setSelectedHumans([]);
    setError(null);
    seededOnceRef.current = false;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (seededOnceRef.current) return;
    if (isDm) return;
    const totalMembers = members.agents.length + members.humans.length;
    if (totalMembers === 0) return; // wait for the members query to land
    // Cindy review #task:890: wait for `viewerUserId` to resolve before
    // seeding. If we seed against `viewerUserId === null` the
    // `filter(m => m.id !== null)` is a no-op and the viewer ends up in
    // `selectedHumans`. Once `candidates` later excludes the viewer
    // (which it does unconditionally), that selected key becomes an
    // orphan tag rendered as `id.slice(0, 8)`. Worse, the seed ref is
    // already latched so we never self-correct. Gate the seed on the
    // viewer id being known.
    if (viewerUserId === null) return;
    // Auto-seed every workspace agent + every workspace human EXCEPT
    // the viewer themselves — the backend always unions the creator
    // into the channel member set (`channel-service.ts`:
    // `Array.from(new Set([input.actor.userId, ...explicitUserMemberIds]))`),
    // so the viewer is effectively forced. Per shiki #task:888 we don't
    // surface that forced membership as a deselectable chip; the picker
    // only lists the candidates the user actually controls.
    const seed = computeChannelSeedSelection({ members, viewerUserId });
    setSelectedAgents(seed.agents);
    setSelectedHumans(seed.humans);
    seededOnceRef.current = true;
  }, [open, isDm, members, viewerUserId]);

  const candidates = useMemo<MemberPickerCandidate[]>(
    () => [
      ...members.agents.map(agent => ({ kind: 'agent' as const, agent })),
      // See seed effect above — the viewer is auto-added by the
      // backend on every channel create, so they have no business
      // appearing as a selectable human candidate either.
      ...members.humans
        .filter(user => user.id !== viewerUserId)
        .map(user => ({ kind: 'human' as const, user })),
    ],
    [members, viewerUserId],
  );
  const selectedMembers = useMemo(
    () => [
      ...selectedAgents.map(id => `agent:${id}`),
      ...selectedHumans.map(id => `human:${id}`),
    ],
    [selectedAgents, selectedHumans],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError('请填写 Channel 标题');
      return;
    }
    // DM channels are always 1:1 — no member selection needed.
    const memberAgentIds = isDm ? [] : selectedAgents;
    const memberUserIds = isDm ? undefined : selectedHumans;
    try {
      const channel = await createChannel.mutateAsync({
        title: title.trim(),
        member_agent_ids: memberAgentIds,
        member_user_ids: memberUserIds,
      });
      onCreated?.(channel.id);
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Channel</DialogTitle>
          <DialogDescription>Channel 拥有独立上下文</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="se-title">标题</Label>
            <Input
              id="se-title"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="修复 login bug"
              autoFocus
            />
          </div>

          {isDm ? null : (
            <RegularMemberPicker
              candidates={candidates}
              selected={selectedMembers}
              onChange={values => {
                const agents: string[] = [];
                const humans: string[] = [];
                for (const value of values) {
                  const [kind, id] = value.split(':', 2);
                  if (!id) continue;
                  if (kind === 'agent') agents.push(id);
                  if (kind === 'human') humans.push(id);
                }
                setSelectedAgents(agents);
                setSelectedHumans(humans);
              }}
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
            <Button type="submit" disabled={createChannel.isPending}>
              {createChannel.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RegularMemberPicker({
  candidates,
  selected,
  onChange,
}: {
  candidates: MemberPickerCandidate[];
  selected: string[];
  onChange: (values: string[]) => void;
}): JSX.Element {
  if (candidates.length === 0) {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>成员</Label>
        <span className="text-xs text-text-muted">
          这个 Workspace 还没有成员。先去 Members 面板加。
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="se-add-member">
        成员
        <span className="ml-1 text-text-muted">
          ({selected.length} / {candidates.length})
        </span>
      </Label>

      <MemberPicker
        selectId="se-add-member"
        candidates={candidates}
        value={selected}
        onChange={onChange}
        placeholder={
          selected.length === 0 ? '选择要加入的成员…' : '继续添加成员…'
        }
        allSelectedText="已添加全部成员"
      />
    </div>
  );
}
