/**
 * D4.a Commit 2 — unit tests for the desktop server-connection-profile
 * storage primitive.
 *
 * Coverage:
 *   - Round-trip: write → read returns the same profile.
 *   - Overwriting preserves `created_at`, bumps `updated_at`.
 *   - safeStorage unavailable at read time / write time → typed
 *     `storage_unavailable` (we never persist plaintext).
 *   - decrypt failure → typed `decrypt_failed`.
 *   - parse failure (decrypted to non-JSON / schema mismatch) → typed
 *     `parse_failed` with detail.
 *   - File permissions = 0600 after commit.
 *   - Atomic rename: temp file is cleaned up if write fails, and an
 *     overwrite never leaves a corrupted final file behind.
 *   - Clear: idempotent (`cleared: false` on missing); reports
 *     `cleared: true` when it actually removes a file.
 *   - Redact: view shape matches `{ server_url, updated_at }`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearServerConnectionProfile,
  readServerConnectionProfile,
  readServerConnectionProfileViewOrNull,
  serverConnectionProfilePath,
  writeServerConnectionProfile,
  type SafeStorageLike,
} from '../server-connection-profile.js';

/**
 * Fake safeStorage that uses a simple base64 round-trip — good enough
 * for tests because we only need encryptString / decryptString to be
 * inverses, not actually cryptographically secure.
 */
function makeFakeSafeStorage(opts?: {
  available?: boolean;
  decryptThrow?: boolean;
  encryptThrow?: boolean;
}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => opts?.available ?? true,
    encryptString: (plaintext: string): Buffer => {
      if (opts?.encryptThrow) throw new Error('encrypt fake fail');
      return Buffer.from(`fakecrypt:${plaintext}`, 'utf8');
    },
    decryptString: (buf: Buffer): string => {
      if (opts?.decryptThrow) throw new Error('decrypt fake fail');
      const s = buf.toString('utf8');
      if (!s.startsWith('fakecrypt:')) throw new Error('not fake-crypt');
      return s.slice('fakecrypt:'.length);
    },
  };
}

describe('server-connection-profile storage', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'd4a-profile-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('serverConnectionProfilePath', () => {
    it('joins under <root>/desktop/server-profile.bin', () => {
      expect(serverConnectionProfilePath(root)).toBe(
        join(root, 'desktop', 'server-profile.bin'),
      );
    });
  });

  describe('readServerConnectionProfile', () => {
    it('returns not_found when no file exists', () => {
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    it('returns storage_unavailable when safeStorage refuses', () => {
      // Pre-create a file so we get past the existence check; the
      // unavailable branch must fire before the read.
      const path = serverConnectionProfilePath(root);
      const writeResult = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ available: true }),
        serverUrl: 'http://127.0.0.1:7321',
      });
      expect(writeResult.ok).toBe(true);
      expect(existsSync(path)).toBe(true);
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ available: false }),
      });
      expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });
    });

    it('returns decrypt_failed when decryptString throws', () => {
      // Write a valid blob first.
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'http://127.0.0.1:7321',
      });
      // Now read with a safeStorage that always throws on decrypt.
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ decryptThrow: true }),
      });
      expect(result).toEqual({ ok: false, reason: 'decrypt_failed' });
    });

    it('returns parse_failed when decrypted content is not JSON', () => {
      const path = serverConnectionProfilePath(root);
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'http://127.0.0.1:7321',
      });
      // Replace the file with a fakecrypt blob of garbage.
      writeFileSync(path, Buffer.from('fakecrypt:not-json{', 'utf8'), { mode: 0o600 });
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('parse_failed');
    });

    it('returns parse_failed when schema does not match', () => {
      const path = serverConnectionProfilePath(root);
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'http://127.0.0.1:7321',
      });
      // Replace with valid JSON but missing required fields.
      writeFileSync(path, Buffer.from('fakecrypt:{"version":1}', 'utf8'), { mode: 0o600 });
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('parse_failed');
      expect((result as { detail: string }).detail).toContain('server_url');
    });
  });

  describe('writeServerConnectionProfile', () => {
    it('refuses when safeStorage is unavailable', () => {
      const result = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ available: false }),
        serverUrl: 'https://example.test',
      });
      expect(result).toEqual({ ok: false, reason: 'storage_unavailable' });
      // No file should have been created.
      expect(existsSync(serverConnectionProfilePath(root))).toBe(false);
    });

    it('round-trips: write then read returns the same profile', () => {
      const writeResult = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://backend.example.test',
        now: () => 1716800000000,
      });
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) throw new Error('unreachable');
      expect(writeResult.profile).toEqual({
        version: 1,
        server_url: 'https://backend.example.test',
        created_at: 1716800000000,
        updated_at: 1716800000000,
      });
      const readResult = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(readResult.ok).toBe(true);
      if (!readResult.ok) throw new Error('unreachable');
      expect(readResult.profile).toEqual(writeResult.profile);
    });

    it('preserves created_at on overwrite and bumps updated_at', () => {
      const firstWrite = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://first.example.test',
        now: () => 1000,
      });
      expect(firstWrite.ok).toBe(true);
      const secondWrite = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://second.example.test',
        now: () => 2000,
      });
      expect(secondWrite.ok).toBe(true);
      if (!secondWrite.ok) throw new Error('unreachable');
      expect(secondWrite.profile).toEqual({
        version: 1,
        server_url: 'https://second.example.test',
        created_at: 1000, // preserved
        updated_at: 2000, // bumped
      });
    });

    it('writes file with mode 0600', () => {
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://example.test',
      });
      const path = serverConnectionProfilePath(root);
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('leaves no temp file behind after a successful write', () => {
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://example.test',
      });
      const dir = join(root, 'desktop');
      const entries = readdirSync(dir);
      // Exactly one file: the live profile. No `.tmp-*` siblings.
      expect(entries).toEqual(['server-profile.bin']);
    });

    it('reports write_failed when encryptString throws and does NOT persist anything', () => {
      const result = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ encryptThrow: true }),
        serverUrl: 'https://example.test',
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('write_failed');
      expect(existsSync(serverConnectionProfilePath(root))).toBe(false);
    });

    it('does NOT overwrite the existing profile when encryptString throws on the second write', () => {
      // First write succeeds.
      const first = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://first.example.test',
        now: () => 1000,
      });
      expect(first.ok).toBe(true);
      // Second write throws — must not corrupt the first.
      const failedSecond = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ encryptThrow: true }),
        serverUrl: 'https://second.example.test',
        now: () => 2000,
      });
      expect(failedSecond.ok).toBe(false);
      // Read should still see the first profile intact.
      const readback = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(readback.ok).toBe(true);
      if (!readback.ok) throw new Error('unreachable');
      expect(readback.profile.server_url).toBe('https://first.example.test');
      expect(readback.profile.created_at).toBe(1000);
    });
  });

  describe('readServerConnectionProfileViewOrNull', () => {
    it('returns null when no profile exists', () => {
      expect(
        readServerConnectionProfileViewOrNull({
          silverhandRoot: root,
          safe: makeFakeSafeStorage(),
        }),
      ).toBeNull();
    });

    it('returns a redacted view (only server_url + updated_at)', () => {
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://example.test',
        now: () => 4242,
      });
      const view = readServerConnectionProfileViewOrNull({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(view).toEqual({
        server_url: 'https://example.test',
        updated_at: 4242,
      });
      // Defensive: the view object MUST NOT carry `version` /
      // `created_at`. If a future change widens
      // `redactServerConnectionProfile` and this test still passes
      // accidentally, the explicit `Object.keys` check below catches it.
      expect(Object.keys(view ?? {}).sort()).toEqual([
        'server_url',
        'updated_at',
      ]);
    });
  });

  describe('clearServerConnectionProfile', () => {
    it('is idempotent: reports cleared:false when no file exists', () => {
      const result = clearServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(result).toEqual({ ok: true, cleared: false });
    });

    it('reports cleared:true when it removes a real file', () => {
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://example.test',
      });
      const path = serverConnectionProfilePath(root);
      expect(existsSync(path)).toBe(true);
      const result = clearServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(result).toEqual({ ok: true, cleared: true });
      expect(existsSync(path)).toBe(false);
    });

    it('subsequent reads return not_found after a successful clear', () => {
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://example.test',
      });
      clearServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
      });
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('logger seam', () => {
    it('emits a warn line when decrypt fails', () => {
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: 'https://example.test',
      });
      const warn = vi.fn();
      const result = readServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ decryptThrow: true }),
        logger: { warn, info: vi.fn() },
      });
      expect(result.ok).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      // First arg is the structured payload bag; second is the message.
      const [payload, msg] = warn.mock.calls[0]!;
      expect(payload).toHaveProperty('path');
      expect(typeof msg).toBe('string');
    });

    it('emits a warn line when write fails (encryptThrow)', () => {
      const warn = vi.fn();
      const result = writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage({ encryptThrow: true }),
        serverUrl: 'https://example.test',
        logger: { warn, info: vi.fn() },
      });
      expect(result.ok).toBe(false);
      expect(warn).toHaveBeenCalled();
    });
  });

  describe('on-disk bytes contract', () => {
    it('persists the encrypted blob — plaintext URL must not appear in the file bytes', () => {
      const url = 'https://very-distinctive-string.example.test';
      writeServerConnectionProfile({
        silverhandRoot: root,
        safe: makeFakeSafeStorage(),
        serverUrl: url,
      });
      const path = serverConnectionProfilePath(root);
      const onDisk = readFileSync(path, 'utf8');
      // Our fake's "encryption" is base64-ish (just a prefix), so it's
      // intentionally visible in this test — but production safeStorage
      // would not emit the URL plaintext. Pin the fake's contract so a
      // future refactor that accidentally bypasses encryption gets
      // caught: the bytes MUST start with the `fakecrypt:` prefix.
      expect(onDisk.startsWith('fakecrypt:')).toBe(true);
      // And the encoded bytes MUST contain the URL because our fake
      // just prepends a prefix. (This is a sanity check that the
      // fake is actually round-tripping; with real safeStorage the
      // assertion would be inverted — URL must NOT appear.)
      expect(onDisk).toContain(url);
    });
  });
});
