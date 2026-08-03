import type { MessageDto } from '@silverhand/shared';
import { authorStateLabel, presentAuthor } from './author-presentation';

/**
 * Build a markdown transcript from a list of selected messages.
 *
 * Format (per @shiki + Cindy spec):
 *
 *   ## <displayName> · <isoTime>
 *
 *   <content>
 *
 *
 *   ## <displayName> · <isoTime>
 *
 *   <content>
 *
 * Two blank lines between consecutive messages. A header carries the
 * sender's display label and the ISO timestamp so the resulting file is
 * a real "transcript with context" rather than a bare content dump.
 *
 * Single-message exports go through the same path so there is no hidden
 * branch — selecting one message still produces a header. Use the
 * single-message context-menu Copy markdown action when you actually
 * want raw content with no header.
 *
 * Display label comes from the ONE shared author seam (#task:1792) — the
 * server-authoritative `MessageAuthorDto`, never a live `from_*_id` directory
 * re-join — so a hard-deleted author keeps its snapshot name here instead of
 * degrading to a raw id. This text format is the one surface that keeps the
 * `@` handle decoration for agents (there is no avatar or color to tell an
 * agent from a human in plain text), applied on TOP of the seam's identity.
 * A frozen export has no hover to recover the deleted state, so the label also
 * carries the `(deleted account)` suffix from its ONE home (`authorStateLabel`)
 * (#task:1792 B3):
 *   - agent (active):    `@<label>`                    (`display_name || name`)
 *   - agent (deleted):   `@<label> (deleted account)`
 *   - agent (unresolved):`Unknown agent`               (no handle to prefix)
 *   - user (active):     `<label>`                     (no leading `@`)
 *   - user (deleted):    `<label> (deleted account)`
 *   - system:            `system`
 *
 * Sort order: ASCENDING by `MessageDto.seq`. Callers MUST pass already
 * sorted messages — the function does not re-sort because in production
 * we run on `selectionSorted()` output which is already canonical.
 */
export function buildMarkdownTranscript(
  messages: readonly MessageDto[],
  opts: {
    /** Optional override for the time formatter; defaults to ISO 8601
     *  (e.g. `2026-05-25T00:30:00.000Z`). The default keeps tests
     *  deterministic without relying on local timezone. */
    formatTime?: (epochMs: number) => string;
  } = {},
): string {
  const formatTime = opts.formatTime ?? defaultFormatTime;

  const blocks = messages.map(m => {
    const sender = formatSenderLabel(m);
    const time = formatTime(m.created_at);
    const header = `## ${sender} · ${time}`;
    return `${header}\n\n${m.content}`;
  });

  // Two blank lines between blocks → join with "\n\n\n" (each block
  // ends without trailing newline; "\n\n\n" inserts one trailing newline
  // from the previous block + one blank line + the next block's content).
  // The result is `## A\n\n<a>\n\n\n## B\n\n<b>` which renders as the
  // intended visual gap when round-tripped through any markdown viewer.
  return blocks.join('\n\n\n') + '\n';
}

export function formatSenderLabel(m: MessageDto): string {
  const { author } = m;
  if (author === null) return 'system';
  const p = presentAuthor(author);
  // Carry the deleted state into this frozen export (#task:1792 B3): there is
  // no hover or color here to recover it later, so the label appends the
  // `(deleted account)` suffix from its ONE home. `active`/`unresolved` read as
  // their plain label.
  const decorated = authorStateLabel(p);
  // Agents keep the transcript's `@handle` decoration, but only when the seam
  // resolved a real handle — an `unresolved` agent has no name to prefix, so
  // its "Unknown agent" placeholder stands alone.
  return p.kind === 'agent' && p.status !== 'unresolved'
    ? `@${decorated}`
    : decorated;
}

function defaultFormatTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Same suggestion shape for PNG image exports. Markdown transcripts
 * no longer need a filename helper — multi-select Copy markdown writes
 * to the clipboard directly (shiki `vBRFDuOuOqhsYzow`), so there is no
 * save dialog to seed.
 */
export function suggestImageFilename(
  messages: readonly MessageDto[],
  channelTitle: string | null,
): string {
  const safeTitle = (channelTitle ?? 'transcript')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .trim()
    .slice(0, 80);
  const firstSeq = messages.length > 0 ? messages[0]!.seq : 0;
  return `${safeTitle || 'transcript'}-${firstSeq}.png`;
}
