import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonLogControl, createDaemonLogger } from '../src/daemon/logger.js';
import { SILVERHAND_LOG_LEVEL_ENV } from '@silverhand/shared';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-daemon-logger-'));
  dirs.push(dir);
  return dir;
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('daemon file logger levels', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('writes info by default so daemon lifecycle diagnostics land on disk', async () => {
    const previous = process.env[SILVERHAND_LOG_LEVEL_ENV];
    delete process.env[SILVERHAND_LOG_LEVEL_ENV];
    try {
      const logger = createDaemonLogger({ dir: tempDir() });

      logger.info({ action: 'ready' }, 'daemon ready');
      await logger.close();

      const [line] = readLines(logger.filePath);
      expect(line?.msg).toBe('daemon ready');
      expect(typeof line?.ts).toBe('string');
      expect(line?.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{2}:\d{2}$/);
      expect(typeof line?.ts_unix_ms).toBe('number');
    } finally {
      if (previous === undefined) {
        delete process.env[SILVERHAND_LOG_LEVEL_ENV];
      } else {
        process.env[SILVERHAND_LOG_LEVEL_ENV] = previous;
      }
    }
  });

  it('mirrors the exact JSONL line to stderr when requested', async () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const logger = createDaemonLogger({
      dir: tempDir(),
      alsoStderr: true,
      logControl: createDaemonLogControl('info'),
    });

    logger.warn({ action: 'diagnostic' }, 'daemon diagnostic');
    await logger.close();

    const diskLine = readFileSync(logger.filePath, 'utf8').trim();
    expect(writes).toEqual([`${diskLine}\n`]);
    expect(writes[0]).not.toContain('[daemon warn]');
  });

  it('filters info at warn level and lifts a single conversation during debug window', async () => {
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

    expect(readLines(logger.filePath).map((line) => line.msg)).toEqual([
      'visible debug',
      'visible warn',
    ]);
  });

  it('redacts content fields on disk while preserving structural diagnostics', async () => {
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
        payload: 'SECRET-PAYLOAD',
        body: 'SECRET-BODY',
        prompt: 'SECRET-PROMPT',
        line: 'SECRET-LINE',
        env: 'SECRET-ENV-OBJECT',
        stdout: 'SECRET-STDOUT',
        nested: { soft_directive: 'SECRET-DIRECTIVE', keep: 'visible' },
        ok: true,
      },
      'redaction check',
    );
    await logger.close();

    const serialized = JSON.stringify(readLines(logger.filePath)[0]);
    expect(serialized).toContain('"ok":true');
    expect(serialized).toContain('"keep":"visible"');
    expect(serialized).toContain('"redactedFieldCount":11');
    expect(serialized).not.toContain('SECRET-');
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
