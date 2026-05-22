import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDaemonLogControl, createDaemonLogger } from '../src/daemon/logger.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-daemon-logger-'));
  dirs.push(dir);
  return dir;
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('daemon file logger levels', () => {
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('filters info by default and lifts a single conversation during debug window', async () => {
    const control = createDaemonLogControl('warn');
    const logger = createDaemonLogger({
      dir: tempDir(),
      logControl: control,
    });

    logger.info({ conversationId: 'c1' }, 'hidden info');
    control.enableConversationDebug('c1', Date.now() + 60_000);
    logger.debug({ conversationId: 'c1' }, 'visible debug');
    logger.info({ conversationId: 'other' }, 'hidden other');
    logger.warn({ conversationId: 'other' }, 'visible warn');
    await logger.close();

    expect(readLines(logger.filePath).map(line => line.msg)).toEqual([
      'visible debug',
      'visible warn',
    ]);
  });

  it('redacts forbidden top-level fields before writing', async () => {
    const logger = createDaemonLogger({
      dir: tempDir(),
      logControl: createDaemonLogControl('debug'),
    });

    logger.debug(
      {
        conversationId: 'c1',
        chunk: 'SECRET-CHUNK',
        text: 'SECRET-TEXT',
        stderr: 'SECRET-STDERR',
        env_TOKEN: 'SECRET-ENV',
        nested: { soft_directive: 'SECRET-DIRECTIVE', keep: 'visible' },
        ok: true,
      },
      'redaction check',
    );
    await logger.close();

    const serialized = JSON.stringify(readLines(logger.filePath)[0]);
    expect(serialized).toContain('"ok":true');
    expect(serialized).toContain('"keep":"visible"');
    expect(serialized).toContain('"redactedFieldCount":5');
    expect(serialized).not.toContain('SECRET-CHUNK');
    expect(serialized).not.toContain('SECRET-TEXT');
    expect(serialized).not.toContain('SECRET-STDERR');
    expect(serialized).not.toContain('SECRET-ENV');
    expect(serialized).not.toContain('SECRET-DIRECTIVE');
    expect(serialized).not.toContain('"chunk"');
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"stderr"');
    expect(serialized).not.toContain('"env_TOKEN"');
    expect(serialized).not.toContain('"soft_directive"');
  });
});
