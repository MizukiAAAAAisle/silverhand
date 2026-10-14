import { beforeEach, expect, it, vi } from 'vitest';
const boundary = vi.hoisted(() => ({
  options: [] as unknown[],
  shown: vi.fn(),
  closed: vi.fn(),
  send: vi.fn(),
  events: {} as Record<string, () => void>,
}));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => null,
    fromWebContents: () => null,
    getAllWindows: () => [],
  },
  dialog: {},
  shell: {},
  Notification: class {
    constructor(options: unknown) {
      boundary.options.push(options);
    }
    on(name: string, fn: () => void) {
      boundary.events[name] = fn;
    }
    show() {
      boundary.shown();
    }
    close() {
      boundary.closed();
    }
  },
}));
import { registerSurfaceIpcHandlers } from '../ipc/surface-ipc';
import type { GuardedIpcRegistrar } from '../ipc/guarded-ipc';
beforeEach(() => {
  boundary.options = [];
  boundary.events = {};
  vi.clearAllMocks();
});
it('uses the independent default sound preference without changing click or dismissal', () => {
  const handlers = new Map<string, Function>();
  let sound = true;
  registerSurfaceIpcHandlers(
    {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    } satisfies GuardedIpcRegistrar,
    () => sound,
  );
  const event = { sender: { isDestroyed: () => false, send: boundary.send } };
  const notify = () =>
    handlers.get('notification:show')!(event, {
      title: 'Mention',
      body: 'Hello',
      notificationId: 'n1',
    });
  notify();
  expect(boundary.options[0]).toMatchObject({ silent: false });
  sound = false;
  notify();
  expect(boundary.options[1]).toMatchObject({ silent: true });
  boundary.events.click!();
  expect(boundary.send).toHaveBeenCalledWith('notification:clicked', 'n1');
  handlers.get('notification:dismiss')!(event, ['n1']);
  expect(boundary.closed).toHaveBeenCalledOnce();
  expect(boundary.shown).toHaveBeenCalledTimes(2);
});

it('replaces the system sound with custom audio without changing notification delivery', () => {
  const handlers = new Map<string, Function>();
  let enabled = true;
  registerSurfaceIpcHandlers(
    {
      handle: (channel, fn) => {
        handlers.set(channel, fn);
      },
      on: () => {},
    },
    () => enabled,
    () => 'data:audio/ogg;base64,AAAA',
  );
  const event = { sender: { isDestroyed: () => false, send: boundary.send } };
  const notify = () =>
    handlers.get('notification:show')!(event, { title: 'Mention', body: 'Hello' });
  expect(notify()).toBe('data:audio/ogg;base64,AAAA');
  expect(boundary.options[0]).toMatchObject({ silent: true });
  enabled = false;
  expect(notify()).toBeUndefined();
  expect(boundary.shown).toHaveBeenCalledTimes(2);
});
