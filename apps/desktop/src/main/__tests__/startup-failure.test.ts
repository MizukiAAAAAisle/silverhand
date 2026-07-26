import { describe, expect, it } from 'vitest';
import { describeStartupFailure } from '../startup-failure';
import {
  presentStartupFailure,
  renderStartupFailureDocument,
  QUIT_URL,
  REVEAL_LOGS_URL,
  type StartupFailureExitDeps,
} from '../startup-failure-exit';
import { LayoutMigrationError } from '../layout-migration/engine';
import { ProfileUnusableError } from '../backend-boot-mode';

const NOTICE = {
  headline: 'Silverhand could not migrate its data folder.',
  code: 'layout_conflict',
  detail: 'both the legacy and the v2 root exist',
};

function deps(
  overrides: Partial<StartupFailureExitDeps> = {},
): StartupFailureExitDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    openWindow: async () => {
      calls.push('openWindow');
    },
    showErrorBox: () => calls.push('showErrorBox'),
    revealLogs: dir => calls.push(`revealLogs:${dir}`),
    exit: code => calls.push(`exit:${code}`),
    ...overrides,
  };
}

describe('presentStartupFailure — every path reaches the user and exits', () => {
  it('a window whose document fails to load falls back to the native box and exits 1', async () => {
    // The falsifier for the original bug: `void win.loadURL(…)` left the
    // rejection unhandled, so a failed load produced an invisible window,
    // no `ready-to-show`, and the same silence this module exists to
    // remove. The window dependency now rejects, and that rejection MUST
    // converge here.
    const d = deps({
      openWindow: async () => {
        throw new Error('ERR_FAILED');
      },
    });
    await presentStartupFailure({ notice: NOTICE, logsDir: '/logs' }, d);
    expect(d.calls).toEqual(['showErrorBox', 'exit:1']);
  });

  it('a window dependency that throws synchronously converges the same way', async () => {
    const d = deps({
      openWindow: () => {
        throw new Error('BrowserWindow unavailable');
      },
    });
    await presentStartupFailure({ notice: NOTICE, logsDir: '/logs' }, d);
    expect(d.calls).toEqual(['showErrorBox', 'exit:1']);
  });

  it('still exits 1 when even the native box throws', async () => {
    const d = deps({
      openWindow: async () => {
        throw new Error('ERR_FAILED');
      },
      showErrorBox: () => {
        throw new Error('no display');
      },
    });
    await expect(
      presentStartupFailure({ notice: NOTICE, logsDir: null }, d),
    ).rejects.toThrow('no display');
    expect(d.calls).toEqual(['exit:1']);
  });

  it('a window that loads owns the lifetime — no box, no exit yet', async () => {
    const d = deps();
    await presentStartupFailure({ notice: NOTICE, logsDir: '/logs' }, d);
    expect(d.calls).toEqual(['openWindow']);
  });
});

describe('presentStartupFailure — window actions', () => {
  async function capturedActions(logsDir: string | null) {
    let onAction: (url: string) => void = () => {
      throw new Error('window never opened');
    };
    const d = deps({
      openWindow: async input => {
        onAction = input.onAction;
      },
    });
    await presentStartupFailure({ notice: NOTICE, logsDir }, d);
    return { act: (url: string) => onAction(url), calls: d.calls };
  }

  it('reveals the logs directory and quits non-zero', async () => {
    const { act, calls } = await capturedActions('/logs');
    act(REVEAL_LOGS_URL);
    act(QUIT_URL);
    expect(calls).toEqual(['revealLogs:/logs', 'exit:1']);
  });

  it('ignores a reveal action when there is no logs directory, and ignores unknown urls', async () => {
    const { act, calls } = await capturedActions(null);
    act(REVEAL_LOGS_URL);
    act('https://example.com/');
    expect(calls).toEqual([]);
  });
});

describe('renderStartupFailureDocument', () => {
  it('escapes the failure detail — it is verbatim error text', () => {
    const html = renderStartupFailureDocument(
      { ...NOTICE, detail: '<script>alert(1)</script>' },
      '/logs/<x>',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('/logs/&lt;x&gt;');
  });

  it('offers Quit always and Reveal Logs only with a logs directory, and never a Retry', () => {
    const withLogs = renderStartupFailureDocument(NOTICE, '/logs');
    expect(withLogs).toContain(REVEAL_LOGS_URL);
    expect(withLogs).toContain(QUIT_URL);
    const withoutLogs = renderStartupFailureDocument(NOTICE, null);
    expect(withoutLogs).not.toContain(REVEAL_LOGS_URL);
    expect(withoutLogs).toContain(QUIT_URL);
    // No in-process retry exists on this path: every landing needs a
    // filesystem or profile repair first.
    for (const html of [withLogs, withoutLogs]) {
      expect(html).not.toMatch(/retry/i);
    }
  });

  it('never claims the data was left alone', async () => {
    // Semantic fence, not a styling one (#task:1641 review): the claim
    // cannot be derived from the error — `LayoutMigrationError` is thrown
    // both before and after the migration's renames, and
    // `ProfileUnusableError` is evaluated after the migration has legally
    // moved things. Saying it "when we can" is how it becomes a lie.
    for (const logsDir of ['/logs', null]) {
      const html = renderStartupFailureDocument(NOTICE, logsDir);
      expect(html).not.toMatch(/not (been )?(modified|touched|changed)/i);
      expect(html).not.toMatch(/data is (safe|intact)/i);
    }
  });
});

describe('describeStartupFailure', () => {
  it('names the failing layer and carries a greppable code', () => {
    expect(
      describeStartupFailure(
        new LayoutMigrationError('layout_conflict', 'both roots exist'),
      ),
    ).toMatchObject({
      code: 'layout_conflict',
      headline: 'Silverhand could not migrate its data folder.',
    });
    expect(
      describeStartupFailure(
        new ProfileUnusableError({
          mode: 'profile_invalid',
          profileUrl: 'http://box.local:8765',
          classifyMessage: 'plaintext http remote requires an opt-in build',
        }),
      ),
    ).toMatchObject({ code: 'profile_invalid' });
    expect(describeStartupFailure('boom')).toMatchObject({
      code: 'startup_failed',
      detail: 'boom',
    });
  });

  it('trims the profile refusal down to address + classifier reason', () => {
    const notice = describeStartupFailure(
      new ProfileUnusableError({
        mode: 'profile_invalid',
        profileUrl: 'http://box.local:8765',
        classifyMessage: 'plaintext http remote requires an opt-in build',
      }),
    );
    // The error's own message is a multi-clause repair essay (env vars,
    // Settings steps); the window must not become that.
    expect(notice.detail).toBe(
      'http://box.local:8765 — plaintext http remote requires an opt-in build',
    );
  });

  it('collapses whitespace, caps length, and omits an empty detail', () => {
    const notice = describeStartupFailure(
      new Error(`line one\n   line two ${'x'.repeat(400)}`),
    );
    expect(notice.detail).not.toContain('\n');
    expect(notice.detail!.length).toBeLessThanOrEqual(200);
    expect(notice.detail!.endsWith('…')).toBe(true);
    expect(describeStartupFailure(new Error('   ')).detail).toBeNull();
  });
});
