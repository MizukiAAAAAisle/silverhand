import type { EmbeddedRustBackendHandle } from "./embedded-rust-backend.js";

/** Main owns children independently of whether a renderer-visible backend is published. */
export class EmbeddedBackendOwner {
  private readonly abort = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly handles = new Set<EmbeddedRustBackendHandle>();
  private readonly closing = new WeakMap<EmbeddedRustBackendHandle, Promise<void>>();
  private stopped = false;
  private draining: Promise<void> | undefined;

  get signal(): AbortSignal {
    return this.abort.signal;
  }
  get isStopping(): boolean {
    return this.stopped;
  }

  own<T>(operation: () => Promise<T>): Promise<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason: unknown) => void;
    const task = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );
    // Register ownership first, but preserve synchronous runtime invalidation.
    try {
      resolve(operation());
    } catch (error) {
      reject(error);
    }
    return task;
  }

  start(operation: () => Promise<EmbeddedRustBackendHandle>): Promise<EmbeddedRustBackendHandle> {
    return this.own(async () => {
      if (this.stopped) throw new Error("embedded startup cancelled before preparation");
      const handle = await operation();
      this.handles.add(handle);
      if (this.stopped) {
        await this.close(handle);
        throw new Error("embedded startup cancelled before publication");
      }
      return handle;
    });
  }

  close(handle: EmbeddedRustBackendHandle): Promise<void> {
    const existing = this.closing.get(handle);
    if (existing) return existing;
    const task = this.own(async () => {
      try {
        await handle.close();
      } finally {
        this.handles.delete(handle);
      }
    });
    this.closing.set(handle, task);
    return task;
  }

  beginShutdown(): void {
    this.stopped = true;
    this.abort.abort();
  }

  shutdown(): Promise<void> {
    this.beginShutdown();
    return (this.draining ??= (async () => {
      // Startup may produce a handle while abort/reclaim is in flight. Drain to a fixed
      // point, retaining each task until its finally cleanup has actually completed.
      while (this.pending.size || this.handles.size) {
        await Promise.allSettled([
          ...this.pending,
          ...[...this.handles].map((handle) => this.close(handle)),
        ]);
      }
    })());
  }
}
