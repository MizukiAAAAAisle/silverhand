// #task:2343 — sidecar artifact identity + integrity for the embedded Rust backend.
//
// The prebuilt `silverhand-backend` binary is shipped as a packaged sidecar next to a
// MANIFEST that pins its target/arch and executable SHA-256. Before spawning it, the
// launcher resolves the manifest and verifies the on-disk executable against it (arch
// match + SHA-256 match). This is the embedded ARTIFACT-IDENTITY gate (the version axis
// was deleted): a missing sidecar, a manifest/executable arch mismatch, or a corrupt/
// substituted binary all FAIL LOUD — the embedded arm never falls back to the TS
// backend. (Wire compatibility remains the independent `api_epoch`; process correlation
// is the startup `generation`.)

import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** The packaged sidecar manifest (`silverhand-backend.manifest.json`). No build_id /
 * version — only artifact location + platform identity + integrity. */
export interface SidecarManifest {
  /** The executable path, relative to the manifest's directory. #task:2343 P1-8: MUST be
   * a containment-safe RELATIVE path (no absolute, no `..` escape) — a canonical regular
   * executable inside the manifest directory. */
  executable: string;
  /** The Rust target triple the binary was built for (diagnostics + target gate). */
  target: string;
  /** `process.arch`-style arch label the binary runs on (e.g. `arm64`). Verified against
   * `process.arch` — a manifest whose `arch` contradicts the running process is rejected
   * (no self-contradicting identity fields). */
  arch: string;
  /** Lowercase hex SHA-256 of the executable file. */
  sha256: string;
}

export interface VerifiedSidecar {
  executablePath: string;
}

export type SidecarFailureKind =
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'unsupported-platform'
  | 'target-mismatch'
  | 'arch-mismatch'
  | 'executable-uncontained'
  | 'executable-missing'
  | 'executable-not-regular'
  | 'executable-not-executable'
  | 'sha256-mismatch';

export class SidecarVerificationError extends Error {
  constructor(
    readonly kind: SidecarFailureKind,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'SidecarVerificationError';
  }
}

/** Injection seams for unit tests (no real fs). */
export interface SidecarDeps {
  readManifest: (manifestPath: string) => Promise<string>;
  hashFile: (executablePath: string) => Promise<string>;
  /** Resolve the canonical (symlink-followed) absolute path. #task:2343 P1-8: used to
   * reject a symlink that escapes the manifest directory. Throws if the path is missing. */
  realpath: (path: string) => Promise<string>;
  /** Stat the executable (NOT following the final symlink). Returns whether it is a
   * regular file and whether the owner-executable bit is set. Throws if missing. */
  statExecutable: (path: string) => Promise<{ isRegularFile: boolean; isExecutable: boolean }>;
  /** The running process platform (`process.platform`, e.g. `darwin`). */
  currentPlatform: string;
  /** The running process arch (`process.arch`, e.g. `arm64`). */
  currentArch: string;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/**
 * #task:2343 — the Rust target triple the Desktop embedded package REQUIRES for the
 * current Electron platform + arch. The embedded sidecar must have been built for exactly
 * this triple (verified against `manifest.target`, not merely arch) — an ECS/Linux build
 * or an x64 build on an arm64 mac is rejected. Returns `null` for a platform/arch pair
 * the Desktop embedded build does not support (→ typed rejection).
 */
export function expectedRustTarget(
  platform: string,
  arch: string,
): string | null {
  const table: Record<string, Record<string, string>> = {
    darwin: {
      arm64: 'aarch64-apple-darwin',
      x64: 'x86_64-apple-darwin',
    },
    linux: {
      arm64: 'aarch64-unknown-linux-gnu',
      x64: 'x86_64-unknown-linux-gnu',
    },
    win32: {
      x64: 'x86_64-pc-windows-msvc',
    },
  };
  return table[platform]?.[arch] ?? null;
}

/**
 * Verify a packaged sidecar against its manifest: parse the manifest, require the manifest
 * TARGET TRIPLE to equal the Rust target this Desktop platform+arch requires (subsumes
 * arch — an ECS/Linux or wrong-arch build is rejected, #task:2343), then compute the
 * executable's SHA-256 and require it to equal the manifest value. Any discrepancy is a
 * hard, typed failure. Returns the absolute executable path to spawn.
 */
export async function verifySidecar(
  manifestPath: string,
  deps: SidecarDeps,
): Promise<VerifiedSidecar> {
  let raw: string;
  try {
    raw = await deps.readManifest(manifestPath);
  } catch (err) {
    throw new SidecarVerificationError(
      'manifest-missing',
      `embedded Rust backend sidecar manifest not found at ${manifestPath}`,
      err,
    );
  }
  const manifest = parseManifest(raw);
  // #task:2343 — verify the manifest TARGET TRIPLE against what this Desktop platform+arch
  // requires (subsumes arch). A sidecar built for a different target (an ECS/Linux build,
  // or the wrong arch) is rejected — the embedded package accepts only the desktop target.
  const requiredTarget = expectedRustTarget(deps.currentPlatform, deps.currentArch);
  if (requiredTarget === null) {
    throw new SidecarVerificationError(
      'unsupported-platform',
      `embedded Rust backend has no supported target for platform ${deps.currentPlatform} arch ${deps.currentArch}`,
    );
  }
  if (manifest.target !== requiredTarget) {
    throw new SidecarVerificationError(
      'target-mismatch',
      `embedded Rust backend sidecar target ${manifest.target} does not match the required desktop target ${requiredTarget} `
        + `(platform ${deps.currentPlatform} arch ${deps.currentArch})`,
    );
  }
  // #task:2343 P1-8 — the manifest `arch` must not contradict the running process. The
  // target triple already subsumes arch, so `arch` is a redundant identity field; keeping
  // it means it MUST agree with `process.arch`, otherwise the manifest is self-inconsistent.
  if (manifest.arch !== deps.currentArch) {
    throw new SidecarVerificationError(
      'arch-mismatch',
      `embedded Rust backend sidecar manifest arch ${manifest.arch} does not match process arch ${deps.currentArch}`,
    );
  }
  // #task:2343 P1-8 — CONTAINMENT: the executable must be a RELATIVE path that resolves to
  // a location INSIDE the manifest's directory. Reject absolute paths and any `..` escape
  // up front (before any fs touch), then reject a symlink that escapes the directory by
  // comparing the realpath'd executable against the realpath'd manifest dir.
  const manifestDir = dirname(manifestPath);
  if (isAbsolute(manifest.executable)) {
    throw new SidecarVerificationError(
      'executable-uncontained',
      `embedded Rust backend sidecar executable must be relative to the manifest directory, got absolute ${manifest.executable}`,
    );
  }
  const executablePath = resolve(manifestDir, manifest.executable);
  const containedRel = relative(manifestDir, executablePath);
  if (containedRel === '' || containedRel === '..' || containedRel.startsWith(`..${sep}`) || isAbsolute(containedRel)) {
    throw new SidecarVerificationError(
      'executable-uncontained',
      `embedded Rust backend sidecar executable ${manifest.executable} escapes the manifest directory`,
    );
  }
  // Symlink-escape: the canonical (symlink-followed) executable must still live inside the
  // canonical manifest directory. A symlink pointing outside the sidecar dir is rejected.
  let canonicalExecutable: string;
  let canonicalDir: string;
  try {
    canonicalExecutable = await deps.realpath(executablePath);
  } catch (err) {
    throw new SidecarVerificationError(
      'executable-missing',
      `embedded Rust backend executable not found at ${executablePath}`,
      err,
    );
  }
  try {
    canonicalDir = await deps.realpath(manifestDir);
  } catch (err) {
    throw new SidecarVerificationError(
      'executable-uncontained',
      `embedded Rust backend sidecar manifest directory ${manifestDir} could not be canonicalized`,
      err,
    );
  }
  const canonicalRel = relative(canonicalDir, canonicalExecutable);
  if (canonicalRel === '' || canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`) || isAbsolute(canonicalRel)) {
    throw new SidecarVerificationError(
      'executable-uncontained',
      `embedded Rust backend sidecar executable resolves (via symlink) outside the manifest directory: ${canonicalExecutable}`,
    );
  }
  // The target must be a REGULAR, EXECUTABLE file (not a directory, device, or a
  // non-executable blob).
  let fileStat: { isRegularFile: boolean; isExecutable: boolean };
  try {
    fileStat = await deps.statExecutable(executablePath);
  } catch (err) {
    throw new SidecarVerificationError(
      'executable-missing',
      `embedded Rust backend executable not readable at ${executablePath}`,
      err,
    );
  }
  if (!fileStat.isRegularFile) {
    throw new SidecarVerificationError(
      'executable-not-regular',
      `embedded Rust backend sidecar executable ${executablePath} is not a regular file`,
    );
  }
  if (!fileStat.isExecutable) {
    throw new SidecarVerificationError(
      'executable-not-executable',
      `embedded Rust backend sidecar executable ${executablePath} is not executable`,
    );
  }
  let actualSha: string;
  try {
    actualSha = await deps.hashFile(executablePath);
  } catch (err) {
    throw new SidecarVerificationError(
      'executable-missing',
      `embedded Rust backend executable not readable at ${executablePath}`,
      err,
    );
  }
  if (actualSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
    throw new SidecarVerificationError(
      'sha256-mismatch',
      `embedded Rust backend executable SHA-256 ${actualSha} does not match manifest ${manifest.sha256}`,
    );
  }
  return { executablePath: canonicalExecutable };
}

function parseManifest(raw: string): SidecarManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SidecarVerificationError(
      'manifest-invalid',
      'embedded Rust backend sidecar manifest is not valid JSON',
      err,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SidecarVerificationError(
      'manifest-invalid',
      'embedded Rust backend sidecar manifest must be a JSON object',
    );
  }
  const record = parsed as Record<string, unknown>;
  const executable = record.executable;
  const target = record.target;
  const arch = record.arch;
  const sha256 = record.sha256;
  if (
    Object.keys(record).length !== 4 ||
    typeof executable !== 'string' ||
    executable.length === 0 ||
    typeof target !== 'string' ||
    target.length === 0 ||
    typeof arch !== 'string' ||
    arch.length === 0 ||
    typeof sha256 !== 'string' ||
    !HEX64.test(sha256)
  ) {
    throw new SidecarVerificationError(
      'manifest-invalid',
      'embedded Rust backend sidecar manifest is missing/malformed fields (executable, target, arch, sha256)',
    );
  }
  return { executable, target, arch, sha256 };
}

/** The default production fs-backed deps: read the manifest file and stream-hash the
 * executable with SHA-256. */
export function productionSidecarDeps(): SidecarDeps {
  return {
    readManifest: (manifestPath) => readFile(manifestPath, 'utf8'),
    hashFile: (executablePath) =>
      new Promise<string>((resolvePromise, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(executablePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolvePromise(hash.digest('hex')));
      }),
    realpath: (path) => realpath(path),
    statExecutable: async (path) => {
      const st = await stat(path);
      // Owner/group/other execute bit (any) — the packaged sidecar is chmod +x.
      const isExecutable =
        (st.mode &
          (fsConstants.S_IXUSR | fsConstants.S_IXGRP | fsConstants.S_IXOTH)) !==
        0;
      return { isRegularFile: st.isFile(), isExecutable };
    },
    currentPlatform: process.platform,
    currentArch: process.arch,
  };
}

/** The electron environment inputs `resolveBackendSidecarManifestPath` needs. Passed in
 * (not read from `electron`) so the resolution is pure + unit-testable. */
export interface BackendSidecarLocation {
  isPackaged: boolean;
  /** `process.resourcesPath` (packaged). */
  resourcesPath: string;
  /** `app.getAppPath()` (dev) — the desktop package dir, two levels under the repo root. */
  appPath: string;
}

/** The manifest filename shipped alongside the sidecar executable. */
export const SIDECAR_MANIFEST_FILENAME = 'silverhand-backend.manifest.json';

/**
 * Resolve the absolute path to the sidecar MANIFEST for the current environment. The
 * executable path itself is derived from the manifest by `verifySidecar` (so the manifest
 * is the single source of the artifact location + integrity).
 *
 *  - packaged: `${resourcesPath}/silverhand-backend/silverhand-backend.manifest.json`
 *    (electron-builder `extraResources` ships the sidecar dir there, mirroring
 *    `silverhand-cli` / `silverhand-daemon`).
 *  - dev: `<repo>/rust/target/release/silverhand-backend.manifest.json` — the dev build
 *    script writes the manifest next to the `cargo build --release` binary. `appPath` is
 *    `<repo>/apps/desktop`, so the repo root is two levels up.
 *
 * NEVER a Cargo invocation at runtime: this only LOCATES a prebuilt artifact + manifest;
 * a missing manifest/binary fails loud in `verifySidecar`.
 */
export function resolveBackendSidecarManifestPath(
  location: BackendSidecarLocation,
): string {
  if (location.isPackaged) {
    return resolve(location.resourcesPath, 'silverhand-backend', SIDECAR_MANIFEST_FILENAME);
  }
  const repoRoot = resolve(location.appPath, '../..');
  return resolve(repoRoot, 'rust/target/release', SIDECAR_MANIFEST_FILENAME);
}
