// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientPlatform } from '@silverhand/client';
import type { NotificationDto, ServerFrame } from '@silverhand/shared';
import { configurePlatform } from '@/platform';
import { useNotificationToasts } from './notifications';
import { createAndroidNotifications, type AndroidNotificationBridge } from '../../../../../apps/android/src/notifications';
import { createAndroidNotices } from '../../../../../apps/android/src/notices';

const stream = vi.hoisted(() => ({ receive: undefined as ((frame: ServerFrame) => void) | undefined }));
vi.mock('@/lib/ws-client', () => ({
  subscribeViewerScope: () => ({ unsubscribe() {} }),
  isCurrentViewerScope: (scope: string) => scope === 'viewer:me',
  onWsFrame: (receive: (frame: ServerFrame) => void) => { stream.receive = receive; return () => { stream.receive = undefined; }; },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const platformFixture = {} as ClientPlatform;
configurePlatform(platformFixture);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function row(overrides: Partial<NotificationDto> = {}): NotificationDto {
  return {
    id: 'n', kind: 'mention_self', user_id: 'me', agent_id: null, workspace_id: 'ws',
    conversation_id: 'channel', message_id: 'message', thread_root_id: 'thread-root',
    source_workspace_id: null, source_conversation_id: null, source_message_id: null,
    payload: { trigger_name: 'Sender', conversation_title: 'Channel', mention_excerpt: 'hello' },
    created_at: 1, read_at: null, sender: null, ...overrides,
  };
}
type Jump = Parameters<typeof useNotificationToasts>[1];
async function harness(initial: NotificationDto[] = [], firstRows?: Promise<NotificationDto[]>) {
  let rows = initial;
  let first = firstRows;
  let nativeClick!: () => void;
  let pending: Array<{ id: string; token: string }> = [];
  let reference: Promise<unknown> | undefined;
  let serial = 0;
  const bridge: AndroidNotificationBridge = {
    notificationSession: vi.fn(async () => ({ session: 'session-a' })),
    notificationShow: vi.fn(async () => ({ status: 'posted' })),
    notificationDismiss: vi.fn(async () => ({ status: 'dismissed' })),
    notificationTakeClicks: vi.fn(async () => { const clicks = pending; pending = []; return { clicks }; }),
    addListener: vi.fn(async (_event, receive) => { nativeClick = receive; return { remove: vi.fn(async () => {}) }; }),
  };
  const request = vi.fn(async ({ path }: { path: string }) => {
    let body: unknown;
    if (path.startsWith('/api/notifications?')) {
      const wait = first; first = undefined;
      body = { notifications: wait ? await wait : rows };
    } else if (path.endsWith('/ref')) {
      body = reference ? await reference : { ref: { id: 'channel', workspace_id: 'ws' } };
    } else body = { marked: 1 };
    return { status: 200, bodyText: JSON.stringify(body) };
  });
  const notifications = createAndroidNotifications(bridge);
  const notices = createAndroidNotices();
  Object.assign(platformFixture, { client: { backendRequest: request }, notifications: notifications.capability,
    banner: notices.banner, toast: notices.toast });
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const viewing: { conversationId: string | null; threadRootId: string | null } = { conversationId: 'other', threadRootId: null };
  function Consumer({ jump }: { jump?: Jump }) { useNotificationToasts(viewing, jump); return null; }
  async function render(jump?: Jump) {
    await act(async () => { root.render(createElement(QueryClientProvider, { client: qc }, createElement(Consumer, { jump }))); });
  }
  async function settle(ms = 20) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(ms);
      else await new Promise((done) => setTimeout(done, ms));
    });
  }
  await render(); await settle();
  return {
    bridge, notifications, request, notices, qc, focus, viewing, render, settle,
    async click(id: string, token = 'click-'+(++serial)) {
      await act(async () => { pending.push({ id, token }); nativeClick(); });
      await settle();
    },
    async publish(next: NotificationDto[]) {
      rows = next;
      await act(async () => qc.setQueryData(['notifications','list',{unread:true,toasts:true}], { notifications: next }));
      await settle();
    },
    async viewer(next: NotificationDto[]) {
      rows = next;
      await act(async () => stream.receive!({ type: 'event', scope: 'viewer:me', epoch: 'e', seq: ++serial,
        kind: 'notification', payload: {} } as ServerFrame));
      await settle(130); await settle();
    },
    blockReference(value: Promise<unknown>) { reference = value; },
    async close() { await act(async () => root.unmount()); notifications.dispose(); notices.dispose(); qc.clear(); host.remove(); },
  };
}

it('keeps an early click until its list row arrives and permits a later independent same-ID click', async () => {
  const list = deferred<NotificationDto[]>(); const h = await harness([], list.promise); const jump = vi.fn();
  try {
    await h.render(jump);
    await h.click('n');
    expect(jump).not.toHaveBeenCalled();
    await act(async () => list.resolve([row()])); await h.settle();
    expect(jump).toHaveBeenCalledExactlyOnceWith({ workspaceId:'ws',channelId:'channel',threadRootId:'thread-root',messageId:'message' });
    await h.click('n');
    expect(jump).toHaveBeenCalledTimes(2); // New native token means a new user operation.
  } finally { await h.close(); }
});

it('waits for navigation and permits banner then system notification as independent same-ID clicks', async () => {
  const h = await harness([row()]); const jump = vi.fn();
  try {
    await h.click('n');
    expect(jump).not.toHaveBeenCalled();
    await h.render(jump); await h.settle();
    expect(jump).toHaveBeenCalledOnce();
    await h.viewer([row(),row({ id:'banner',message_id:'banner-message',created_at:2 })]);
    const banner = document.querySelector<HTMLButtonElement>('.android-notice-banner .android-notice-content')!;
    await act(async () => banner.click()); await h.settle();
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ messageId:'banner-message' }));
    await h.click('banner');
    expect(jump).toHaveBeenCalledTimes(3);
    expect(jump).toHaveBeenLastCalledWith(expect.objectContaining({ messageId:'banner-message' }));
  } finally { await h.close(); }
});

it('deduplicates repeated delivery while target resolution is pending, using the current handler', async () => {
  const h = await harness([row({ thread_root_id:null })]); const ref = deferred<unknown>();
  const oldJump = vi.fn(); const newJump = vi.fn(); h.blockReference(ref.promise);
  try {
    await h.render(oldJump); await h.click('n'); await h.click('n');
    expect(h.request.mock.calls.filter(([v]) => v.path.endsWith('/ref'))).toHaveLength(1);
    await h.render(newJump);
    await act(async () => ref.resolve({ ref:{id:'channel',workspace_id:'ws'} })); await h.settle();
    expect(oldJump).not.toHaveBeenCalled(); expect(newJump).toHaveBeenCalledOnce();
  } finally { await h.close(); }
});

it('cannot navigate an old owner after unmount/account replacement during async resolution', async () => {
  const h = await harness([row({ thread_root_id:null })]); const ref = deferred<unknown>(); const jump = vi.fn();
  h.blockReference(ref.promise); await h.render(jump); await h.click('n'); await h.close();
  await act(async () => ref.resolve({ ref:{id:'channel',workspace_id:'ws'} }));
  await h.settle(); expect(jump).not.toHaveBeenCalled();
});

it('expires unmatched clicks and terminates a row with no meaningful destination', async () => {
  vi.useFakeTimers(); const h = await harness(); const jump = vi.fn();
  try {
    await h.render(jump); await h.click('missing'); await h.settle(10_001);
    await h.publish([row({ id:'missing' }),row({ id:'invalid',message_id:null })]);
    expect(jump).not.toHaveBeenCalled();
    await h.click('invalid'); await h.settle(10_001);
    expect(jump).not.toHaveBeenCalled();
  } finally { await h.close(); }
});

it('delivers all three kinds through the real shared hook, preserves banner/toast and exact read-id clearing', async () => {
  const h = await harness();
  const failed = row({ id:'failed',kind:'agent_start_failed',message_id:null,thread_root_id:null,agent_id:'agent',
    payload:{agent_name:'Agent',error:'runtime unavailable'} });
  try {
    await h.viewer([row({ id:'self' }),row({ id:'external',kind:'mention_external' }),failed]);
    expect(h.bridge.notificationShow).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(h.bridge.notificationShow).mock.calls.map(([v]) => v);
    expect(calls[0]).toEqual(expect.objectContaining({notificationId:'self',force:true}));
    expect(calls[1]).toEqual(expect.objectContaining({notificationId:'external',force:false}));
    expect(calls[2]).not.toHaveProperty('notificationId');
    expect(document.querySelector<HTMLElement>('.android-notice-banner')!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.android-notice-toast')!.hidden).toBe(false);
    await h.viewer([row({ id:'self' }),row({ id:'external',kind:'mention_external' }),{...failed,created_at:2}]);
    expect(h.bridge.notificationShow).toHaveBeenCalledTimes(4);
    await act(async () => stream.receive!({ type:'event',scope:'viewer:me',kind:'unread_updated',
      payload:{dismissed_notification_ids:['self',7,'external']} } as unknown as ServerFrame));
    await h.settle();
    expect(h.bridge.notificationDismiss).toHaveBeenCalledWith({session:'session-a',ids:['self','external']});
  } finally { await h.close(); }
});

it('surfaces an unread start failure on first load without replaying the initial mentions', async () => {
  const h = await harness([row(),row({id:'error',kind:'agent_start_failed',message_id:null,payload:{agent_name:'Agent'}})]);
  try {
    expect(h.bridge.notificationShow).toHaveBeenCalledOnce();
    expect(vi.mocked(h.bridge.notificationShow).mock.calls[0]![0]).not.toHaveProperty('notificationId');
  } finally { await h.close(); }
});

it('keeps focused matching conversations silent without turning that rule into a scroll-visibility test', async () => {
  const h = await harness();
  try {
    h.focus.mockReturnValue(true); h.viewing.conversationId = 'channel'; h.viewing.threadRootId = 'thread-root';
    await h.viewer([row()]);
    expect(h.bridge.notificationShow).not.toHaveBeenCalled();
    expect(document.querySelector('.android-notice-banner:not([hidden])')).toBeNull();
  } finally { await h.close(); }
});

it.each(['success', 'failure'] as const)('does not let expired resolver %s consume or clear a newer same-ID click', async (outcome) => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const h = await harness([row({ thread_root_id:null })]);
  const reference = deferred<unknown>();
  // Resolve the query dependency directly here: normal HTTP/query failures are
  // intentionally converted to a fallback target by the unchanged resolver.
  // A malformed cached ref exercises its unexpected-error cleanup separately.
  vi.spyOn(h.qc, 'fetchQuery').mockImplementationOnce(() => reference.promise as never);
  const jump = vi.fn();
  try {
    await h.render(jump); await h.click('n');
    await h.settle(10_001); await h.render(undefined);
    // A business notification keeps its source coordinates. The later click is
    // a new delivery of that same ID, not a fabricated replacement message row.
    await h.click('n');
    await act(async () => reference.resolve({ ref:outcome === 'failure' ? null : {id:'old-channel',workspace_id:'ws'} })); await h.settle();
    if (outcome === 'failure') expect(error).toHaveBeenCalledWith('Unable to resolve notification click', expect.any(Error));
    else expect(error).not.toHaveBeenCalled();
    await h.render(jump); await h.settle();
    expect(jump).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({channelId:'channel',messageId:'message'}));
  } finally { await h.close(); }
});
