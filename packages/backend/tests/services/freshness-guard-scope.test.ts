import { describe, expect, it } from 'vitest';
import {
  FreshnessGuardInvariantError,
  MessageStaleError,
  freshnessGuardScope,
} from '../../src/services/conversation-message/contracts.js';

/**
 * The freshness guard's runtime-scope arm (#task:2095). The `undefined`/`null`
 * branch is unreachable by construction — the send path authorizes the actor
 * upstream, and an FK guarantees a participant's `agents` row exists in the
 * guard's transaction — but an unreachable arm with no test is a phantom fence
 * (尺子⑭), and "missing row" is the branch most likely to quietly become
 * reachable if that authorization chain changes. This pins the throw so the
 * unsafe silent-widen-to-'agent' regression cannot creep back.
 */
describe('freshnessGuardScope', () => {
  it('returns the row\'s session_scope arm', () => {
    expect(freshnessGuardScope({ session_scope: 'conversation' }, 'a1')).toBe(
      'conversation',
    );
    expect(freshnessGuardScope({ session_scope: 'agent' }, 'a1')).toBe('agent');
  });

  it('throws an invariant violation on a missing row — never silently widening to the broad arm', () => {
    for (const missing of [undefined, null] as const) {
      expect(() => freshnessGuardScope(missing, 'agent-42')).toThrow(
        FreshnessGuardInvariantError,
      );
    }
  });

  it('carries the agentId and is NOT a MessageStaleError (so it 500s, never a looping 409)', () => {
    let thrown: unknown;
    try {
      freshnessGuardScope(undefined, 'agent-42');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FreshnessGuardInvariantError);
    // Deliberately NOT a MessageStaleError: the service's stale catch rethrows
    // only that class, so this surfaces as an unmapped 500 (a bug to find),
    // never a 409 that would send the runtime to stale-receive an empty batch
    // and retry a non-stale error forever.
    expect(thrown).not.toBeInstanceOf(MessageStaleError);
    expect((thrown as FreshnessGuardInvariantError).agentId).toBe('agent-42');
    // Recognizable in logs (the 500 must be diagnosable, not a bare Error).
    expect((thrown as Error).name).toBe('FreshnessGuardInvariantError');
    expect((thrown as Error).message).toContain('agent-42');
  });
});
