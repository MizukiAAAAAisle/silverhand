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
import {
  isBackendUnreachable,
  isRegistrationRequired,
  useViewerUser,
} from '@/features/me/hooks';
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
  const viewer = useViewerUser();
  const viewerUserId =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
      ? viewer.data.id
      : null;
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
      // The viewer is auto-added as a workspace member by the backend
      // (`routes.ts: workspaces.addUserMember(workspace.id, viewerUserId)`
      // runs before the explicit `member_user_ids`); listing them as a
      // selectable candidate would be misleading "do I add myself?"
      // noise. Per shiki #task:888: "操作人应该是默认加入的,而不是需要
      // 选择". Drop the viewer here so they never appear in the picker
      // dropdown or as a selected tag.
      ...users
        .filter((user: UserDto) => user.id !== viewerUserId)
        .map((user: UserDto) => ({ kind: 'human' as const, user })),
    ],
    [agents, users, viewerUserId],
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
      setError('Please enter a Workspace name');
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
          <DialogTitle>New Workspace</DialogTitle>
          <DialogDescription>
            A shared space backed by a local project directory.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-name">Name</Label>
            <Input
              id="ch-name"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="my-frontend"
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-path">Working directory (optional)</Label>
            {canPickLocalFolder ? (
              // Local host: native folder picker is the primary affordance;
              // the typed input mirrors the picked path and stays editable.
              // The picker button is icon-only (shiki #task:920 D) — the
              // FolderOpen glyph + tooltip is enough; freeing a label
              // worth of width lets the typed path breathe.
              <div className="flex gap-2">
                <Input
                  id="ch-path"
                  value={workspacePath}
                  onChange={e => setWorkspacePath(e.target.value)}
                  placeholder="Leave empty to let this host's daemon create it automatically under its managed directory"
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  onClick={pickDirectory}
                  aria-label="Browse"
                  title="Browse"
                  className="w-9 shrink-0 px-0"
                >
                  <FolderOpen className="size-4" />
                </Button>
              </div>
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
                    Use host-managed directory (default) · Advanced: specify a path manually
                  </button>
                ) : (
                  <>
                    <Input
                      id="ch-path"
                      value={workspacePath}
                      onChange={e => setWorkspacePath(e.target.value)}
                      placeholder="Absolute path on this host (validated by its daemon)"
                      className="font-mono text-xs"
                    />
                    <span className="text-xs text-text-muted">
                      Remote / sandbox hosts can't be browsed with the local
                      picker; leave empty to use the daemon-managed directory.
                    </span>
                  </>
                )}
              </>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-add-member">
              Initial members
              <span className="ml-1 text-text-muted">
                ({selectedMembers.length} / {memberCandidates.length})
              </span>
            </Label>
            {memberCandidates.length === 0 ? (
              <span className="text-xs text-text-muted">
                No members available to add yet. You can add them later from the
                Members panel.
              </span>
            ) : (
              <MemberPicker
                selectId="ch-add-member"
                candidates={memberCandidates}
                value={selectedMembers}
                onChange={setSelectedMembers}
                placeholder={
                  selectedMembers.length === 0
                    ? 'Select initial members…'
                    : 'Add more members…'
                }
                allSelectedText="All members added"
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
              Cancel
            </Button>
            <Button type="submit" disabled={createWorkspace.isPending}>
              {createWorkspace.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
