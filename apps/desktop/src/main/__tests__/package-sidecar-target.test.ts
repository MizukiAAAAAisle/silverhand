import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// #task:2343 — this task builds+verifies ONLY the current Desktop HOST target (no
// cross-compile / ECS here). package.sh derives the desktop target from the Electron
// platform+arch and uses that ONE value for BOTH the manifest `target` and (implicitly,
// host build) the artifact — never a recomputed uname triple. `verifySidecar` then checks
// manifest.target against (process.platform, process.arch). This static test pins that
// the manifest target is the derived desktop target (not a uname-recomputed string) and
// that Cargo is invoked at package time (never runtime).

const PACKAGE_SH = fileURLToPath(
  new URL('../../../../../scripts/package.sh', import.meta.url),
);

describe('package.sh embedded Rust sidecar — host-target manifest identity', () => {
  const src = readFileSync(PACKAGE_SH, 'utf8');

  it('derives the desktop target from the Electron platform+arch (not a uname triple)', () => {
    expect(src).toMatch(/DESKTOP_ARCH="\$\(node -p 'process\.arch'\)"/);
    expect(src).toContain('darwin:arm64');
    expect(src).toContain('BACKEND_TARGET="aarch64-apple-darwin"');
    expect(src).not.toContain('BACKEND_TARGET="x86_64-apple-darwin"');
    // The old host-recomputed uname triple must be gone.
    expect(src).not.toMatch(/SIDECAR_TARGET="\$\(uname -m\)-apple-darwin"/);
  });

  it('writes manifest.target from that SAME derived BACKEND_TARGET (single source)', () => {
    expect(src).toMatch(/"target": "\$BACKEND_TARGET"/);
  });

  it('builds the sidecar with cargo at PACKAGE time (never at runtime)', () => {
    expect(src).toMatch(/cargo build --release --bin silverhand-backend/);
    // Sidecar artifact is the host release path that manifest describes.
    expect(src).toContain('rust/target/$BACKEND_TARGET/release/silverhand-backend');
    expect(src).toContain('--target "$BACKEND_TARGET"');
  });

  it('does NOT claim an ECS/cross-compile Linux target build in this task', () => {
    // shiki (seq357/358): no cross-compile in #2343. No required SILVERHAND_RUST_TARGET
    // and no Linux target build in the embedded sidecar path.
    expect(src).not.toMatch(/SILVERHAND_RUST_TARGET is required/);
    expect(src).not.toMatch(/unknown-linux-gnu/);
  });

  it('switches to Node ABI before production smoke and restores Electron afterwards', () => {
    const smoke = src.indexOf('tsx scripts/smoke-embedded-rust-backend.mts');
    expect(src.lastIndexOf('ensure_binding "$NODE_ABI"', smoke)).toBeGreaterThan(0);
    expect(src.indexOf('ensure_binding "$ELECTRON_ABI"', smoke)).toBeGreaterThan(smoke);
    expect(src).toContain('scripts/smoke-embedded-rust-backend.mts "$PACKAGED_APP_PATH/Contents/Resources"');
  });
});
