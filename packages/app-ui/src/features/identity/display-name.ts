import { DISPLAY_NAME_MAX_LENGTH, DisplayNameSchema } from "@silverhand/shared";
import type { ZodError } from "zod";

/**
 * Client-side gate for every `display_name` write, human and agent.
 *
 * The authority is the shared `DisplayNameSchema` — trim → 1..
 * `DISPLAY_NAME_MAX_LENGTH` → no control characters or Unicode line
 * separators. Editors call in here instead of re-deriving the rule, and
 * they carry NO DOM `maxLength`, because a length attribute is wrong on
 * both counts (@Alice / @Cindy 2026-08-06, #task:1846):
 *   - it filters nothing else — a single-line `<input>` swallows CR/LF but
 *     keeps a pasted U+2028 / U+2029 / U+0085 / DEL, which the schema's
 *     refinement rejects, so that value looks submittable and fails as a
 *     400;
 *   - and it counts the RAW string while the schema counts the TRIMMED
 *     one, so capping at the schema's bound cuts a padded paste short and
 *     saves the truncated name with no word to the viewer — a silent
 *     rewrite, worse than the 400.
 *
 * Parsing before the request is the same shape the host rename mutation
 * already uses (`UpdateHostInputSchema.parse`).
 *
 * The rejection copy is ours, not Zod's: the schema's messages name the
 * wire field (`display_name must not contain…`) and are written for API
 * consumers. We read the issue *code* to pick a line, so the wording is
 * product copy while the rule stays in one place.
 */

/** What `Save` would do with the current draft. */
export type DisplayNameDraft =
  /** Untouched — nothing to save. */
  | { kind: "pristine" }
  /** Blank. Nothing to say: an empty field says it itself. */
  | { kind: "empty" }
  /** Equal to the persisted value once trimmed — a no-op save. */
  | { kind: "unchanged" }
  /** Refused by the schema, with a line the viewer can act on. */
  | { kind: "rejected"; message: string }
  /** Submittable, `value` being exactly what to send. */
  | { kind: "ready"; value: string };

/**
 * Classify a draft against the persisted value. `draft === null` means
 * the field has not been touched this session.
 */
export function readDisplayNameDraft(draft: string | null, persisted: string): DisplayNameDraft {
  if (draft === null) return { kind: "pristine" };
  const parsed = DisplayNameSchema.safeParse(draft);
  if (!parsed.success) {
    if (draft.trim().length === 0) return { kind: "empty" };
    return { kind: "rejected", message: describeRejection(parsed.error) };
  }
  if (parsed.data === persisted) return { kind: "unchanged" };
  return { kind: "ready", value: parsed.data };
}

/**
 * The reason `candidate` cannot be saved as a display name, or `null`
 * when it can. For editors that already own an empty/unchanged check of
 * their own (`InlineText`) and need only the validity half.
 */
export function rejectDisplayName(candidate: string): string | null {
  const parsed = DisplayNameSchema.safeParse(candidate);
  return parsed.success ? null : describeRejection(parsed.error);
}

function describeRejection(error: ZodError<string>): string {
  const code = error.issues[0]?.code;
  if (code === "too_big") {
    return `Display name is limited to ${DISPLAY_NAME_MAX_LENGTH} characters.`;
  }
  if (code === "too_small") return "Display name cannot be empty.";
  // The remaining issue is the refinement: invisible characters the
  // viewer cannot see in the field, so the message has to name them.
  return "Display name cannot contain control characters or line breaks.";
}
