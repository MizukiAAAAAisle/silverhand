import { type ReactNode } from 'react';
import * as Select from '@radix-ui/react-select';
import { Check } from 'lucide-react';
import { Label } from '@/components/ui/input';
import { cn } from '@/lib/cn';

/**
 * Shared building blocks for filter dropdowns built on the Radix `Select`
 * primitive. Every filter surface (SearchPanel, SavedListView, …) routes its
 * selects through THESE constants + components rather than hand-rolling its own
 * dropdown, so keyboard nav (arrows / typeahead / Enter / Esc), focus ring,
 * portal positioning, and per-theme radius/border all behave identically
 * (Cindy review #task:1258). Radius/border consume control tokens, so forza6
 * stays square + hard-edged automatically.
 *
 * This is the value-list select (a fixed set of options with built-in keyboard
 * nav). The task filter bar's *searchable* channel picker is a combobox and
 * legitimately can't be a plain Select — it shares its keyboard behaviour via a
 * separate roving-focus helper instead (#task:1257).
 */
export const FILTER_SELECT_TRIGGER_CLASS =
  'flex h-8 w-full items-center justify-between gap-2 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating px-2.5 text-xs text-text-primary outline-none transition-colors hover:border-[color:var(--border-control-hover)] focus:border-border-focus data-[placeholder]:text-text-muted';

export const FILTER_SELECT_CONTENT_CLASS =
  'z-[60] max-h-[42vh] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-[var(--select-content-radius)] border border-border bg-bg-floating shadow-popover';

export const FILTER_SELECT_ITEM_CLASS =
  'relative flex cursor-default select-none items-center gap-2 rounded-[var(--select-item-radius)] px-2 py-1.5 pr-7 text-xs text-text-primary outline-none data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary data-[disabled]:cursor-not-allowed data-[disabled]:text-text-muted data-[disabled]:opacity-60 data-[disabled]:data-[highlighted]:bg-transparent';

/** Label-above-control layout for one filter dimension. */
export function FilterBlock({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={cn('block min-w-0', className)}>
      <Label className="mb-1 block">{label}</Label>
      {children}
    </div>
  );
}

/** One option row inside a `Select.Viewport`. `icon` is optional — dimensions
 *  without a natural per-row glyph (e.g. workspaces) render without one.
 *  `disabled` renders the row greyed + non-selectable (Radix skips it in
 *  keyboard nav); pair it with `suffix` to say why (e.g. "Offline"). */
export function FilterSelectItem({
  value,
  icon,
  suffix,
  disabled,
  children,
}: {
  value: string;
  icon?: JSX.Element;
  suffix?: string;
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Select.Item
      value={value}
      disabled={disabled}
      className={FILTER_SELECT_ITEM_CLASS}
    >
      {icon ? <span className="shrink-0 text-text-muted">{icon}</span> : null}
      <Select.ItemText>
        <span className="truncate">{children}</span>
      </Select.ItemText>
      {suffix ? (
        <span className="ml-auto text-[10px] text-text-muted">{suffix}</span>
      ) : null}
      <Select.ItemIndicator className="absolute right-2 inline-flex items-center">
        <Check className="size-3.5 text-accent" />
      </Select.ItemIndicator>
    </Select.Item>
  );
}
