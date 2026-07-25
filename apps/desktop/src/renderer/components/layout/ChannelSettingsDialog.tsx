/**
 * #task:1109 — Channel settings modal, opened from the conversation
 * header's gear button.
 *
 * Consolidates the per-channel actions (rename + visibility + archive + leave)
 * into a single modal instead of a dropdown popover (@shiki feedback msg
 * `otnb0ykIuDaNTtoC`): a popover whose only job was to proxy into another
 * dialog was one layer of indirection too many — the gear now opens the
 * modal that holds the actions directly. The modal also keeps the header
 * stable (a dense flex row of title + member strip + actions never has to
 * swap the title for an input).
 *
 * Sections render only when their handler / carrier is wired, top → bottom:
 *  - Rename     → `onRename` present (top-level regular channel, not closed)
 *  - Visibility → `onSetVisibility` present AND `canUpdateVisibility` (workspace
 *                 admin) — fail-closed: a missing carrier hides the control.
 *  - Archive    → `onToggleArchive` present (top-level regular channel)
 *  - Leave      → `onLeave` present; disabled with a reason line when the
 *                 carrier says `!canLeave` (owner / last human / archived).
 * The header gear is shown when at least one section is available.
 *
 * Channel titles are free-form (spaces / CJK / `/` are all valid — e.g.
 * "UI/UX 优化"), so rename validation is non-empty + maxLength only, NOT
 * the workspace `NAME_PATTERN`. `onRename` is async and may reject; the
 * rename row surfaces the rejection inline and keeps the modal open so the
 * user can retry or close. `onSetVisibility` / `onLeave` are async the same
 * way — each surfaces its own inline error and stays open on rejection.
 *
 * Visibility toggles in ONE click (reversible — toggle straight back), no
 * confirm: `Make private` / `Make public` fires the PATCH directly and closes
 * the modal on success. Leave keeps a confirm but APPENDS rather than replaces:
 * the Leave button stays put, and clicking it appends below it a
 * `--warning-surface` caution note carrying the consequence line, with the
 * Cancel / Leave confirm buttons beneath the note (outside the tinted surface —
 * the tip is the tip, the buttons are buttons); it stays open on error. Each is
 * its OWN mutation — visibility is never bundled into the rename Save (v1 PATCH
 * is exactly-one).
 *
 * Unified action buttons: Visibility, Archive and Leave are the SAME full-width
 * neutral action — one `variant="outline"` carrying `neutralAction()`, the
 * app-wide framed rank (shiki 2026-07-26: "channel settings 里的 Archive/Restore
 * 是不是应该从旧 hook 统一到 neutralAction?"). They used to carry a modal-local
 * `data-channel-settings-action` hook that resolved to the same forza6 sticker by
 * coincidence rather than by contract — two definitions of one rank, only one of
 * which got the cross-theme hover pair. Each carries a leading glyph of the
 * state/action it commits to (matching Archive / Leave in the same group, shiki
 * 2026-07-21): the Visibility action shows the TARGET-state glyph — `LockOpen`
 * for `Make public`, `Lock` for `Make private` (one lock metaphor, open ↔
 * closed) — the way Archive shows `Archive` / `ArchiveRestore`.
 * Save (rename) is the only solid `default` primary; the three action buttons
 * never compete with it.
 *
 * Destructive weight lives at the CONFIRM step, not the resting row: the
 * resting Leave button is the same neutral action button as the others; only
 * Leave's warning-tip confirm buttons carry the destructive rank, so the modal
 * stays calm until the moment the choice is committed.
 *
 * That confirm is a PAIR and joins the app-wide destructive family (shiki
 * 2026-07-26: "Channel settings 里 Leave 确认的那个 Cancel 和 Leave 两个 action
 * button 也一起统一"): `Leave` = `destructiveAction()` + `DESTRUCTIVE_TRIGGER`
 * (red frame on paper, the `Delete computer` shape), `Cancel` =
 * `destructiveCancel()` (the one neutral framed surface). Before this the Cancel
 * was `ghost` — no paper at all beside a tinted Leave — and the Leave's red was
 * a local `border-error/40` + `hover:bg-error/10`, the alpha-thinned recipe shiki
 * had already rejected elsewhere for reading as washed.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Loader2, Lock, LockOpen, LogOut } from 'lucide-react';
import type {
  ChannelLeaveBlockedReason,
  ConversationVisibility,
} from '@silverhand/shared';
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
  DESTRUCTIVE_TRIGGER,
} from '@/features/common/DestructiveAction';

/** Client-side cap. Keep in sync with the backend rename schema. */
const MAX_TITLE_LENGTH = 128;

interface ChannelSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
   *  surfaces rejection inline and keeps the modal open. */
  onSetVisibility?: (visibility: ConversationVisibility) => Promise<void>;
  isArchived: boolean;
  /** Toggle archive state. Absent → the archive section is hidden. */
  onToggleArchive?: (archived: boolean) => void;
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
function leaveBlockedCopy(
  reason: ChannelLeaveBlockedReason | null | undefined,
): string | null {
  switch (reason) {
    case 'channel_owner':
      return "As the owner, you can't leave this channel.";
    case 'last_human_member':
      return "As the last member, you can't leave this channel.";
    case 'channel_archived':
      return 'Restore the channel before leaving.';
    default:
      return null;
  }
}

export function ChannelSettingsDialog({
  open,
  onOpenChange,
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
}: ChannelSettingsDialogProps): JSX.Element {
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Visibility toggle: one-click execute (reversible — toggle straight back),
  // so no confirm step; just its own async + error state.
  const [visSaving, setVisSaving] = useState(false);
  const [visError, setVisError] = useState<string | null>(null);

  // Leave: inline two-step confirm + its own async state.
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // Reseed every time the modal reopens (the channel — or its title /
  // visibility — may have changed since last open), and collapse any
  // half-open confirm so it never lingers into the next open.
  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setError(null);
      setSaving(false);
      setVisSaving(false);
      setVisError(null);
      setLeaveConfirm(false);
      setLeaving(false);
      setLeaveError(null);
    }
  }, [open, currentTitle]);

  const trimmed = title.trim();
  const dirty = trimmed !== currentTitle.trim();
  const saveDisabled = !onRename || saving || trimmed === '' || !dirty;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!onRename || saveDisabled) return;
    setSaving(true);
    setError(null);
    try {
      await onRename(trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  // Archive toggles are fire-and-forget at this layer; close the modal so
  // the user immediately sees the channel's new placement (the archived
  // channel may also leave the active list under us).
  const handleToggleArchive = (): void => {
    if (!onToggleArchive || archivePending) return;
    onToggleArchive(!isArchived);
    onOpenChange(false);
  };

  const isPrivate = visibility === 'private';
  const nextVisibility: ConversationVisibility = isPrivate ? 'public' : 'private';
  const showVisibility =
    !!onSetVisibility && canUpdateVisibility && visibility !== undefined;

  const handleToggleVisibility = async (): Promise<void> => {
    if (!onSetVisibility || visSaving) return;
    setVisSaving(true);
    setVisError(null);
    try {
      await onSetVisibility(nextVisibility);
      // Success closes the modal — the flipped glyph shows in the header/sidebar.
      onOpenChange(false);
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
      // Success closes the modal; the caller collapses the view (public) or
      // navigates away (private).
      onOpenChange(false);
    } catch (err) {
      setLeaveError(err instanceof Error ? err.message : String(err));
      setLeaving(false);
      // Keep the tip open so the error shows in context and Cancel/retry stay
      // reachable.
    }
  };

  const blockedCopy = leaveBlockedCopy(leaveBlockedReason);

  // Rename is its own layer (a labelled text input); Visibility / Archive /
  // Leave are one ACTION GROUP — stacked tight with NO divider between them.
  // Only Rename ↔ group gets a separator.
  const renameNode = onRename ? (
    <form className="flex flex-col gap-2" onSubmit={e => void handleSubmit(e)}>
      <Label htmlFor="channel-settings-name">Channel name</Label>
      <div className="flex items-center gap-2">
        <Input
          id="channel-settings-name"
          autoFocus
          value={title}
          maxLength={MAX_TITLE_LENGTH}
          spellCheck={false}
          disabled={saving}
          onChange={e => setTitle(e.target.value)}
        />
        <Button
          type="submit"
          disabled={saveDisabled}
          {...primaryAction('shrink-0')}
        >
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
      key: 'visibility',
      node: (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            {...neutralAction('w-full')}
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
            {isPrivate ? 'Make public' : 'Make private'}
          </Button>
          {visError ? <p className="text-xs text-error">{visError}</p> : null}
        </div>
      ),
    });
  }

  if (onToggleArchive) {
    actions.push({
      key: 'archive',
      node: (
        <Button
          type="button"
          variant="outline"
          disabled={archivePending}
          onClick={handleToggleArchive}
          {...neutralAction('w-full')}
        >
          {isArchived ? (
            <ArchiveRestore className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
          {isArchived ? 'Restore channel' : 'Archive channel'}
        </Button>
      ),
    });
  }

  if (onLeave) {
    actions.push({
      key: 'leave',
      // The Leave button stays put; clicking it APPENDS a warning tip below it
      // (never replaces the row) carrying the consequence + Cancel/confirm.
      node: canLeave ? (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            {...neutralAction('w-full')}
            disabled={leaving}
            onClick={() => setLeaveConfirm(true)}
          >
            <LogOut className="size-3.5" />
            Leave channel
          </Button>
          {leaveConfirm ? (
            <div className="flex flex-col gap-2.5">
              <div className="rounded-[var(--control-radius)] bg-[var(--warning-surface)] px-3 py-2.5">
                <p className="text-sm leading-relaxed text-text-primary">
                  {isPrivate
                    ? "You won't be able to rejoin unless you're added back."
                    : 'You can rejoin this channel anytime.'}
                </p>
              </div>
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={leaving}
                  onClick={() => setLeaveConfirm(false)}
                  {...destructiveCancel()}
                >
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={leaving}
                  onClick={() => void handleConfirmLeave()}
                  {...destructiveAction(DESTRUCTIVE_TRIGGER)}
                >
                  {leaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <LogOut className="size-3.5" />
                  )}
                  Leave
                </Button>
              </div>
              {leaveError ? (
                <p className="text-xs text-error">{leaveError}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            disabled
            {...neutralAction('w-full')}
          >
            <LogOut className="size-3.5" />
            Leave channel
          </Button>
          {blockedCopy ? (
            <p className="text-xs text-text-secondary">{blockedCopy}</p>
          ) : null}
        </div>
      ),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Channel settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {renameNode}
          {renameNode && actions.length > 0 ? (
            <div className="border-t border-border-subtle" />
          ) : null}
          {actions.length > 0 ? (
            <div className="flex flex-col gap-2">
              {actions.map(action => (
                <Fragment key={action.key}>{action.node}</Fragment>
              ))}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
