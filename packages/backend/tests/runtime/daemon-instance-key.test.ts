import { describe, expect, it } from 'vitest';

import { makeDaemonInstanceKey } from '../../src/runtime/daemon-instance-key.js';

// The daemon-instance key is a cross-component contract (`RunStateCache`
// latches it and rejects any event carrying a different key as stale). Both
// the outbound fanout and the runtime event-handler mint it via this one
// helper — historically they had two spellings (`123@ts` vs `pid:123@ts`),
// which silently defeated the cache's `acceptDaemonKey` equality check. This
// pins the canonical shape so a second format cannot creep back in.
describe('makeDaemonInstanceKey', () => {
  it('mints the canonical pid:-prefixed pid@startedAt form', () => {
    expect(makeDaemonInstanceKey(123, 1700000000000)).toBe(
      'pid:123@1700000000000',
    );
  });

  it('distinguishes a recycled pid across daemon restarts', () => {
    // Same pid, different start time ⇒ different daemon instance.
    expect(makeDaemonInstanceKey(123, 1000)).not.toBe(
      makeDaemonInstanceKey(123, 2000),
    );
  });
});
