import { describe, expect, it } from 'vitest';
import { ObserveSourceSchema } from '@silverhand/shared';
import {
  explicitStreamClearHead,
  mainlineStreamSourceHead,
  notificationSource,
  streamSourceAtSeq,
} from './observe';

// The renderer constructs source_refs by hand, so these AUTO-path builders are
// the client edge of the §9.10 caller-intent contract. The tests lock two
// things: (1) every built source is wire-valid against the shared schema, and
// (2) the AUTO builders can NEVER emit thread + `stream_head` (the regression
// these typed builders exist to make unrepresentable). This is scoped to the
// AUTO builders ONLY — phase B's explicit `explicitStreamClearHead(conv, root|null)`
// will knowingly emit thread + `stream_head`; that is an explicit path, not a
// regression, so it gets its own builder and its own test.
describe('observe auto-path source builders', () => {
  it('builds a thread source as at_seq (never stream_head)', () => {
    const src = streamSourceAtSeq('conv-1', 'root-9', 42);
    expect(src).toEqual({
      kind: 'stream',
      conversation_id: 'conv-1',
      thread_root_id: 'root-9',
      position: { kind: 'at_seq', seq: 42 },
    });
    expect(() => ObserveSourceSchema.parse(src)).not.toThrow();
  });

  it('builds a channel-with-snapshot source as at_seq (root null)', () => {
    const src = streamSourceAtSeq('conv-1', null, 7);
    expect(src.kind).toBe('stream');
    expect(src).toMatchObject({ thread_root_id: null, position: { kind: 'at_seq', seq: 7 } });
    expect(() => ObserveSourceSchema.parse(src)).not.toThrow();
  });

  it('builds a mainline head source that is ALWAYS root-null + stream_head', () => {
    const src = mainlineStreamSourceHead('conv-1');
    expect(src).toEqual({
      kind: 'stream',
      conversation_id: 'conv-1',
      thread_root_id: null,
      position: { kind: 'stream_head' },
    });
    // §9.10: the AUTO `stream_head` builder pairs `stream_head` with a null
    // thread_root_id — the only AUTO builder that emits stream_head structurally
    // cannot carry a thread root. (Phase B's explicit builder may; not this one.)
    if (src.kind !== 'stream') throw new Error('expected a stream source');
    expect(src.thread_root_id).toBeNull();
    expect(() => ObserveSourceSchema.parse(src)).not.toThrow();
  });

  it('builds a directed notification source by id', () => {
    const src = notificationSource('notif-3');
    expect(src).toEqual({ kind: 'notification', notification_id: 'notif-3' });
    expect(() => ObserveSourceSchema.parse(src)).not.toThrow();
  });
});

// The EXPLICIT phase-B builder is the deliberate counterpart: an explicit user
// clear (hover-✓ / Mark all) MAY tail-swallow, so it CAN emit `stream_head` on a
// thread — exactly what the AUTO builders above forbid. The split is intent, not
// stream shape (§9.10); these tests lock that the explicit builder carries the
// thread root through and stays wire-valid.
describe('observe explicit-path source builder', () => {
  it('builds a thread stream clear to head (the AUTO builders cannot)', () => {
    const src = explicitStreamClearHead('conv-1', 'root-9');
    expect(src).toEqual({
      kind: 'stream',
      conversation_id: 'conv-1',
      thread_root_id: 'root-9',
      position: { kind: 'stream_head' },
    });
    expect(() => ObserveSourceSchema.parse(src)).not.toThrow();
  });

  it('builds a mainline stream clear to head when root is null', () => {
    const src = explicitStreamClearHead('conv-1', null);
    expect(src).toMatchObject({
      kind: 'stream',
      thread_root_id: null,
      position: { kind: 'stream_head' },
    });
    expect(() => ObserveSourceSchema.parse(src)).not.toThrow();
  });
});
