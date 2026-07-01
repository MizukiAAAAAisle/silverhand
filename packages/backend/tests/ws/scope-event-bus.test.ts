import { describe, it, expect, vi } from 'vitest';
import { decodeTransportEpoch, decodeTransportSeq } from '@silverhand/shared';
import { ScopeEventBus, type ScopedEvent } from '../../src/ws/scope-event-bus.js';

describe('ScopeEventBus', () => {
  it('has a stable epoch per instance', () => {
    const bus = new ScopeEventBus();
    expect(typeof bus.epoch).toBe('string');
    expect(bus.epoch.length).toBeGreaterThan(0);
    // Different instances get different epochs
    const bus2 = new ScopeEventBus();
    expect(bus.epoch).not.toBe(bus2.epoch);
  });

  it('accepts epoch override (for deterministic tests)', () => {
    const bus = new ScopeEventBus('test-epoch');
    expect(bus.epoch).toBe('test-epoch');
  });

  describe('backward-compat conversation API', () => {
    it('subscribe + publish delivers to conversation handler', () => {
      const bus = new ScopeEventBus('e');
      const received: unknown[] = [];
      const unsub = bus.subscribe('conv-1', e => received.push(e));

      // Two message-stream kinds — the compat emitter is what `publish()`
      // (message-stream) feeds. Side kinds go through `publishSide` and never
      // touch this path (asserted in the side-channel describe below).
      bus.publish('conv-1', { kind: 'message', payload: { id: 1 } });
      bus.publish('conv-1', { kind: 'task_changed', payload: { id: 1 } });

      expect(received).toEqual([
        { kind: 'message', payload: { id: 1 } },
        { kind: 'task_changed', payload: { id: 1 } },
      ]);

      unsub();
      bus.publish('conv-1', { kind: 'message', payload: { id: 2 } });
      // Should not receive after unsub
      expect(received).toHaveLength(2);
    });

    it('does not cross-deliver between conversations', () => {
      const bus = new ScopeEventBus('e');
      const a: unknown[] = [];
      const b: unknown[] = [];
      bus.subscribe('conv-a', e => a.push(e));
      bus.subscribe('conv-b', e => b.push(e));

      bus.publish('conv-a', { kind: 'msg', payload: 'for-a' });
      expect(a).toHaveLength(1);
      expect(b).toHaveLength(0);
    });
  });

  describe('dual-rail: conversation publish also routes to WS scope', () => {
    it('publish() fans out to conversation: scope subscribers', () => {
      const bus = new ScopeEventBus('epoch-x');
      const wsEvents: ScopedEvent[] = [];
      bus.subscribeScope('conversation:conv-1', e => wsEvents.push(e));

      bus.publish('conv-1', { kind: 'message', payload: { id: 42 } });

      expect(wsEvents).toHaveLength(1);
      expect(wsEvents[0]).toMatchObject({
        scope: 'conversation:conv-1',
        kind: 'message',
        payload: { id: 42 },
        epoch: 'epoch-x',
        seq: 1,
      });
    });

    it('seq increments per scope', () => {
      const bus = new ScopeEventBus('e');
      const events: ScopedEvent[] = [];
      bus.subscribeScope('conversation:c', e => events.push(e));

      bus.publish('c', { kind: 'a', payload: null });
      bus.publish('c', { kind: 'b', payload: null });
      bus.publish('c', { kind: 'c', payload: null });

      expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
    });

    it('different scopes have independent seq counters', () => {
      const bus = new ScopeEventBus('e');
      const conv1Events: ScopedEvent[] = [];
      const conv2Events: ScopedEvent[] = [];
      bus.subscribeScope('conversation:c1', e => conv1Events.push(e));
      bus.subscribeScope('conversation:c2', e => conv2Events.push(e));

      bus.publish('c1', { kind: 'msg', payload: null });
      bus.publish('c2', { kind: 'msg', payload: null });
      bus.publish('c1', { kind: 'msg', payload: null });

      expect(conv1Events.map(e => e.seq)).toEqual([1, 2]);
      expect(conv2Events.map(e => e.seq)).toEqual([1]);
    });
  });

  describe('side-channel: publishSide routes to conversation-side scope', () => {
    it('publishSide() fans out to conversation-side: scope subscribers', () => {
      const bus = new ScopeEventBus('epoch-s');
      const sideEvents: ScopedEvent[] = [];
      bus.subscribeScope('conversation-side:conv-1', e => sideEvents.push(e));

      bus.publishSide('conv-1', { kind: 'agent_status', payload: { s: 'idle' } });

      expect(sideEvents).toHaveLength(1);
      expect(sideEvents[0]).toMatchObject({
        scope: 'conversation-side:conv-1',
        kind: 'agent_status',
        payload: { s: 'idle' },
        epoch: 'epoch-s',
        seq: 1,
      });
    });

    it('publishSide() does NOT reach the message-stream scope or compat subscribe()', () => {
      const bus = new ScopeEventBus('e');
      const streamEvents: ScopedEvent[] = [];
      const compat: unknown[] = [];
      bus.subscribeScope('conversation:conv-1', e => streamEvents.push(e));
      bus.subscribe('conv-1', e => compat.push(e));

      bus.publishSide('conv-1', { kind: 'agent_status', payload: null });

      // Side-channel frames never bleed onto the resume-governed message stream
      // nor the (dead) compat conversation emitter.
      expect(streamEvents).toHaveLength(0);
      expect(compat).toHaveLength(0);
    });

    it('message-stream and side scopes keep independent seq counters', () => {
      const bus = new ScopeEventBus('e');
      const streamEvents: ScopedEvent[] = [];
      const sideEvents: ScopedEvent[] = [];
      bus.subscribeScope('conversation:c', e => streamEvents.push(e));
      bus.subscribeScope('conversation-side:c', e => sideEvents.push(e));

      bus.publish('c', { kind: 'message', payload: null });
      bus.publishSide('c', { kind: 'agent_status', payload: null });
      bus.publish('c', { kind: 'message', payload: null });
      bus.publishSide('c', { kind: 'agent_activity', payload: null });
      bus.publishSide('c', { kind: 'agent_activity', payload: null });

      // Each scope owns its own transport-seq space (a side frame must never
      // advance the message-stream cursor and vice-versa).
      expect(streamEvents.map(e => e.seq)).toEqual([1, 2]);
      expect(sideEvents.map(e => e.seq)).toEqual([1, 2, 3]);
      expect(bus.currentSeq('conversation:c')).toBe(2);
      expect(bus.currentSeq('conversation-side:c')).toBe(3);
    });
  });

  describe('publishToScope (workspace / app / viewer scopes)', () => {
    it('delivers to scope subscribers with epoch and seq', () => {
      const bus = new ScopeEventBus('ep');
      const events: ScopedEvent[] = [];
      bus.subscribeScope('workspace:w1', e => events.push(e));

      bus.publishToScope('workspace:w1', 'channel_created', { id: 'ch1' });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        scope: 'workspace:w1',
        kind: 'channel_created',
        payload: { id: 'ch1' },
        epoch: 'ep',
        seq: 1,
      });
    });

    it('conversation subscribers are NOT notified for non-conversation scopes', () => {
      const bus = new ScopeEventBus('e');
      const conversationEvents: unknown[] = [];
      // Subscribe conversation-style to 'w1' (won't match workspace:w1 events)
      bus.subscribe('w1', e => conversationEvents.push(e));

      bus.publishToScope('workspace:w1', 'channel_created', {});
      expect(conversationEvents).toHaveLength(0);
    });

    it('logs conversation message fanout metadata without payload', () => {
      const info = vi.fn();
      const bus = new ScopeEventBus('ep', { info });
      bus.subscribeScope('conversation:c1', () => {});

      bus.publishToScope('conversation:c1', 'message', { secret: 'not logged' });

      expect(info).toHaveBeenCalledWith(
        {
          category: 'event_ws.publish',
          scope: 'conversation:c1',
          conversationId: 'c1',
          eventKind: 'message',
          seq: 1,
          epoch: 'ep',
          listenerCount: 1,
        },
        'event ws publish',
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain('not logged');
    });
  });

  describe('replay buffer integration', () => {
    it('getReplayBuffer returns buffer that records published events', () => {
      const bus = new ScopeEventBus('ep');
      bus.publishToScope('app', 'workspace_list_changed', null);
      bus.publishToScope('app', 'workspace_list_changed', null);

      const buf = bus.getReplayBuffer('app');
      expect(buf.currentSeq(decodeTransportEpoch('ep'))).toBe(2);
      const replayed = buf.replay(decodeTransportSeq(0), decodeTransportEpoch('ep'));
      expect(replayed).toHaveLength(2);
      expect(replayed[0]).toMatchObject({ seq: 1, epoch: 'ep', kind: 'workspace_list_changed' });
    });

    it('conversation publish writes to replay buffer for conversation: scope', () => {
      const bus = new ScopeEventBus('ep');
      bus.publish('conv-7', { kind: 'message', payload: 'hi' });

      const buf = bus.getReplayBuffer('conversation:conv-7');
      expect(buf.currentSeq(decodeTransportEpoch('ep'))).toBe(1);
      const replayed = buf.replay(decodeTransportSeq(0), decodeTransportEpoch('ep'));
      expect(replayed[0]).toMatchObject({ seq: 1, kind: 'message', payload: 'hi' });
    });
  });

  describe('currentSeq', () => {
    it('returns 0 for unknown scope', () => {
      const bus = new ScopeEventBus('e');
      expect(bus.currentSeq('workspace:nope')).toBe(0);
    });

    it('returns correct seq after publishes', () => {
      const bus = new ScopeEventBus('e');
      bus.publishToScope('viewer:u1', 'notification', {});
      bus.publishToScope('viewer:u1', 'unread_updated', {});
      expect(bus.currentSeq('viewer:u1')).toBe(2);
    });
  });
});
