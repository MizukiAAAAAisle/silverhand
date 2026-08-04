import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveComputerSlotFromComputersRoot } from '@silverhand/shared/app-data-layout';
import { readLayoutMigrationFailures } from '../src/diagnostics/layout-migration-breadcrumb.js';
import { resolveAgentWorkspaceBundleDir } from '../src/daemon/agent-materialize/handler.js';
import { runDirectStartupPreflight } from '../src/daemon/direct-startup-preflight.js';
import { RelocationError } from '../src/daemon/workspace-registry/relocation-error.js';
import type { RegistryBinding } from '../src/daemon/workspace-registry/registry.js';
import { cwdSessionSlug } from '../src/daemon/workspace-registry/session-migration.js';

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

  it('fails closed on a relocation conflict, writes diagnostics, and never writes the marker', async () => {
    const fx = setUpLegacyState();
    write(join(fx.newSession, 'session.jsonl'), 'CONFLICTING\n');

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
