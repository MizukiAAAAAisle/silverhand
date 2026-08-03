import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  WorkspaceRegistry,
  WorkspaceRegistryError,
  REGISTRY_SCHEMA_VERSION,
  bindingSlug,
  managedWorkspaceSlug,
  type RegistryBinding,
} from '../../src/daemon/workspace-registry/index.js';

// #task:1608 workspace-data convergence: the registry lives FLAT on the
// workspace-data root (`workspace-registry.json` + `workspaces/<raw id>`);
// the computers/<computer_id> slot is the enrollment boundary and the
// binding header is the foreign guard. Managed dirs are the VALIDATED raw
// workspace id — unsafe ids fail closed instead of being hashed.

/**
 * D4.e-1 daemon workspace registry tests. The registry is the keystone
 * primitive making the daemon the sole authority for host-local
 * regular-workspace path resolution. Each block pins one invariant:
 * deterministic managed path, idempotent provision, atomic + 0600
 * persistence, read fail-closed (`not_provisioned`), binding-slug
 * namespace isolation, and the header foreign-guard (`registry_foreign`).
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

function makeRegistry(binding: RegistryBinding, now = () => 1_700_000_000_000) {
  return new WorkspaceRegistry({ stateDir, binding, now });
}

describe('WorkspaceRegistry — provision', () => {
  it('provisions a deterministic managed path: the raw id directly under workspaces/', () => {
    const reg = makeRegistry(STANDALONE);
    const result = reg.provision('ws_1');
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(stateDir, 'workspaces', 'ws_1'));
  });

  it('is idempotent: re-provision returns existing path, created=false, preserves provisioned_at', () => {
    let t = 1_700_000_000_000;
    const reg = makeRegistry(STANDALONE, () => t);
    const first = reg.provision('ws_1');
    t = 1_700_000_999_999;
    const second = reg.provision('ws_1');
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    // provisioned_at must not be rewritten on re-provision.
    const file = JSON.parse(readFileSync(reg.registryFilePath(), 'utf-8'));
    expect(file.workspaces['ws_1'].provisioned_at).toBe(1_700_000_000_000);
  });

  it('does NOT create the managed directory on disk (registry is a pure mapping)', () => {
    const reg = makeRegistry(STANDALONE);
    const { path } = reg.provision('ws_1');
    expect(existsSync(path)).toBe(false);
  });

  it('persists the file with schema_version + current binding', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    const file = JSON.parse(readFileSync(reg.registryFilePath(), 'utf-8'));
    expect(file.schema_version).toBe(REGISTRY_SCHEMA_VERSION);
    expect(file.binding).toEqual(STANDALONE);
  });

  it('writes the registry file with mode 0600', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    const mode = statSync(reg.registryFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('WorkspaceRegistry — resolve (read fail-closed)', () => {
  it('resolves a provisioned workspace', () => {
    const reg = makeRegistry(STANDALONE);
    const { path } = reg.provision('ws_1');
    expect(reg.resolve('ws_1')).toBe(path);
  });

  it('throws not_provisioned for an unknown workspace (no managed-path guess)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    try {
      reg.resolve('ws_unknown');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceRegistryError);
      expect((err as WorkspaceRegistryError).code).toBe('not_provisioned');
    }
  });

  it('resolve on a never-written registry throws not_provisioned (not corrupt)', () => {
    const reg = makeRegistry(STANDALONE);
    try {
      reg.resolve('ws_1');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('not_provisioned');
    }
  });

  it('has() reflects provisioning', () => {
    const reg = makeRegistry(STANDALONE);
    expect(reg.has('ws_1')).toBe(false);
    reg.provision('ws_1');
    expect(reg.has('ws_1')).toBe(true);
  });
});

describe('WorkspaceRegistry — managed path safety (no traversal)', () => {
  const ESCAPES = ['../escape', 'a/b', '/abs', '..', '../../etc/passwd', 'x/../../y', '', 'a'.repeat(65), 'dot.dot'];

  it('a hostile or non-conforming id FAILS CLOSED instead of becoming a path component', () => {
    const reg = makeRegistry(STANDALONE);
    for (const id of ESCAPES) {
      try {
        reg.provision(id);
        throw new Error(`expected throw for ${JSON.stringify(id)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistryError);
        expect((err as WorkspaceRegistryError).code).toBe('invalid_path');
      }
      expect(reg.has(id)).toBe(false);
    }
  });

  it('resolve() fails closed on an unsafe id BEFORE any lookup — the id is now a downstream path SEGMENT (relocation-v1 §7 task 1)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    for (const id of ESCAPES) {
      try {
        reg.resolve(id);
        throw new Error(`expected throw for ${JSON.stringify(id)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistryError);
        expect((err as WorkspaceRegistryError).code).toBe('invalid_path');
      }
    }
  });

  it('provision(requestedPath) also fails closed on an unsafe id — the requested-path arm used to validate the PATH but not the ID (Cindy #1804 R1)', () => {
    const reg = makeRegistry(STANDALONE);
    for (const id of ESCAPES) {
      try {
        reg.provision(id, '/Users/someone/custom');
        throw new Error(`expected throw for ${JSON.stringify(id)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistryError);
        expect((err as WorkspaceRegistryError).code).toBe('invalid_path');
      }
      expect(reg.has(id)).toBe(false);
    }
  });

  it('a conforming id round-trips: provision → resolve by raw id', () => {
    const reg = makeRegistry(STANDALONE);
    const { path } = reg.provision('r6Cb5cuDnS2hAP9l');
    expect(path).toBe(join(stateDir, 'workspaces', 'r6Cb5cuDnS2hAP9l'));
    expect(reg.resolve('r6Cb5cuDnS2hAP9l')).toBe(path);
  });

  it('case-fold uniqueness (Cindy R3-4): a NEW id colliding case-insensitively with an existing one fails closed', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('WsAbC');
    try {
      reg.provision('wsabc');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('path_conflict');
    }
    expect(reg.has('wsabc')).toBe(false);
    // The exact same id stays idempotent.
    expect(reg.provision('WsAbC').created).toBe(false);
  });

  it('a persisted registry with case-fold-colliding ids is corrupt (fail closed on load)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('WsAbC');
    const file = JSON.parse(readFileSync(reg.registryFilePath(), 'utf-8'));
    file.workspaces['wsabc'] = { path: '/tmp/elsewhere', provisioned_at: 1 };
    writeFileSync(reg.registryFilePath(), JSON.stringify(file));
    expect(() => makeRegistry(STANDALONE).list()).toThrowError(
      expect.objectContaining({ code: 'registry_corrupt' }),
    );
  });

  it('managedWorkspaceSlug stays deterministic (legacy migration coordinate only)', () => {
    expect(managedWorkspaceSlug('ws_1')).toBe(managedWorkspaceSlug('ws_1'));
    expect(managedWorkspaceSlug('ws_1')).toMatch(/^[0-9a-f]{32}$/);
    expect(managedWorkspaceSlug('ws_1')).not.toBe(managedWorkspaceSlug('ws_2'));
  });
});

describe('WorkspaceRegistry — provision with a caller-proposed path', () => {
  const REQUESTED = '/Users/someone/projects/my-workspace';

  it('binds a caller-proposed path verbatim (resolved), preserving the user dir', () => {
    const reg = makeRegistry(STANDALONE);
    const result = reg.provision('ws_custom', REQUESTED);
    expect(result.created).toBe(true);
    expect(result.path).toBe(REQUESTED);
    expect(reg.resolve('ws_custom')).toBe(REQUESTED);
  });

  it('is idempotent on identical path; conflicts on a different path (no overwrite)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_custom', REQUESTED);
    expect(reg.provision('ws_custom', REQUESTED).created).toBe(false);
    try {
      reg.provision('ws_custom', '/Users/someone/other');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('path_conflict');
    }
    expect(reg.resolve('ws_custom')).toBe(REQUESTED);
  });

  it('no-path re-provision of an id bound to a custom path is idempotent (returns existing)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_custom', REQUESTED);
    const again = reg.provision('ws_custom');
    expect(again.created).toBe(false);
    expect(again.path).toBe(REQUESTED);
  });

  it('rejects a different id binding an already-bound path (cross-workspace conflict)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_a', REQUESTED);
    try {
      reg.provision('ws_b', REQUESTED);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('path_conflict');
    }
    expect(reg.has('ws_b')).toBe(false);
  });

  it('conflicts when a requested path differs from an id already bound to a managed path', () => {
    const reg = makeRegistry(STANDALONE);
    const managed = reg.provision('ws_1').path;
    expect(() => reg.provision('ws_1', REQUESTED)).toThrow(WorkspaceRegistryError);
    expect(reg.resolve('ws_1')).toBe(managed);
  });

  // Idempotent-first (D4.e-1 3b-2): re-binding an id to the SAME path it
  // already holds is a faithful no-op even when that path lives INSIDE the
  // managed root (which the requested-path guards reject for everyone
  // else) — but ONLY for that exact id+path pair; the managed-root guard
  // must still bite everyone else.
  it('managed-default id re-provisioned with its OWN managed path is idempotent (skips guards)', () => {
    const reg = makeRegistry(STANDALONE);
    const managed = reg.provision('ws_1').path; // inside the managed root
    const again = reg.provision('ws_1', managed); // faithful re-bind by the exact bound path
    expect(again.created).toBe(false);
    expect(again.path).toBe(managed);
    expect(reg.resolve('ws_1')).toBe(managed);
  });

  it('a DIFFERENT id requesting an existing managed path is still rejected', () => {
    const reg = makeRegistry(STANDALONE);
    const managed = reg.provision('ws_1').path;
    // ws_2 trying to claim ws_1's managed path must not succeed: it is inside
    // the managed root (invalid_path) — and even were it not, it overlaps an
    // existing binding (path_conflict). Either way: never created.
    try {
      reg.provision('ws_2', managed);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toMatch(
        /^(invalid_path|path_conflict)$/,
      );
    }
    expect(reg.has('ws_2')).toBe(false);
  });

  it('validates the requested path (daemon does not blindly trust backend)', () => {
    const reg = makeRegistry(STANDALONE);
    for (const bad of ['', '   ', 'relative/path', '/', homedir()]) {
      try {
        reg.provision('ws_bad', bad);
        throw new Error(`expected throw for ${JSON.stringify(bad)}`);
      } catch (err) {
        expect((err as WorkspaceRegistryError).code).toBe('invalid_path');
      }
    }
  });

  it('rejects a requested path inside the daemon-managed root', () => {
    const reg = makeRegistry(STANDALONE);
    const insideManaged = join(stateDir, 'workspaces', 'x');
    try {
      reg.provision('ws_inside', insideManaged);
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('invalid_path');
    }
  });
});

describe('WorkspaceRegistry — cross-workspace overlap conflict (P1-2)', () => {
  // Two workspaces must never bind equal OR nested roots: a recursive purge
  // of the outer one would delete the inner one (ownership alias).
  it('rejects a child path under an already-bound parent (parent → child)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_parent', '/Users/someone/projects');
    try {
      reg.provision('ws_child', '/Users/someone/projects/nested');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('path_conflict');
    }
    expect(reg.has('ws_child')).toBe(false);
  });

  it('rejects a parent path over an already-bound child (child → parent)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_child', '/Users/someone/projects/nested');
    try {
      reg.provision('ws_parent', '/Users/someone/projects');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('path_conflict');
    }
    expect(reg.has('ws_parent')).toBe(false);
  });

  it('allows sibling paths that merely share a prefix string but do not nest', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_a', '/Users/someone/proj');
    // `/Users/someone/proj-2` starts with `/Users/someone/proj` as a STRING
    // but is not nested (no `sep` boundary), so it must NOT conflict.
    const b = reg.provision('ws_b', '/Users/someone/proj-2');
    expect(b.created).toBe(true);
    expect(reg.resolve('ws_b')).toBe('/Users/someone/proj-2');
  });

  it('same-id parent↔child move is path_conflict, not a migration', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1', '/Users/someone/projects');
    expect(() => reg.provision('ws_1', '/Users/someone/projects/nested')).toThrow(
      WorkspaceRegistryError,
    );
    expect(reg.resolve('ws_1')).toBe('/Users/someone/projects');
  });
});

describe('WorkspaceRegistry — state-root guard (P1-3)', () => {
  // The daemon-canonical form of the retired backend `validateWorkspacePath`
  // rule (removed in D4.e-5): a caller-proposed path may not live inside the
  // silverhand state dir (L1 identity / daemon state / registry), EXCEPT a
  // child of the generated workspaces root.
  const SILVERHAND_ROOT = '/Users/someone/.silverhand';
  const LEGACY_ROOT = `${SILVERHAND_ROOT}/workspaces`;

  function makeGuarded() {
    return new WorkspaceRegistry({
      stateDir,
      binding: STANDALONE,
      silverhandStateRoot: SILVERHAND_ROOT,
      legacyWorkspacesRoot: LEGACY_ROOT,
      now: () => 1_700_000_000_000,
    });
  }

  it.each([
    SILVERHAND_ROOT,
    `${SILVERHAND_ROOT}/agents/AbCd`,
    `${SILVERHAND_ROOT}/daemon`,
    LEGACY_ROOT, // the workspaces root ITSELF is still rejected
  ])('rejects %s inside the state root', bad => {
    const reg = makeGuarded();
    try {
      reg.provision('ws_x', bad);
      throw new Error(`expected throw for ${bad}`);
    } catch (err) {
      expect((err as WorkspaceRegistryError).code).toBe('invalid_path');
    }
  });

  it('allows a child of the generated workspaces root (pre-D4 external-path carve-out)', () => {
    const reg = makeGuarded();
    const legacyWs = `${LEGACY_ROOT}/ws-legacy-abc`;
    const result = reg.provision('ws_legacy', legacyWs);
    expect(result.created).toBe(true);
    expect(reg.resolve('ws_legacy')).toBe(legacyWs);
  });

  it('without the guard configured, a state-dir path is NOT rejected by it', () => {
    // No silverhandStateRoot → the guard is off (other guards still apply).
    const reg = makeRegistry(STANDALONE);
    const inState = `${SILVERHAND_ROOT}/agents/AbCd`;
    const result = reg.provision('ws_nostate', inState);
    expect(result.created).toBe(true);
  });
});

describe('WorkspaceRegistry — remove (compensation, P1-1)', () => {
  const REQUESTED = '/Users/someone/projects/my-workspace';

  it('removes an entry that maps to the expected path and re-allows the id', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1', REQUESTED);
    expect(reg.remove('ws_1', REQUESTED)).toBe(true);
    expect(reg.has('ws_1')).toBe(false);
    // After rollback the id is free to bind a corrected path.
    const retry = reg.provision('ws_1', '/Users/someone/projects/fixed');
    expect(retry.created).toBe(true);
    expect(reg.resolve('ws_1')).toBe('/Users/someone/projects/fixed');
  });

  it('is a no-op when the entry maps to a DIFFERENT path (never deletes a rebind)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1', REQUESTED);
    expect(reg.remove('ws_1', '/Users/someone/other')).toBe(false);
    expect(reg.resolve('ws_1')).toBe(REQUESTED);
  });

  it('is a no-op for an unknown id', () => {
    const reg = makeRegistry(STANDALONE);
    expect(reg.remove('ws_missing', REQUESTED)).toBe(false);
  });
});

describe('WorkspaceRegistry — unbindMany (server-driven teardown, #task:1719)', () => {
  it('removes existing entries by id (no path guard), reports the rest absent, and re-allows removed ids', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1', '/Users/someone/projects/my-workspace');
    reg.provision('ws_2');
    expect(reg.unbindMany(['ws_1', 'ws_never_bound', 'ws_1'])).toEqual({
      removed: ['ws_1'],
      absent: ['ws_never_bound'],
    });
    expect(reg.has('ws_1')).toBe(false);
    // Untargeted binding survives; duplicate input ids are reported once.
    expect(reg.has('ws_2')).toBe(true);
    // After unbind the id is free to bind again (fresh workspace, same id).
    expect(reg.provision('ws_1').created).toBe(true);
  });

  it('is idempotent: a re-dispatched batch is pure absent, not an error', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    expect(reg.unbindMany(['ws_1'])).toEqual({ removed: ['ws_1'], absent: [] });
    expect(reg.unbindMany(['ws_1'])).toEqual({ removed: [], absent: ['ws_1'] });
  });

  it('an absent-only batch does NOT rewrite the registry file (persist skipped, P1-2)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    const file = reg.registryFilePath();
    // Pin the mtime far in the past: any persist (temp + rename) would
    // stamp a fresh mtime, so an unchanged stamp proves no write happened.
    const past = new Date('2000-01-01T00:00:00Z');
    utimesSync(file, past, past);
    const before = statSync(file).mtimeMs;
    expect(reg.unbindMany(['ws_never_bound', 'ws_also_never'])).toEqual({
      removed: [],
      absent: ['ws_never_bound', 'ws_also_never'],
    });
    expect(statSync(file).mtimeMs).toBe(before);
    expect(reg.has('ws_1')).toBe(true);
  });

  it('a mixed batch persists (removed set applied atomically alongside absent verdicts)', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    reg.provision('ws_2');
    const file = reg.registryFilePath();
    const past = new Date('2000-01-01T00:00:00Z');
    utimesSync(file, past, past);
    const before = statSync(file).mtimeMs;
    expect(reg.unbindMany(['ws_1', 'ws_ghost', 'ws_2'])).toEqual({
      removed: ['ws_1', 'ws_2'],
      absent: ['ws_ghost'],
    });
    // The one persist actually landed…
    expect(statSync(file).mtimeMs).not.toBe(before);
    // …and the reloaded file reflects the whole batch at once.
    const reopened = makeRegistry(STANDALONE);
    expect(reopened.has('ws_1')).toBe(false);
    expect(reopened.has('ws_2')).toBe(false);
  });

  it('fails closed on a foreign registry (WorkspaceRegistryError propagates, file untouched)', () => {
    const embedded = makeRegistry(EMBEDDED);
    embedded.provision('ws_1');
    const file = JSON.parse(readFileSync(embedded.registryFilePath(), 'utf-8'));
    file.binding = { server_origin: 'https://evil.example.com', host_id: 'other' };
    const foreignBytes = JSON.stringify(file);
    writeFileSync(embedded.registryFilePath(), foreignBytes);

    const reopened = makeRegistry(EMBEDDED);
    try {
      reopened.unbindMany(['ws_1']);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceRegistryError);
      expect((err as WorkspaceRegistryError).code).toBe('registry_foreign');
    }
    // Never clobbers someone else's registry.
    expect(readFileSync(reopened.registryFilePath(), 'utf-8')).toBe(foreignBytes);
  });

  it('NEVER touches the workspace directory on disk (mapping removal only, #1594)', () => {
    const reg = makeRegistry(STANDALONE);
    const { path } = reg.provision('ws_1');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'user-data.txt'), 'precious bytes');

    expect(reg.unbindMany(['ws_1'])).toEqual({ removed: ['ws_1'], absent: [] });
    expect(reg.has('ws_1')).toBe(false);
    // The directory and its contents survive the unbind untouched.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(join(path, 'user-data.txt'), 'utf-8')).toBe(
      'precious bytes',
    );
  });
});

describe('WorkspaceRegistry — one workspace-data root, one binding (#task:1608)', () => {
  it('a second binding on the same root fails closed as registry_foreign (never a parallel namespace)', () => {
    // The computers/<computer_id> slot is the enrollment boundary: the flat
    // registry belongs to exactly one binding. Another binding must not get
    // its own nested namespace back — every op fails closed on the header.
    const standalone = makeRegistry(STANDALONE);
    standalone.provision('ws_same_id');
    const embedded = makeRegistry(EMBEDDED);
    expect(embedded.registryFilePath()).toBe(standalone.registryFilePath());
    for (const op of [
      () => embedded.resolve('ws_same_id'),
      () => embedded.provision('ws_other'),
      () => embedded.list(),
    ]) {
      expect(op).toThrowError(expect.objectContaining({ code: 'registry_foreign' }));
    }
    // The rightful binding still reads its data.
    expect(makeRegistry(STANDALONE).has('ws_same_id')).toBe(true);
  });

  it('bindingSlug is stable and path-safe (legacy migration coordinate only)', () => {
    const a = bindingSlug(STANDALONE);
    const b = bindingSlug(STANDALONE);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(bindingSlug(EMBEDDED)).not.toBe(a);
  });
});

describe('WorkspaceRegistry — foreign guard + corruption (fail-closed)', () => {
  it('a registry file whose header binding mismatches fails closed with registry_foreign', () => {
    // Standalone provisions; then a handle with a *different* host_id but
    // the SAME slug path is impossible (slug derives from binding), so we
    // simulate a stale file by hand-writing a foreign binding into the
    // path the embedded handle reads.
    const embedded = makeRegistry(EMBEDDED);
    embedded.provision('ws_1'); // create the file at embedded's slug path
    const file = JSON.parse(readFileSync(embedded.registryFilePath(), 'utf-8'));
    file.binding = { server_origin: 'https://evil.example.com', host_id: 'other' };
    writeFileSync(embedded.registryFilePath(), JSON.stringify(file));

    // Re-open the same binding handle: the file now records a foreign
    // binding → every op fails closed and does not clobber.
    const reopened = makeRegistry(EMBEDDED);
    for (const op of [
      () => reopened.resolve('ws_1'),
      () => reopened.has('ws_1'),
      () => reopened.provision('ws_2'),
      () => reopened.list(),
    ]) {
      try {
        op();
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(WorkspaceRegistryError);
        expect((err as WorkspaceRegistryError).code).toBe('registry_foreign');
      }
    }
  });

  it('does not clobber a foreign registry on provision', () => {
    const embedded = makeRegistry(EMBEDDED);
    embedded.provision('ws_1');
    const file = JSON.parse(readFileSync(embedded.registryFilePath(), 'utf-8'));
    file.binding = { server_origin: 'https://evil.example.com', host_id: 'other' };
    const foreignBytes = JSON.stringify(file);
    writeFileSync(embedded.registryFilePath(), foreignBytes);

    const reopened = makeRegistry(EMBEDDED);
    expect(() => reopened.provision('ws_2')).toThrow(WorkspaceRegistryError);
    // File untouched.
    expect(readFileSync(reopened.registryFilePath(), 'utf-8')).toBe(foreignBytes);
  });

  it('malformed JSON / schema fails closed with registry_corrupt', () => {
    const reg = makeRegistry(STANDALONE);
    reg.provision('ws_1');
    writeFileSync(reg.registryFilePath(), '{ not valid json');
    expect(() => makeRegistry(STANDALONE).resolve('ws_1')).toThrow(
      /registry_corrupt|malformed/,
    );
  });
});
