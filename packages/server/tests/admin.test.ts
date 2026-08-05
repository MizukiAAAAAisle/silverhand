import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiPaths, authPaths } from '@silverhand/shared';
import { runAdminCommand, startStandaloneSilverhandServer } from '../src/index.js';

const tmpDirs: string[] = [];
let previousTargetMs: string | undefined;

beforeEach(() => {
  previousTargetMs = process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS;
  process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS = '1';
});

afterEach(async () => {
  if (previousTargetMs === undefined) delete process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS;
  else process.env.SILVERHAND_PASSWORD_HASH_TARGET_MS = previousTargetMs;
  await Promise.all(
    tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  );
});

describe('silverhand-server admin reset-password', () => {
  it('resets from a 0600 password file, unlinks it, revokes sessions, and audits', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-admin-test-'));
    tmpDirs.push(dataDir);
    const env = {
      SILVERHAND_LISTEN: '127.0.0.1:0',
      SILVERHAND_DATA_DIR: dataDir,
      SILVERHAND_LOG_LEVEL: 'warn',
    };

    const running = await startStandaloneSilverhandServer({ env });
    let oldToken: string;
    try {
      const signup = await fetch(`${running.url}${authPaths.signup}`, {
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'old-password',
          name: 'user-one',
          display_name: 'User',
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(signup.status).toBe(200);
      oldToken = ((await signup.json()) as { user_token: string }).user_token;
    } finally {
      await running.close();
    }

    const passwordFile = join(dataDir, 'new-password.txt');
    await writeFile(passwordFile, 'new-password\n', { mode: 0o600 });
    await chmod(passwordFile, 0o600);
    const stdout = new MemorySink();
    const stderr = new MemorySink();
    const code = await runAdminCommand(
      [
        'reset-password',
        '--email',
        'user@example.com',
        '--password-from-file',
        passwordFile,
      ],
      env,
      { stdout, stderr },
    );
    expect(code).toBe(0);
    expect(stderr.text).toBe('');
    expect(stdout.text).toContain('password reset for user@example.com');
    await expect(access(passwordFile)).rejects.toThrow();

    const restarted = await startStandaloneSilverhandServer({
      env: { ...env, SILVERHAND_DISABLE_SIGNUP: '1' },
    });
    try {
      const revokedSession = await fetch(`${restarted.url}${apiPaths.me}`, {
        headers: { authorization: `Bearer ${oldToken}` },
      });
      expect(revokedSession.status).toBe(401);

      const oldLogin = await fetch(`${restarted.url}${authPaths.login}`, {
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'old-password',
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(oldLogin.status).toBe(401);

      const newLogin = await fetch(`${restarted.url}${authPaths.login}`, {
        method: 'POST',
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'new-password',
        }),
        headers: { 'content-type': 'application/json' },
      });
      expect(newLogin.status).toBe(200);
    } finally {
      await restarted.close();
    }

    const logFiles = (await readdir(join(dataDir, 'logs'))).filter(name =>
      name.startsWith('cli-'),
    );
    expect(logFiles.length).toBeGreaterThan(0);
    const logBody = (
      await Promise.all(
        logFiles.map(name => readFile(join(dataDir, 'logs', name), 'utf8')),
      )
    ).join('\n');
    expect(logBody).toContain('"admin_op":"reset-password"');
    expect(logBody).toContain('"user_email":"user@example.com"');
    expect(logBody).toContain('"success":true');
    expect(logBody).not.toContain('new-password');
    expect(logBody).not.toContain('old-password');
  });

  it('rejects plaintext password argv and world-readable password files', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-admin-test-'));
    tmpDirs.push(dataDir);
    const env = {
      SILVERHAND_DATA_DIR: dataDir,
      SILVERHAND_LOG_LEVEL: 'warn',
    };
    const plaintext = await runAdminCommand(
      ['reset-password', '--email', 'user@example.com', '--password', 'secret'],
      env,
      { stdout: new MemorySink(), stderr: new MemorySink() },
    );
    expect(plaintext).toBe(1);

    const passwordFile = join(dataDir, 'world-readable-password.txt');
    await writeFile(passwordFile, 'new-password\n', { mode: 0o644 });
    await chmod(passwordFile, 0o644);
    const stderr = new MemorySink();
    const fileMode = await runAdminCommand(
      [
        'reset-password',
        '--email',
        'user@example.com',
        '--password-from-file',
        passwordFile,
      ],
      env,
      { stdout: new MemorySink(), stderr },
    );
    expect(fileMode).toBe(1);
    expect(stderr.text).toContain('0600');
    await expect(access(passwordFile)).resolves.toBeUndefined();
  });

  it('fails unknown email without creating a user and audits the failure', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-admin-test-'));
    tmpDirs.push(dataDir);
    const env = {
      SILVERHAND_DATA_DIR: dataDir,
      SILVERHAND_LOG_LEVEL: 'warn',
    };
    const passwordFile = join(dataDir, 'missing-user-password.txt');
    await writeFile(passwordFile, 'new-password\n', { mode: 0o600 });
    await chmod(passwordFile, 0o600);
    const stderr = new MemorySink();

    const code = await runAdminCommand(
      [
        'reset-password',
        '--email',
        'missing@example.com',
        '--password-from-file',
        passwordFile,
      ],
      env,
      { stdout: new MemorySink(), stderr },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain('user_not_found');
    await expect(access(passwordFile)).rejects.toThrow();
    const logFiles = (await readdir(join(dataDir, 'logs'))).filter(name =>
      name.startsWith('cli-'),
    );
    const logBody = (
      await Promise.all(
        logFiles.map(name => readFile(join(dataDir, 'logs', name), 'utf8')),
      )
    ).join('\n');
    expect(logBody).toContain('"admin_op":"reset-password"');
    expect(logBody).toContain('"user_email":"missing@example.com"');
    expect(logBody).toContain('"success":false');
    expect(logBody).toContain('"code":"user_not_found"');
    expect(logBody).not.toContain('new-password');
  });

  it('rejects symlinked password files before reading or unlinking the target', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'silverhand-server-admin-test-'));
    tmpDirs.push(dataDir);
    const targetFile = join(dataDir, 'real-password.txt');
    const symlinkFile = join(dataDir, 'password-link.txt');
    await writeFile(targetFile, 'new-password\n', { mode: 0o600 });
    await chmod(targetFile, 0o600);
    await symlink(targetFile, symlinkFile);

    const stderr = new MemorySink();
    const code = await runAdminCommand(
      [
        'reset-password',
        '--email',
        'user@example.com',
        '--password-from-file',
        symlinkFile,
      ],
      {
        SILVERHAND_DATA_DIR: dataDir,
        SILVERHAND_LOG_LEVEL: 'warn',
      },
      { stdout: new MemorySink(), stderr },
    );

    expect(code).toBe(1);
    expect(stderr.text).toContain('symbolic link');
    await expect(access(targetFile)).resolves.toBeUndefined();
    await expect(access(symlinkFile)).resolves.toBeUndefined();
  });
});

class MemorySink {
  text = '';

  write(chunk: string): void {
    this.text += chunk;
  }
}
