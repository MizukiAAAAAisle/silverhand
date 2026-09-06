import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

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

  it('supports isolated artifact output and rejects traversal before building', () => {
    expect(src).toContain('ARTIFACT_OUTPUT_DIR="$OUTPUT_DIR"');
    expect(src.match(/--config\.directories\.output="\$ARTIFACT_OUTPUT_DIR"/g)).toHaveLength(2);
    for (const name of ['../release', '/tmp', '.', '']) {
      const result = spawnSync('bash', [PACKAGE_SH, '--output-dir', name], { encoding: 'utf8' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('simple directory name');
    }
  });

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
    expect(src).toContain('${CARGO_TARGET_DIR:-$ROOT_DIR/rust/target}/$BACKEND_TARGET/release/silverhand-backend');
    expect(src).toContain('--target "$BACKEND_TARGET"');
  });

  it('does NOT claim an ECS/cross-compile Linux target build in this task', () => {
    // shiki (seq357/358): no cross-compile in #2343. No required SILVERHAND_RUST_TARGET
    // and no Linux target build in the embedded sidecar path.
    expect(src).not.toMatch(/SILVERHAND_RUST_TARGET is required/);
    expect(src).not.toMatch(/unknown-linux-gnu/);
  });

  it('keeps process smoke explicit while retaining static artifact checks', () => {
    expect(src).not.toContain('smoke-embedded-rust-backend.mts');
    expect(src).not.toContain('ensure_binding');
    expect(src).not.toContain('electron-rebuild');
    expect(src).toContain('SIDECAR_SHA256=');
    expect(src).toContain('verify_packaged_code_signature "$PACKAGED_APP_PATH"');
    expect(src).toContain('verify_packaged_app_version "$PACKAGED_APP_PATH"');
    const root = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));
    expect(root.scripts.build).toBe('pnpm -r build');
    expect(root.scripts['smoke:embedded-backend']).toBe('./packages/cli/node_modules/.bin/tsx scripts/smoke-embedded-rust-backend.mts');
  });
});
