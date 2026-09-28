import type { EventSocket, EventSocketEvents } from '@silverhand/client';
import type { NativeBridge, NativeSocketEvent } from './bridge';

/** Listener registration precedes native connect, so immediate auth frames cannot be lost. */
export class NativeEventSocket implements EventSocket {
  readyState = 0;
  private readonly id = crypto.randomUUID();
  private readonly listeners = new Map<string, Set<(event: never) => void>>();
  private removeListener?: () => Promise<void>;

  constructor(
    private readonly bridge: NativeBridge,
    url: string,
  ) {
    void this.start(url);
  }

  addEventListener<K extends keyof EventSocketEvents>(
    type: K,
    listener: (event: EventSocketEvents[K]) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(type, listeners);
  }

  private emit<K extends keyof EventSocketEvents>(type: K, event: EventSocketEvents[K]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  private async start(url: string): Promise<void> {
    try {
      const subscription = await this.bridge.addListener('socket', (event) => this.receive(event));
      this.removeListener = () => subscription.remove();
      if (this.readyState === 3) {
        await this.removeListener();
        return;
      }
      await this.bridge.openSocket({ id: this.id, url });
      // close may happen while native creation is pending.
      if (this.readyState !== 0 && this.readyState !== 1)
        await this.bridge.closeSocket({ id: this.id });
    } catch {
      if (this.readyState === 3) return;
      this.emit('error', {});
      this.finish(1006);
    }
  }

  private receive(event: NativeSocketEvent): void {
    if (event.id !== this.id || this.readyState === 3) return;
    switch (event.type) {
      case 'open':
        this.readyState = 1;
        this.emit('open', {});
        break;
      case 'message':
        if (this.readyState === 1) this.emit('message', { data: event.data });
        break;
      case 'error':
        this.emit('error', {});
        break;
      case 'close':
        this.finish(event.code ?? 1006);
        break;
    }
  }

  private finish(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    void this.removeListener?.();
    this.emit('close', { code, wasClean: code === 1000 });
    this.listeners.clear();
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('Socket is not open');
    void this.bridge.sendSocket({ id: this.id, data }).catch(() => {
      this.emit('error', {});
      this.close();
    });
  }

  close(): void {
    if (this.readyState === 3) return;
    this.finish(1000);
    void this.bridge.closeSocket({ id: this.id }).catch(() => undefined);
  }
}
