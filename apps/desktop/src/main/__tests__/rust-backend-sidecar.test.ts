import { describe, expect, it } from 'vitest';

import {
  SIDECAR_MANIFEST_FILENAME,
  SidecarVerificationError,
  resolveBackendSidecarManifestPath,
  verifySidecar,
  type SidecarDeps,
} from '../rust-backend-sidecar.js';

const SHA = 'a'.repeat(64);

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    executable: 'silverhand-backend',
    target: 'aarch64-apple-darwin',
    arch: 'arm64',
    sha256: SHA,
    ...overrides,
  });
}

function deps(overrides: Partial<SidecarDeps> = {}): SidecarDeps {
  return {
    readManifest: async () => manifest(),
    hashFile: async () => SHA,
    // By default the executable is a contained, regular, executable file whose realpath
    // stays inside the manifest dir.
    realpath: async (p) => p,
    statExecutable: async () => ({ isRegularFile: true, isExecutable: true }),
    currentPlatform: 'darwin',
    currentArch: 'arm64',
    ...overrides,
  };
}

describe('verifySidecar — artifact identity + integrity (no version)', () => {
  it('resolves the executable path (relative to the manifest dir) on a full match', async () => {
    const result = await verifySidecar('/app/resources/silverhand-backend.manifest.json', deps());
    expect(result.executablePath).toBe('/app/resources/silverhand-backend');
  });

  it('#task:2343 P1-8: REJECTS an absolute executable path (must be contained in the manifest dir)', async () => {
    await expect(
      verifySidecar('/app/m.json', deps({
        readManifest: async () => manifest({ executable: '/opt/silverhand-backend' }),
      })),
    ).rejects.toMatchObject({ kind: 'executable-uncontained' });
  });

  it('#task:2343 P1-8: REJECTS a `..` escape in the executable path', async () => {
    await expect(
      verifySidecar('/app/resources/silverhand-backend/m.json', deps({
        readManifest: async () => manifest({ executable: '../../../etc/evil' }),
      })),
    ).rejects.toMatchObject({ kind: 'executable-uncontained' });
  });

  it('#task:2343 P1-8: REJECTS a symlink that escapes the manifest directory', async () => {
    await expect(
      verifySidecar('/app/sidecar/m.json', deps({
        // The relative path is contained, but its realpath points outside the dir.
        realpath: async (p) =>
          p.endsWith('silverhand-backend') ? '/opt/outside/silverhand-backend' : p,
      })),
    ).rejects.toMatchObject({ kind: 'executable-uncontained' });
  });

  it('#task:2343 P1-8: REJECTS a non-regular file (directory/device)', async () => {
    await expect(
      verifySidecar('/app/sidecar/m.json', deps({
        statExecutable: async () => ({ isRegularFile: false, isExecutable: true }),
      })),
    ).rejects.toMatchObject({ kind: 'executable-not-regular' });
  });

  it('#task:2343 P1-8: REJECTS a non-executable file', async () => {
    await expect(
      verifySidecar('/app/sidecar/m.json', deps({
        statExecutable: async () => ({ isRegularFile: true, isExecutable: false }),
      })),
    ).rejects.toMatchObject({ kind: 'executable-not-executable' });
  });

  it('#task:2343 P1-8: REJECTS a manifest whose arch contradicts the running process', async () => {
    // target matches the required desktop triple, but the redundant `arch` field lies.
    await expect(
      verifySidecar('/app/sidecar/m.json', deps({
        readManifest: async () =>
          manifest({ target: 'aarch64-apple-darwin', arch: 'x64' }),
        currentPlatform: 'darwin',
        currentArch: 'arm64',
      })),
    ).rejects.toMatchObject({ kind: 'arch-mismatch' });
  });

  it('fails loud when the manifest is missing', async () => {
    await expect(
      verifySidecar('/nope.json', deps({
        readManifest: async () => {
          throw new Error('ENOENT');
        },
      })),
    ).rejects.toMatchObject({ kind: 'manifest-missing' });
  });

  it('fails loud on invalid manifest JSON / shape', async () => {
    await expect(
      verifySidecar('/m.json', deps({ readManifest: async () => 'not json' })),
    ).rejects.toMatchObject({ kind: 'manifest-invalid' });
    await expect(
      verifySidecar('/m.json', deps({ readManifest: async () => manifest({ sha256: 'short' }) })),
    ).rejects.toMatchObject({ kind: 'manifest-invalid' });
    await expect(
      verifySidecar('/m.json', deps({ readManifest: async () => manifest({ arch: '' }) })),
    ).rejects.toMatchObject({ kind: 'manifest-invalid' });
  });

  it('fails loud on a target mismatch — wrong arch on this platform (no fallback)', async () => {
    // darwin/x64 requires x86_64-apple-darwin; the manifest is aarch64-apple-darwin.
    await expect(
      verifySidecar('/m.json', deps({ currentArch: 'x64' })),
    ).rejects.toMatchObject({ kind: 'target-mismatch' });
  });

  it('REJECTS a forged manifest whose arch matches but target is a Linux triple (#task:2343)', async () => {
    // The exact ECS/desktop confusion: same arch label (arm64) but an ECS Linux target.
    // Verifying only arch would wrongly accept it; the target check fails closed.
    await expect(
      verifySidecar(
        '/m.json',
        deps({
          readManifest: async () =>
            manifest({ target: 'aarch64-unknown-linux-gnu', arch: 'arm64' }),
          currentPlatform: 'darwin',
          currentArch: 'arm64',
        }),
      ),
    ).rejects.toMatchObject({ kind: 'target-mismatch' });
  });

  it('fails loud on an unsupported platform/arch pair', async () => {
    await expect(
      verifySidecar('/m.json', deps({ currentPlatform: 'aix', currentArch: 'ppc64' })),
    ).rejects.toMatchObject({ kind: 'unsupported-platform' });
  });

  it('fails loud when the executable is unreadable', async () => {
    await expect(
      verifySidecar('/m.json', deps({
        hashFile: async () => {
          throw new Error('ENOENT');
        },
      })),
    ).rejects.toMatchObject({ kind: 'executable-missing' });
  });

  it('fails loud on a SHA-256 mismatch (corrupt/substituted binary)', async () => {
    await expect(
      verifySidecar('/m.json', deps({ hashFile: async () => 'b'.repeat(64) })),
    ).rejects.toMatchObject({ kind: 'sha256-mismatch' });
  });

  it('is case-insensitive on the hex digest comparison', async () => {
    const result = await verifySidecar('/app/m.json', deps({
      readManifest: async () => manifest({ sha256: SHA.toUpperCase() }),
      hashFile: async () => SHA,
    }));
    expect(result.executablePath).toBe('/app/silverhand-backend');
  });
});

describe('resolveBackendSidecarManifestPath — dev vs packaged (no runtime Cargo)', () => {
  it('packaged: under resourcesPath/silverhand-backend', () => {
    const path = resolveBackendSidecarManifestPath({
      isPackaged: true,
      resourcesPath: '/Applications/Silverhand.app/Contents/Resources',
      appPath: '/whatever',
    });
    expect(path).toBe(
      `/Applications/Silverhand.app/Contents/Resources/silverhand-backend/${SIDECAR_MANIFEST_FILENAME}`,
    );
  });

  it('dev: under <repo>/rust/target/release (repo root = appPath ../..)', () => {
    const path = resolveBackendSidecarManifestPath({
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: '/Users/x/workspace/repo/apps/desktop',
    });
    expect(path).toBe(
      `/Users/x/workspace/repo/rust/target/release/${SIDECAR_MANIFEST_FILENAME}`,
    );
  });
});
