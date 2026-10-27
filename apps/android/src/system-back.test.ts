import { describe, expect, it, vi } from 'vitest';
import { createSystemBack } from './system-back';

describe('committed Android Back ownership', () => {
  it('consumes once, releases its subscription and leaves root requests unconsumed', () => {
    const events = new EventTarget();
    const back = createSystemBack(events);
    const handler = vi.fn(() => true);
    const remove = back.subscribe(handler);
    const second = vi.fn(() => true);
    const removeSecond = back.subscribe(second);
    expect(events.dispatchEvent(new Event('silverhand:system-back', { cancelable: true }))).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    remove(); removeSecond();
    const root = vi.fn(() => false);
    const removeRoot = back.subscribe(root);
    expect(events.dispatchEvent(new Event('silverhand:system-back', { cancelable: true }))).toBe(true);
    removeRoot();
    events.dispatchEvent(new Event('silverhand:system-back', { cancelable: true }));
    expect(root).toHaveBeenCalledTimes(1);
  });
});
