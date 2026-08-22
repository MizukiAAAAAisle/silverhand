import { describe, expect, it } from 'vitest';
import {
  WorkspaceIdSegmentError,
  assertSafeWorkspaceIdSegment,
} from '../src/daemon/workspace-path-authority.js';

/**
 * A server-supplied workspace id becomes a filesystem path
 * SEGMENT under the agent bundle root, so an id that is not structurally safe
 * must fail closed — never be hashed, trimmed or otherwise "repaired" into
 * something acceptable.
 */

const HOSTILE_OR_NONCONFORMING = [
  '../escape',
  'a/b',
  '/abs',
  '..',
  '.',
  '../../etc/passwd',
  'x/../../y',
  '',
  '   ',
  'a'.repeat(65),
  'dot.dot',
  'ws\\back',
  'ws\u0000nul',
  'ws id',
  'ws:colon',
];

describe('assertSafeWorkspaceIdSegment', () => {
  it('fails closed on every hostile or non-conforming id, by dedicated class + invalid_path', () => {
    for (const id of HOSTILE_OR_NONCONFORMING) {
      let thrown: unknown;
      try {
        assertSafeWorkspaceIdSegment(id);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected a throw for ${JSON.stringify(id)}`).toBeInstanceOf(
        WorkspaceIdSegmentError,
      );
      // Consumers catch this ONE concern by class; `code` stays `invalid_path`
      // for wire/log continuity with the pre-demotion registry taxonomy.
      expect((thrown as WorkspaceIdSegmentError).code).toBe('invalid_path');
    }
  });

  it('returns a conforming id unchanged — the caller uses the RETURN value as the segment', () => {
    for (const id of ['r6Cb5cuDnS2hAP9l', 'ws_1', 'ws-1', 'A', 'a'.repeat(64)]) {
      expect(assertSafeWorkspaceIdSegment(id)).toBe(id);
    }
  });

  it('never repairs an unsafe id into a safe one (no hashing, no trimming)', () => {
    // ` ws_1 ` differs from the safe `ws_1` only by surrounding blanks: a
    // "helpful" trim would silently bind a DIFFERENT workspace's directory.
    expect(() => assertSafeWorkspaceIdSegment(' ws_1 ')).toThrow(WorkspaceIdSegmentError);
  });
});
