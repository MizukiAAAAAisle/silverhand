import { HOOK_LIMITS, type EventHooksCapability } from '@silverhand/client';
import type { EventFrame, ServerFrame } from '@silverhand/shared';

/** One in-flight batch; this observer never waits on the WS dispatch path. */
export function startHookFeed(
  api: Pick<EventHooksCapability, 'beginFeed' | 'endFeed' | 'deliver'>,
  source: {
    subscribe(listener: (frame: ServerFrame) => void): () => void;
    isViewer(scope: string): boolean;
    warning(message: string): void;
  },
): () => void {
  let active = true,
    busy = false,
    lease: string | null = null,
    overflow = false;
  const pending: EventFrame[] = [];
  const pump = () => {
    if (!active || busy || !lease || !pending.length) return;
    busy = true;
    const frames = pending.splice(0, HOOK_LIMITS.batchSize);
    void api
      .deliver({ lease, frames })
      .catch((error) => {
        if (active) source.warning(`Hooks delivery failed: ${String(error)}`);
      })
      .finally(() => {
        busy = false;
        pump();
      });
  };
  const unsubscribe = source.subscribe((frame) => {
    if (
      !active ||
      frame.type !== 'event' ||
      !source.isViewer(frame.scope) ||
      !['notification', 'task_changed'].includes(frame.kind)
    )
      return;
    if (new TextEncoder().encode(JSON.stringify(frame)).length > HOOK_LIMITS.eventBytes) {
      source.warning('Hook event exceeds 64 KiB');
      return;
    }
    if (pending.length >= HOOK_LIMITS.forwardingQueue) {
      if (!overflow) source.warning('Hook forwarding queue is full; events were dropped');
      overflow = true;
      return;
    }
    overflow = false;
    pending.push(frame);
    pump();
  });
  void api
    .beginFeed()
    .then((value) => {
      if (!active) {
        if (value) void api.endFeed(value).catch(() => {});
        return;
      }
      lease = value;
      if (!lease) {
        pending.length = 0;
        source.warning('Hooks have no active viewer session');
        return;
      }
      pump();
    })
    .catch((error) => {
      if (!active) return;
      pending.length = 0;
      source.warning(`Hooks unavailable: ${String(error)}`);
    });
  return () => {
    active = false;
    pending.length = 0;
    unsubscribe();
    if (lease) void api.endFeed(lease).catch(() => {});
  };
}
