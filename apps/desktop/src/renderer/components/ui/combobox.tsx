import { useId, useRef, useState, type KeyboardEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Editable combobox — a free-text input paired with a suggestions dropdown.
 *
 * Unlike a Radix `Select` (closed value set), this ACCEPTS any typed value
 * AND offers quick-pick suggestions. Used for the agent Model field: qoder
 * exposes capability tiers as suggestions but any model-id string is valid
 * (shiki #task:1328). Reasoning stays a plain Select — it has a small closed
 * value set and must not accept unknown values.
 *
 * Styling consumes the same per-theme control tokens as `filter-select.tsx`
 * (`--control-radius`, `--control-border-width`, `--select-*`) so it inherits
 * forza6's square/hard-edged look without a bespoke visual language.
 *
 * Focus discipline: the popover never steals focus from the input
 * (`onOpenAutoFocus` prevented); suggestion rows `preventDefault` on
 * mousedown so selecting one doesn't blur-commit the in-progress draft first.
 */
export function Combobox({
  value,
  onChange,
  onCommit,
  suggestions,
  placeholder,
  id,
  className,
  ariaLabel,
}: {
  value: string;
  /** Fired on each keystroke (draft update). */
  onChange: (next: string) => void;
  /** Fired when the value is committed: blur, Enter, or picking a suggestion. */
  onCommit: (next: string) => void;
  suggestions: readonly string[];
  placeholder?: string;
  id?: string;
  className?: string;
  ariaLabel?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const hasSuggestions = suggestions.length > 0;

  const pick = (v: string) => {
    onChange(v);
    onCommit(v);
    setOpen(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit(value);
      setOpen(false);
    } else if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown' && hasSuggestions && !open) {
      setOpen(true);
    }
  };

  return (
    <Popover.Root open={open && hasSuggestions} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div
          className={cn(
            'flex items-center rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-floating transition-colors',
            'hover:border-[color:var(--border-control-hover)]',
            'focus-within:border-border-focus',
            className,
          )}
        >
          <input
            ref={inputRef}
            id={id}
            role="combobox"
            aria-expanded={open && hasSuggestions}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={ariaLabel}
            value={value}
            placeholder={placeholder}
            onChange={e => {
              onChange(e.target.value);
              if (hasSuggestions) setOpen(true);
            }}
            onFocus={() => hasSuggestions && setOpen(true)}
            onClick={() => hasSuggestions && setOpen(true)}
            onBlur={() => onCommit(value)}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent px-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
          />
          {hasSuggestions ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Show suggestions"
              // Keep input focus; just toggle the list.
              onMouseDown={e => e.preventDefault()}
              onClick={() => {
                setOpen(o => !o);
                inputRef.current?.focus();
              }}
              className="flex shrink-0 items-center px-1.5 text-text-muted hover:text-text-primary"
            >
              <ChevronDown className="size-3.5" />
            </button>
          ) : null}
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id={listId}
          align="start"
          sideOffset={4}
          onOpenAutoFocus={e => e.preventDefault()}
          className="z-[60] max-h-[42vh] min-w-[var(--radix-popover-trigger-width)] overflow-y-auto rounded-[var(--select-content-radius)] border border-border bg-bg-floating p-1 shadow-popover"
        >
          {suggestions.map(s => (
            <button
              key={s}
              type="button"
              // preventDefault so the input doesn't blur-commit before this
              // click lands (which would fire onCommit twice with the draft).
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(s)}
              className={cn(
                'flex w-full items-center rounded-[var(--select-item-radius)] px-2 py-1.5 text-left text-sm text-text-primary outline-none',
                'hover:bg-bg-hover',
                s === value ? 'bg-bg-hover' : '',
              )}
            >
              {s}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
