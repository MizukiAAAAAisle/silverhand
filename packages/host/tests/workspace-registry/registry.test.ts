import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  REGISTRY_SCHEMA_VERSION,
  bindingSlug,
  managedWorkspaceSlug,
  type RegistryBinding,
} from '../../src/daemon/workspace-registry/index.js';

/**
 * relocation-v1 §7-4 (#task:1808) — the registry is a READ-ONLY reader of a
 * file an OLDER daemon wrote, consumed only by the one-time layout relocation.
 * Its write path (provision / resolve / has / requested-path validation) is
 * gone: a regular workspace's per-agent bundle resolves to a terminal
 * deterministic agent-centric coordinate, so there is no mapping to mint.
 *
 * What each block pins is therefore what a reader owes its one caller:
 *  - the inventory is reported faithfully, and an absent file means "nothing to
 *    relocate" rather than an error;
 *  - the header foreign guard (`registry_foreign`) still refuses to hand
 *    another binding's entries to a migration that would relocate them;
 *  - every deviation is `registry_corrupt` and NEVER a partial inventory — a
 *    half-read inventory would relocate half the old layout;
 *  - the reader writes nothing at all.
 *
 * The id-as-path-SEGMENT security boundary that used to live in `provision` /
 * `resolve` now lives in `daemon/workspace-path-authority.ts` and is covered by
 * `tests/workspace-path-authority.test.ts`.
 */

const STANDALONE: RegistryBinding = {
  server_origin: 'https://app.example.com',
  host_id: 'host_abc',
};
const EMBEDDED: RegistryBinding = {
  server_origin: 'local-embedded',
  host_id: 'local',
};

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'shd4e1-reg-'));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function makeRegistry(binding: RegistryBinding) {
  return new WorkspaceRegistry({ stateDir, binding });
}

/**
 * Write the legacy registry file the way the retired write path did. Tests
 * fixture it directly BECAUSE that is now the only way it can exist: the
 * reader never creates it, so a fixture that went through `provision()` would
 * be exercising code that no longer ships.
 */
function writeRegistryFile(
  binding: RegistryBinding,
  workspaces: Record<string, { path: string; provisioned_at: number }>,
): string {
  const filePath = join(stateDir, 'workspace-registry.json');
  writeFileSync(
    filePath,
    JSON.stringify({ schema_version: REGISTRY_SCHEMA_VERSION, binding, workspaces }, null, 2),
  );
  return filePath;
}

describe('WorkspaceRegistry — legacy inventory read', () => {
  it('reports the recorded inventory verbatim (id, path, provisioned_at)', () => {
    writeRegistryFile(STANDALONE, {
      ws_1: { path: join(stateDir, 'workspaces', 'ws_1'), provisioned_at: 1_700_000_000_000 },
      ws_2: { path: '/Users/someone/projects/custom', provisioned_at: 1_700_000_000_001 },
    });
    const entries = makeRegistry(STANDALONE)
      .list()
      .sort((a, b) => a.workspace_id.localeCompare(b.workspace_id));
    expect(entries).toEqual([
      {
        workspace_id: 'ws_1',
        path: join(stateDir, 'workspaces', 'ws_1'),
        provisioned_at: 1_700_000_000_000,
      },
      {
        workspace_id: 'ws_2',
        path: '/Users/someone/projects/custom',
        provisioned_at: 1_700_000_000_001,
      },
    ]);
  });

  it('an absent registry file is an EMPTY inventory, not a failure (nothing was ever provisioned)', () => {
    const reg = makeRegistry(STANDALONE);
    expect(reg.list()).toEqual([]);
    // …and reading did not conjure the file or a managed root.
    expect(existsSync(reg.registryFilePath())).toBe(false);
    expect(existsSync(join(stateDir, 'workspaces'))).toBe(false);
  });

  it('an empty recorded inventory reads as an empty list', () => {
    writeRegistryFile(STANDALONE, {});
    expect(makeRegistry(STANDALONE).list()).toEqual([]);
  });

  it('reading never mutates the file (the reader has no write path)', () => {
    const filePath = writeRegistryFile(STANDALONE, {
      ws_1: { path: '/Users/someone/projects/a', provisioned_at: 7 },
    });
    const before = readFileSync(filePath, 'utf-8');
    makeRegistry(STANDALONE).list();
    expect(readFileSync(filePath, 'utf-8')).toBe(before);
  });
});

describe('WorkspaceRegistry — one workspace-data root, one binding (#task:1608)', () => {
  it('the registry file sits FLAT on the workspace-data root — no per-binding namespace', () => {
    const standalone = makeRegistry(STANDALONE);
    expect(standalone.registryFilePath()).toBe(join(stateDir, 'workspace-registry.json'));
    // Both bindings address the SAME file: the computers/<computer_id> slot is
    // the enrollment boundary, so a second binding cannot get a parallel
    // namespace back — it gets the foreign guard (below) instead.
    expect(makeRegistry(EMBEDDED).registryFilePath()).toBe(standalone.registryFilePath());
    expect(standalone.currentBinding()).toEqual(STANDALONE);
  });

  it('bindingSlug is stable and path-safe (legacy migration coordinate only)', () => {
    const a = bindingSlug(STANDALONE);
    const b = bindingSlug(STANDALONE);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(bindingSlug(EMBEDDED)).not.toBe(a);
  });

  it('managedWorkspaceSlug stays deterministic (legacy migration coordinate only)', () => {
    expect(managedWorkspaceSlug('ws_1')).toBe(managedWorkspaceSlug('ws_1'));
    expect(managedWorkspaceSlug('ws_1')).toMatch(/^[0-9a-f]{32}$/);
    expect(managedWorkspaceSlug('ws_1')).not.toBe(managedWorkspaceSlug('ws_2'));
  });
});

describe('WorkspaceRegistry — fail-closed reads', () => {
  it('a file bound to another control-plane identity fails closed with registry_foreign', () => {
    writeRegistryFile(
      { server_origin: 'https://evil.example.com', host_id: 'other' },
      { ws_1: { path: '/Users/someone/projects/a', provisioned_at: 1 } },
    );
    // Never serve another backend/profile's entries to a migration that would
    // relocate them.
    expect(() => makeRegistry(STANDALONE).list()).toThrowError(
      expect.objectContaining({ code: 'registry_foreign' }),
    );
    expect(() => makeRegistry(EMBEDDED).list()).toThrowError(
      expect.objectContaining({ code: 'registry_foreign' }),
    );
  });

  it('malformed JSON fails closed with registry_corrupt', () => {
    const reg = makeRegistry(STANDALONE);
    writeFileSync(reg.registryFilePath(), '{ not valid json');
    expect(() => reg.list()).toThrowError(
      expect.objectContaining({ code: 'registry_corrupt' }),
    );
  });

  it('a schema deviation fails closed with registry_corrupt rather than a partial inventory', () => {
    const reg = makeRegistry(STANDALONE);
    for (const bad of [
      { schema_version: 99, binding: STANDALONE, workspaces: {} },
      { schema_version: REGISTRY_SCHEMA_VERSION, workspaces: {} },
      {
        schema_version: REGISTRY_SCHEMA_VERSION,
        binding: STANDALONE,
        workspaces: { ws_1: { path: '/a' } },
      },
      {
        schema_version: REGISTRY_SCHEMA_VERSION,
        binding: STANDALONE,
        workspaces: { ws_1: { path: '/a', provisioned_at: 1, extra: true } },
      },
    ]) {
      writeFileSync(reg.registryFilePath(), JSON.stringify(bad));
      let thrown: unknown;
      try {
        reg.list();
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected registry_corrupt for ${JSON.stringify(bad)}`).toBeInstanceOf(
        WorkspaceRegistryError,
      );
      expect((thrown as WorkspaceRegistryError).code).toBe('registry_corrupt');
    }
  });

  it('a directory where the registry file belongs is registry_corrupt (not an absent file)', () => {
    const reg = makeRegistry(STANDALONE);
    mkdirSync(reg.registryFilePath());
    expect(() => reg.list()).toThrowError(
      expect.objectContaining({ code: 'registry_corrupt' }),
    );
  });

  it('ids that collide case-insensitively are corrupt — their managed dirs alias on APFS (Cindy R3-4)', () => {
    writeRegistryFile(STANDALONE, {
      WsAbC: { path: join(stateDir, 'workspaces', 'WsAbC'), provisioned_at: 1 },
      wsabc: { path: '/tmp/elsewhere', provisioned_at: 1 },
    });
    expect(() => makeRegistry(STANDALONE).list()).toThrowError(
      expect.objectContaining({ code: 'registry_corrupt' }),
    );
  });
});
