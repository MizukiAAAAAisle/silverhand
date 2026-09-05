// #task:2343 P0-10 — the REMOTE-ONLY build alias for `embedded-launcher.ts`. The
// electron-vite main config aliases `./embedded-launcher.js` to THIS file when
// `SILVERHAND_DESKTOP_REMOTE_ONLY=1`, so a remote-only package's main module graph contains
// NO import of `@silverhand/backend` (→ no `better-sqlite3`), NO embedded Rust launcher,
// and NO sidecar verifier. A remote-only desktop refuses embedded startup long before any
// of these would run (see `backend-boot-mode.ts` / the `DESKTOP_REMOTE_ONLY` guards in
// `index.ts`); reaching one here can only be a build/wiring regression, so each throws loud.

import type {
  EmbeddedRustBackendHandle,
  EmbeddedRustBackendConfig,
} from './embedded-rust-backend.js';

const REMOTE_ONLY_MESSAGE =
  'This Silverhand Desktop package was built as remote-only; embedded backend startup is unavailable.';

export function startDesktopEmbeddedBackend(
  _location: unknown, _config: EmbeddedRustBackendConfig, _logger: unknown,
): Promise<EmbeddedRustBackendHandle> { throw new Error(REMOTE_ONLY_MESSAGE); }
