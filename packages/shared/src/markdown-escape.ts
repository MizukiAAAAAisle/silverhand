/**
 * Escapers for interpolating a free-text value into Markdown-bearing prose.
 *
 * This module exists so producers can find them. Both the platform prompt and
 * the agent-facing system messages interpolate labels a user picked (a
 * workspace name, a channel title), and both need the same guarantee; the
 * escaper belongs to neither domain, so it lives here rather than in the
 * prompt builder or in the system-message subtype registry.
 */

/**
 * Render a value as a single-line Markdown code span.
 *
 * Two guarantees, both required by the callers:
 *
 * - **Single line.** Every line-break character — including the Unicode
 *   separators U+2028 / U+2029 / U+0085 that `JSON.stringify` leaves literal —
 *   collapses to a space, so the value cannot break out of the line it was
 *   interpolated into (a prompt Context bullet, a sentence of system-message
 *   prose).
 * - **No Markdown structure.** The span delimiter is one backtick longer than
 *   the longest backtick run in the value, and is padded with a space on each
 *   side when the value contains a backtick at all — CommonMark requires that
 *   padding for content that begins or ends with a backtick, and without it a
 *   value ending in a backtick merges with the closing fence and the whole
 *   span degrades to plain text. Inside a code span, `@name` is not a mention,
 *   `#name` is not a reference, and `**x**` is not emphasis.
 *
 * So a label may legally contain `@`, `#`, or a backtick and still be safe to
 * quote into agent-facing prose. One implementation, not a copy per producer.
 */
export function inlineCode(value: string): string {
  const singleLine = value.replace(/[\r\n\u2028\u2029\u0085]+/g, ' ');
  let longest = 0;
  const re = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(singleLine)) !== null) {
    if (match[0].length > longest) longest = match[0].length;
  }
  if (longest === 0) return `\`${singleLine}\``;
  const delimiter = '`'.repeat(longest + 1);
  return `${delimiter} ${singleLine} ${delimiter}`;
}
