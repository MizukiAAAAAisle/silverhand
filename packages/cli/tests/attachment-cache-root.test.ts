import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { attachmentCacheRoot } from '../src/commands/file.js';

/**
 * #task:1603 — the CLI consumes the ONE unified SILVERHAND_DIR contract
 * (trim; blank after trim = unset), shared with desktop and the daemon
 * defaults. The historical CLI/desktop divergence is gone.
 */
describe('attachmentCacheRoot — unified SILVERHAND_DIR contract', () => {
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
