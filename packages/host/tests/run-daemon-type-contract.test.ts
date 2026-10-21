/**
 * Type-contract regression guard for `RunDaemonOptions.supervisorFactory`.
 *
 * Backstory (shiki `Go9ZiB4OnwTbELZU` + Cindy `XuKGmdna3GWZcY2G` /
 * `M6dAIAynz9S-I4D4` / `iAbuG0AXK6k4BXDU`):
 *
 *   Before this commit `supervisorFactory` was `?:` optional. Production
 *   `entry.ts` accidentally omitted it; TypeScript was happy; the
 *   daemon booted into PR-1 mode and every `runtime_*` intent failed
 *   at runtime with `no supervisor wired`. We fixed the runtime in
 *   `43d5295` and tightened the type to required-but-nullable so any
 *   future omission fails typecheck. This file is the type-side
 *   tripwire that proves the tightening actually does the work — if
 *   anyone reverts the field to optional, these `@ts-expect-error`
 *   markers stop being errors and TypeScript fails the suite.
 *
 * Cindy `iAbuG0AXK6k4BXDU` review bar: must defend "all `runDaemon`
 * callers are forced to a typed choice (Supervisor / Fake / null)", not
 * just a local helper alias. We exercise `RunDaemonOptions` directly
 * — the same type the callers see.
 */
import { describe, it, expect } from 'vitest';
import type { RunDaemonOptions } from '../src/daemon/index.js';
import type { SupervisorContract } from '../src/daemon/supervisor-contract.js';

describe('RunDaemonOptions.supervisorFactory — required-but-nullable contract', () => {
  it('omitting supervisorFactory fails typecheck (regression guard for shiki `Go9ZiB4OnwTbELZU`)', () => {
    // If this `@ts-expect-error` STOPS firing, supervisorFactory has
    // silently regressed back to optional and the daemon-mode boot
    // blocker we just fixed can re-land via a quiet code change.
    // The TypeScript error here is intentional and load-bearing.
    // @ts-expect-error supervisorFactory is required (see RunDaemonOptions doc).
    const badProductionShape: RunDaemonOptions = {
      socketPath: '/tmp/x.sock',
      pidFilePath: '/tmp/x.pid',
      logDir: '/tmp/logs',
      // supervisorFactory deliberately omitted — must be a type error.
    };
    // Sanity reference so the value is "used" and the linter / TS
    // doesn't complain about unused locals. We never construct a
    // daemon here.
    expect(badProductionShape.socketPath).toBe('/tmp/x.sock');
  });

  it('explicit null is the typed opt-out for protocol-only fixtures', () => {
    const protocolOnly: RunDaemonOptions = {
      socketPath: '/tmp/x.sock',
      pidFilePath: '/tmp/x.pid',
      logDir: '/tmp/logs',
      supervisorFactory: null,
    };
    expect(protocolOnly.supervisorFactory).toBeNull();
  });

  it('a real factory function is accepted', () => {
    // The shape Supervisor / FakeSupervisor factories take. We
    // don't actually call it — the assertion is just that the
    // assignment typechecks.
    const factory: NonNullable<RunDaemonOptions['supervisorFactory']> = () =>
      ({}) as SupervisorContract;
    const productionShape: RunDaemonOptions = {
      socketPath: '/tmp/x.sock',
      pidFilePath: '/tmp/x.pid',
      logDir: '/tmp/logs',
      supervisorFactory: factory,
    };
    expect(typeof productionShape.supervisorFactory).toBe('function');
  });

  it('arbitrary truthy non-function values are rejected at the type level', () => {
    const wrongShape: RunDaemonOptions = {
      socketPath: '/tmp/x.sock',
      pidFilePath: '/tmp/x.pid',
      logDir: '/tmp/logs',
      // @ts-expect-error supervisorFactory must be a factory function OR null.
      supervisorFactory: 'not a factory',
    };
    expect(wrongShape.socketPath).toBe('/tmp/x.sock');
  });
});
