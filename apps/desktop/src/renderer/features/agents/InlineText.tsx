import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/cn';
import { CancelButton, SaveButton } from './EditToolbarButtons';

/**
 * Inline edit field for a required non-null string, controlled by the
 * parent (the section owns the edit trigger and passes `editing` /
 * `onExitEdit`). Display body shows only the value — the pencil affordance
 * lives in the section header (`ProfileSection titleAdornment`) so all
 * three profile sections use one uniform enter-edit pattern
 * (shiki 2026-07-12 dogfood).
 *
 * Commit is explicit — blur does not save. Enter or the Save button
 * persists; Escape or Cancel discards; focus loss preserves the draft.
 * This differs from `features/hosts/InlineRename`, which commits on blur;
 * #task:1472 gave the agent profile explicit-Save semantics so a stray
 * click on the page can't silently PATCH.
 */

export interface InlineTextProps {
  value: string;
  ariaLabel: string;
  editing: boolean;
  onExitEdit: () => void;
  maxLength?: number;
  className?: string;
  onCommit: (next: string) => Promise<void>;
}

/** Pure commit decision — exported for tests. */
export function decideTextCommit(
  draft: string,
  value: string,
): { commit: false } | { commit: true; next: string } {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return { commit: false };
  if (trimmed === value) return { commit: false };
  return { commit: true, next: trimmed };
}

export function InlineText({
  value,
  ariaLabel,
  editing,
  onExitEdit,
  maxLength = 128,
  className,
  onCommit,
}: InlineTextProps): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorId = useId();

  // Keep draft in sync with the persisted prop while NOT editing (a save
  // or a realtime update replaces `value`; the next edit-enter must start
  // from the current value, not a stale draft). Editing = true is a mutex:
  // we don't clobber an in-flight edit. The enter-edit effect below only
  // handles focus/select/reset — it must NOT re-seed the draft, or the
  // first paint after `editing → true` renders with the previous draft
  // and the second frame updates to `value`, visible as a one-frame flash
  // (Cindy round-8 axis B — draft must be already-correct at first paint).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      setError(null);
      setPending(false);
      // Preserve the profile viewport while entering edit.
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function cancel() {
    if (pending) return;
    setError(null);
    onExitEdit();
  }

  async function commit() {
    if (pending) return;
    const decision = decideTextCommit(draft, value);
    if (!decision.commit) {
      cancel();
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCommit(decision.next);
      onExitEdit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          disabled={pending}
          maxLength={maxLength}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          // No onBlur — commit is explicit only (Enter / Save button).
          // Focus loss preserves the draft. Locked by source fence in
          // InlineText.test.ts.
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'h-8 min-w-0 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2 leading-tight text-text-primary outline-none focus:border-border-focus disabled:opacity-60',
            className,
          )}
        />
        <div className="flex items-center justify-end gap-1.5">
          <CancelButton onClick={cancel} disabled={pending} />
          <SaveButton onClick={() => void commit()} pending={pending} />
        </div>
        {error ? (
          <p id={errorId} className="text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'min-w-0 truncate text-text-primary',
        className,
      )}
    >
      {value}
    </div>
  );
}
