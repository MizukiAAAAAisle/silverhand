import { ClipboardCopy, Image as ImageIcon, X } from 'lucide-react';

/**
 * Top bar shown while MessageList is in multi-select mode.
 *
 * Three buttons, per @shiki's spec:
 * - **Cancel** — exit selection mode entirely (clears selection).
 * - **Copy markdown** — write the selected messages' transcript
 *   (sender + time header per row, sorted by seq) directly to the
 *   system clipboard. Disabled when no rows selected. Shiki
 *   `vBRFDuOuOqhsYzow`: multi-select markdown share is clipboard, not
 *   a save dialog — sharing flow stays in the app instead of forcing
 *   a file detour.
 * - **Save image** — open the image preview modal which renders the
 *   selection to PNG and offers Cancel / Copy / Save inside.
 *
 * Theme tokens — wrapper uses `bg-bg-elevated` (subtle lift relative
 * to message list) and `border-border-subtle`; control radius reads
 * from `--control-radius` so forza6's hard-cut corners still propagate
 * (forza6 = 0, warm-script = 6px). Avoid hardcoded `rounded-sm` —
 * @shiki `cKM3NLjAQU-idOWD` flagged the previous styling as not
 * following the active theme.
 *
 * The export callbacks (`onCopyMarkdown` / `onSaveImage`) are
 * optional — when absent (e.g. before the export pipeline lands)
 * the corresponding button stays disabled with a "coming soon"
 * tooltip. Per Cindy's review the Share *entry* doesn't reach the
 * user until the pipeline is wired, so this state should only ever
 * be visible during interim development with feature flags.
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
      className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-elevated px-3 py-2 text-xs text-text-primary"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel selection"
          className="inline-flex size-6 items-center justify-center rounded-[var(--control-radius)] text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          <X className="size-3.5" />
        </button>
        <span className="font-medium">
          {count === 0 ? '未选择' : `已选 ${count} 条`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ToolbarButton
          icon={<ClipboardCopy className="size-3.5" />}
          label="Copy markdown"
          disabled={!hasSelection || !onCopyMarkdown}
          onClick={onCopyMarkdown}
        />
        <ToolbarButton
          icon={<ImageIcon className="size-3.5" />}
          label="Save image"
          disabled={!hasSelection || !onSaveImage}
          onClick={onSaveImage}
        />
      </div>
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-[var(--control-radius)] border border-border-subtle bg-bg-floating px-2 py-1 text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg-floating focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
