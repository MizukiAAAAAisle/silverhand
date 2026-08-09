import { useEffect, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Settings2, ShieldCheck } from 'lucide-react';
import type { AgentCapability } from '@silverhand/shared';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { primaryAction } from '@/features/common/PrimaryAction';
import { neutralAction } from '@/features/common/ControlInkBorder';
import {
  destructiveAction,
  destructiveCancel,
} from '@/features/common/DestructiveAction';
import { cn } from '@/lib/cn';
import { nameFormatMessage } from '@/features/naming/useNameAvailability';
import { AgentPermissionsPanel } from './AgentPermissionsPanel';
import { HumanRolesPanel } from './HumanRolesPanel';
import {
  useArchiveWorkspace,
  useDeleteWorkspace,
  useRenameWorkspace,
  useWorkspaceMemberLists,
} from './hooks';
import {
  canManageWorkspaceLifecycle,
  canRenameWorkspace,
} from './workspace-permissions';

type SettingsSection = 'general' | 'agents';
type PermissionTab = 'agents' | 'human';

const PERMISSION_TABS: { id: PermissionTab; label: string }[] = [
  { id: 'agents', label: 'Agents' },
  { id: 'human', label: 'Humans' },
];

interface WorkspaceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceKind: string | null;
  /** epoch ms when archived; null for active workspaces. */
  archivedAt: number | null;
  onDeleted?: () => void;
  /** Deep-link: open straight to a section. Defaults to 'general'. The
   *  unified "open settings → Agent 权限" entry (channel jump today, future
   *  capability_denied notification) passes 'agents' + a focus agent. */
  initialSection?: SettingsSection;
  focusAgentId?: string | null;
  highlightCapability?: AgentCapability | null;
}

const NAV_ITEMS: { id: SettingsSection; label: string; icon: typeof Settings2 }[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'agents', label: 'Permission', icon: ShieldCheck },
];

export function WorkspaceSettingsDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  workspaceKind,
  archivedAt,
  onDeleted,
  initialSection = 'general',
  focusAgentId = null,
  highlightCapability = null,
}: WorkspaceSettingsDialogProps): JSX.Element {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  // Sub-tab within the Permission section. Agent capabilities and human
  // roles are orthogonal permission models, so they live as sibling tabs
  // rather than one merged list. A deep-link that targets an agent
  // (focusAgentId) implies the Agents tab.
  const [permTab, setPermTab] = useState<PermissionTab>('agents');
  const [name, setName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const renameWorkspace = useRenameWorkspace();
  const deleteWorkspace = useDeleteWorkspace();
  const archiveWorkspace = useArchiveWorkspace();

  // Governance affordances are driven by the server-authoritative viewer_role
  // (the SAME source the Permission panels consume), never guessed from the
  // owner id or local identity. Fail-closed: while the members query is
  // unresolved `data` is undefined → role null → no write control renders, so
  // the UI never flashes a writable control it then retracts (#task:1772). The
  // backend gate stays the real boundary; this only decides what to show.
  const membersQuery = useWorkspaceMemberLists(workspaceId);
  const viewerRole = membersQuery.data?.viewerRole ?? null;
  const canRename = canRenameWorkspace(viewerRole);
  const canManageLifecycle = canManageWorkspaceLifecycle(viewerRole);

  const isDm = workspaceKind === 'dm';
  const isArchived = archivedAt !== null;
  const visibleNavItems = isDm
    ? NAV_ITEMS.filter(item => item.id === 'general')
    : NAV_ITEMS;
  const activeSection = isDm && section !== 'general' ? 'general' : section;

  // Reset every time the dialog reopens for a (potentially different)
  // workspace.
  useEffect(() => {
    if (open) {
      setSection(isDm ? 'general' : initialSection);
      setPermTab('agents');
      setName(workspaceName ?? '');
      setRenameError(null);
      setConfirmingDelete(false);
    }
  }, [open, workspaceName, initialSection, isDm]);

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    setRenameError(null);
    if (!workspaceId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setRenameError('Please enter a workspace name');
      return;
    }
    // ONE format rule for both doors (#task:1827): the shared
    // `WorkspaceNameSchema` verdict, through the same copy the create dialog
    // shows. Rename previously kept a local `/^[a-zA-Z0-9_-]+$/`, so a
    // workspace create had just admitted as `设计 评审` could not be renamed at
    // all. Uniqueness stays server-only — the PATCH answers 409.
    const formatMessage = nameFormatMessage('workspace', trimmed);
    if (formatMessage) {
      setRenameError(formatMessage);
      return;
    }
    if (trimmed === workspaceName) return;
    try {
      await renameWorkspace.mutateAsync({ id: workspaceId, name: trimmed });
    } catch (err) {
      setRenameError(String(err));
    }
  };

  const handleDelete = () => {
    if (!workspaceId || deleteWorkspace.isPending) return;
    deleteWorkspace.mutate(workspaceId, {
      onSuccess: () => {
        onOpenChange(false);
        onDeleted?.();
      },
    });
  };

  const handleToggleArchive = () => {
    if (!workspaceId || archiveWorkspace.isPending) return;
    archiveWorkspace.mutate(
      { id: workspaceId, archived: !isArchived },
      {
        onSuccess: () => {
          // Close so the user sees the workspace either disappear into
          // the Archived group or pop back into the active list.
          onOpenChange(false);
        },
      },
    );
  };

  const renameDirty = name.trim() !== (workspaceName ?? '');
  const renameDisabled =
    isDm || renameWorkspace.isPending || !renameDirty || !workspaceId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            Workspace Settings
            {workspaceName ? (
              <span className="min-w-0 truncate text-sm font-normal text-text-muted">
                {workspaceName}
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>

        {/* The only dialog body with a FIXED height, so it is the only one that
            can outgrow a top-anchored shell (#task:1829): a centred shell used
            to split the overflow across both edges, a top-anchored one puts all
            of it past the bottom — taking the footer with it. Capping against
            the viewport keeps 32rem as the intent and lets a short window
            shrink the body instead of hiding it. 65vh, not 70: the shell costs
            15vh above plus ~92px of chrome, so 65 keeps the footer on screen
            down to a ~460px-tall window — below that nothing in this app is
            usable anyway. */}
        <div className="flex h-[min(32rem,65vh)] gap-5">
          <nav className="flex w-40 shrink-0 flex-col gap-0.5">
            {visibleNavItems.map(item => {
              const active = activeSection === item.id;
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setSection(item.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-[var(--control-radius)] px-2.5 py-1.5 text-left text-sm transition-colors',
                    active
                      ? 'bg-[var(--bg-row-selected)] font-medium text-text-on-selected'
                      : 'text-text-secondary hover:bg-[var(--bg-option-hover)] hover:text-text-primary',
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="scrollbar-hide min-w-0 flex-1 overflow-y-auto pr-1">
            {activeSection === 'general' ? (
              <GeneralSection
                isDm={isDm}
                isArchived={isArchived}
                canRename={canRename}
                canManageLifecycle={canManageLifecycle}
                name={name}
                onNameChange={setName}
                onRename={handleRename}
                renameError={renameError}
                renameDisabled={renameDisabled}
                renamePending={renameWorkspace.isPending}
                workspaceId={workspaceId}
                onToggleArchive={handleToggleArchive}
                archivePending={archiveWorkspace.isPending}
                confirmingDelete={confirmingDelete}
                setConfirmingDelete={setConfirmingDelete}
                onDelete={handleDelete}
                deletePending={deleteWorkspace.isPending}
              />
            ) : (
              <div className="flex flex-col gap-4">
                {/* Permission sub-tabs: agent capabilities vs human roles.
                    Horizontal segmented control pinned above the active
                    panel. */}
                <div
                  role="tablist"
                  aria-label="Permission target"
                  className="flex items-center gap-1 border-b-[length:var(--control-border-width)] border-border-subtle"
                >
                  {PERMISSION_TABS.map(tab => {
                    const active = permTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setPermTab(tab.id)}
                        className={cn(
                          '-mb-px border-b-2 px-3 py-1.5 text-sm transition-colors',
                          active
                            ? 'border-border-focus font-medium text-text-primary'
                            : 'border-transparent text-text-secondary hover:text-text-primary',
                        )}
                      >
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {permTab === 'agents' ? (
                  <AgentPermissionsPanel
                    workspaceId={workspaceId}
                    focusAgentId={focusAgentId}
                    highlightCapability={highlightCapability}
                  />
                ) : (
                  <HumanRolesPanel workspaceId={workspaceId} />
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface GeneralSectionProps {
  isDm: boolean;
  isArchived: boolean;
  /** Viewer may rename (owner|admin). When false, Name is shown read-only. */
  canRename: boolean;
  /** Viewer may archive/delete (owner). When false, both blocks are hidden. */
  canManageLifecycle: boolean;
  name: string;
  onNameChange: (v: string) => void;
  onRename: (e: FormEvent) => void;
  renameError: string | null;
  renameDisabled: boolean;
  renamePending: boolean;
  workspaceId: string | null;
  onToggleArchive: () => void;
  archivePending: boolean;
  confirmingDelete: boolean;
  setConfirmingDelete: (v: boolean) => void;
  onDelete: () => void;
  deletePending: boolean;
}

function GeneralSection({
  isDm,
  isArchived,
  canRename,
  canManageLifecycle,
  name,
  onNameChange,
  onRename,
  renameError,
  renameDisabled,
  renamePending,
  workspaceId,
  onToggleArchive,
  archivePending,
  confirmingDelete,
  setConfirmingDelete,
  onDelete,
  deletePending,
}: GeneralSectionProps): JSX.Element {
  // A DM name is immutable (auto-generated); a regular workspace is editable
  // only for owner|admin. Everyone else sees the name read-only — the value is
  // still worth showing, but there is no Save affordance that would 403.
  const nameEditable = !isDm && canRename;

  return (
    <div className="flex flex-col gap-4">
      {isDm ? (
        <p className="text-xs text-text-muted">
          {'DM workspace names are auto-generated as dm-<agent> and cannot be changed.'}
        </p>
      ) : canRename ? (
        <p className="text-xs text-text-muted">
          Renaming notifies online agents to update old name references in MEMORY.
        </p>
      ) : null}

      {nameEditable ? (
        <form onSubmit={onRename} className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-settings-name">Name</Label>
          <div className="flex gap-2">
            <Input
              id="workspace-settings-name"
              value={name}
              onChange={e => onNameChange(e.target.value)}
              placeholder="my-frontend"
              autoFocus
              className="transition-colors hover:border-[color:var(--border-control-hover)]"
            />
            <Button type="submit" disabled={renameDisabled} {...primaryAction()}>
              {renamePending ? 'Saving…' : 'Save'}
            </Button>
          </div>
          {renameError ? (
            <div className="text-xs text-error">{renameError}</div>
          ) : null}
        </form>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="workspace-settings-name">Name</Label>
          <Input
            id="workspace-settings-name"
            value={name}
            readOnly
            onFocus={e => e.currentTarget.select()}
          />
        </div>
      )}

      {!isDm && canManageLifecycle ? (
        <>
          {/* Archive + Delete are owner-only administrative ACTIONS (gated on
              canManageLifecycle). Unlike Name, they carry no read value for a
              viewer who can't perform them — a disabled button + "owner required"
              caption would be pure noise and a false affordance — so they are
              hidden entirely rather than shown disabled (#task:1772).

              Administrative blocks are static panels, not controls: the only
              affordance is the Button inside, so neither this one nor the
              Delete block below reacts to hover (shiki 2026-07-27 — Archive
              used to light up its border while Delete stayed inert). A hover
              frame on a whole panel promises a click the panel does not
              honour, and the Delete block's `border-error/30` is identity
              (danger tint) that hover must not recolour anyway. */}
          <div className="flex items-center justify-between gap-3 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-elevated/40 p-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text-primary">
                {isArchived ? 'Archived' : 'Archive workspace'}
              </span>
              <span className="text-xs text-text-muted">
                {isArchived
                  ? 'Collapsed into the sidebar Archived group; still accessible.'
                  : 'Collapse into the sidebar Archived group, keep all content, restore anytime.'}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={onToggleArchive}
              disabled={!workspaceId || archivePending}
              {...neutralAction()}
            >
              {isArchived ? (
                <>
                  <ArchiveRestore className="mr-1.5 size-3.5" />
                  {archivePending ? 'Working…' : 'Unarchive'}
                </>
              ) : (
                <>
                  <Archive className="mr-1.5 size-3.5" />
                  {archivePending ? 'Working…' : 'Archive'}
                </>
              )}
            </Button>
          </div>

          <div className="flex flex-col gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-error/30 bg-error/5 p-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-text-primary">
                Delete workspace
              </span>
              <span className="text-xs text-text-muted">
                All channels, threads, and messages are removed permanently and
                cannot be recovered.
              </span>
            </div>
            {confirmingDelete ? (
              <div className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deletePending}
                  {...destructiveCancel()}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  onClick={onDelete}
                  disabled={deletePending}
                  {...destructiveAction()}
                >
                  {deletePending ? 'Deleting…' : 'Confirm delete'}
                </Button>
              </div>
            ) : (
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="danger"
                  onClick={() => setConfirmingDelete(true)}
                  disabled={!workspaceId}
                  {...destructiveAction()}
                >
                  Delete workspace
                </Button>
              </div>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
