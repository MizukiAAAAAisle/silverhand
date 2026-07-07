import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { FolderOpen } from 'lucide-react';
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
import { describeApiError } from '@/lib/api-error-message';
import {
  NameAvailabilityHint,
  useNameAvailability,
} from '@/features/naming/useNameAvailability';
import {
  useHostAvailabilityMap,
  useHostProvenanceGate,
  useHostsQuery,
} from '@/features/hosts/hooks';
import { isComputerAvailable } from '@/features/hosts/host-display';
import { ComputerPicker } from '@/features/hosts/ComputerPicker';
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
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedHumans, setSelectedHumans] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const previousHostIdRef = useRef<string | null | undefined>(undefined);

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
  // onBlur name validation — format (shared EntityNameSchema) + uniqueness
  // (regular workspaces, global; server probe). Mirrors CreateAgentDialog.
  const nameCheck = useNameAvailability('workspace', name);
  const hostProvenance = useHostProvenanceGate();
  const hostsQuery = useHostsQuery();

  // Placement candidates come straight from the backend's `placeable`
  // predicate — one kind-independent eligibility source (doc §5.4). The picker
  // is a Select dropdown shown whenever any placeable computer exists.
  const placeableHosts = useMemo(
    () => (hostsQuery.data?.hosts ?? []).filter(host => host.placeable),
    [hostsQuery.data],
  );
  const placeableHostIds = useMemo(
    () => placeableHosts.map(host => host.id),
    [placeableHosts],
  );
  // Second placement axis: a `placeable` computer can only store a workspace if
  // its daemon is online right now. Probe live availability per candidate;
  // offline/unreachable ones stay visible but disabled in the picker, and only
  // `available` computers count toward the default + submit check (#task:1359).
  const { availabilityById, allSettled } = useHostAvailabilityMap(placeableHostIds);
  const availableHosts = useMemo(
    () =>
      placeableHosts.filter(host =>
        isComputerAvailable(availabilityById.get(host.id)),
      ),
    [placeableHosts, availabilityById],
  );
  // The computer picker is always present (0 available → nothing to pick,
  // 1 → preselected, several → no default so the user must choose). Gate the
  // default on `allSettled` (Cindy P1): staggered probe resolution must not
  // auto-select a transient single `available`.
  const defaultHostId =
    allSettled && availableHosts.length === 1
      ? (availableHosts[0]?.id ?? null)
      : null;

  // The picker is the single source of the chosen host; when no placeable
  // computer exists `selectedHostId` stays null and the backend resolves.
  const effectiveHostId = selectedHostId;

  // Local desktop host → the user can pick a real folder on this machine.
  // Another host → no native picker; default to that daemon's managed path,
  // with an advanced typed override that the OWNING daemon validates.
  const canPickLocalFolder = hostProvenance.canUseLocalHostPathFor(effectiveHostId);

  useEffect(() => {
    if (!open) {
      setSelectedHostId(null);
      previousHostIdRef.current = undefined;
      return;
    }
    // Preselect the sole available host; drop a prior pick that dropped offline
    // while the dialog is open, falling back to the default.
    const availableIds = new Set(availableHosts.map(host => host.id));
    setSelectedHostId(prev =>
      prev && availableIds.has(prev) ? prev : defaultHostId,
    );
  }, [open, defaultHostId, availableHosts]);

  useEffect(() => {
    if (!open) return;
    const previousHostId = previousHostIdRef.current;
    previousHostIdRef.current = effectiveHostId;
    if (previousHostId === undefined || previousHostId === effectiveHostId) {
      return;
    }
    setWorkspacePath('');
    setShowAdvancedPath(false);
  }, [open, effectiveHostId]);

  const reset = () => {
    setName('');
    setWorkspacePath('');
    setShowAdvancedPath(false);
    setSelectedHostId(null);
    setSelectedAgents([]);
    setSelectedHumans([]);
    setError(null);
  };

  const eligibleAgents = useMemo(
    () =>
      effectiveHostId
        ? agents.filter(agent => agent.host_id === effectiveHostId)
        : [],
    [agents, effectiveHostId],
  );

  // Agent membership must match the workspace host. If the user changes the
  // storage host after selecting agents, prune now instead of letting the
  // backend reject with `host_mismatch`.
  useEffect(() => {
    const eligibleIds = new Set(eligibleAgents.map(agent => agent.id));
    setSelectedAgents(prev => {
      const next = prev.filter(id => eligibleIds.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [eligibleAgents]);

  const memberCandidates = useMemo<MemberPickerCandidate[]>(
    () => [
      ...eligibleAgents.map((agent: AgentDto) => ({
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
    [eligibleAgents, users, viewerUserId],
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
    if (placeableHosts.length > 0) {
      if (!allSettled) {
        setError('Checking which computers are online…');
        return;
      }
      if (availableHosts.length === 0) {
        setError('No computer is online right now. Connect one and try again.');
        return;
      }
      if (!selectedHostId || !availableHosts.some(h => h.id === selectedHostId)) {
        setError('Please choose an online computer to store this workspace');
        return;
      }
    }
    try {
      const input: CreateWorkspaceInput = {
        name: name.trim(),
        workspace_path: workspacePath.trim() || undefined,
        member_agent_ids: selectedAgents,
        member_user_ids: selectedHumans,
      };
      if (effectiveHostId) input.workspace_host_id = effectiveHostId;
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

  const pickDirectory = async () => {
    const path = await window.agentHub.pickDirectory();
    if (path) setWorkspacePath(path);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New Workspace</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ch-host" required className="font-semibold">
              Stored on
            </Label>
            <ComputerPicker
              id="ch-host"
              hosts={placeableHosts}
              availabilityById={availabilityById}
              value={selectedHostId}
              onChange={setSelectedHostId}
              ariaLabel="Stored on"
            />
          </div>

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
            <Label htmlFor="ch-path" className="font-semibold">
              Working directory (optional)
            </Label>
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
                  placeholder="/path/to/project"
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
                    Set a path manually
                  </button>
                ) : (
                  <Input
                    id="ch-path"
                    value={workspacePath}
                    onChange={e => setWorkspacePath(e.target.value)}
                    placeholder="Absolute path on this host"
                    className="font-mono text-xs"
                  />
                )}
              </>
            )}
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
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                createWorkspace.isPending
                || hostsQuery.isLoading
                || hostProvenance.isLoading
                || (placeableHosts.length > 0 && !allSettled)
                || nameCheck.blocking
              }
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
  local_host_ambiguous: 'Choose which computer should store this workspace.',
  local_host_unbound:
    'No connected computer can store this workspace. Connect one and try again.',
  host_revoked:
    "That computer isn't available anymore. Pick another and try again.",
  host_not_owned:
    "That computer isn't available anymore. Pick another and try again.",
  host_missing:
    "That computer isn't available anymore. Pick another and try again.",
  host_mismatch: 'Initial agents must live on the selected computer.',
  host_attach_pending:
    'That computer is not connected yet. Try again in a moment.',
  workspace_path_conflict:
    'This folder is already used by another Silverhand workspace; choose a different folder.',
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
