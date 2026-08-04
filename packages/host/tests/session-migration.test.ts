/**
 * #task:1603/#task:1608 — session-namespace pure-function falsifiers
 * (hoisted with the module into the host migration unit; the vendor facts
 * they pin did not change).
 */
import { describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cwdSessionSlug,
  defaultNamespaceProbe,
  normalizeStoreRootOverride,
  runSessionRenamePass,
  runSessionSlugRepairPass,
  sessionNamespaceFor,
  SessionMigrationError,
} from '../src/daemon/workspace-registry/session-migration.js';

const silent = { info: () => {}, warn: () => {} };
const HOME = '/home/u';

/**
 * The vendors' own transforms, transcribed from the installed binaries
 * (`claude 2.1.221` `GC`/`nat`, `qodercli 1.1.6` `Bk`/`Uz_`). They are the
 * ORACLE for `cwdSessionSlug`: if the port ever drifts, the differential
 * assertion below fails. Never "cleaned up" — mirror the vendor code shape.
 */
function vendorClaudeSlug(cwd: string): string {
  const folded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (folded.length <= 200) return folded;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${folded.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

function vendorQoderSlug(cwd: string): string {
  const folded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (folded.length <= 200) return folded;
  let h = 5381;
  for (let i = 0; i < cwd.length; i++) h = (h * 33) ^ cwd.charCodeAt(i);
  return `${folded.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

/** Paths under a root that cannot exist, so the physical-path step is the
 *  identity and the differential compares the transform alone. Every input is
 *  ABSOLUTE — that is the callers' contract (registry paths are validated
 *  absolute) and what a child's `getcwd()` always is. */
const HERMETIC = '/nonexistent-1816';
const LONG_CWD = `${HERMETIC}/${'deep/'.repeat(50)}ws`;

describe('cwdSessionSlug — the claude/qoder cwd → namespace transform', () => {
  it('is byte-identical to both vendor transforms (#task:1816 differential)', () => {
    for (const cwd of [
      `${HERMETIC}/computers/host_id/workspaces/w_1`,
      `${HERMETIC}/My Projects/app (v2)`,
      `${HERMETIC}/\u6587\u6863/\u9879\u76ee a`,
      `${HERMETIC}/a'b&c#d,e/ws`,
      `${HERMETIC}/emoji-\u{1F600}/ws`,
      LONG_CWD,
    ]) {
      expect(cwdSessionSlug('claude', cwd)).toBe(vendorClaudeSlug(cwd.normalize('NFC')));
      expect(cwdSessionSlug('qoder', cwd)).toBe(vendorQoderSlug(cwd));
    }
  });

  it('matches the live managed-workspace probe byte-for-byte', () => {
    for (const kind of ['claude', 'qoder'] as const) {
      expect(
        cwdSessionSlug(kind, '/Users/shiki/.silverhand/computers/host_id/workspaces/w_1'),
      ).toBe('-Users-shiki--silverhand-computers-host-id-workspaces-w-1');
    }
  });

  it('every non-alphanumeric code unit folds — no path is outside the domain', () => {
    // The pre-#task:1816 gate rejected these; a real folder picker produces them.
    expect(cwdSessionSlug('claude', `${HERMETIC}/My Projects/app (v2)`)).toBe(
      '-nonexistent-1816-My-Projects-app--v2-',
    );
    expect(cwdSessionSlug('qoder', `${HERMETIC}/\u6587\u6863/\u9879\u76ee a`)).toBe(
      '-nonexistent-1816-------a',
    );
  });

  it('caps the folded slug at 200 and appends each vendor OWN hash', () => {
    const folded200 = `-nonexistent-1816${'-deep'.repeat(50)}-ws`.slice(0, 200);
    expect(cwdSessionSlug('claude', LONG_CWD)).toBe(`${folded200}-8js9uk`);
    expect(cwdSessionSlug('qoder', LONG_CWD)).toBe(`${folded200}-r8xt0f`);
    // The two hashes are what makes the slug a function of (kind, cwd).
    expect(cwdSessionSlug('claude', LONG_CWD)).not.toBe(cwdSessionSlug('qoder', LONG_CWD));
  });

  it('claude NFC-normalizes its input; qoder slugs the raw code units', () => {
    const nfc = `${HERMETIC}/caf\u00e9`;
    const nfd = `${HERMETIC}/cafe\u0301`;
    expect(cwdSessionSlug('claude', nfd)).toBe(cwdSessionSlug('claude', nfc));
    expect(cwdSessionSlug('qoder', nfd)).not.toBe(cwdSessionSlug('qoder', nfc));
  });

  it('slugs the PHYSICAL path, as the spawned child getcwd() would report it', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sh-slug-')));
    try {
      mkdirSync(join(root, 'real'));
      symlinkSync(join(root, 'real'), join(root, 'link'));
      for (const kind of ['claude', 'qoder'] as const) {
        expect(cwdSessionSlug(kind, join(root, 'link'))).toBe(
          cwdSessionSlug(kind, join(root, 'real')),
        );
        // A destination is slugged before it exists: the deepest existing
        // ancestor resolves and the remaining segments are re-appended.
        expect(cwdSessionSlug(kind, join(root, 'link', 'not-created-yet'))).toBe(
          cwdSessionSlug(kind, join(root, 'real', 'not-created-yet')),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('sessionNamespaceFor — the frozen inventory', () => {
  it('claude and qoder are cwd-scoped; codex/opencode/cursor/gemini are no-ops', () => {
    expect(sessionNamespaceFor('claude', '/w/s', HOME)).toBe(
      join(HOME, '.claude', 'projects', cwdSessionSlug('claude', '/w/s')),
    );
    expect(sessionNamespaceFor('qoder', '/w/s', HOME)).toBe(
      join(HOME, '.qoder', 'projects', cwdSessionSlug('qoder', '/w/s')),
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
    ).toBe(join('/custom/claude', 'projects', cwdSessionSlug('claude', '/w/s')));
  });

  it('QODER_CONFIG_DIR: absolute honored with qodercli 1.0.48 semantics (resolve + NFC); exact empty string is unset', () => {
    expect(
      sessionNamespaceFor('qoder', '/w/s', HOME, {
        QODER_CONFIG_DIR: '/custom/qode\u0301r/sub/..',
      }),
    ).toBe(join('/custom/qod\u00e9r', 'projects', cwdSessionSlug('qoder', '/w/s')));
    expect(sessionNamespaceFor('qoder', '/w/s', HOME, { QODER_CONFIG_DIR: '' })).toBe(
      join(HOME, '.qoder', 'projects', cwdSessionSlug('qoder', '/w/s')),
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

  it('repairs a cwd the old charset gate refused (space in the path, #task:1816)', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-repair-'));
    try {
      const cwd = '/root/workspaces/user name_w';
      const legacySlug = cwd.replace(/[/.]/g, '-');
      // The released slug kept the space verbatim; the vendor coordinate folds it.
      expect(legacySlug).toBe('-root-workspaces-user name_w');
      for (const store of ['.claude', '.qoder']) {
        const bucket = join(home, store, 'projects', legacySlug);
        mkdirSync(bucket, { recursive: true });
        writeFileSync(join(bucket, 's.jsonl'), store);
      }
      const warnings: Record<string, unknown>[] = [];

      expect(
        runSessionSlugRepairPass([cwd], {
          sessionStoreHome: home,
          env: {},
          logger: { info: () => {}, warn: fields => warnings.push(fields) },
        }),
      ).toEqual({ renamed: 2 });
      expect(warnings).toEqual([]);
      for (const kind of ['claude', 'qoder'] as const) {
        const store = kind === 'claude' ? '.claude' : '.qoder';
        expect(
          readFileSync(
            join(home, store, 'projects', cwdSessionSlug(kind, cwd), 's.jsonl'),
            'utf8',
          ),
        ).toBe(store);
        expect(existsSync(join(home, store, 'projects', legacySlug))).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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

  it('repairs a space-bearing and an ordinary cwd in one pass, warning about neither', () => {
    const spaceCwd = '/root/workspaces/user name_w';
    const plainCwd = '/root/workspaces/w_1';
    const warnings: Record<string, unknown>[] = [];
    const renamed: string[] = [];

    expect(
      runSessionSlugRepairPass([spaceCwd, plainCwd], {
        sessionStoreHome: HOME,
        env: {},
        logger: {
          info: () => {},
          warn: fields => warnings.push(fields),
        },
        probe: path =>
          path.endsWith(spaceCwd.replace(/[/.]/g, '-')) ||
          path.endsWith(plainCwd.replace(/[/.]/g, '-'))
            ? 'dir'
            : 'absent',
        rename: (from, to) => renamed.push(`${from}->${to}`),
      }),
    ).toEqual({ renamed: 4 });
    expect(warnings).toEqual([]);
    expect(renamed).toHaveLength(4);
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
      for (const kind of ['claude', 'qoder'] as const) {
        const store = kind === 'claude' ? '.claude' : '.qoder';
        expect(
          readFileSync(
            join(home, store, 'projects', cwdSessionSlug(kind, cwd), 's.jsonl'),
            'utf8',
          ),
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
      mkdirSync(join(root, cwdSessionSlug('claude', coexistCwd)), { recursive: true });
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
      expect(existsSync(join(root, cwdSessionSlug('claude', coexistCwd)))).toBe(true);
      expect(existsSync(join(root, cwdSessionSlug('claude', repairCwd)))).toBe(true);
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
    const currentPath = join(claudeRoot, cwdSessionSlug('claude', cwd));
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
      for (const kind of ['claude', 'qoder'] as const) {
        const store = kind === 'claude' ? '.claude' : '.qoder';
        const bucket = join(home, store, 'projects', cwdSessionSlug(kind, oldCwd));
        mkdirSync(bucket, { recursive: true });
        writeFileSync(join(bucket, 's.jsonl'), store);
      }
      const r = runSessionRenamePass([{ oldCwd, newCwd }], {
        sessionStoreHome: home,
        env: {},
        logger: silent,
      });
      expect(r.renamed).toBe(2);
      for (const kind of ['claude', 'qoder'] as const) {
        const store = kind === 'claude' ? '.claude' : '.qoder';
        expect(
          readFileSync(
            join(home, store, 'projects', cwdSessionSlug(kind, newCwd), 's.jsonl'),
            'utf8',
          ),
        ).toBe(store);
        expect(
          existsSync(join(home, store, 'projects', cwdSessionSlug(kind, oldCwd))),
        ).toBe(false);
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
      symlinkSync(target, join(home, '.claude', 'projects', cwdSessionSlug('claude', oldCwd)));
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
          probe: p => (p.includes(cwdSessionSlug('claude', '/a/b')) ? 'dir' : 'absent'),
          rename: () => {
            const err = new Error('EXDEV') as NodeJS.ErrnoException;
            err.code = 'EXDEV';
            throw err;
          },
        },
      ),
    ).toThrow(/EXDEV/);
  });

  it('migrates a cwd pair the old charset gate bricked (space + CJK, #task:1816)', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-'));
    try {
      // Exactly what the native folder picker used to accept unvalidated.
      const oldCwd = '/root/My Silverhand (2025)/\u5de5\u4f5c\u533a/w_1';
      const newCwd = '/root/computers/host_id/agents/a_1/workspaces/w_1';
      for (const kind of ['claude', 'qoder'] as const) {
        const store = kind === 'claude' ? '.claude' : '.qoder';
        const bucket = join(home, store, 'projects', cwdSessionSlug(kind, oldCwd));
        mkdirSync(bucket, { recursive: true });
        writeFileSync(join(bucket, 's.jsonl'), store);
      }

      expect(
        runSessionRenamePass([{ oldCwd, newCwd }], {
          sessionStoreHome: home,
          env: {},
          logger: silent,
        }).renamed,
      ).toBe(2);

      for (const kind of ['claude', 'qoder'] as const) {
        const store = kind === 'claude' ? '.claude' : '.qoder';
        expect(
          readFileSync(
            join(home, store, 'projects', cwdSessionSlug(kind, newCwd), 's.jsonl'),
            'utf8',
          ),
        ).toBe(store);
        expect(
          existsSync(join(home, store, 'projects', cwdSessionSlug(kind, oldCwd))),
        ).toBe(false);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a coexisting destination still FAILS CLOSED for such a cwd, never merged', () => {
    const home = mkdtempSync(join(tmpdir(), 'sh-sess-'));
    try {
      const oldCwd = '/root/My Silverhand (2025)/\u5de5\u4f5c\u533a/w_1';
      const newCwd = '/root/computers/host_id/agents/a_1/workspaces/w_1';
      const projects = join(home, '.claude', 'projects');
      mkdirSync(join(projects, cwdSessionSlug('claude', oldCwd)), { recursive: true });
      mkdirSync(join(projects, cwdSessionSlug('claude', newCwd)), { recursive: true });

      expect(() =>
        runSessionRenamePass([{ oldCwd, newCwd }], {
          sessionStoreHome: home,
          env: {},
          logger: silent,
        }),
      ).toThrow(/coexist/);
      expect(existsSync(join(projects, cwdSessionSlug('claude', oldCwd)))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
