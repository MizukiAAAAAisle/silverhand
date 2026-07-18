import { describe, expect, it } from 'vitest';
import { TASK_TITLE_MAX_LEN, TaskTitleSchema } from '../src/api/index.js';

// The title single-line invariant lives in exactly one authority
// (TaskTitleSchema), shared by create + both edit paths, so CLI `--title` and
// the UI textarea normalize identically. These falsify that contract without
// mirroring the regex: they pin observable normalization, not its shape.
describe('TaskTitleSchema — single-line title invariant', () => {
  it('trims and collapses interior whitespace (incl. newlines/tabs) to single spaces', () => {
    expect(TaskTitleSchema.parse('  foo\n\tbar  ')).toBe('foo bar');
    expect(TaskTitleSchema.parse('a\n\n\nb')).toBe('a b');
    expect(TaskTitleSchema.parse('keep single spaces')).toBe('keep single spaces');
  });

  it('rejects an all-whitespace title as empty', () => {
    expect(TaskTitleSchema.safeParse('   \n\t  ').success).toBe(false);
    expect(TaskTitleSchema.safeParse('').success).toBe(false);
  });

  it('measures the length cap on the canonical (collapsed) form, not raw', () => {
    // Raw far exceeds the cap purely through a whitespace run; canonical is short → valid.
    const raw = `foo${' '.repeat(TASK_TITLE_MAX_LEN * 3)}bar`;
    expect(TaskTitleSchema.parse(raw)).toBe('foo bar');
    // A canonical form over the cap is still rejected.
    expect(TaskTitleSchema.safeParse('x'.repeat(TASK_TITLE_MAX_LEN + 1)).success).toBe(false);
    expect(TaskTitleSchema.parse('x'.repeat(TASK_TITLE_MAX_LEN))).toHaveLength(TASK_TITLE_MAX_LEN);
  });
});
