/**
 * #task:1109 — Channel settings modal, opened from the conversation
 * header's gear button.
 *
 * Consolidates the per-channel actions (rename + archive) into a single
 * modal instead of a dropdown popover (@shiki feedback msg
 * `otnb0ykIuDaNTtoC`): a popover whose only job was to proxy into another
 * dialog was one layer of indirection too many — the gear now opens the
 * modal that holds the actions directly. The modal also keeps the header
 * stable (a dense flex row of title + member strip + actions never has to
 * swap the title for an input).
 *
 * Sections render only when their handler is wired:
 *  - Rename  → `onRename` present (top-level regular channel, not closed)
 *  - Archive → `onToggleArchive` present (top-level regular channel)
 * The header gear is shown when at least one section is available, so the
 * modal always has at least one actionable section.
 *
 * Channel titles are free-form (spaces / CJK / `/` are all valid — e.g.
 * "UI/UX 优化"), so rename validation is non-empty + maxLength only, NOT
 * the workspace `NAME_PATTERN`. `onRename` is async and may reject; the
 * rename row surfaces the rejection inline and keeps the modal open so the
 * user can retry or close.
 *
 * Single primary CTA: Save (rename) is the only `default` button — Archive
 * is a neutral `outline` action (archive is organizational + reversible,
 * not destructive) so the modal never shows two competing primaries.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Archive, ArchiveRestore, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

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
  isArchived: boolean;
  /** Toggle archive state. Absent → the archive section is hidden. */
  onToggleArchive?: (archived: boolean) => void;
  archivePending?: boolean;
}

export function ChannelSettingsDialog({
  open,
  onOpenChange,
  currentTitle,
  onRename,
  isArchived,
  onToggleArchive,
  archivePending = false,
}: ChannelSettingsDialogProps): JSX.Element {
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reseed every time the modal reopens (the channel — or its title —
  // may have changed since last open).
  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setError(null);
      setSaving(false);
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Channel settings</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {onRename ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={e => void handleSubmit(e)}
            >
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
                <Button type="submit" disabled={saveDisabled} className="shrink-0">
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Save
                </Button>
              </div>
              {error ? <p className="text-xs text-error">{error}</p> : null}
            </form>
          ) : null}

          {onRename && onToggleArchive ? (
            <div className="border-t border-border-subtle" />
          ) : null}

          {onToggleArchive ? (
            <Button
              type="button"
              variant="outline"
              disabled={archivePending}
              onClick={handleToggleArchive}
              data-channel-settings-archive
              className="w-full"
            >
              {isArchived ? (
                <ArchiveRestore className="size-3.5" />
              ) : (
                <Archive className="size-3.5" />
              )}
              {isArchived ? 'Restore channel' : 'Archive channel'}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
