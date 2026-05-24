import { FileText, Image as ImageIcon, X } from 'lucide-react';

/**
 * Top bar shown while MessageList is in multi-select mode.
 *
 * Three buttons, per @shiki's spec:
 * - **Cancel** — exit selection mode entirely (clears selection).
 * - **Save markdown** — export selected messages as a transcript
 *   (sender + time header per row, sorted by seq) and hand off to
 *   the main process for save dialog. Disabled when no rows selected.
 * - **Save image** — open the image preview modal which renders the
 *   selection to PNG and offers Cancel / Copy / Save inside.
 *
 * The export callbacks (`onSaveMarkdown` / `onSaveImage`) are
 * optional — when absent (e.g. before the export pipeline lands)
 * the corresponding button stays disabled with a "coming soon"
 * tooltip. Per Cindy's review the Share *entry* doesn't reach the
 * user until the pipeline is wired, so this state should only ever
 * be visible during interim development with feature flags.
 */
export function SelectionToolbar({
  count,
  onCancel,
  onSaveMarkdown,
  onSaveImage,
}: {
  count: number;
  onCancel: () => void;
  onSaveMarkdown?: () => void;
  onSaveImage?: () => void;
}): JSX.Element {
  const hasSelection = count > 0;
  return (
    <div
      role="toolbar"
      aria-label="Message selection"
      className="flex items-center justify-between gap-3 border-b border-border-subtle bg-bg-floating px-3 py-2 text-xs text-text-primary"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel selection"
          className="inline-flex size-6 items-center justify-center rounded-sm text-text-muted hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
        >
          <X className="size-3.5" />
        </button>
        <span className="font-medium">
          {count === 0 ? '未选择' : `已选 ${count} 条`}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <ToolbarButton
          icon={<FileText className="size-3.5" />}
          label="Save markdown"
          disabled={!hasSelection || !onSaveMarkdown}
          onClick={onSaveMarkdown}
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
      className="inline-flex items-center gap-1 rounded-sm border border-border-subtle bg-bg-elevated px-2 py-1 text-text-primary transition-colors hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
