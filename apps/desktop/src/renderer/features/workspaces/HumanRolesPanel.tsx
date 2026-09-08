import * as Select from "@radix-ui/react-select";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceHumanMemberDto, WorkspaceRole } from "@silverhand/shared";
import { ApiError } from "@/lib/api";
import { UserAvatar } from "@/components/UserAvatar";
import { AVATAR_PX } from "@/components/avatar-scale";
import { useUserAvatarObjectUrls } from "@/features/users/avatar-hooks";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useUpdateWorkspaceHumanMemberRole, useWorkspaceMemberLists } from "./hooks";

/** Stable empty reference so the avatar batch hook doesn't re-fetch on
 *  every render while members are still loading. */
const EMPTY_HUMANS: WorkspaceHumanMemberDto[] = [];

/** Roles a human can be reassigned to. `owner` is intentionally absent:
 *  owner transfer is unsupported on the backend (any owner-involving change
 *  → `owner_role_change_unsupported` 400), so the client never offers it. */
const ASSIGNABLE_ROLES: readonly Exclude<WorkspaceRole, "owner">[] = ["admin", "member"];

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function viewerRoleLabel(role: WorkspaceRole | null | undefined): string {
  return role ? ROLE_LABEL[role].toLowerCase() : "non-member";
}

/** Turn a PATCH failure into an operator-facing message. The backend gates
 *  on owner (403) and rejects owner-involving changes (400); both must be
 *  visible even though the front-end also gates. */
function describeRoleSaveError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.kind === "backend_unreachable") return "Update failed: cannot reach backend";
    if (err.status === 403) return "You don't have permission (owner required)";
    if (err.status === 404) return "Update failed: member no longer exists";
    if (err.status === 400) return "Update failed: that role change is not allowed";
    return `Update failed (${err.status})`;
  }
  return "Update failed";
}

export interface HumanRolesPanelProps {
  workspaceId: string | null;
}

/**
 * Human-axis counterpart to `AgentPermissionsPanel`. Agents carry a
 * capability set; humans carry a single workspace `role`. Both live under
 * the dialog's Permission section as sibling tabs.
 *
 * Editing is owner-only and mirrors the backend gate exactly:
 *   - only owner viewers see an editable control (`viewerRole === 'owner'`);
 *   - the owner row itself is never editable, and `owner` is never an option;
 *   - so the only legal move is admin↔member, matching the route.
 * Non-owner viewers get read-only badges plus an explainer.
 */
export function HumanRolesPanel({ workspaceId }: HumanRolesPanelProps): JSX.Element {
  const membersQuery = useWorkspaceMemberLists(workspaceId);
  const humans = membersQuery.data?.humans ?? EMPTY_HUMANS;
  const viewerRole = membersQuery.data?.viewerRole;
  const canEdit = viewerRole === "owner";
  const avatarUrls = useUserAvatarObjectUrls(humans);
  const update = useUpdateWorkspaceHumanMemberRole(workspaceId);

  if (membersQuery.isLoading) {
    return <PanelSkeleton />;
  }
  if (membersQuery.isError) {
    return (
      <PanelMessage tone="error">
        Failed to load members.
        <Button variant="ghost" size="sm" onClick={() => void membersQuery.refetch()}>
          Retry
        </Button>
      </PanelMessage>
    );
  }
  if (humans.length === 0) {
    return <PanelMessage>This workspace has no human members yet.</PanelMessage>;
  }

  const onChangeRole = (member: WorkspaceHumanMemberDto, role: Exclude<WorkspaceRole, "owner">) => {
    if (role === member.role) return;
    update.mutate(
      { userId: member.user_id, role },
      {
        onSuccess: () =>
          toast.success(
            `${member.display_name || member.name} is now ${ROLE_LABEL[role].toLowerCase()}`,
          ),
        onError: (err) => toast.error(describeRoleSaveError(err)),
      },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {!canEdit ? (
        <div className="flex items-start gap-2 rounded-(--control-radius) border-(length:--control-border-width) border-border-subtle bg-bg-elevated/40 p-2.5 text-xs text-text-muted">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            You are {viewerRoleLabel(viewerRole)} in this workspace — you can view member roles, but
            changing them requires owner.
          </span>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5">
        {humans.map((member) => {
          const isOwner = member.role === "owner";
          // The owner row is never editable (backend rejects any
          // owner-involving change); only owner viewers may edit the rest.
          const editable = canEdit && !isOwner;
          return (
            <li
              key={member.user_id}
              className="flex items-center gap-2.5 rounded-(--control-radius) border-(length:--control-border-width) border-border bg-bg-floating px-3 py-2"
            >
              <UserAvatar
                size={AVATAR_PX.sm}
                avatarObjectUrl={avatarUrls.get(member.id) ?? null}
                alt={member.display_name || member.name}
              />
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="truncate text-sm font-medium text-text-primary">
                  {member.display_name || member.name}
                </span>
                <span className="truncate font-mono text-(length:--text-meta) text-text-muted">
                  @{member.name}
                </span>
              </span>
              {editable ? (
                <RoleSelect
                  value={member.role as Exclude<WorkspaceRole, "owner">}
                  disabled={update.isPending}
                  onChange={(role) => onChangeRole(member, role)}
                />
              ) : (
                <RoleBadge role={member.role} />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Read-only role pill. Owner uses a neutral-but-distinct emphasis; admin /
 *  member stay plain so the strip doesn't read like a status signal. */
function RoleBadge({ role }: { role: WorkspaceRole }): JSX.Element {
  return (
    <span
      className={cn(
        "shrink-0 rounded-(--chip-radius) border-(length:--control-border-width) px-2 py-0.5 text-(length:--text-meta) font-medium",
        role === "owner"
          ? "border-border text-text-secondary"
          : "border-border-subtle text-text-muted",
      )}
    >
      {ROLE_LABEL[role]}
    </span>
  );
}

function RoleSelect({
  value,
  disabled,
  onChange,
}: {
  value: Exclude<WorkspaceRole, "owner">;
  disabled: boolean;
  onChange: (role: Exclude<WorkspaceRole, "owner">) => void;
}): JSX.Element {
  return (
    <Select.Root
      value={value}
      onValueChange={(v) => onChange(v as Exclude<WorkspaceRole, "owner">)}
      disabled={disabled}
    >
      <Select.Trigger
        aria-label="Member role"
        className={cn(
          "flex h-7 shrink-0 items-center justify-between gap-1.5 rounded-(--control-radius) bg-bg-base px-2.5 text-xs",
          "border-(length:--control-border-width) border-border transition-colors",
          "hover:border-(--border-control-hover)",
          "data-[state=open]:border-border-focus focus-visible:outline-none focus-visible:border-border-focus",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <Select.Value />
        <Select.Icon>
          <ChevronDown className="size-3 shrink-0 text-text-muted" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          align="end"
          sideOffset={4}
          className="z-(--z-in-dialog) min-w-40 rounded-(--control-radius) border-(length:--control-border-width) border-border bg-bg-floating p-1 text-sm shadow-popover"
        >
          <Select.Viewport>
            {ASSIGNABLE_ROLES.map((role) => (
              <Select.Item
                key={role}
                value={role}
                className="flex cursor-default items-center gap-2 rounded-(--control-radius) px-2 py-1.5 text-text-primary outline-none data-highlighted:bg-bg-hover"
              >
                <span className="flex w-3.5 shrink-0 justify-center">
                  <Select.ItemIndicator>
                    <Check className="size-3" />
                  </Select.ItemIndicator>
                </span>
                <Select.ItemText asChild>
                  <span className="text-xs font-medium">{ROLE_LABEL[role]}</span>
                </Select.ItemText>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function PanelSkeleton(): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-11 animate-pulse rounded-(--control-radius) border border-border-subtle bg-bg-elevated/40"
        />
      ))}
    </div>
  );
}

function PanelMessage({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-(--control-radius) border border-border-subtle bg-bg-elevated/40 p-4 text-sm",
        tone === "error" ? "text-error" : "text-text-muted",
      )}
    >
      <span className="flex flex-1 items-center gap-2">{children}</span>
    </div>
  );
}
