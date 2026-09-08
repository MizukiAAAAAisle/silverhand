import { ClipboardCopy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { neutralAction } from "@/components/common/control-ink-border";
import { primaryAction, primaryCancel } from "@/components/common/primary-action";

/**
 * Top bar shown while MessageList is in multi-select mode — the "share messages
 * as image" entry point.
 *
 * Three right-aligned buttons, ranked by the app-wide poster-action family
 * (shiki 2026-07-26: "share message as image 的时候,顶部的工具条,以及 Image
 * preview 的几个 button 规范也统一一下"):
 * - **Save image** → `primaryAction()`, the green CTA. This bar exists to
 *   produce an image, so exactly ONE button is the commit.
 * - **Copy markdown** → `neutralAction()`, the framed neutral rank. It is a
 *   second, cheaper export path, not a second primary.
 * - **Cancel** → `primaryCancel()`, the way out of selection mode.
 *
 * What this replaced: a local recipe where BOTH exports were "primary" and
 * ranked only on hover, by filling with `--brand-primary` (forza6 #FF2C7A hot
 * pink / warm #FFD440) — two equal primaries, a hue that no longer belongs to
 * commits after #task:1623 moved the CTA to `--bg-control-primary`, and a
 * resting state where all three buttons were indistinguishable. Cancel's
 * lift-only, frameless rest is gone with it: the family's Cancel is a framed
 * surface, the same one every dialog footer uses.
 *
 * `size="xs"` keeps the previous dense metrics (h-6 / px-2 / text-xs) — this bar
 * sits above the message list, not in a dialog footer.
 */
export function SelectionToolbar({
  count,
  onCancel,
  onCopyMarkdown,
  onSaveImage,
}: {
  count: number;
  onCancel: () => void;
  onCopyMarkdown?: () => void;
  onSaveImage?: () => void;
}): JSX.Element {
  const hasSelection = count > 0;
  return (
    <div
      role="toolbar"
      aria-label="Message selection"
      className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-floating px-3 py-2 text-xs text-text-primary"
    >
      <span className="font-medium">{count === 0 ? "None selected" : `${count} selected`}</span>
      <div className="flex items-center gap-2">
        <SelectionActionButton rank="cancel" label="Cancel" onClick={onCancel} />
        <SelectionActionButton
          rank="secondary"
          icon={<ClipboardCopy className="size-3.5" />}
          label="Copy markdown"
          disabled={!hasSelection || !onCopyMarkdown}
          onClick={onCopyMarkdown}
        />
        <SelectionActionButton
          rank="primary"
          icon={<Download className="size-3.5" />}
          label="Save image"
          disabled={!hasSelection || !onSaveImage}
          onClick={onSaveImage}
        />
      </div>
    </div>
  );
}

/**
 * Shared "selection action" button — exported for reuse by the image preview
 * modal so its Copy / Save row is the same three-rank family as this toolbar
 * (one commit, one neutral, one way out). It only maps a rank onto the app-wide
 * hooks; every visual decision lives in those hooks and in the theme rules they
 * paint, so this surface can never drift from a dialog footer again.
 */
export function SelectionActionButton({
  rank,
  icon,
  label,
  disabled,
  onClick,
}: SelectionActionButtonProps): JSX.Element {
  const rankProps =
    rank === "primary"
      ? primaryAction("gap-1")
      : rank === "cancel"
        ? primaryCancel("gap-1")
        : neutralAction("gap-1");
  return (
    <Button
      type="button"
      size="xs"
      variant={rank === "primary" ? "default" : "outline"}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      {...rankProps}
    >
      {icon}
      <span>{label}</span>
    </Button>
  );
}

interface SelectionActionButtonProps {
  /** `primary` = the commit (filled), `secondary` = framed neutral peer,
   *  `cancel` = the way out. */
  rank: "primary" | "secondary" | "cancel";
  icon?: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}
