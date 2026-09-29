import { afterEach, expect, it, vi } from "vitest";
import { TouchSensor } from "@dnd-kit/core";
import { useListSortSensors } from "./list-sort-sensors";

vi.mock("@dnd-kit/core", async (original) => ({
  ...(await original<typeof import("@dnd-kit/core")>()),
  useSensor: (sensor: unknown, options: unknown) => ({ sensor, options }),
  useSensors: (...sensors: unknown[]) => sensors,
}));

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function gesture() {
  vi.useFakeTimers();
  // Only the native event boundary is faked; activation runs the installed sensor.
  const node = new EventTarget();
  const doc = Object.assign(new EventTarget(), { getSelection: () => null });
  const win = Object.assign(new EventTarget(), { EventTarget, TouchEvent: Event });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  const send = (type: string, y = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      touches: { value: [{ clientX: 0, clientY: y }] },
      changedTouches: { value: [{ clientX: 0, clientY: y }] },
    });
    node.dispatchEvent(event);
    return event;
  };
  const config = useListSortSensors().find((s) => s.sensor === TouchSensor)!;
  const onStart = vi.fn();
  const onMove = vi.fn();
  const onCancel = vi.fn();
  const onEnd = vi.fn();
  new TouchSensor({
    active: "row",
    event: send("touchstart"),
    options: config.options,
    onStart,
    onMove,
    onCancel,
    onEnd,
    onAbort: vi.fn(),
    onPending: vi.fn(),
  } as unknown as ConstructorParameters<typeof TouchSensor>[0]);
  return { send, onStart, onMove, onCancel, onEnd };
}

it("lets a swipe scroll and permanently cancels the pending long press", () => {
  const g = gesture();
  expect(g.send("touchmove", 20).defaultPrevented).toBe(false);
  vi.advanceTimersByTime(500);
  g.send("touchmove", 80);
  expect(g.onStart).not.toHaveBeenCalled();
  expect(g.onCancel).toHaveBeenCalledOnce();
  expect(g.onEnd).not.toHaveBeenCalled();
});

it("activates a stationary long press, then consumes movement until release", () => {
  const g = gesture();
  vi.advanceTimersByTime(349);
  expect(g.onStart).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(g.onStart).toHaveBeenCalledOnce();
  expect(g.send("touchmove", 40).defaultPrevented).toBe(true);
  expect(g.onMove).toHaveBeenCalledOnce();
  g.send("touchend");
  expect(g.onEnd).toHaveBeenCalledOnce();
});

it("cancels an active touch without committing a drop", () => {
  const g = gesture();
  vi.advanceTimersByTime(350);
  g.send("touchcancel");
  expect(g.onCancel).toHaveBeenCalledOnce();
  expect(g.onEnd).not.toHaveBeenCalled();
});
