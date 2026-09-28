import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, Loader2, Lock, LockOpen, LogOut } from "lucide-react";
import type { ChannelLeaveBlockedReason, ConversationVisibility } from "@silverhand/shared";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/** Client-side cap. Keep in sync with the backend rename schema. */
const MAX_TITLE_LENGTH = 128;

interface ChannelSettingsDetailsProps {
  notifications?: ReactNode;
  /** The channel's current title (no `#` prefix — that's presentational). */
  currentTitle: string;
  /** Persist the trimmed new title. Rejects with a surfaced message.
   *  Absent → the rename section is hidden (e.g. a closed channel). */
  onRename?: (title: string) => Promise<void>;
  /** Current stored visibility, from the channel-detail carrier. Drives the
   *  glyph + the Public/Private label + the leave consequence copy. */
  visibility?: ConversationVisibility;
  /** Whether the viewer may toggle visibility (workspace admin). Fail-closed:
   *  the visibility section is hidden unless this is `true` AND `onSetVisibility`
   *  is wired AND `visibility` resolved. */
  canUpdateVisibility?: boolean;
  /** Persist the new visibility (its own exactly-one-field PATCH). Async;
   *  surfaces rejection inline and keeps the panel open. */
  onSetVisibility?: (visibility: ConversationVisibility) => Promise<void>;
  isArchived: boolean;
  /** Toggle archive state. Absent → the archive section is hidden. */
  onToggleArchive?: (archived: boolean) => Promise<void>;
  archivePending?: boolean;
  /** Self-leave the channel. Async; surfaces rejection inline. Absent → the
   *  leave section is hidden. Present but `!canLeave` → disabled + reason. */
  onLeave?: () => Promise<void>;
  /** Whether the viewer may leave, from the carrier. Fail-closed default. */
  canLeave?: boolean;
  /** Stable reason the viewer may NOT leave (renderer owns the copy). */
  leaveBlockedReason?: ChannelLeaveBlockedReason | null;
}

/** Human copy for a leave-blocked reason. The backend emits only the stable
 *  code; UI text is never outsourced to the backend. `null` → no line (either
 *  leave is allowed, or a code that shouldn't reach a member, e.g. not_member). */
function leaveBlockedCopy(reason: ChannelLeaveBlockedReason | null | undefined): string | null {
  switch (reason) {
    case "channel_owner":
      return "As the owner, you can't leave this channel.";
    case "last_human_member":
      return "As the last member, you can't leave this channel.";
    case "channel_archived":
      return "Restore the channel before leaving.";
    default:
      return null;
  }
}

export function ChannelSettingsDetails({
  notifications,
  currentTitle,
  onRename,
  visibility,
  canUpdateVisibility = false,
  onSetVisibility,
  isArchived,
  onToggleArchive,
  archivePending = false,
  onLeave,
  canLeave = false,
  leaveBlockedReason = null,
}: ChannelSettingsDetailsProps): JSX.Element {
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Visibility toggle: one-click execute (reversible — toggle straight back),
  // so no confirm step; just its own async + error state.
  const [visSaving, setVisSaving] = useState(false);
  const [visError, setVisError] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  // Leave: inline two-step confirm + its own async state.
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // The host remounts on channel changes; a successful rename refreshes the form.
  useEffect(() => {
    setTitle(currentTitle);
    setError(null);
    setSaving(false);
    setVisSaving(false);
    setVisError(null);
    setLeaveConfirm(false);
    setLeaving(false);
    setLeaveError(null);
  }, [currentTitle]);

  const trimmed = title.trim();
  const dirty = trimmed !== currentTitle.trim();
  const saveDisabled = !onRename || saving || trimmed === "" || !dirty;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!onRename || saveDisabled) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(trimmed);
      setSaving(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const handleToggleArchive = async (): Promise<void> => {
    if (!onToggleArchive || archivePending) return;
    setArchiveError(null);
    try {
      await onToggleArchive(!isArchived);
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : String(err));
    }
  };

  const isPrivate = visibility === "private";
  const nextVisibility: ConversationVisibility = isPrivate ? "public" : "private";
  const showVisibility = !!onSetVisibility && canUpdateVisibility && visibility !== undefined;

  const handleToggleVisibility = async (): Promise<void> => {
    if (!onSetVisibility || visSaving) return;
    setVisSaving(true);
    setVisError(null);
    try {
      await onSetVisibility(nextVisibility);
      setVisSaving(false);
    } catch (err) {
      setVisError(err instanceof Error ? err.message : String(err));
      setVisSaving(false);
    }
  };

  const handleConfirmLeave = async (): Promise<void> => {
    if (!onLeave || leaving) return;
    setLeaving(true);
    setLeaveError(null);
    try {
      await onLeave();
      // The host owns navigation after leaving.
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : String(err));
      setLeaving(false);
      // Keep the tip open so the error shows in context and Cancel/retry stay
      // reachable.
    }
  };

  const blockedCopy = leaveBlockedCopy(leaveBlockedReason);

  const renameNode = onRename ? (
    <form className="flex flex-col gap-2" onSubmit={(e) => void handleSubmit(e)}>
      <Label htmlFor="channel-settings-name">Channel name</Label>
      <div className="flex items-center gap-2">
        <Input
          id="channel-settings-name"
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          spellCheck={false}
          disabled={saving}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Button type="submit" variant="primary" className="shrink-0" disabled={saveDisabled}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Save
        </Button>
      </div>
      {error ? <p className="text-xs text-error">{error}</p> : null}
    </form>
  ) : null;

  const actions: { key: string; node: JSX.Element }[] = [];

  if (showVisibility) {
    actions.push({
      key: "visibility",
      node: (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="neutral"
            className="w-full"
            disabled={visSaving}
            onClick={() => void handleToggleVisibility()}
          >
            {visSaving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : isPrivate ? (
              <LockOpen className="size-3.5" />
            ) : (
              <Lock className="size-3.5" />
            )}
            {isPrivate ? "Make public" : "Make private"}
          </Button>
          {visError ? <p className="text-xs text-error">{visError}</p> : null}
        </div>
      ),
    });
  }

  if (onToggleArchive) {
    actions.push({
      key: "archive",
      node: (
        <Button
          type="button"
          variant="neutral"
          className="w-full"
          disabled={archivePending}
          onClick={() => void handleToggleArchive()}
        >
          {isArchived ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
          {isArchived ? "Restore channel" : "Archive channel"}
        </Button>
      ),
    });
  }

  if (onLeave) {
    actions.push({
      key: "leave",
      // The Leave button stays put; clicking it APPENDS a warning tip below it
      // (never replaces the row) carrying the consequence + Cancel/confirm.
      node: canLeave ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="neutral"
            className="w-full"
            disabled={leaving}
            onClick={() => setLeaveConfirm(true)}
          >
            <LogOut className="size-3.5" />
            Leave channel
          </Button>
          {leaveConfirm ? (
            <div className="flex flex-col gap-2.5">
              <div className="rounded-(--control-radius) bg-(--warning-surface) px-3 py-2.5">
                <p className="text-sm leading-relaxed text-text-primary">
                  {isPrivate
                    ? "You won't be able to rejoin unless you're added back."
                    : "You can rejoin this channel anytime."}
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="cancel"
                  size="sm"
                  disabled={leaving}
                  onClick={() => setLeaveConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive-outline"
                  size="sm"
                  disabled={leaving}
                  onClick={() => void handleConfirmLeave()}
                >
                  {leaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <LogOut className="size-3.5" />
                  )}
                  Leave
                </Button>
              </div>
              {leaveError ? <p className="text-xs text-error">{leaveError}</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="neutral" className="w-full" disabled>
            <LogOut className="size-3.5" />
            Leave channel
          </Button>
          {blockedCopy ? <p className="text-xs text-text-secondary">{blockedCopy}</p> : null}
        </div>
      ),
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">INFO</h3>
        {renameNode ?? (
          <div>
            <p className="text-xs text-text-muted">Channel name</p>
            <p className="mt-1 text-sm font-medium">{currentTitle}</p>
          </div>
        )}
        {isArchived ? <p className="mt-2 text-xs text-text-muted">Archived</p> : null}
      </section>
      {notifications}
      {archiveError ? (
        <p role="alert" className="text-xs text-error">
          {archiveError}
        </p>
      ) : null}
      {actions.length > 0 ? (
        <section className="flex flex-col gap-2">
          {actions.map((action) => (
            <Fragment key={action.key}>{action.node}</Fragment>
          ))}
        </section>
      ) : null}
    </div>
  );
}
