import { useMemo, useState, type FormEvent } from 'react';
import type { AgentDto, CreateWorkspaceInput, UserDto } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { primaryAction, primaryCancel } from '@/features/common/PrimaryAction';
import { describeApiError } from '@/lib/api-error-message';
import {
  NameAvailabilityHint,
  useNameAvailability,
} from '@/features/naming/useNameAvailability';
import { useAgents } from '@/features/agents/hooks';
import {
  isBackendUnreachable,
  isRegistrationRequired,
  isUpdateRequired,
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

/**
 * New Workspace — Name + initial members, and nothing else.
 *
 * A workspace is not stored on a computer (doc §3.5 / §7): it is an IM +
 * memory unit whose per-agent bundle path is derived from ids, so there is no
 * placement decision left for the user to make. That retires the whole
 * host-placement half of this dialog — the Computer picker, the live
 * availability probe, the "choose an online computer" submit gate and the
 * `local_host_*` / `host_*` create refusals. It also retires the #task:1600
 * candidate-filtering contract structurally rather than by a guard: with no
 * host in this dialog at all, agents cannot be filtered or pruned by one.
 * Members on other computers stay legal.
 */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateWorkspaceDialogProps): JSX.Element {
  const [name, setName] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedHumans, setSelectedHumans] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Only the agents this viewer created: creating a workspace enrolls its
  // initial `member_agent_ids`, and enrollment is the creator's call
  // (#task:1681). `?scope=owned` is the single authority for "mine" — the
  // renderer passes the flag and never re-filters client-side.
  const { data: agents = [] } = useAgents({ scope: 'owned' });
  const { data: users = [] } = useUsers();
  const viewer = useViewerUser();
  const viewerUserId =
    viewer.data
    && !isRegistrationRequired(viewer.data)
    && !isBackendUnreachable(viewer.data)
    && !isUpdateRequired(viewer.data)
      ? viewer.data.id
      : null;
  const createWorkspace = useCreateWorkspace();
  // onBlur name validation — format (shared EntityNameSchema) + uniqueness
  // (regular workspaces, global; server probe). Mirrors CreateAgentDialog.
  const nameCheck = useNameAvailability('workspace', name);

  const reset = () => {
    setName('');
    setSelectedAgents([]);
    setSelectedHumans([]);
    setError(null);
  };

  const memberCandidates = useMemo<MemberPickerCandidate[]>(
    () => [
      ...agents.map((agent: AgentDto) => ({
        kind: 'agent' as const,
        agent,
      })),
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
    // Final format pass — arms the inline hint even on a field never blurred.
    // Uniqueness is left to create (the authoritative backstop).
    if (!nameCheck.formatValid) {
      nameCheck.markTouched();
      return;
    }
    try {
      const input: CreateWorkspaceInput = {
        name: name.trim(),
        member_agent_ids: selectedAgents,
        member_user_ids: selectedHumans,
      };
      const res = await createWorkspace.mutateAsync(input);
      onCreated?.({
        workspaceId: res.workspace.id,
        channelId: res.onboarding_channel_id,
      });
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(friendlyCreateWorkspaceError(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-name" required className="font-semibold">
              Name
            </Label>
            <Input
              id="ch-name"
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={nameCheck.markTouched}
              aria-invalid={nameCheck.blocking || undefined}
              placeholder="my-frontend"
              autoFocus
            />
            <NameAvailabilityHint check={nameCheck} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-add-member" className="font-semibold">
              Initial members
              <span className="ml-1 text-text-muted">
                ({selectedMembers.length} / {memberCandidates.length})
              </span>
            </Label>
            {memberCandidates.length === 0 ? (
              <span className="text-xs text-text-muted">
                No members available yet.
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
              variant="outline"
              onClick={() => onOpenChange(false)}
              {...primaryCancel()}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createWorkspace.isPending || nameCheck.blocking}
              {...primaryAction()}
            >
              {createWorkspace.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const WORKSPACE_CREATE_ERROR_MESSAGES: Record<string, string> = {
  // #task:1681 — the picker only offers the viewer's own agents, so this is a
  // backstop for a stale pool (an agent transferred or deleted mid-dialog).
  // Same wording as the two member pickers: enrollment is creator-only, so the
  // line names the creator and no role (#task:1682).
  agent_not_owned:
    "You can only add agents you created. Someone else's can be brought in only by its creator.",
  // No host-placement arms: a workspace is not stored on a computer, so create
  // sends no computer and the route resolves none. The `local_host_*` / `host_*`
  // refusals belong to create-AGENT, which keeps its own wording (an agent IS
  // placed on a computer).
};

function friendlyCreateWorkspaceError(err: unknown): string {
  return describeApiError(err, {
    actionLabel: "Couldn't create the workspace",
    backendUnreachableMessage:
      "Can't reach the backend. Check your connection and try again.",
    fallbackMessage: "Couldn't create the workspace. Please try again.",
    knownCodeMessages: WORKSPACE_CREATE_ERROR_MESSAGES,
  });
}
