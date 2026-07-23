import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { attachmentCacheRoot } from '../src/commands/file.js';

/**
 * #task:1598 round 2 (Cindy P1-3) — the CLI's HISTORICAL SILVERHAND_DIR
 * semantics (trimmed value; whitespace-only falls back), which diverge
 * from desktop's untrimmed `||` semantics. The compatibility floor
 * preserves the divergence; v2 unifies on "SILVERHAND_DIR is the app
 * root" (shiki's decision, recorded in #task:1597).
 */
describe('attachmentCacheRoot — historical CLI env semantics', () => {
  const HOME = join(homedir(), '.silverhand', 'attachments-cache');

  it('unset / empty / whitespace fall back to the home root; explicit is used trimmed', () => {
    expect(attachmentCacheRoot({})).toBe(HOME);
    expect(attachmentCacheRoot({ SILVERHAND_DIR: '' })).toBe(HOME);
    expect(attachmentCacheRoot({ SILVERHAND_DIR: '   ' })).toBe(HOME);
    expect(attachmentCacheRoot({ SILVERHAND_DIR: '/x/y' })).toBe(
      '/x/y/attachments-cache',
    );
    expect(attachmentCacheRoot({ SILVERHAND_DIR: '  /x/y  ' })).toBe(
      '/x/y/attachments-cache',
    );
  });
});
