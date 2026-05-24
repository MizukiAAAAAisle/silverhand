import { ClipboardCopy, Download } from 'lucide-react';

/**
 * Top bar shown while MessageList is in multi-select mode.
 *
 * Three right-aligned buttons (shiki `el2J5BByCR02Cy07`):
 * - **Cancel** — exit selection mode entirely (clears selection).
 *   Replaces the previous leading X icon-button — having the cancel
 *   affordance live next to the action buttons gives the toolbar a
 *   single right-side cluster instead of split affordances.
 * - **Copy markdown** — write the selected messages' transcript
 *   (sender + time header per row, sorted by seq) directly to the
 *   system clipboard. Disabled when no rows selected.
 * - **Save image** — open the image preview modal (uses the Download
 *   lucide icon, not Image — shiki feedback: download is the verb,
 *   image is the medium).
 *
 * Theme tokens — wrapper background reads `bg-bg-floating` (= `#FFFFFF`
 * in both forza6 and warm-script; the canonical "paper-white" surface).
 * Buttons read three theme contracts:
 *   - `--control-radius` (forza6 = 0, warm = 6px)
 *   - `--control-border-width` (forza6 = 2px hard-cut, warm = 1px)
 *   - `--bg-control-hover` (each theme's brand-color-mixed hover —
 *     forza6 = 22% pink on white = "节日粉", warm = 22% yellow on white)
 * Hover also lifts each button by 1px (`-translate-y-px`) for a tiny
 * micro-interaction; that came from shiki's request to add a
 * "位移动画" on hover. shiki `0eolIYXZmVVYAjrM` flagged the previous
 * `bg-bg-hover` as too neutral — control hover must read brand.
 *
 * The export callbacks (`onCopyMarkdown` / `onSaveImage`) are
 * optional — when absent the corresponding button stays disabled
 * with a "coming soon" tooltip. Cancel is always enabled because
 * dismissing selection mode never depends on having a selection.
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
      <span className="font-medium">
        {count === 0 ? '未选择' : `已选 ${count} 条`}
      </span>
      <div className="flex items-center gap-2">
        <ToolbarButton label="Cancel" onClick={onCancel} />
        <ToolbarButton
          icon={<ClipboardCopy className="size-3.5" />}
          label="Copy markdown"
          disabled={!hasSelection || !onCopyMarkdown}
          onClick={onCopyMarkdown}
        />
        <ToolbarButton
          icon={<Download className="size-3.5" />}
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
  icon?: React.ReactNode;
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
      className="inline-flex items-center gap-1 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-2 py-1 text-text-primary transition-[background-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:bg-bg-control-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:bg-bg-floating focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
