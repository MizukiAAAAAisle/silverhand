/**
 * `#task:808` slice 4 — minimal inline-rename field.
 *
 * The renderer has no prior inline-edit primitive (all renames were
 * dialog-driven before, e.g. `WorkspaceSettingsDialog`). This component
 * is intentionally narrow:
 *   - Display mode shows `valueDisplay` (current label, falling back
 *     to placeholder) with a pencil-hover affordance.
 *   - Activates on click of the pencil button OR a double-click on the
 *     display text — keeps the row keyboard-accessible (`<button>`).
 *   - Edit mode shows an `<input>` prefilled with the live label;
 *     Enter commits, Esc cancels, blur commits. Empty string commits
 *     as `null` (clear-the-label flow, matches the route's repo-side
 *     `empty → null` rule).
 *   - Submission is async via `onCommit`; the field stays in edit
 *     mode + disabled until the promise settles, with an inline
 *     error banner if it rejects. On resolve we exit edit mode.
 *
 * **No-op semantics (Cindy `bpBngcaDmQrQ9M_Q` P1):** when `value` is
 * `null` we seed the input with `fallbackForEdit` (typically the
 * entity's stable `name`) so the user starts from a non-empty
 * baseline. The naive check `next === value` would then fire a PATCH
 * the moment the user double-clicked and immediately blurred —
 * `host.name` would be persisted as the label, breaking the
 * `display_label ?? name` nullable model. Two-arm no-op:
 *   (a) user didn't change the draft they started with (`trimmed ===
 *       initialDraft`) — the dominant case, covers the silent blur, and
 *   (b) the committed value already matches the live `value` (catches
 *       "user cleared a fallback seed when value was already null").
 * Single source of error: we DO NOT take an `errorMessage` prop. The
 * parent's mutation result reaches us through `onCommit`'s rejection.
 *
 * **No DOM length cap (#task:1849).** The field used to carry a
 * `maxLength` (default 128, a bound nothing else shared). It is gone,
 * and deliberately not replaced by the schema's 64: `display_label` is
 * bounded AFTER `.trim()`, so a `maxLength` would cut a padded paste at
 * the raw code-unit count and persist a name the user never typed — a
 * silent client-side rewrite, which is exactly what shiki's ruling
 * removed from the server. Length is now refused loudly like every
 * other rule, with the reason arriving through `onCommit` (see
 * `rejectHostLabel` in `./host-label`). Same shape as the display-name
 * editors in `features/identity/display-name`.
 *
 * Layout/styling is deliberately bare so the host header can swap
 * typography per surface. Tokens used are existing
 * (`text-text-primary` / `text-text-muted` / `--control-radius`); no
 * new CSS.
 */
import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface InlineRenameProps {
  /** Current label rendered in display mode. May be `null` when no
   *  rename has been applied yet — the component shows `placeholder`
   *  in that case but seeds the edit input with `fallbackForEdit`
   *  (typically the host's stable `name`) so the user starts from a
   *  reasonable baseline. */
  value: string | null;
  /** Fallback rendered in display mode when `value` is null. Usually
   *  the entity's stable name (`host.name`). */
  placeholder: string;
  /** Initial text shown inside the input when the user enters edit
   *  mode and `value` is null. Defaults to `placeholder`. */
  fallbackForEdit?: string;
  /** Accessible label for the rename trigger / input. */
  ariaLabel: string;
  /** Async commit. Receives the trimmed string (empty → null to
   *  signal "clear"). Resolve to exit edit mode; reject to surface
   *  the message inline without losing the draft. */
  onCommit: (next: string | null) => Promise<void>;
}

/**
 * Pure decision: given the current draft, the snapshot of what the
 * input showed at edit-mode entry, and the live persisted `value`,
 * decide whether to commit a PATCH and what to send.
 *
 * Returns `{ commit: false }` for:
 *   - draft equal (after trim) to the initial seeded view — the
 *     "double-clicked, didn't change, blurred" branch,
 *   - normalized `next` equal to the live `value` — the "deleted
 *     fallback seed when value was already null" branch, AND any
 *     symmetric "typed the same string that's already persisted".
 *
 * Otherwise `{ commit: true; next }` with `next` empty→null.
 */
export function decideRenameCommit(
  draft: string,
  initialDraft: string,
  value: string | null,
): { commit: false } | { commit: true; next: string | null } {
  const trimmed = draft.trim();
  const next: string | null = trimmed.length === 0 ? null : trimmed;
  if (trimmed === initialDraft.trim()) return { commit: false };
  if (next === value) return { commit: false };
  return { commit: true, next };
}

export function InlineRename({
  value,
  placeholder,
  fallbackForEdit,
  ariaLabel,
  onCommit,
}: InlineRenameProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Snapshot of the input contents at edit-mode entry. Used as the
  // no-op baseline so a silent blur after seeding from `fallbackForEdit`
  // does NOT promote the seed string into a persisted label.
  const initialDraftRef = useRef<string>("");
  const errorId = useId();

  function enterEdit() {
    const seeded = value ?? fallbackForEdit ?? placeholder;
    setDraft(seeded);
    initialDraftRef.current = seeded;
    setError(null);
    setEditing(true);
  }

  function cancel() {
    if (pending) return;
    setEditing(false);
    setDraft("");
    setError(null);
  }

  async function commit() {
    if (pending) return;
    const decision = decideRenameCommit(draft, initialDraftRef.current, value);
    if (!decision.commit) {
      setEditing(false);
      setDraft("");
      setError(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await onCommit(decision.next);
      setEditing(false);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setPending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <input
            ref={inputRef}
            type="text"
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void commit()}
            aria-label={ariaLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            // Typography (font, size, weight) intentionally inherits
            // from the wrapping element so the caller controls it
            // (e.g. the Hero wraps with `font-serif text-lg font-semibold`).
            // Tailwind preflight sets `font: inherit` on form elements,
            // so we only style chrome here.
            //
            // Height matches the ghost `<Button size="icon">` next to us
            // and the parent Hero's Refresh button (`h-8` = 32px) so the
            // edit row reads as one aligned control strip rather than
            // tall-input + tiny-button (shiki dogfood `aF5e0z_kHXo1Omv7`).
            // Border width is driven by `--control-border-width`
            // (forza6 = 2px, warm = 1px) so the focus stroke matches the
            // theme's chrome weight.
            className={cn(
              "h-8 min-w-0 flex-1 rounded-[var(--control-radius)] border-[length:var(--control-border-width)] border-border bg-bg-base px-2 leading-tight text-text-primary outline-none focus:border-accent disabled:opacity-60",
            )}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // Prevent blur on the input from firing commit() before
            // our cancel — mouse down on a sibling button defaults to
            // blurring the focused input.
            onMouseDown={(e) => {
              e.preventDefault();
              cancel();
            }}
            disabled={pending}
            aria-label="Cancel rename"
            title="Cancel"
          >
            <X className="size-3.5" />
          </Button>
        </div>
        {error ? (
          <p id={errorId} className="text-xs text-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  const displayed = value && value.trim().length > 0 ? value : placeholder;
  const isFallback = !value || value.trim().length === 0;
  return (
    <div className="group/inline-rename flex min-w-0 items-center gap-1">
      <button
        type="button"
        onDoubleClick={enterEdit}
        aria-label={`${ariaLabel} (double-click to rename)`}
        title="Double-click to rename"
        // Typography inherits from the wrapping element so the caller
        // owns the visual weight (e.g. Hero wraps in `font-serif
        // text-lg font-semibold`). We only color the fallback variant
        // since that's a UX cue ("this is a placeholder, not your
        // chosen name"), not a layout decision.
        className={cn(
          "min-w-0 truncate rounded-[var(--control-radius)] px-1 py-0.5 text-left transition-colors",
          isFallback ? "text-text-muted italic" : "text-text-primary",
        )}
      >
        {displayed}
      </button>
      <button
        type="button"
        onClick={enterEdit}
        aria-label={ariaLabel}
        title="Rename"
        className="shrink-0 rounded-[var(--control-radius)] p-1 text-text-muted opacity-0 transition-opacity hover:bg-bg-hover hover:text-text-primary group-hover/inline-rename:opacity-100 focus-visible:opacity-100"
      >
        <Pencil className="size-3.5" />
      </button>
    </div>
  );
}
