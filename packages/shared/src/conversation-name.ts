import {
  CONVERSATION_NAME_PATTERN,
  ConversationNameSchema,
  ENTITY_NAME_MAX_LENGTH,
} from './api/name.js';

/**
 * #task:2016 — deriving a conversation NAME from a display title.
 *
 * The name grammar itself lives in `api/name.ts`
 * ({@link CONVERSATION_NAME_PATTERN} / `ConversationNameSchema`); this module
 * owns the one-way derivation, and it exists because TWO paths must produce
 * byte-identical results from the same title:
 *
 *  - the v72 backfill, which has to give every pre-existing workspace channel a
 *    name without inventing one, and
 *  - channel creation, when the caller does not spell a name explicitly.
 *
 * A second copy of the algorithm would mean an upgraded database and a
 * freshly-created channel disagree about what "the obvious name for this title"
 * is — a difference nobody looks at until an address stops resolving.
 *
 * Derivation is DETERMINISTIC and one-way. It seeds a name; it does not track
 * one. Once allocated, a name has no further relationship with the title, so
 * renaming the title never re-derives, and the title is never the canonical
 * identity (#task:2016 explicitly forbids that, and forbids a random fallback).
 */

/** Substitute for a title that contains nothing the grammar admits — a
 *  CJK-only or emoji-only title, most of the system's real ones. Also the stable
 *  letter prefix for a title whose slug would otherwise start with a digit
 *  (`2026 roadmap` → `channel-2026-roadmap`): the grammar bars a digit first
 *  character because the chat tokenizer reads bare `#42` as a TASK, and one
 *  prefix word serving both cases keeps "unnamed-looking channel" a single
 *  recognizable shape. Deliberately a plain word rather than a random or
 *  id-derived token: it must be predictable enough that the same title always
 *  yields the same name, and legible enough that a human seeing `#channel-3`
 *  recognizes an unnamed channel and renames it. Collisions are expected here
 *  and are resolved by {@link disambiguateConversationName}. */
export const CONVERSATION_NAME_FALLBACK = 'channel';

/** Budget for the derived stem, below {@link ENTITY_NAME_MAX_LENGTH} so a
 *  disambiguating suffix always fits without truncating the stem a second time
 *  (a stem whose length depended on how many collisions preceded it would make
 *  the derivation order-dependent). */
export const CONVERSATION_NAME_STEM_MAX_LENGTH = 56;

/**
 * Derive a name STEM from a display title. Total: every string maps to a value
 * admissible by `ConversationNameSchema`.
 *
 * The range is closed by construction, in this order: every run of characters
 * outside `[a-z0-9]` collapses to a single `-` (which is why a mixed title like
 * `UI/UX 优化` keeps its ASCII words instead of being thrown away), leading
 * separators go, a digit-leading remainder gets the {@link
 * CONVERSATION_NAME_FALLBACK} prefix so the first character is a letter, the
 * result is cut to the stem budget, the cut's own trailing separator is
 * stripped, and an empty result becomes the fallback word. Prefixing BEFORE the
 * cut is what keeps the budget honest; stripping AFTER it is what keeps the last
 * character alphanumeric.
 */
export function slugifyConversationTitle(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '');
  const prefixed = /^[0-9]/.test(ascii)
    ? `${CONVERSATION_NAME_FALLBACK}-${ascii}`
    : ascii;
  const stem = prefixed
    .slice(0, CONVERSATION_NAME_STEM_MAX_LENGTH)
    .replace(/-+$/, '');
  return stem === '' ? CONVERSATION_NAME_FALLBACK : stem;
}

/**
 * The nth spelling of a stem, for a caller that must place a name in an
 * already-occupied namespace: `design` → `design-2` → `design-3`.
 *
 * Only the BACKFILL may use this. It has to be total (every pre-existing
 * channel gets a name) and has no requester to tell, so it resolves collisions
 * by convention; creation refuses instead, because the address you asked for
 * must be the address you got.
 *
 * Both arguments are CHECKED, not merely documented, and a violation throws.
 * This function is the only name deriver the v72 migration runs, so an
 * out-of-domain entrance here is an out-of-domain entrance into the database:
 * `NaN`, `Infinity`, `2.5`, `1e21` and a negative all format into a string the
 * name schema rejects, and so does any stem that is not already a name. Given
 * checked arguments the result is admissible — the head keeps the stem's letter
 * first character, stripping separators before the suffix cannot remove it, and
 * the slice bound leaves exactly room for the suffix.
 */
export function disambiguateConversationName(
  stem: string,
  ordinal: number,
): string {
  if (!ConversationNameSchema.safeParse(stem).success) {
    throw new Error(
      `disambiguateConversationName: stem is not an admissible conversation name: ${JSON.stringify(stem)}`,
    );
  }
  if (!Number.isSafeInteger(ordinal) || ordinal < 2) {
    throw new Error(
      `disambiguateConversationName: ordinal must be a safe integer >= 2, got ${String(ordinal)}`,
    );
  }
  const suffix = `-${ordinal}`;
  const head = stem
    .slice(0, ENTITY_NAME_MAX_LENGTH - suffix.length)
    .replace(/[-_]+$/, '');
  return `${head}${suffix}`;
}
