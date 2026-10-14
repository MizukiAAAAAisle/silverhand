import { expect, it, vi } from 'vitest';
import type { EventFrame, ServerFrame } from '@silverhand/shared';
import { startHookFeed } from './feed';
it('forwards only viewer product events with bounded pending IPC and detaches cleanly', async () => {
  let listener!: (frame: ServerFrame) => void;
  let finish!: () => void;
  const detach = vi.fn(),
    end = vi.fn(async () => {}),
    warning = vi.fn();
  const deliver = vi.fn(
    (_input: { lease: string; frames: EventFrame[] }) =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = startHookFeed(
    { beginFeed: async () => 'lease', endFeed: end, deliver },
    {
      subscribe: (fn) => {
        listener = fn;
        return detach;
      },
      isViewer: (scope) => scope === 'viewer:a',
      warning,
    },
  );
  await Promise.resolve();
  const frame = {
    type: 'event',
    scope: 'viewer:a',
    epoch: 'one',
    seq: 1,
    kind: 'notification',
    payload: {},
  } as EventFrame;
  listener({ ...frame, scope: 'conversation:a' });
  listener({ ...frame, kind: 'message' });
  expect(deliver).not.toHaveBeenCalled();
  for (let seq = 1; seq < 200; seq++) listener({ ...frame, seq } as EventFrame);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalled();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(deliver).toHaveBeenCalledTimes(2);
  expect(deliver.mock.calls[1]![0].frames).toHaveLength(8);
  stop();
  finish();
  await Promise.resolve();
  expect(detach).toHaveBeenCalledOnce();
  expect(end).toHaveBeenCalledWith('lease');
  expect(deliver).toHaveBeenCalledTimes(2);
});
