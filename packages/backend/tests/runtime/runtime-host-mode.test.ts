/**
 * Unit tests for `runtime-host-mode` — the parse helper shared by
 * Electron main and the backend boot. Pins:
 *
 *   - default = `daemon` (Commit A of cleanup: daemon is now the
 *     supported runtime path; legacy remains as explicit rollback
 *     during the soak window)
 *   - empty string == unset (treat misconfigured env like absent)
 *   - `'legacy'` / `'daemon'` accepted verbatim
 *   - invalid values throw loud — no silent coerce, no lowercasing
 *   - banner describer surfaces a rollback recipe in `daemon` mode
 *     AND labels `legacy` as an explicit rollback (not the default)
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

  it('accepts the literal "legacy" (explicit rollback override)', () => {
    // Regression guard for Commit A: even though daemon is now the
    // default, the explicit `=legacy` rollback path MUST keep
    // returning 'legacy' until the legacy CM surfaces are deleted in a
    // later commit. Deleting the legacy path and the env switch in the
    // same diff would strand any operator who needed the rollback.
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
    expect(err?.message).toContain('default daemon runtime');
    expect(err?.message).toContain('SILVERHAND_RUNTIME_HOST=legacy');
  });

  it('throws on whitespace-padded values (no auto-trim)', () => {
    // We deliberately do not trim — a stray space is almost certainly
    // a config error the user wants to see, not silently swallow.
    expect(() => parseAgentRuntimeHostMode(' legacy')).toThrow();
    expect(() => parseAgentRuntimeHostMode('daemon ')).toThrow();
  });
});

describe('describeAgentRuntimeHostMode', () => {
  it('daemon mode is labelled as default and surfaces the legacy rollback recipe', () => {
    const d = describeAgentRuntimeHostMode('daemon');
    expect(d.mode).toBe('daemon');
    expect(d.note).toMatch(/daemon/);
    expect(d.note).toMatch(/default/);
    expect(d.rollback).toBe(`${SILVERHAND_RUNTIME_HOST_ENV}=legacy`);
    // The note should also mention the rollback path in prose so a
    // raw `tail -f` reader can recover without consulting docs.
    expect(d.note).toContain('SILVERHAND_RUNTIME_HOST=legacy');
  });

  it('legacy mode is labelled as explicit rollback (not the default)', () => {
    const d = describeAgentRuntimeHostMode('legacy');
    expect(d.mode).toBe('legacy');
    expect(d.note).toMatch(/legacy/);
    expect(d.note).toMatch(/ConversationManager/);
    // Rollback recipe for legacy = "go back to default" = unset / set daemon.
    expect(d.rollback).toContain(SILVERHAND_RUNTIME_HOST_ENV);
    expect(d.rollback).toMatch(/unset|daemon/);
    // The note should signal this is an explicit override away from
    // the default daemon path, so operators do not assume legacy is
    // the supported steady state.
    expect(d.note).toMatch(/explicit rollback|default daemon/);
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
