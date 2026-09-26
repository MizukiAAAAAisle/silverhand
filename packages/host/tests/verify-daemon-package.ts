/** Release-only smoke of the actual npm artifacts, not their source text. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HostClient } from '../src/client/index.js';
import { spawnDaemonChild } from '../src/spawn.js';

const repo = resolve(import.meta.dirname, '../../..');
const packageRoot = join(repo, 'packages/silverhand-daemon');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const daemonEntry = join(packageRoot, 'dist/daemon.js');
const cliEntry = join(packageRoot, 'dist/cli.js');
assert.ok(existsSync(daemonEntry), 'Build dist/daemon.js before verification');
assert.ok(existsSync(cliEntry), 'Build dist/cli.js before verification');

const cache = join(repo, '.cache');
mkdirSync(cache, { recursive: true });
const sandbox = mkdtempSync(join(cache, 'daemon-pkg-'));
try {
  const env = { ...process.env, SILVERHAND_DIR: sandbox };
  execFileSync(process.execPath, [cliEntry, '--help'], { env, timeout: 10_000 });
  const socketPath = join(sandbox, 'd.sock');
  const pidFilePath = join(sandbox, 'd.pid');
  const handle = await spawnDaemonChild({
    launcher: { command: process.execPath, args: [daemonEntry], env: { SILVERHAND_DIR: sandbox } },
    socketPath,
    pidFilePath,
    logDir: join(sandbox, 'logs'),
    runtimePidRootDir: join(sandbox, 'runtime-pids'),
    daemonIdentityPath: join(sandbox, 'identity.json'),
    silverhandStateRootDir: sandbox,
    computersRootDir: join(sandbox, 'computers'),
    reclaimStaleDaemon: false,
    maxRestarts: 0,
    readyTimeoutMs: 10_000,
    alsoStderr: false,
  });
  const client = new HostClient({ socketPath });
  try {
    await client.connect();
    assert.equal(client.negotiated?.daemonVersion, manifest.version, 'Published handshake version');
    assert.deepEqual(await client.runtimeStatus({}), { runtimes: [] });
  } finally {
    try {
      await client.close();
    } finally {
      await handle.kill();
    }
  }
  assert.equal(existsSync(pidFilePath), false, 'Owned daemon must release its pidfile');
  console.log(`Verified daemon ${manifest.version}: packaged CLI, handshake and runtime wiring`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
