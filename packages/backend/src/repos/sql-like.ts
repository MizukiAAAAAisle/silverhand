// SQLite `LIKE` helpers shared by the repos that do substring matching on
// message/entity text (cross-conversation SearchRepo and in-stream message
// find on MessageRepo). Both must escape user input identically so a query
// containing `%`, `_`, or `\` matches literally rather than as a wildcard.
// Callers pair the needle with `LIKE ? ESCAPE '\\'`.

/** Escape LIKE wildcards (`%`, `_`) and the escape char itself so `value`
 *  matches literally under `LIKE ? ESCAPE '\\'`. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/** Wrap an escaped query as a contains-needle (`%…%`). */
export function likeNeedle(query: string): string {
  return `%${escapeLike(query)}%`;
}
