import type { EmbeddedRustBackendHandle, EmbeddedRustBackendTerminalReason } from './embedded-rust-backend.js';

export class EmbeddedBackendPublicationError extends Error {
  constructor(readonly kind: 'persistence-failed' | 'terminal-before-publication', cause?: unknown) {
    super(`embedded backend publication failed (${kind})`, { cause });
    this.name = 'EmbeddedBackendPublicationError';
  }
}

/** Own the live child until both URL writes succeed; failure invalidates both records. */
export async function persistEmbeddedBackend(
  handle: EmbeddedRustBackendHandle,
  writes: { config(): Promise<void>; controlUrl(): void; invalidate(): Promise<void> },
  signal: AbortSignal,
): Promise<EmbeddedRustBackendHandle> {
  let terminal: EmbeddedRustBackendTerminalReason | undefined;
  handle.onTerminal(reason => { terminal = reason; });
  const check = (): void => {
    if (signal.aborted || terminal) throw new EmbeddedBackendPublicationError('terminal-before-publication', terminal);
  };
  try {
    check();
    await writes.config();
    check();
    writes.controlUrl();
    check();
    return handle;
  } catch (error) {
    try { await handle.close(); } finally { await writes.invalidate(); }
    throw error instanceof EmbeddedBackendPublicationError ? error : new EmbeddedBackendPublicationError('persistence-failed', error);
  }
}

/** Runtime owner: invalidate synchronously before awaiting child teardown. */
export async function invalidateEmbeddedRuntime(
  reason: EmbeddedRustBackendTerminalReason,
  owner: {
    isCurrent(): boolean;
    invalidate(): void;
    clearUrls(): void | Promise<void>;
    close(): Promise<void>;
    report(reason: EmbeddedRustBackendTerminalReason): void;
  },
): Promise<void> {
  if (!owner.isCurrent()) return;
  owner.invalidate();
  try { await owner.clearUrls(); } finally {
    try { await owner.close(); } finally { owner.report(reason); }
  }
}
