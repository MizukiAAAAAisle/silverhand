// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bindShortViewport } from './short-viewport';
let matches = true;
let frames: Map<number, FrameRequestCallback>;
let release: (() => void) | undefined;
let field: HTMLTextAreaElement;
let scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>();
function flush() { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); }
beforeEach(() => {
  matches = true; frames = new Map(); let id = 0;
  vi.spyOn(window, 'matchMedia').mockReturnValue({ get matches() { return matches; }, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { frames.set(++id, fn); return id; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(n => { frames.delete(n); });
  vi.stubGlobal('innerHeight', 120);
  document.body.innerHTML = '<form data-composer><textarea></textarea></form><button>Outside</button>';
  const form = document.querySelector('form')!;
  vi.spyOn(form, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 180 } as DOMRect);
  scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>(); form.scrollIntoView = scroll;
  field = document.querySelector('textarea')!;
});
afterEach(() => { release?.(); release = undefined; document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('reveals a clipped current editor once per size without changing value or selection', () => {
  release = bindShortViewport(); field.value = '中文 draft'; field.focus(); field.setSelectionRange(1, 3); flush();
  expect(scroll).toHaveBeenCalledTimes(1); expect(field.selectionStart).toBe(1); expect(field.selectionEnd).toBe(3); expect(field.value).toBe('中文 draft');
  window.dispatchEvent(new Event('resize')); flush(); expect(scroll).toHaveBeenCalledTimes(1);
});
it('does not touch a tall viewport or an already visible composer', () => {
  matches = false; release = bindShortViewport(); field.focus(); flush(); expect(scroll).not.toHaveBeenCalled();
  matches = true; document.querySelector('form')!.getBoundingClientRect = () => ({ top: 10, bottom: 80 } as DOMRect);
  window.dispatchEvent(new Event('resize')); flush(); expect(scroll).not.toHaveBeenCalled();
});
it('releases pending work on blur and ignores its late callback', () => {
  release = bindShortViewport(); field.focus(); const late = [...frames.values()][0]!;
  document.querySelector('button')!.focus(); expect(frames.size).toBe(0); late(0); expect(scroll).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('resize')); expect(frames.size).toBe(0);
});
it('honors manual scrolling instead of fighting later viewport callbacks', () => {
  release = bindShortViewport(); field.focus(); document.dispatchEvent(new Event('touchmove')); flush();
  vi.stubGlobal('innerHeight', 110); window.dispatchEvent(new Event('resize')); flush(); expect(scroll).not.toHaveBeenCalled();
});
it('does not operate on an old node after removal or page cleanup', () => {
  release = bindShortViewport(); field.focus(); const late = [...frames.values()][0]!;
  document.querySelector('form')!.remove(); flush(); expect(scroll).not.toHaveBeenCalled();
  release(); late(0); expect(scroll).not.toHaveBeenCalled();
});

it('reveals a reopened short viewport even when it returns to the same size', () => {
  release = bindShortViewport(); field.focus(); flush(); expect(scroll).toHaveBeenCalledTimes(1);
  matches = false; window.dispatchEvent(new Event('resize')); flush();
  matches = true; window.dispatchEvent(new Event('resize')); flush(); expect(scroll).toHaveBeenCalledTimes(2);
});
