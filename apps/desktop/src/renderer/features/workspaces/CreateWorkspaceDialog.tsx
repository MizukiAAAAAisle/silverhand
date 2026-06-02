import { useMemo, useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
import type { AgentDto, UserDto } from '@silverhand/shared';
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
import { useHostProvenanceGate } from '@/features/hosts/hooks';
import { useAgents } from '@/features/agents/hooks';
import { useUsers } from '@/features/users/hooks';
import { MemberPicker, type MemberPickerCandidate } from './AgentPicker';
import { useCreateWorkspace } from './hooks';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (created: { workspaceId: string; channelId: string }) => void;
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [showAdvancedPath, setShowAdvancedPath] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedHumans, setSelectedHumans] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const { data: agents = [] } = useAgents();
  const { data: users = [] } = useUsers();
  const createWorkspace = useCreateWorkspace();
  const hostProvenance = useHostProvenanceGate();
  // Local desktop host → the user can pick a real folder on this machine.
  // Remote / sandbox host → no native picker (the folder lives on another
  // machine); default to the daemon-managed path, with an advanced typed
  // override that the OWNING daemon validates (the server never interprets
  // the path — D4.e-1).
  const canPickLocalFolder = hostProvenance.canUseCurrentLocalHostPath;

  const reset = () => {
    setName('');
    setWorkspacePath('');
    setShowAdvancedPath(false);
    setSelectedAgents([]);
    setSelectedHumans([]);
    setError(null);
  };

  const memberCandidates = useMemo<MemberPickerCandidate[]>(
    () => [
      ...agents.map((agent: AgentDto) => ({ kind: 'agent' as const, agent })),
      ...users.map((user: UserDto) => ({ kind: 'human' as const, user })),
    ],
    [agents, users],
  );

  const selectedMembers = useMemo(
    () => [
      ...selectedAgents.map(id => `agent:${id}`),
      ...selectedHumans.map(id => `human:${id}`),
    ],
    [selectedAgents, selectedHumans],
  );

  const setSelectedMembers = (values: string[]): void => {
    const agentsNext: string[] = [];
    const humansNext: string[] = [];
    for (const value of values) {
      const sep = value.indexOf(':');
      if (sep <= 0) continue;
      const kind = value.slice(0, sep);
      const id = value.slice(sep + 1);
      if (kind === 'agent') agentsNext.push(id);
      if (kind === 'human') humansNext.push(id);
    }
    setSelectedAgents(agentsNext);
    setSelectedHumans(humansNext);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('请填写 Workspace 名称');
      return;
    }
    try {
      const res = await createWorkspace.mutateAsync({
        name: name.trim(),
        workspace_path: workspacePath.trim() || undefined,
        member_agent_ids: selectedAgents,
        member_user_ids: selectedHumans,
      });
      onCreated?.({
        workspaceId: res.workspace.id,
        channelId: res.onboarding_channel_id,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    }
  };

  const pickDirectory = async () => {
    const path = await window.agentHub.pickDirectory();
    if (path) setWorkspacePath(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建 Workspace</DialogTitle>
          <DialogDescription>
            一个 Workspace 是一个本地工作目录上的协作空间。创建后会自动开一个 Onboarding Channel，你在里面通过对话塑造每个成员的角色。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-name">名称</Label>
            <Input
              id="ch-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-frontend"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-path">工作目录（可选）</Label>
            {canPickLocalFolder ? (
              // Local host: native folder picker is the primary affordance;
              // the typed input mirrors the picked path and stays editable.
              <>
                <div className="flex gap-2">
                  <Input
                    id="ch-path"
                    value={workspacePath}
                    onChange={e => setWorkspacePath(e.target.value)}
                    placeholder="留空则由该 host 的 daemon 在其托管目录下自动创建"
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    onClick={pickDirectory}
                  >
                    <FolderOpen className="size-4" />
                    浏览
                  </Button>
                </div>
                <span className="text-xs text-text-muted">
                  路径由该 host 的 daemon 校验与绑定。
                </span>
              </>
            ) : (
              // Remote / sandbox host: no native picker. Default to the
              // daemon-managed path; expose a typed override under "高级".
              <>
                {!showAdvancedPath ? (
                  <button
                    type="button"
                    className="self-start text-xs text-text-muted underline underline-offset-2"
                    onClick={() => setShowAdvancedPath(true)}
                  >
                    使用 host 托管目录（默认）· 高级：手动指定路径
                  </button>
                ) : (
                  <>
                    <Input
                      id="ch-path"
                      value={workspacePath}
                      onChange={e => setWorkspacePath(e.target.value)}
                      placeholder="该 host 上的绝对路径（由其 daemon 校验）"
                      className="font-mono text-xs"
                    />
                    <span className="text-xs text-text-muted">
                      远程 / 沙箱 host 无法用本地选择器浏览；留空则使用 daemon
                      托管目录。
                    </span>
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-add-member">
              初始成员
              <span className="ml-1 text-text-muted">
                ({selectedMembers.length} / {memberCandidates.length})
              </span>
            </Label>
            {memberCandidates.length === 0 ? (
              <span className="text-xs text-text-muted">
                还没有可添加的成员。可以稍后从 Members 面板加入。
              </span>
            ) : (
              <MemberPicker
                selectId="ch-add-member"
                candidates={memberCandidates}
                value={selectedMembers}
                onChange={setSelectedMembers}
                placeholder={
                  selectedMembers.length === 0
                    ? '选择初始成员…'
                    : '继续添加成员…'
                }
                allSelectedText="已添加全部成员"
              />
            )}
          </div>

          {error ? <div className="text-xs text-error">{error}</div> : null}

          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={createWorkspace.isPending}>
              {createWorkspace.isPending ? '创建中…' : '创建'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
