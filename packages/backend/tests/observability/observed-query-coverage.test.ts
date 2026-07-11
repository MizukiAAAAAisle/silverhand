import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('named query coverage', () => {
  it('keeps the migrated high-traffic HostRepo free of bare prepare calls', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../../src/repos/host-repo.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\.prepare\s*(?:<|\()/);
    expect(source).toContain("'hosts.list_for_user'");
    expect(source).toContain("'hosts.get_by_id'");
    expect(source).toContain("'hosts.touch_last_seen'");
  });
});
