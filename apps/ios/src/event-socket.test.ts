import { describe, expect, it, vi } from 'vitest';
import { NativeEventSocket } from './event-socket';
import type { NativeBridge, NativeSocketEvent } from './bridge';

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function harness() {
  let handler!: (event: NativeSocketEvent) => void;
  const remove = vi.fn();
  const bridge = {
    addListener: vi.fn(async (_event, callback) => {
      handler = callback;
      return { remove };
    }),
    openSocket: vi.fn(async () => {}),
    closeSocket: vi.fn(async () => {}),
    sendSocket: vi.fn(async () => {}),
  } as unknown as NativeBridge;
  const socket = new NativeEventSocket(bridge, 'wss://server.example/api/ws/events');
  const emit = (type: NativeSocketEvent['type'], rest = {}) => {
    const id = vi.mocked(bridge.openSocket).mock.calls[0]![0].id;
    handler({ id, type, ...rest });
  };
  return { bridge, socket, emit, remove };
}

describe('native event socket', () => {
  it('opens only after the listener is installed and forwards authenticated frames', async () => {
    const { socket, bridge, emit } = harness();
    const message = vi.fn();
    socket.addEventListener('message', message);
    expect(bridge.openSocket).not.toHaveBeenCalled();
    await tick();
    emit('open');
    emit('message', { data: '{"type":"authenticated"}' });
    expect(socket.readyState).toBe(1);
    expect(message).toHaveBeenCalledWith({ data: '{"type":"authenticated"}' });
  });

  it('ignores native events after close and removes its listener', async () => {
    const { socket, emit, remove } = harness();
    const message = vi.fn();
    const close = vi.fn();
    socket.addEventListener('message', message);
    socket.addEventListener('close', close);
    await tick();
    emit('open');
    socket.close();
    emit('message', { data: 'old server frame' });
    emit('close');
    expect(message).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('does not create a native socket if closed while listener registration was pending', async () => {
    const { socket, bridge, remove } = harness();
    socket.close();
    await tick();
    expect(bridge.openSocket).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
  });
});
