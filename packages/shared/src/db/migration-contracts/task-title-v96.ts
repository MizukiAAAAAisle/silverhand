/**
 * Frozen step96 data contract. Do not evolve this with the product validator:
 * future title rules require a new migration/version. No runtime schema imports.
 */
export function canonicalizeTaskTitleV96(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('step96: tasks.title cannot satisfy the canonical title contract');
  }

  // Explicit ECMAScript whitespace set at v96; ASCII edge trimming occurs only
  // after replacement, so future JS whitespace additions cannot change the step.
  const title = raw
    .replace(
      /[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g,
      ' ',
    )
    .replace(/^ /, '')
    .replace(/ $/, '');
  if (title.length === 0 || title.length > 200) {
    throw new Error('step96: tasks.title cannot satisfy the canonical title contract');
  }
  return title;
}
