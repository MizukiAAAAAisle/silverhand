import { expect, it } from 'vitest';
import type { EventFrame } from '@silverhand/shared';
import type { HookRule } from '@silverhand/client';
import { HookService } from './service';
const rule: HookRule = {
  id: 'mention',
  name: 'Mention',
  enabled: true,
  event: 'notification',
  match: { kind: 'mention_self' },
  action: { type: 'command', command: 'cat' },
};
const frame = (seq = 1, scope = 'viewer:alice'): EventFrame =>
  ({
    type: 'event',
    scope,
    seq,
    epoch: 'epoch-1',
    kind: 'notification',
    payload: { kind: 'mention_self', future: 'preserved' },
  }) as EventFrame;
it('dispatches only matched current viewer events once and preserves their raw payload', async () => {
  const service = new HookService();
  service.updateRules([rule]);
  const lease = service.beginFeed('server/alice', 'viewer:alice', () => true);
  service.deliver(lease, [
    frame(1, 'conversation:one'),
    frame(),
    frame(),
    { ...frame(2), payload: { kind: 'mention_external' } },
  ]);
  await expect.poll(() => service.runs().filter((r) => r.status === 'succeeded').length).toBe(1);
  expect(service.runs()).toHaveLength(1);
  expect(JSON.parse(service.runs()[0]!.stdout)).toEqual(frame());
  service.revoke();
});
it('bounds concurrency and waiting work, cancels changed queued rules, and invalidates old sessions', async () => {
  const service = new HookService({ concurrency: 2, queue: 2 });
  const slow = { ...rule, action: { type: 'command' as const, command: 'exec sleep 5' } };
  service.updateRules([slow, { ...slow, id: 'second' }]);
  const lease = service.beginFeed('server/alice', 'viewer:alice', () => true);
  try {
    service.deliver(lease, [frame(), frame(2), frame(3)]);
    expect(service.runs().filter((r) => r.status === 'running')).toHaveLength(2);
    expect(service.runs().filter((r) => r.status === 'queued')).toHaveLength(2);
    expect(service.runs().filter((r) => r.status === 'rejected')).toHaveLength(2);
    service.updateRules([{ ...slow, enabled: false }]);
    expect(service.runs().filter((r) => r.status === 'queued')).toHaveLength(0);
    expect(service.runs().filter((r) => r.status === 'running')).toHaveLength(2);
    service.revoke();
    const next = service.beginFeed('server/bob', 'viewer:bob', () => true);
    service.updateRules([rule]);
    service.deliver(lease, [frame(4)]);
    service.deliver(next, [frame(4)]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(service.runs()).toEqual([]);
  } finally {
    service.revoke();
  }
});
it('keeps the replay watermark across feed replacement, rejects malformed input, and exposes cancellable runs', async () => {
  const service = new HookService();
  service.updateRules([rule]);
  let current = true;
  const lease = service.beginFeed('server/alice', 'viewer:alice', () => current);
  service.deliver(lease, [frame()]);
  await expect.poll(() => service.runs()[0]?.status).toBe('succeeded');
  service.endFeed(lease);
  const next = service.beginFeed('server/alice', 'viewer:alice', () => current);
  service.deliver(next, [frame()]);
  expect(service.runs()).toHaveLength(1);
  expect(() => service.deliver(next, [{ ...frame(2), seq: NaN } as EventFrame])).toThrow();
  expect(() =>
    service.deliver(
      next,
      Array.from({ length: 9 }, () => frame(2)),
    ),
  ).toThrow();
  service.updateRules([{ ...rule, action: { type: 'command', command: 'exec sleep 5' } }]);
  service.deliver(next, [frame(2)]);
  const id = service.runs().find((r) => r.status === 'running')!.id;
  service.cancel(id);
  await expect.poll(() => service.runs().find((r) => r.id === id)?.status).toBe('cancelled');
  current = false;
  service.deliver(next, [frame(3)]);
  expect(service.runs()).toEqual([]);
});
it('shutdown waits for cancellation and rejects new intake', async () => {
  const service = new HookService();
  service.updateRules([rule]);
  const lease = service.beginFeed('server/alice', 'viewer:alice', () => true);
  const slow = {
    ...rule,
    action: { type: 'command' as const, command: "trap '' TERM; exec sleep 30" },
  };
  service.updateRules([slow]);
  service.deliver(lease, [frame()]);
  try {
    await service.shutdown();
    expect(service.runs()).toEqual([]);
    expect(() => service.beginFeed('server/alice', 'viewer:alice', () => true)).toThrow(
      /shut down/i,
    );
    service.deliver(lease, [frame()]);
    expect(service.runs()).toEqual([]);
  } finally {
    service.revoke();
  }
});
