import type {
  EmbeddedRustBackendHandle,
  EmbeddedRustBackendConfig,
} from './embedded-rust-backend.js';

const REMOTE_ONLY_MESSAGE =
  'This Silverhand Desktop package was built as remote-only; embedded backend startup is unavailable.';

export function startDesktopEmbeddedBackend(
  _location: unknown, _config: EmbeddedRustBackendConfig, _logger: unknown,
): Promise<EmbeddedRustBackendHandle> { throw new Error(REMOTE_ONLY_MESSAGE); }
