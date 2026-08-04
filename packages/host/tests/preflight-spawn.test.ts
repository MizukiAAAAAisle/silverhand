import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { DaemonLayoutMigrationCodeSchema } from '@silverhand/shared';
import {
  spawnWorkspaceStartupPreflight,
  type PreflightSpawnProcessImpl,
} from '../src/preflight-spawn.js';
import {
  parseWorkspacePreflightFailureFrame,
  serializeWorkspacePreflightFailureFrame,
  WorkspaceStartupPreflightFailure,
} from '../src/workspace-preflight-protocol.js';

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

  describe('failure frame (#task:1815)', () => {
    function run(): {
      child: FakeChild;
      pending: Promise<unknown>;
    } {
      const child = new FakeChild();
      const pending = spawnWorkspaceStartupPreflight({
        launcher: { command: 'node', args: ['daemon.js'] },
        logDir: '/tmp/logs',
        computersRootDir: '/tmp/computers',
        binding: { host_id: 'computer-1', server_origin: 'local-embedded' },
        alsoStderr: false,
        spawnProcess: () => child as unknown as ChildProcess,
      });
      return { child, pending };
    }

    it('rejects with the typed refusal carrying the child code', async () => {
      const { child, pending } = run();
      child.stdout.emit(
        'data',
        '{"event":"workspace_startup_preflight_failed","code":"session_store_root_unverifiable"}\n',
      );
      child.emit('close', 1);
      await expect(pending).rejects.toBeInstanceOf(
        WorkspaceStartupPreflightFailure,
      );
      await pending.catch((err: unknown) => {
        expect((err as WorkspaceStartupPreflightFailure).code).toBe(
          'session_store_root_unverifiable',
        );
      });
    });

    it('never invents a cause: a code outside the closed set stays generic', async () => {
      // The whole point of the frame is to name a cause we recognize. An
      // arbitrary string must not become one — it would reach a product window.
      const { child, pending } = run();
      child.stdout.emit(
        'data',
        '{"event":"workspace_startup_preflight_failed","code":"EPERM: /Users/someone/.silverhand"}\n',
      );
      child.emit('close', 1);
      await expect(pending).rejects.toThrow(
        'workspace startup preflight exited with code 1',
      );
    });

    it('a success frame on a nonzero exit is not read as a refusal code', async () => {
      const { child, pending } = run();
      child.stdout.emit(
        'data',
        '{"event":"workspace_startup_preflight_complete","layout_migration_outcome":"migrated"}\n',
      );
      child.emit('close', 1);
      await expect(pending).rejects.toThrow(
        'workspace startup preflight exited with code 1',
      );
    });

    it('parses the exact bytes the child writes, for every daemon code', () => {
      // Producer/consumer are pinned to each other rather than to a literal, so
      // a rename cannot leave one side reading a frame nobody writes.
      for (const code of DaemonLayoutMigrationCodeSchema.options) {
        expect(
          parseWorkspacePreflightFailureFrame(
            serializeWorkspacePreflightFailureFrame(code),
          ),
        ).toBe(code);
      }
      expect(parseWorkspacePreflightFailureFrame('')).toBeNull();
      expect(parseWorkspacePreflightFailureFrame('not json')).toBeNull();
      expect(
        parseWorkspacePreflightFailureFrame(
          '{"event":"workspace_startup_preflight_failed","code":"relocation_conflict"}\n{"event":"workspace_startup_preflight_failed","code":"relocation_conflict"}\n',
        ),
      ).toBeNull();
    });
  });
});
