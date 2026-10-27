import type { T2Event } from './t2-observer.mjs';
export const T2_CASES: readonly ['B3.T2.create', 'B3.T2.edit-cancel-save', 'B3.T2.status', 'B3.T2.restore'];
export function t2Until<Value>(name: string, predicate: (value: Value) => boolean, read: () => Promise<Value>, options: {
  unitDeadline: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  observe?: (name: string, value: Value) => void;
}): Promise<Value>;
export function t2IndependentTodoRead(rows: readonly T2Event[], ack: T2Event, context: {
  workspaceId: string;
  channelId: string;
  task: { id: string; task_number: number };
}): { request: T2Event; response: T2Event; terminal: T2Event } | null;
// UI/CDP collaborators are supplied by both the device entry and host models.
// Their values cross a JavaScript boundary; declarations do not validate them.
export function runT2(input: Record<string, unknown>, helpers: Record<string, unknown>): Promise<void>;
