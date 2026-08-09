import {
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { cn } from '@/lib/cn';
import { CancelButton, SaveButton } from '@/features/common/EditToolbarButtons';

/**
 * Inline edit textarea for a nullable long-form string (agent description,
 * etc.), controlled by the parent (edit trigger lives in the section
 * header via `ProfileSection titleAdornment`). Same interaction shape as
 * `InlineText`, but the value is `string | null` — empty → `null` commits
 * a clear.
 *
 * Contract:
 *  - Display mode: value (or the muted placeholder when null). No inline
 *    pencil; entering edit is the header trigger's job.
 *  - Edit mode: `<textarea>` prefilled with the current value.
 *    `Ctrl/⌘+Enter` commits; plain Enter inserts newline; Esc cancels.
 *    Explicit Save required — long-form drafts must not blur-commit.
 */
export interface InlineTextareaProps {
  value: string | null;
  placeholder: string;
  ariaLabel: string;
  editing: boolean;
  onExitEdit: () => void;
  rows?: number;
  maxLength?: number;
  onCommit: (next: string | null) => Promise<void>;
}

export function decideTextareaCommit(
  draft: string,
  value: string | null,
): { commit: false } | { commit: true; next: string | null } {
  const trimmed = draft;
  const next: string | null = trimmed.length === 0 ? null : trimmed;
  if (next === value) return { commit: false };
  if (next === null && (value === null || value === '')) {
    // "still empty" — nothing to persist.
    return { commit: false };
  }
  return { commit: true, next };
}

export function InlineTextarea({
  value,
  placeholder,
  ariaLabel,
  editing,
  onExitEdit,
  rows = 3,
  maxLength = 2000,
  onCommit,
}: InlineTextareaProps): JSX.Element {
  const [draft, setDraft] = useState(value ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const errorId = useId();

  // Keep draft synced to prop while NOT editing (save / realtime updates
  // replace `value`; next edit-enter reads that new value, not stale
  // draft). Enter-edit only focuses/resets — never re-seeds — so the
  // first paint after `editing → true` has the correct value already
  // (Cindy round-8 axis B — no blank→value one-frame flash).
  useEffect(() => {
    if (!editing) setDraft(value ?? '');
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      setError(null);
      setPending(false);
      // Preserve the profile viewport while entering edit.
      textareaRef.current?.focus({ preventScroll: true });
      const len = textareaRef.current?.value.length ?? 0;
      textareaRef.current?.setSelectionRange(len, len);
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
    const decision = decideTextareaCommit(draft, value);
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

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
        <textarea
          ref={textareaRef}
          data-input=""
          value={draft}
          disabled={pending}
          rows={rows}
          maxLength={maxLength}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label={ariaLabel}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            'w-full resize-none rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2 py-1.5 text-sm leading-relaxed text-text-primary outline-none focus:border-border-focus disabled:opacity-60',
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

  const hasValue = value !== null && value.length > 0;
  return (
    <div
      className={cn(
        'whitespace-pre-wrap text-sm leading-relaxed',
        hasValue ? 'text-text-primary' : 'text-text-muted italic',
      )}
    >
      {hasValue ? value : placeholder}
    </div>
  );
}
