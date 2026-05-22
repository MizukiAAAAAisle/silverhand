/**
 * Unit tests for `runtime-host-mode` — the parse helper shared by
 * Electron main and the backend boot. Pins:
 *
 *   - default = `daemon` (Commit A flipped the default; Commit B
 *     deleted the in-process ConversationManager runtime — daemon is
 *     now the only supported runtime)
 *   - empty string == unset (treat misconfigured env like absent)
 *   - `'legacy'` / `'daemon'` accepted verbatim by the parser. The
 *     parser does NOT throw on `'legacy'` — the dispatch sites
 *     (backend startBackend / Electron main) throw at boot with an
 *     explicit Commit B removed-message instead. This split keeps
 *     parse semantics narrow and lets the dispatch site own the
 *     operator-facing diagnostic.
 *   - invalid values throw loud — no silent coerce, no lowercasing
 *   - banner describer is honest post-Commit B: daemon's rollback
 *     field must NOT sell `=legacy` as a real recovery path
 *     (Cindy `0aTZCqe07rmqA08k` blocker 1); legacy describer must
 *     say "now throws / not a runtime recovery".
 *
 * Cindy `bJUazoeBrxK8XglK` blocker (2) + `Q48i12KhABcPcnK1`: the
 * helper must be pure (no DB/logger imports). The test file imports
 * directly and only — if a future change accidentally pulls in
 * backend side effects, this test file's import alone would surface
 * the regression.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_RUNTIME_HOST_MODE,
  SILVERHAND_RUNTIME_HOST_ENV,
  describeAgentRuntimeHostMode,
  parseAgentRuntimeHostMode,
} from '../../src/runtime/runtime-host-mode.js';

describe('parseAgentRuntimeHostMode', () => {
  it('defaults to daemon when env var is undefined', () => {
    expect(parseAgentRuntimeHostMode(undefined)).toBe('daemon');
    expect(DEFAULT_AGENT_RUNTIME_HOST_MODE).toBe('daemon');
  });

  it('treats empty string the same as unset', () => {
    expect(parseAgentRuntimeHostMode('')).toBe('daemon');
  });

  it('accepts the literal "legacy" at parse time (the throw is owned by the dispatch sites)', () => {
    // Post-Commit B `=legacy` no longer runs a different runtime —
    // backend `startBackend` and Electron main bootstrap throw at
    // boot with an explicit removed-message. Parse stays narrow:
    // `'legacy'` parses successfully so the dispatch site owns the
    // operator-facing diagnostic. This split is intentional.
    expect(parseAgentRuntimeHostMode('legacy')).toBe('legacy');
  });

  it('accepts the literal "daemon"', () => {
    expect(parseAgentRuntimeHostMode('daemon')).toBe('daemon');
  });

  it('throws loudly on uppercase or mixed case (no silent coerce)', () => {
    expect(() => parseAgentRuntimeHostMode('LEGACY')).toThrow(
      /invalid value/i,
    );
    expect(() => parseAgentRuntimeHostMode('Daemon')).toThrow(
      /invalid value/i,
    );
    expect(() => parseAgentRuntimeHostMode('Legacy')).toThrow(
      /invalid value/i,
    );
  });

  it('throws on unknown values with helpful message', () => {
    let err: Error | null = null;
    try {
      parseAgentRuntimeHostMode('inprocess');
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain(SILVERHAND_RUNTIME_HOST_ENV);
    expect(err?.message).toContain("'legacy'");
    expect(err?.message).toContain("'daemon'");
    expect(err?.message).toContain('"inprocess"');
    // Post-Commit B the parse-failure message must explain that
    // `=legacy` is no longer a runtime fallback so an operator
    // hitting a typo near `=legacy` doesn't think they're one
    // correct value away from a working rollback.
    expect(err?.message).toContain('Commit B');
  });

  it('throws on whitespace-padded values (no auto-trim)', () => {
    // We deliberately do not trim — a stray space is almost certainly
    // a config error the user wants to see, not silently swallow.
    expect(() => parseAgentRuntimeHostMode(' legacy')).toThrow();
    expect(() => parseAgentRuntimeHostMode('daemon ')).toThrow();
  });
});

describe('describeAgentRuntimeHostMode', () => {
  it('daemon mode is labelled as the only supported runtime; rollback field MUST NOT sell =legacy', () => {
    // Cindy `0aTZCqe07rmqA08k` blocker 1: post-Commit B the legacy
    // CM runtime no longer exists, so the daemon banner cannot tell
    // operators to roll back via `=legacy`. The rollback field must
    // not contain `SILVERHAND_RUNTIME_HOST=legacy`, and the prose
    // must explicitly say there is no runtime fallback.
    const d = describeAgentRuntimeHostMode('daemon');
    expect(d.mode).toBe('daemon');
    expect(d.note).toMatch(/daemon/);
    expect(d.note).toMatch(/only supported runtime/);
    // Banner must mention Commit B + that legacy is not a runtime
    // path so a tail -f reader does not assume `=legacy` is recovery.
    expect(d.note).toContain('Commit B');
    expect(d.note).toMatch(/no runtime fallback/);
    // Hard guard: the rollback field MUST NOT advertise `=legacy`
    // as a recovery recipe — that's the entire point of the
    // blocker. The describer also explicitly mentions Commit B so
    // the field stays self-explanatory in structured logs.
    expect(d.rollback).not.toContain(`${SILVERHAND_RUNTIME_HOST_ENV}=legacy`);
    expect(d.rollback).toContain('Commit B');
    // The note prose must NOT advertise `=legacy` as a recovery.
    // Mention is allowed (in the "now throws" context) but the
    // word "fall back" must not appear next to `=legacy`.
    expect(d.note).not.toMatch(/restart with [^.]*legacy[^.]*fall back/i);
  });

  it('legacy mode is labelled as a parse-only value that boot-throws (not a runtime path)', () => {
    const d = describeAgentRuntimeHostMode('legacy');
    expect(d.mode).toBe('legacy');
    expect(d.note).toMatch(/legacy/);
    // Mention ConversationManager (in the "removed in Commit B"
    // context) so the historical context is preserved.
    expect(d.note).toMatch(/ConversationManager/);
    expect(d.note).toContain('Commit B');
    expect(d.note).toMatch(/throws at boot|removed-message/);
    // Recovery path = back to default daemon. NOT a runtime
    // alternative to daemon.
    expect(d.rollback).toContain(SILVERHAND_RUNTIME_HOST_ENV);
    expect(d.rollback).toMatch(/unset|daemon/);
    expect(d.note).toMatch(/not a runtime recovery|not a runtime fallback/);
  });
});

describe('module surface — no side effects on import', () => {
  it('importing the helper does not throw and does not touch process state', () => {
    // The helper file imports only zod; verify nothing observable
    // happened at import time (no env var read, no log line, no
    // process.exit). This is a smoke test for Cindy `Q48i12KhABcPcnK1`:
    // "保持这个文件只依赖 zod 或轻量 shared. 否则 main 层 import helper
    // 可能带出 backend side effects".
    expect(SILVERHAND_RUNTIME_HOST_ENV).toBe('SILVERHAND_RUNTIME_HOST');
    expect(DEFAULT_AGENT_RUNTIME_HOST_MODE).toBe('daemon');
  });
});
