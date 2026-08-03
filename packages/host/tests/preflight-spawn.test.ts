import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  spawnWorkspaceStartupPreflight,
  type PreflightSpawnProcessImpl,
} from '../src/preflight-spawn.js';

class FakeStream extends EventEmitter {
  setEncoding(): this {
    return this;
  }
}

class FakeChild extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kill = vi.fn(() => true);
}

describe('spawnWorkspaceStartupPreflight (#task:1806)', () => {
  it('waits for the one-shot process without a daemon-ready timeout and returns its outcome', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      let capturedArgs: readonly string[] = [];
      const spawnProcess: PreflightSpawnProcessImpl = (
        _command: string,
        args: ReadonlyArray<string>,
        _options: SpawnOptions,
      ): ChildProcess => {
        capturedArgs = args;
        return child as unknown as ChildProcess;
      };
      const pending = spawnWorkspaceStartupPreflight({
        launcher: { command: 'node', args: ['daemon.js'] },
        logDir: '/tmp/logs',
        computersRootDir: '/tmp/computers',
        silverhandStateRootDir: '/tmp/state',
        binding: {
          host_id: 'computer-1',
          server_origin: 'https://app.example.com',
        },
        layoutMigrationOutcome: 'already_current',
        alsoStderr: false,
        spawnProcess,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(child.kill).not.toHaveBeenCalled();
      expect(capturedArgs).toEqual([
        'daemon.js',
        'preflight',
        '--log-dir',
        '/tmp/logs',
        '--computers-root-dir',
        '/tmp/computers',
        '--silverhand-state-root-dir',
        '/tmp/state',
        '--workspace-relocation-host-id',
        'computer-1',
        '--workspace-relocation-server-origin',
        'https://app.example.com',
        '--layout-migration-outcome',
        'already_current',
      ]);

      child.stdout.emit(
        'data',
        '{"event":"workspace_startup_preflight_complete","layout_migration_outcome":"migrated"}\n',
      );
      child.emit('close', 0);
      await expect(pending).resolves.toBe('migrated');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the one-shot process exits nonzero', async () => {
    const child = new FakeChild();
    const pending = spawnWorkspaceStartupPreflight({
      launcher: { command: 'node', args: ['daemon.js'] },
      logDir: '/tmp/logs',
      computersRootDir: '/tmp/computers',
      binding: { host_id: 'computer-1', server_origin: 'local-embedded' },
      alsoStderr: false,
      spawnProcess: () => child as unknown as ChildProcess,
    });
    child.emit('close', 1);
    await expect(pending).rejects.toThrow(
      'workspace startup preflight exited with code 1',
    );
  });
});
