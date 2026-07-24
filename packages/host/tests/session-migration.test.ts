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
  sessionNamespaceFor,
  SessionMigrationError,
} from '../src/daemon/workspace-registry/session-migration.js';

const silent = { info: () => {}, warn: () => {} };
const HOME = '/home/u';

describe('cwdSessionSlug — the claude/qoder cwd → namespace transform', () => {
  it('matches the live fixture byte-for-byte (every / and . becomes -)', () => {
    expect(cwdSessionSlug('/Users/shiki/.silverhand/run/c8705d/workspaces/w1')).toBe(
      '-Users-shiki--silverhand-run-c8705d-workspaces-w1',
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
      const oldCwd = '/root/run/b/workspaces/w';
      const newCwd = '/root/computers/local/workspace-data/b/workspaces/w';
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
