import type { IncomingMessage, ServerResponse } from 'node:http';
export interface T2Event { seq: number; event: string; [field: string]: unknown }
export interface ObservedRequest {
  readonly tlsFixtureUserId: string | null;
  reply(response: IncomingMessage): void;
}
export class TaskWriteObserver {
  constructor(file: string, events: string, options?: { append?: (row: T2Event) => void });
  failed: boolean;
  attach(request: IncomingMessage, response: ServerResponse): ObservedRequest | null;
}
export function readT2Events(text: string): T2Event[];
export function assertT2ZeroWrites(rows: readonly T2Event[], start: string, end: string, taskId: string): {
  from: number;
  to: number;
  observedWrites: 0;
};
