import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveComputerSlotFromComputersRoot } from '@silverhand/shared/app-data-layout';
import { readLayoutMigrationFailures } from '../src/diagnostics/layout-migration-breadcrumb.js';
import { resolveAgentWorkspaceBundleDir } from '../src/daemon/agent-materialize/handler.js';
import {
  runDirectStartupPreflight,
  runDirectStartupPreflightCommand,
} from '../src/daemon/direct-startup-preflight.js';
import { RelocationError } from '../src/daemon/workspace-registry/relocation-error.js';
import type { RegistryBinding } from '../src/daemon/workspace-registry/registry.js';
import {
  bindingSlug,
  managedWorkspaceSlug,
} from '../src/daemon/workspace-registry/registry.js';
import {
  cwdSessionSlug,
  SessionStoreConfigError,
} from '../src/daemon/workspace-registry/session-migration.js';
import { parseWorkspacePreflightFailureFrame } from '../src/workspace-preflight-protocol.js';

const BINDING: RegistryBinding = {
  server_origin: 'local-embedded',
  host_id: 'computer-1',
};

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'sh1806-direct-preflight-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function setUpLegacyState() {
  const computersRootDir = join(scratch, 'computers');
  const stateRoot = join(scratch, 'state');
  const sessionHome = join(scratch, 'home');
  const logDir = join(scratch, 'logs');
  const slot = resolveComputerSlotFromComputersRoot(
    computersRootDir,
    BINDING.host_id,
  );
  const workspaceId = 'workspace-1';
  const agentId = 'agent-1';
  const oldRoot = join(scratch, 'legacy-workspace');
  mkdirSync(slot.workspaceData, { recursive: true });
  mkdirSync(oldRoot, { recursive: true });
  // relocation-v1 §7-4 (#task:1808): the registry is a READ-ONLY reader now, so
  // the legacy inventory this preflight must relocate is fixtured by writing the
  // file an older daemon wrote — the only way it can exist.
  writeFileSync(
    join(slot.workspaceData, 'workspace-registry.json'),
    JSON.stringify({
      schema_version: 1,
      binding: BINDING,
      workspaces: { [workspaceId]: { path: oldRoot, provisioned_at: 1 } },
    }),
  );

  const oldL2 = join(oldRoot, '.silverhand', 'agents', agentId);
  write(join(oldL2, 'MEMORY.md'), 'legacy memory');
  const newL2 = resolveAgentWorkspaceBundleDir(agentId, workspaceId, {
    agentHomeRootDir: slot.agents,
  });

  const oldSession = join(
    sessionHome,
    '.claude',
    'projects',
    cwdSessionSlug('claude', oldRoot),
  );
  write(join(oldSession, 'session.jsonl'), '{"turn":1}\n');
  const newSession = join(
    sessionHome,
    '.claude',
    'projects',
    cwdSessionSlug('claude', newL2),
  );

  return {
    computersRootDir,
    stateRoot,
    sessionHome,
    logDir,
    slot,
    oldL2,
    newL2,
    oldSession,
    newSession,
  };
}

describe('direct daemon startup preflight (#task:1806)', () => {
  it('converges a newly enrolled computer whose workspace-data root is still absent', async () => {
    const computersRootDir = join(scratch, 'computers');
    const slot = resolveComputerSlotFromComputersRoot(computersRootDir, BINDING.host_id);
    expect(existsSync(slot.workspaceData)).toBe(false);

    await expect(
      runDirectStartupPreflight({
        binding: BINDING,
        computersRootDir,
        silverhandStateRootDir: join(scratch, 'state'),
        logDir: join(scratch, 'logs'),
        alsoStderr: false,
        initialOutcome: 'already_current',
        sessionStoreHome: join(scratch, 'home'),
        env: {},
      }),
    ).resolves.toBe('migrated');

    expect(existsSync(join(slot.workspaceData, 'relocation-v1.marker.json'))).toBe(true);
  });

  it('migrates L2 and cwd-scoped sessions before direct daemon bind, then replays as a no-op', async () => {
    const fx = setUpLegacyState();
    const first = await runDirectStartupPreflight({
      binding: BINDING,
      computersRootDir: fx.computersRootDir,
      silverhandStateRootDir: fx.stateRoot,
      logDir: fx.logDir,
      alsoStderr: false,
      initialOutcome: 'already_current',
      sessionStoreHome: fx.sessionHome,
      env: {},
    });

    expect(first).toBe('migrated');
    expect(readFileSync(join(fx.newL2, 'MEMORY.md'), 'utf8')).toBe(
      'legacy memory',
    );
    expect(readFileSync(join(fx.newSession, 'session.jsonl'), 'utf8')).toBe(
      '{"turn":1}\n',
    );
    expect(readFileSync(join(fx.oldL2, 'MEMORY.md'), 'utf8')).toBe(
      'legacy memory',
    );
    expect(readFileSync(join(fx.oldSession, 'session.jsonl'), 'utf8')).toBe(
      '{"turn":1}\n',
    );
    expect(
      existsSync(join(fx.slot.workspaceData, 'relocation-v1.marker.json')),
    ).toBe(true);

    const second = await runDirectStartupPreflight({
      binding: BINDING,
      computersRootDir: fx.computersRootDir,
      silverhandStateRootDir: fx.stateRoot,
      logDir: fx.logDir,
      alsoStderr: false,
      initialOutcome: 'already_current',
      sessionStoreHome: fx.sessionHome,
      env: {},
    });
    expect(second).toBe('already_current');
  });

  it('fails closed on an L2 relocation conflict and keeps actionable detail local', async () => {
    const fx = setUpLegacyState();
    write(join(fx.newL2, 'MEMORY.md'), 'CONFLICTING\n');

    await expect(
      runDirectStartupPreflight({
        binding: BINDING,
        computersRootDir: fx.computersRootDir,
        silverhandStateRootDir: fx.stateRoot,
        logDir: fx.logDir,
        alsoStderr: false,
        initialOutcome: 'already_current',
        sessionStoreHome: fx.sessionHome,
        env: {},
      }),
    ).rejects.toBeInstanceOf(RelocationError);

    expect(
      existsSync(join(fx.slot.workspaceData, 'relocation-v1.marker.json')),
    ).toBe(false);
    expect(readLayoutMigrationFailures({ appRoot: fx.stateRoot })).toEqual({
      reports: [
        expect.objectContaining({
          component: 'daemon',
          stage: 'workspace_layout_relocation',
          code: 'relocation_conflict',
          count: 1,
        }),
      ],
    });
    const logPath = join(
      fx.logDir,
      readdirSync(fx.logDir).find(name => name.startsWith('daemon-'))!,
    );
    const failure = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.action === 'layout_v2_migration_failed');
    expect(failure).toMatchObject({
      code: 'relocation_conflict',
      detail: expect.stringContaining(fx.newL2),
    });
  });

  it('preserves the launcher outcome for an unclaimed desktop with no binding', async () => {
    await expect(
      runDirectStartupPreflight({
        binding: null,
        computersRootDir: null,
        silverhandStateRootDir: join(scratch, 'state'),
        logDir: join(scratch, 'logs'),
        alsoStderr: false,
        initialOutcome: 'already_current',
      }),
    ).resolves.toBe('already_current');
    expect(existsSync(join(scratch, 'logs'))).toBe(false);
  });
});

describe('store-root handling across hard convergence and best-effort relocation', () => {
  /** A namespaced (pre-flatten) root, so convergence's session rename pass runs
   * before relocation ever plans — the other side of the same condition. */
  function setUpNamespacedState() {
    const computersRootDir = join(scratch, 'computers');
    const slot = resolveComputerSlotFromComputersRoot(
      computersRootDir,
      BINDING.host_id,
    );
    const workspaceId = 'workspace-1';
    const nsDir = join(slot.workspaceData, bindingSlug(BINDING));
    const managed = join(nsDir, 'workspaces', managedWorkspaceSlug(workspaceId));
    mkdirSync(managed, { recursive: true });
    writeFileSync(join(managed, 'MEMORY.md'), 'legacy memory');
    writeFileSync(
      join(nsDir, 'workspace-registry.json'),
      JSON.stringify({
        schema_version: 1,
        binding: BINDING,
        workspaces: { [workspaceId]: { path: managed, provisioned_at: 1 } },
      }),
    );
    return {
      computersRootDir,
      slot,
      stateRoot: join(scratch, 'state'),
      logDir: join(scratch, 'logs'),
      sessionHome: join(scratch, 'home'),
      managed,
    };
  }

  it('a relocation-only runtime config failure warns locally and does not block launch', async () => {
    const fx = setUpLegacyState();
    // This state is already flat, so the config error belongs only to optional
    // runtime-session relocation. The hard L2 migration must still complete.
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = 'not-absolute';
    const stdout: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk));
        return true;
      });
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    let exitCode: number;
    try {
      exitCode = await runDirectStartupPreflightCommand([
        '--workspace-relocation-host-id',
        BINDING.host_id,
        '--workspace-relocation-server-origin',
        BINDING.server_origin,
        '--computers-root-dir',
        fx.computersRootDir,
        '--silverhand-state-root-dir',
        fx.stateRoot,
        '--log-dir',
        fx.logDir,
        '--layout-migration-outcome',
        'already_current',
      ]);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toContain('"layout_migration_outcome":"migrated"');
    expect(parseWorkspacePreflightFailureFrame(stdout[0]!)).toBeNull();
    // The product frame remains free of local configuration and paths.
    expect(stdout[0]).not.toContain('not-absolute');
    expect(stdout[0]).not.toContain(scratch);
    expect(
      existsSync(join(fx.slot.workspaceData, 'relocation-v1.marker.json')),
    ).toBe(true);
    const logPath = join(
      fx.logDir,
      readdirSync(fx.logDir).find(name => name.startsWith('daemon-'))!,
    );
    const warning = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.action === 'runtime_session_relocation_degraded');
    expect(warning).toMatchObject({
      runtime: 'claude',
      code: 'session_store_root_unverifiable',
      detail: expect.stringContaining('CLAUDE_CONFIG_DIR'),
    });
  });

  it('a hard convergence failure still emits a code-only launcher frame', async () => {
    const fx = setUpNamespacedState();
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = 'not-absolute';
    const stdout: string[] = [];
    const outSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdout.push(String(chunk));
        return true;
      });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCode: number;
    try {
      exitCode = await runDirectStartupPreflightCommand([
        '--workspace-relocation-host-id',
        BINDING.host_id,
        '--workspace-relocation-server-origin',
        BINDING.server_origin,
        '--computers-root-dir',
        fx.computersRootDir,
        '--silverhand-state-root-dir',
        fx.stateRoot,
        '--log-dir',
        fx.logDir,
        '--layout-migration-outcome',
        'already_current',
      ]);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }

    expect(exitCode).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(parseWorkspacePreflightFailureFrame(stdout[0]!)).toBe(
      'session_store_root_unverifiable',
    );
    expect(stdout[0]).not.toContain('not-absolute');
    expect(stdout[0]).not.toContain(scratch);

    const logPath = join(
      fx.logDir,
      readdirSync(fx.logDir).find(name => name.startsWith('daemon-'))!,
    );
    const failure = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .find(line => line.action === 'layout_v2_migration_failed');
    expect(failure).toMatchObject({
      code: 'session_store_root_unverifiable',
      detail: expect.stringContaining('CLAUDE_CONFIG_DIR'),
    });
  });

  it('the same code is filed under the stage of whichever pass noticed', async () => {
    const fx = setUpNamespacedState();

    await expect(
      runDirectStartupPreflight({
        binding: BINDING,
        computersRootDir: fx.computersRootDir,
        silverhandStateRootDir: fx.stateRoot,
        logDir: fx.logDir,
        alsoStderr: false,
        initialOutcome: 'already_current',
        sessionStoreHome: fx.sessionHome,
        env: { CLAUDE_CONFIG_DIR: 'not-absolute' },
      }),
    ).rejects.toBeInstanceOf(SessionStoreConfigError);

    expect(readLayoutMigrationFailures({ appRoot: fx.stateRoot })).toEqual({
      reports: [
        expect.objectContaining({
          // Same code as the relocation-side refusal above; only the
          // attribution key differs, because that is all the stage is for.
          code: 'session_store_root_unverifiable',
          stage: 'workspace_data_convergence',
          count: 1,
        }),
      ],
    });
    // Fail closed: the plan is refused before convergence writes the flat root.
    expect(existsSync(join(fx.slot.workspaceData, 'workspaces'))).toBe(false);
    expect(readFileSync(join(fx.managed, 'MEMORY.md'), 'utf8')).toBe(
      'legacy memory',
    );
  });
});
