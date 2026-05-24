import { ClipboardCopy, Download } from 'lucide-react';

/**
 * Top bar shown while MessageList is in multi-select mode.
 *
 * Three right-aligned buttons (shiki `el2J5BByCR02Cy07`,
 * `RNx6OVt9TlK26kjB`):
 * - **Cancel** (variant: 'neutral') — exit selection mode entirely.
 *   Hover lifts the button (`-translate-y-px`) but does NOT add a
 *   background fill — Cancel is a recovery affordance, not a primary
 *   action; lighting it up the same as Copy/Save would muddy the
 *   semantics.
 * - **Copy markdown** (variant: 'primary') — write the selected
 *   messages' transcript directly to the clipboard.
 * - **Save image** (variant: 'primary') — open the image preview
 *   modal. Uses the Download lucide icon (download is the verb).
 *
 * Theme tokens (shiki `RNx6OVt9TlK26kjB` lock):
 *   - border color: `--border-row-selected` — shared with sidebar's
 *     selected-row stroke. forza6 = `#0A0A0A` (hard black), warm =
 *     `var(--accent)` (warm dark).
 *   - radius: `--control-radius` (forza6 0, warm 6px).
 *   - border width: `--control-border-width` (forza6 2px, warm 1px).
 * Primary-variant hover (Copy / Save):
 *   - bg → `--brand-primary` (full festival color: forza6 #FF2C7A
 *     pink, warm #FFD440 yellow)
 *   - text → `--text-on-brand` (forza6 near-black, warm warm-dark) for
 *     legibility on brand fill
 *   - font-weight bold (visual weight matches the bg punch)
 * Neutral-variant hover (Cancel): translate only, no fill, no weight
 * change. Both variants share the `-translate-y-px` micro-lift.
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
        <ToolbarButton variant="neutral" label="Cancel" onClick={onCancel} />
        <ToolbarButton
          variant="primary"
          icon={<ClipboardCopy className="size-3.5" />}
          label="Copy markdown"
          disabled={!hasSelection || !onCopyMarkdown}
          onClick={onCopyMarkdown}
        />
        <ToolbarButton
          variant="primary"
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
  variant,
  icon,
  label,
  disabled,
  onClick,
}: {
  variant: 'primary' | 'neutral';
  icon?: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick?: () => void;
}): JSX.Element {
  // Static base — radius, border width, padding, lift transition. The
  // border *color* and hover state diverge per variant; rest stays
  // shared so the three buttons read as one cluster at a glance.
  const base =
    'inline-flex items-center gap-1 rounded-[var(--control-radius)] ' +
    'border-[length:var(--control-border-width)] ' +
    'border-[color:var(--border-row-selected)] bg-bg-floating ' +
    'px-2 py-1 text-text-primary transition-[background-color,color,transform,font-weight,box-shadow] duration-150 ' +
    'hover:-translate-y-px ' +
    'disabled:cursor-not-allowed disabled:opacity-50 ' +
    'disabled:hover:translate-y-0 disabled:hover:bg-bg-floating disabled:hover:font-normal disabled:hover:text-text-primary ' +
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-focus';
  const variantCls =
    variant === 'primary'
      ? // hover fill is the literal brand color; text inverts to keep
        // contrast (`--text-on-brand`); weight bumps to bold to
        // match the bg punch. shiki `RNx6OVt9TlK26kjB` spec.
        'hover:bg-[color:var(--brand-primary)] hover:text-[color:var(--text-on-brand)] hover:font-bold'
      : // Cancel: lift only, no fill, no weight change.
        '';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={base + (variantCls ? ' ' + variantCls : '')}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
