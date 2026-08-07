import WebSocket from 'ws';

export class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolvePromise, rejectPromise) => {
      socket.once('open', resolvePromise);
      socket.once('error', rejectPromise);
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on('message', raw => this.receive(raw));
    socket.on('close', () => this.rejectPending(new Error('CDP socket closed')));
    socket.on('error', error => this.rejectPending(error));
  }

  send(method, params) {
    const id = ++this.sequence;
    const payload = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} timed out after 30s`));
      }, 30_000);
      this.pending.set(id, { method, resolvePromise, rejectPromise, timer });
      this.socket.send(JSON.stringify(payload));
    });
  }

  on(method, listener) {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => set.delete(listener);
  }

  receive(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.rejectPromise(new Error(`${pending.method} failed: ${JSON.stringify(message.error)}`));
      } else {
        pending.resolvePromise(message.result);
      }
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.rejectPromise(error);
    }
    this.pending.clear();
  }

  close() {
    this.socket.close();
  }
}
