/**
 * #task:1603/#task:1608 — session-namespace pure-function falsifiers
 * (hoisted with the module into the host migration unit; the vendor facts
 * they pin did not change).
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cwdSessionSlug,
  defaultNamespaceProbe,
  isSlugVerifiableCwd,
  normalizeStoreRootOverride,
  runSessionRenamePass,
  runSessionSlugRepairPass,
  sessionNamespaceFor,
  SessionMigrationError,
} from '../src/daemon/workspace-registry/session-migration.js';

const silent = { info: () => {}, warn: () => {} };
const HOME = '/home/u';

describe('cwdSessionSlug — the claude/qoder cwd → namespace transform', () => {
  it('matches live Claude/Qoder probes byte-for-byte (/ . and _ become -)', () => {
    expect(cwdSessionSlug('/Users/shiki/.silverhand/computers/host_id/workspaces/w_1')).toBe(
      '-Users-shiki--silverhand-computers-host-id-workspaces-w-1',
    );
  });

  it('windows-style separators are outside the verified charset', () => {
    expect(isSlugVerifiableCwd('C:\\Users\\x\\ws')).toBe(false);
    expect(isSlugVerifiableCwd('/Users/x/ws')).toBe(true);
  });
});

describe('sessionNamespaceFor — the frozen inventory', () => {
  it('claude and qoder are cwd-scoped; codex/opencode/cursor/gemini are no-ops', () => {
    expect(sessionNamespaceFor('claude', '/w/s', HOME)).toBe(
      join(HOME, '.claude', 'projects', cwdSessionSlug('/w/s')),
    );
    expect(sessionNamespaceFor('qoder', '/w/s', HOME)).toBe(
      join(HOME, '.qoder', 'projects', cwdSessionSlug('/w/s')),
    );
    for (const kind of ['codex', 'opencode', 'cursor', 'gemini'] as const) {
      expect(sessionNamespaceFor(kind, '/w/s', HOME)).toBeNull();
    }
  });

  it('CLAUDE_CONFIG_DIR: undefined=default; absolute byte-preserved; any other defined value unverifiable', () => {
    expect(normalizeStoreRootOverride(undefined)).toEqual({ kind: 'none' });
    expect(normalizeStoreRootOverride('')).toEqual({ kind: 'unverifiable' });
    expect(normalizeStoreRootOverride('  ')).toEqual({ kind: 'unverifiable' });
    expect(normalizeStoreRootOverride('/abs/dir')).toEqual({ kind: 'root', root: '/abs/dir' });
    expect(normalizeStoreRootOverride('/abs/dir ')).toEqual({ kind: 'root', root: '/abs/dir ' });
    expect(normalizeStoreRootOverride('relative/dir')).toEqual({ kind: 'unverifiable' });
    expect(normalizeStoreRootOverride('~/claude')).toEqual({ kind: 'unverifiable' });
    expect(
      sessionNamespaceFor('claude', '/w/s', HOME, { CLAUDE_CONFIG_DIR: '/custom/claude' }),
    ).toBe(join('/custom/claude', 'projects', cwdSessionSlug('/w/s')));
  });

  it('QODER_CONFIG_DIR: absolute honored with qodercli 1.0.48 semantics (resolve + NFC); exact empty string is unset', () => {
    expect(
      sessionNamespaceFor('qoder', '/w/s', HOME, {
        QODER_CONFIG_DIR: '/custom/qode\u0301r/sub/..',
      }),
    ).toBe(join('/custom/qod\u00e9r', 'projects', cwdSessionSlug('/w/s')));
    expect(sessionNamespaceFor('qoder', '/w/s', HOME, { QODER_CONFIG_DIR: '' })).toBe(
      join(HOME, '.qoder', 'projects', cwdSessionSlug('/w/s')),
    );
  });
});

describe('runSessionSlugRepairPass — released underscore-slug recovery', () => {
  it('is a strict no-op when no cwd can carry the released typo', () => {
    expect(
      runSessionSlugRepairPass(['/root/workspaces/no-underscore'], {
        sessionStoreHome: HOME,
        env: { CLAUDE_CONFIG_DIR: 'relative' },
        logger: silent,
        probe: () => {
          throw new Error('must not inspect an unrelated session store');
        },
      }),
    ).toEqual({ renamed: 0 });
  });

  it('skips before probing when a repair cwd is outside the verified charset', () => {
    const warnings: Record<string, unknown>[] = [];
    expect(
      runSessionSlugRepairPass(['/root/workspaces/user name_w'], {
        sessionStoreHome: HOME,
        env: {},
        logger: {
          info: () => {},
          warn: fields => warnings.push(fields),
        },
        probe: () => {
          throw new Error('must not inspect an unverifiable coordinate');
        },
      }),
    ).toEqual({ renamed: 0 });
    expect(warnings).toEqual([
      {
        action: 'runtime_session_namespace_slug_repair_skipped',
        reason: 'unverifiable_cwd',
        cwd: '/root/workspaces/user name_w',
      },
    ]);
  });

  it('an unverifiable runtime store does not cancel the other runtime repair', () => {
    const cwd = '/root/workspaces/w_1';
    const warnings: Record<string, unknown>[] = [];
    const renamed: string[] = [];
    expect(
      runSessionSlugRepairPass([cwd], {
        sessionStoreHome: HOME,
        env: { CLAUDE_CONFIG_DIR: 'relative' },
        logger: {
          info: () => {},
          warn: fields => warnings.push(fields),
        },
        probe: path =>
          path === join(HOME, '.qoder', 'projects', cwd.replace(/[/.]/g, '-'))
            ? 'dir'
            : 'absent',
        rename: (from, to) => renamed.push(`${from}->${to}`),
      }),
    ).toEqual({ renamed: 1 });
    expect(warnings).toEqual([
      {
        action: 'runtime_session_namespace_slug_repair_skipped',
        reason: 'unverifiable_store_root',
        runtime: 'claude',
        env_var: 'CLAUDE_CONFIG_DIR',
      },
    ]);
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toContain('/.qoder/projects/');
  });

  it('an unverifiable cwd does not cancel another cwd repair', () => {
    const badCwd = '/root/workspaces/user name_w';
    const goodCwd = '/root/workspaces/w_1';
    const warnings: Record<string, unknown>[] = [];
    const renamed: string[] = [];

    expect(
      runSessionSlugRepairPass([badCwd, goodCwd], {
        sessionStoreHome: HOME,
        env: {},
        logger: {
          info: () => {},
          warn: fields => warnings.push(fields),
        },
        probe: path =>
          path.endsWith(goodCwd.replace(/[/.]/g, '-')) ? 'dir' : 'absent',
        rename: (from, to) => renamed.push(`${from}->${to}`),
      }),
    ).toEqual({ renamed: 2 });
    expect(warnings).toEqual([
      {
        action: 'runtime_session_namespace_slug_repair_skipped',
        reason: 'unverifiable_cwd',
        cwd: badCwd,
      },
    ]);
    expect(renamed).toHaveLength(2);
  });

  it('atomically repairs the exact first-v2 namespace typo for both runtimes', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-repair-'));
    try {
      const cwd = '/root/computers/host_id/workspace-data/workspaces/w_1';
      const buggySlug = cwd.replace(/[/.]/g, '-');
      for (const store of ['.claude', '.qoder']) {
        const bucket = join(home, store, 'projects', buggySlug);
        mkdirSync(bucket, { recursive: true });
        writeFileSync(join(bucket, 's.jsonl'), store);
      }

      const result = runSessionSlugRepairPass([cwd], {
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });

      expect(result.renamed).toBe(2);
      for (const store of ['.claude', '.qoder']) {
        expect(
          readFileSync(join(home, store, 'projects', cwdSessionSlug(cwd), 's.jsonl'), 'utf8'),
        ).toBe(store);
        expect(existsSync(join(home, store, 'projects', buggySlug))).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves coexistence inert and continues repairing the next coordinate', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-repair-'));
    try {
      const coexistCwd = '/root/computers/host_id/workspace-data/workspaces/w';
      const repairCwd = '/root/computers/host_id/workspace-data/workspaces/w_2';
      const buggySlug = coexistCwd.replace(/[/.]/g, '-');
      const root = join(home, '.claude', 'projects');
      mkdirSync(join(root, buggySlug), { recursive: true });
      mkdirSync(join(root, cwdSessionSlug(coexistCwd)), { recursive: true });
      mkdirSync(join(root, repairCwd.replace(/[/.]/g, '-')), { recursive: true });
      const warnings: Record<string, unknown>[] = [];

      expect(
        runSessionSlugRepairPass([coexistCwd, repairCwd], {
          sessionStoreHome: home,
          env: {},
          logger: {
            info: () => {},
            warn: fields => warnings.push(fields),
          },
        }),
      ).toEqual({ renamed: 1 });
      expect(existsSync(join(root, buggySlug))).toBe(true);
      expect(existsSync(join(root, cwdSessionSlug(coexistCwd)))).toBe(true);
      expect(existsSync(join(root, cwdSessionSlug(repairCwd)))).toBe(true);
      expect(warnings).toEqual([
        {
          action: 'runtime_session_namespace_slug_repair_skipped',
          reason: 'coexist',
          runtime: 'claude',
          cwd: coexistCwd,
        },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'unreadable legacy namespace',
      legacyState: 'unreadable' as const,
      currentState: 'absent' as const,
      reason: 'legacy_unreadable',
    },
    {
      name: 'special legacy namespace',
      legacyState: 'special' as const,
      currentState: 'absent' as const,
      reason: 'legacy_special',
    },
    {
      name: 'unreadable current namespace',
      legacyState: 'dir' as const,
      currentState: 'unreadable' as const,
      reason: 'current_unreadable',
    },
    {
      name: 'special current namespace',
      legacyState: 'dir' as const,
      currentState: 'special' as const,
      reason: 'current_special',
    },
    {
      name: 'rename failure',
      legacyState: 'dir' as const,
      currentState: 'absent' as const,
      reason: 'rename_failed',
      renameFails: true,
    },
  ])('skips $name without widening it into a startup failure', testCase => {
    const cwd = '/root/computers/host_id/workspace-data/workspaces/w_1';
    const claudeRoot = join(HOME, '.claude', 'projects');
    const legacyPath = join(claudeRoot, cwd.replace(/[/.]/g, '-'));
    const currentPath = join(claudeRoot, cwdSessionSlug(cwd));
    const warnings: Record<string, unknown>[] = [];
    let renameCalls = 0;

    expect(
      runSessionSlugRepairPass([cwd], {
        sessionStoreHome: HOME,
        env: {},
        logger: {
          info: () => {},
          warn: fields => warnings.push(fields),
        },
        probe: path => {
          if (path === legacyPath) return testCase.legacyState;
          if (path === currentPath) return testCase.currentState;
          return 'absent';
        },
        rename: () => {
          renameCalls += 1;
          if (testCase.renameFails) throw new Error('rename failed');
        },
      }),
    ).toEqual({ renamed: 0 });
    expect(renameCalls).toBe(testCase.renameFails ? 1 : 0);
    expect(warnings).toEqual([
      {
        action: 'runtime_session_namespace_slug_repair_skipped',
        reason: testCase.reason,
        runtime: 'claude',
        cwd,
      },
    ]);
  });
});

describe('defaultNamespaceProbe', () => {
  it('classifies dir/absent/symlink correctly and never follows links', () => {
    const root = mkdtempSync(join(tmpdir(), 'sh-probe-'));
    try {
      mkdirSync(join(root, 'd'));
      symlinkSync(join(root, 'd'), join(root, 'link'));
      writeFileSync(join(root, 'f'), 'x');
      expect(defaultNamespaceProbe(join(root, 'd'))).toBe('dir');
      expect(defaultNamespaceProbe(join(root, 'missing'))).toBe('absent');
      expect(defaultNamespaceProbe(join(root, 'link'))).toBe('special');
      expect(defaultNamespaceProbe(join(root, 'f'))).toBe('special');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('runSessionRenamePass — fail-closed arms', () => {
  it('renames a sole old bucket atomically; contents survive byte-for-byte', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-'));
    try {
      const oldCwd = '/root/run/b/workspaces/w_old';
      const newCwd = '/root/computers/host_id/workspace-data/workspaces/w_new';
      for (const store of ['.claude', '.qoder']) {
        const bucket = join(home, store, 'projects', cwdSessionSlug(oldCwd));
        mkdirSync(bucket, { recursive: true });
        writeFileSync(join(bucket, 's.jsonl'), store);
      }
      const r = runSessionRenamePass([{ oldCwd, newCwd }], {
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });
      expect(r.renamed).toBe(2);
      for (const store of ['.claude', '.qoder']) {
        expect(
          readFileSync(join(home, store, 'projects', cwdSessionSlug(newCwd), 's.jsonl'), 'utf8'),
        ).toBe(store);
        expect(existsSync(join(home, store, 'projects', cwdSessionSlug(oldCwd)))).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a symlinked old bucket fails closed without traversal', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-'));
    try {
      const oldCwd = '/root/run/b/workspaces/w';
      const target = join(home, 'elsewhere');
      mkdirSync(target, { recursive: true });
      mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
      symlinkSync(target, join(home, '.claude', 'projects', cwdSessionSlug(oldCwd)));
      expect(() =>
        runSessionRenamePass(
          [{ oldCwd, newCwd: '/root/computers/local/workspace-data/b/workspaces/w' }],
          { sessionStoreHome: home, env: {}, logger: silent },
        ),
      ).toThrow(SessionMigrationError);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('an unreadable probe fails CLOSED, never "no sessions"', () => {
    expect(() =>
      runSessionRenamePass(
        [{ oldCwd: '/a/b', newCwd: '/a/c' }],
        {
          sessionStoreHome: HOME,
          env: {},
          logger: silent,
          probe: () => 'unreadable',
        },
      ),
    ).toThrow(/cannot be inspected/);
  });

  it('a rename failure (EXDEV/permissions) is a typed move failure; a copy is never attempted', () => {
    expect(() =>
      runSessionRenamePass(
        [{ oldCwd: '/a/b', newCwd: '/a/c' }],
        {
          sessionStoreHome: HOME,
          env: {},
          logger: silent,
          probe: p => (p.includes(cwdSessionSlug('/a/b')) ? 'dir' : 'absent'),
          rename: () => {
            const err = new Error('EXDEV') as NodeJS.ErrnoException;
            err.code = 'EXDEV';
            throw err;
          },
        },
      ),
    ).toThrow(/EXDEV/);
  });

  it('a cwd outside the verified slug charset FAILS CLOSED, never guessed (P1-2)', () => {
    expect(() =>
      runSessionRenamePass(
        [{ oldCwd: 'C:\\Users\\x\\ws', newCwd: '/a/c' }],
        {
          sessionStoreHome: HOME,
          env: {},
          logger: silent,
          probe: () => {
            throw new Error('must not probe an unverifiable pair');
          },
        },
      ),
    ).toThrow(/slug charset/);
  });

  it('a non-absolute config-dir override FAILS CLOSED naming the env var (P1-2)', () => {
    expect(() =>
      runSessionRenamePass(
        [{ oldCwd: '/a/b', newCwd: '/a/c' }],
        {
          sessionStoreHome: HOME,
          env: { QODER_CONFIG_DIR: 'relative/dir' },
          logger: silent,
          probe: () => 'absent',
        },
      ),
    ).toThrow(/QODER_CONFIG_DIR/);
  });
});
