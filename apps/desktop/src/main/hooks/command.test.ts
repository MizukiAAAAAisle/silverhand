import { expect, it } from 'vitest';
import { startCommand } from './command';

it('runs a command in another process and passes event data only through stdin', async () => {
  const frame = {
    kind: 'notification',
    payload: { text: '$(touch SHOULD_NOT_EXIST)', future: 42 },
  };
  const run = startCommand({ type: 'command', command: 'cat' }, JSON.stringify(frame) + '\n');
  const result = await run.done;
  expect(result.status).toBe('succeeded');
  expect(JSON.parse(result.stdout)).toEqual(frame);
});
it('bounds output and times out a running command while the event loop remains responsive', async () => {
  const run = startCommand(
    { type: 'command', command: 'yes x | head -c 100000; exec sleep 2', timeoutMs: 100 },
    '{}\n',
  );
  try {
    let finished = false;
    void run.done.then(() => {
      finished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    const result = await run.done;
    expect(result.status).toBe('timed_out');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65536);
    expect(result.truncated).toBe(true);
  } finally {
    run.cancel();
    await run.done;
  }
});
it('cancels the process group including grandchildren and reports startup failures', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'silverhand-hook-child-'));
  const run = startCommand(
    { type: 'command', cwd: directory, command: 'sleep 30 & echo $! > child.pid; wait' },
    '{}\n',
  );
  let pid: number | undefined;
  try {
    await expect
      .poll(async () => {
        try {
          pid = Number(await readFile(join(directory, 'child.pid'), 'utf8'));
          return pid > 0;
        } catch {
          return false;
        }
      })
      .toBe(true);
    run.cancel();
    expect((await run.done).status).toBe('cancelled');
    await expect
      .poll(() => {
        try {
          process.kill(pid!, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    const failed = startCommand(
      { type: 'command', cwd: join(directory, 'missing'), command: 'cat' },
      '{}\n',
    );
    expect((await failed.done).status).toBe('failed');
  } finally {
    run.cancel();
    await run.done;
    if (pid)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    await rm(directory, { recursive: true, force: true });
  }
});

it('allows a background child to finish after its parent command exits normally', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'hook-background-'));
  try {
    const run = startCommand(
      {
        type: 'command',
        cwd: dir,
        command: '(sleep 0.2; printf done > completed) </dev/null >/dev/null 2>&1 &',
      },
      '{}\n',
    );
    expect((await run.done).status).toBe('succeeded');
    await expect.poll(() => readFile(join(dir, 'completed'), 'utf8').catch(() => '')).toBe('done');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('runs asynchronous commands with per-hook environment overrides', async () => {
  const run = startCommand(
    {
      type: 'command',
      command: 'printf "%s:%s" "$SILVERHAND_HOOK_TEST" "$PATH"',
      async: true,
      env: { SILVERHAND_HOOK_TEST: 'custom', PATH: '/usr/bin:/bin' },
    },
    '{}',
  );
  expect(await run.done).toMatchObject({ status: 'succeeded', stdout: 'custom:/usr/bin:/bin' });
});
