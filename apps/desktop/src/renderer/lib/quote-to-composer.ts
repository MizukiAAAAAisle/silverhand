/**
 * Text-selection Quote routing (#task:1544).
 *
 * When the reader selects a passage inside a message body, the
 * SelectionQuoteToolbar offers **Quote** — which drops the selected text
 * into the composer as a Markdown blockquote. The toolbar lives in the
 * message list; the composer is a sibling view. Rather than prop-drill an
 * imperative insert handle across that boundary, the two talk through a
 * tiny window-event bus keyed by the composer's `draftKey`, so a channel
 * with both a main composer and an open thread composer routes each quote
 * to exactly the composer whose message list produced the selection.
 *
 * This is a pure-renderer path: Quote inserts Markdown text a human could
 * have typed. It does NOT touch the metadata-quote contract
 * (`quoted_message_id` + source snapshot) that {@link
 * ../components/chat/QuotedMessagePreview} renders — that quotes a whole
 * message with source-location semantics and is a separate feature.
 */

const QUOTE_EVENT = 'silverhand:quote-to-composer';

interface QuoteToComposerDetail {
  draftKey: string;
  text: string;
}

/** Ask the composer identified by `draftKey` to insert `text` as a quote. */
export function requestQuoteToComposer(draftKey: string, text: string): void {
  window.dispatchEvent(
    new CustomEvent<QuoteToComposerDetail>(QUOTE_EVENT, {
      detail: { draftKey, text },
    }),
  );
}

/** Subscribe the composer at `draftKey` to inbound quote requests. */
export function onQuoteToComposer(
  draftKey: string,
  handler: (text: string) => void,
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<QuoteToComposerDetail>).detail;
    if (detail && detail.draftKey === draftKey) handler(detail.text);
  };
  window.addEventListener(QUOTE_EVENT, listener);
  return () => window.removeEventListener(QUOTE_EVENT, listener);
}

/**
 * Turn a selected passage into a Markdown blockquote. Each line is
 * prefixed with `> ` (a bare `>` for blank lines so the quote block stays
 * contiguous rather than splitting into separate quotes). CRLF is
 * normalized so pasted-then-selected Windows text quotes cleanly.
 */
export function buildQuoteBlock(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * Splice a quote block into an existing draft at the caret, returning the
 * next draft text and caret offset. The quote always begins on its own
 * line (a leading newline is added when the caret isn't already at line
 * start) and is followed by a blank line so the reader's own reply starts
 * below the quote. Pure so the splicing rules are unit-testable without a
 * live textarea.
 */
export function spliceQuoteIntoDraft(
  draft: string,
  caret: number,
  quotedText: string,
): { text: string; caret: number } {
  const clamped = Math.max(0, Math.min(caret, draft.length));
  const before = draft.slice(0, clamped);
  const after = draft.slice(clamped);
  const block = buildQuoteBlock(quotedText);
  const lead = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
  // A single trailing newline when the quote butts up against following
  // text, otherwise a blank line to separate the quote from the reply.
  const trail = after.startsWith('\n') ? '\n' : '\n\n';
  const insertion = `${lead}${block}${trail}`;
  const nextCaret = (before + insertion).length;
  return { text: before + insertion + after, caret: nextCaret };
}

/**
 * Clamp a toolbar's horizontal center so it never overflows the viewport.
 * The toolbar is translated -50% on X, so this returns the desired center
 * X, bounded so `[center - width/2, center + width/2]` stays within
 * `[margin, viewportWidth - margin]`. Pure for unit testing.
 */
export function clampToolbarCenterX(
  desiredCenterX: number,
  toolbarWidth: number,
  viewportWidth: number,
  margin: number,
): number {
  const half = toolbarWidth / 2;
  const min = margin + half;
  const max = viewportWidth - margin - half;
  // Degenerate: toolbar wider than the usable viewport — center it.
  if (min > max) return viewportWidth / 2;
  return Math.max(min, Math.min(desiredCenterX, max));
}
