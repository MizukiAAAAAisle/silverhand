import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextualCloseCoordinator, type CloseTarget } from "./contextual-close.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function target(
  webContentsId: number,
  options: { destroyed?: boolean; throwOnSend?: boolean } = {},
) {
  const sent: string[] = [];
  const win: CloseTarget = {
    webContentsId,
    isDestroyed: () => options.destroyed ?? false,
    sendRequest: (id) => {
      sent.push(id);
      if (options.throwOnSend) throw new Error("WebContents disposed during send");
    },
  };
  return { win, sent };
}
function setup() {
  const background = vi.fn();
  return { background, coord: new ContextualCloseCoordinator(250, background) };
}

describe("main close-request correlation", () => {
  it("sends a request, accepts its sender once and clears the timer", () => {
    const { coord, background } = setup();
    const { win, sent } = target(7);
    coord.begin(win);
    expect(sent).toHaveLength(1);
    coord.resolve(7, sent[0]!, "background-app");
    expect(vi.getTimerCount()).toBe(0);
    coord.resolve(7, sent[0]!, "background-app");
    vi.advanceTimersByTime(250);
    expect(background).toHaveBeenCalledTimes(1);
  });

  it.each(["blocked", "closed-panel", "unknown-junk", ""])(
    "consumes %s without allowing a later background replay",
    (outcome) => {
      const { coord, background } = setup();
      const { win, sent } = target(7);
      coord.begin(win);
      coord.resolve(7, sent[0]!, outcome);
      coord.resolve(7, sent[0]!, "background-app");
      expect(background).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("ignores wrong sender and unknown request without consuming the legitimate request", () => {
    const { coord, background } = setup();
    const { win, sent } = target(7);
    coord.begin(win);
    coord.resolve(999, sent[0]!, "background-app");
    coord.resolve(7, "never-issued", "background-app");
    expect(background).not.toHaveBeenCalled();
    coord.resolve(7, sent[0]!, "background-app");
    expect(background).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [249, 1],
    [250, 0],
  ])("accepts a reply at %d ms only before the deadline", (delay, calls) => {
    const { coord, background } = setup();
    const { win, sent } = target(7);
    coord.begin(win);
    vi.advanceTimersByTime(delay);
    expect(background).not.toHaveBeenCalled();
    coord.resolve(7, sent[0]!, "background-app");
    expect(background).toHaveBeenCalledTimes(calls);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps concurrent requests bound to their captured windows", () => {
    const { coord, background } = setup();
    const a = target(1),
      b = target(2);
    coord.begin(a.win);
    coord.begin(b.win);
    expect(a.sent[0]).not.toBe(b.sent[0]);
    coord.resolve(1, b.sent[0]!, "background-app");
    expect(background).not.toHaveBeenCalled();
    coord.resolve(1, a.sent[0]!, "background-app");
    expect(background).toHaveBeenCalledTimes(1);
    coord.resolve(2, b.sent[0]!, "background-app");
    expect(background).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send to a destroyed target or leave timers behind", () => {
    const { coord, background } = setup();
    const { win, sent } = target(7, { destroyed: true });
    coord.begin(win);
    expect(sent).toEqual([]);
    expect(background).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back a failed send immediately, so even its captured ID cannot be replayed", () => {
    const { coord, background } = setup();
    const { win, sent } = target(7, { throwOnSend: true });
    expect(() => coord.begin(win)).not.toThrow();
    expect(sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    coord.resolve(7, sent[0]!, "background-app");
    expect(background).not.toHaveBeenCalled();
  });
});
