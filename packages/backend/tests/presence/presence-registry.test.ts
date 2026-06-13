import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopeEventBus } from '../../src/ws/scope-event-bus.js';
import { PresenceRegistry } from '../../src/presence/presence-registry.js';

describe('PresenceRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes online only on the first live connection', () => {
    const { registry, publishSpy } = makeRegistry();

    registry.onConnect('u1', 'c1');
    registry.onConnect('u1', 'c2');

    expect(registry.isOnline('u1')).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledWith('app', 'user_presence', {
      user_id: 'u1',
      presence: 'online',
      last_seen_at: null,
    });
  });

  it('keeps a user online until the last connection leaves and grace expires', () => {
    const { registry, users, publishSpy } = makeRegistry({ offlineGraceMs: 50 });
    registry.onConnect('u1', 'c1');
    registry.onConnect('u1', 'c2');

    registry.onDisconnect('u1', 'c1');
    vi.advanceTimersByTime(100);
    expect(registry.isOnline('u1')).toBe(true);
    expect(users.touchLastSeen).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_000);
    registry.onDisconnect('u1', 'c2');
    expect(registry.isOnline('u1')).toBe(true);
    vi.advanceTimersByTime(49);
    expect(registry.isOnline('u1')).toBe(true);
    expect(users.touchLastSeen).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(registry.isOnline('u1')).toBe(false);
    expect(users.touchLastSeen).toHaveBeenCalledWith('u1', 2_000);
    expect(publishSpy).toHaveBeenLastCalledWith('app', 'user_presence', {
      user_id: 'u1',
      presence: 'offline',
      last_seen_at: 2_000,
    });
  });

  it('cancels pending offline when the user reconnects during grace', () => {
    const { registry, users, publishSpy } = makeRegistry({ offlineGraceMs: 50 });

    registry.onConnect('u1', 'c1');
    registry.onDisconnect('u1', 'c1');
    vi.advanceTimersByTime(25);
    registry.onConnect('u1', 'c2');
    vi.advanceTimersByTime(50);

    expect(registry.isOnline('u1')).toBe(true);
    expect(users.touchLastSeen).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });

  it('dispose clears pending offline timers', () => {
    const { registry, users, publishSpy } = makeRegistry({ offlineGraceMs: 50 });

    registry.onConnect('u1', 'c1');
    registry.onDisconnect('u1', 'c1');
    registry.dispose();
    vi.advanceTimersByTime(50);

    expect(registry.isOnline('u1')).toBe(false);
    expect(users.touchLastSeen).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});

function makeRegistry(opts: { offlineGraceMs?: number } = {}) {
  const events = new ScopeEventBus('presence-test');
  const publishSpy = vi.spyOn(events, 'publishToScope');
  const users = {
    touchLastSeen: vi.fn(() => true),
  };
  const registry = new PresenceRegistry({
    events,
    users,
    offlineGraceMs: opts.offlineGraceMs ?? 20,
    now: () => Date.now(),
  });
  return { registry, users, publishSpy };
}
