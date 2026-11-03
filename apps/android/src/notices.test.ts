// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAndroidNotices } from './notices';

let notices: ReturnType<typeof createAndroidNotices>;
const card = (kind: string) => document.querySelector<HTMLDivElement>(`.android-notice-${kind}`)!;
const button = (kind: string, name: string) =>
  card(kind).querySelector<HTMLButtonElement>(`.android-notice-${name}`)!;
const toast = (id: string, extra = {}) => ({ id, title: id, tone: 'neutral' as const, ...extra });
const swipe = (node: Element) => {
  node.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      isPrimary: true,
      pointerId: 1,
      clientY: 60,
      button: 0,
    }),
  );
  node.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, isPrimary: true, pointerId: 1, clientY: 10 }),
  );
  node.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerId: 1, clientY: 10 }),
  );
};

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  notices = createAndroidNotices();
});
afterEach(() => {
  notices.dispose();
  vi.useRealTimers();
});

describe('Android local banner/toast contracts on real DOM nodes', () => {
  it('replaces the banner, opens the current id once, and removes its listener', async () => {
    const open = vi.fn();
    const unsubscribe = await notices.banner.subscribe(open);
    await notices.banner.show({ id: 'old', title: 'Old' });
    await notices.banner.show({ id: 'new', title: 'New', subtitle: 'channel', body: 'mention' });
    expect(document.querySelectorAll('.android-notice-banner')).toHaveLength(1);
    button('banner', 'content').click();
    button('banner', 'content').click();
    expect(open.mock.calls).toEqual([[{ kind: 'open', id: 'new' }]]);
    expect(card('banner').hidden).toBe(true);
    await notices.banner.show({ id: 'later', title: 'Later' });
    unsubscribe();
    expect(card('banner').hidden).toBe(true);
    button('banner', 'content').click();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('keeps the same toast node, resets its deadline, and ignores stale dismiss(id)', async () => {
    await notices.toast.show(toast('progress'));
    const original = card('toast');
    vi.advanceTimersByTime(2500);
    await notices.toast.show(toast('progress', { title: 'Done', tone: 'success' }));
    expect(card('toast')).toBe(original);
    expect(original.textContent).toContain('Done');
    vi.advanceTimersByTime(1000);
    expect(original.hidden).toBe(false);
    await notices.toast.dismiss('older');
    expect(original.hidden).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(original.hidden).toBe(true);
  });

  it('matches banner/error lifetimes; sticky stays until explicit dismissal', async () => {
    await notices.banner.show({ id: 'mention', title: 'Mention' });
    await notices.toast.show(toast('error', { tone: 'error' }));
    vi.advanceTimersByTime(4500);
    expect(card('toast').hidden).toBe(true);
    expect(card('banner').hidden).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(card('banner').hidden).toBe(true);
    await notices.toast.show(toast('sticky', { sticky: true }));
    vi.advanceTimersByTime(60000);
    expect(card('toast').hidden).toBe(false);
    await notices.toast.dismiss();
    expect(card('toast').hidden).toBe(true);
  });

  it('emits action without auto-dismiss so shared preventDefault can keep it open', async () => {
    const acted = vi.fn();
    const unsubscribe = await notices.toast.subscribe(acted);
    await notices.toast.show(toast('retry', { sticky: true, action: { label: 'Retry' } }));
    button('toast', 'action').click();
    expect(acted).toHaveBeenCalledWith({ kind: 'action', id: 'retry' });
    expect(card('toast').hidden).toBe(false);
    unsubscribe();
    button('toast', 'action').click();
    expect(acted).toHaveBeenCalledTimes(1);
    await notices.toast.dismiss('retry');
    expect(card('toast').hidden).toBe(true);
  });

  it('dismisses on upward swipe without firing open/action or bubbling a click', async () => {
    const open = vi.fn();
    const pageClick = vi.fn();
    document.body.addEventListener('click', pageClick, { once: true });
    await notices.banner.subscribe(open);
    await notices.banner.show({ id: 'mention', title: 'Mention' });
    const target = button('banner', 'content');
    swipe(target);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    expect(card('banner').hidden).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(pageClick).not.toHaveBeenCalled();
    document.body.removeEventListener('click', pageClick);
  });

  it('pauses expiry while a keyboard user focuses an action and resumes on blur', async () => {
    await notices.toast.show(toast('action', { action: { label: 'Go' } }));
    button('toast', 'action').focus();
    vi.advanceTimersByTime(10000);
    expect(card('toast').hidden).toBe(false);
    button('toast', 'action').blur();
    await Promise.resolve();
    vi.advanceTimersByTime(3000);
    expect(card('toast').hidden).toBe(true);
  });

  it('treats message text as text, and provides separate polite announcements', async () => {
    await notices.banner.show({
      id: 'untrusted',
      title: '<img src=x onerror=alert(1)>',
      body: '<script>bad()</script>',
    });
    expect(card('banner').querySelector('script,img')).toBeNull();
    expect(card('banner').textContent).toContain('<script>bad()</script>');
    const status = document.querySelector('[role=status]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(button('banner', 'close').getAttribute('aria-label')).toBeTruthy();
  });

  it('clears on background and permanently releases nodes/listeners/timers on disposal', async () => {
    const open = vi.fn();
    await notices.banner.subscribe(open);
    await notices.banner.show({ id: 'old', title: 'Old' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(card('banner').hidden).toBe(true);
    await notices.toast.show(toast('background'));
    expect(card('toast').hidden).toBe(true);
    notices.dispose();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await notices.banner.show({ id: 'late', title: 'Late' });
    expect(document.querySelector('.android-notices')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });
});

it('does not clear another subscriber and prevents a stale gesture opening its replacement', async () => {
  const first = vi.fn();
  const second = vi.fn();
  const unsubscribe = await notices.banner.subscribe(first);
  await notices.banner.subscribe(second);
  await notices.banner.show({ id: 'old', title: 'Old' });
  unsubscribe();
  expect(card('banner').hidden).toBe(false);
  const target = button('banner', 'content');
  target.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, button: 0 }),
  );
  await notices.banner.show({ id: 'new', title: 'New' });
  target.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerId: 1 }),
  );
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  expect(second).not.toHaveBeenCalled();
  expect(card('banner').hidden).toBe(false);
  // Keyboard/assistive activation has no pointerdown and detail=0.
  target.click();
  expect(second).toHaveBeenCalledExactlyOnceWith({ kind: 'open', id: 'new' });
  expect(first).not.toHaveBeenCalled();
});

it('lets a second action subscriber observe the id even if the first dismisses synchronously', async () => {
  await notices.toast.subscribe(({ id }) => {
    void notices.toast.dismiss(id);
  });
  const second = vi.fn();
  await notices.toast.subscribe(second);
  await notices.toast.show(toast('action', { action: { label: 'Go' } }));
  button('toast', 'action').click();
  expect(second).toHaveBeenCalledWith({ kind: 'action', id: 'action' });
  expect(card('toast').hidden).toBe(true);
});
