import { AsyncLocalStorage } from 'node:async_hooks';

export interface BackendRequestContext {
  requestId: string;
  method: string;
}

const requestContextStorage = new AsyncLocalStorage<BackendRequestContext>();

export function runWithBackendRequestContext<T>(
  context: BackendRequestContext,
  callback: () => T,
): T {
  return requestContextStorage.run(context, callback);
}

export function currentBackendRequestContext(): BackendRequestContext | undefined {
  return requestContextStorage.getStore();
}
