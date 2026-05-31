import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCategorizedLoggers,
  createFileLogger,
  createLogLevelControl,
} from '../src/logger.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'silverhand-backend-logger-'));
  dirs.push(dir);
  return dir;
}

function readLines(filePath: string): Array<Record<string, unknown>> {
  const text = readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('backend file logger levels', () => {
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('defaults to warn-level filtering when configured that way', async () => {
    const logger = createFileLogger({
      dir: tempDir(),
      alsoConsole: false,
      logControl: createLogLevelControl('warn'),
    });

    logger.info({ conversationId: 'c1' }, 'hidden info');
    logger.warn({ conversationId: 'c1' }, 'visible warn');
    logger.error({ conversationId: 'c1' }, 'visible error');
    await logger.close();

    expect(readLines(logger.filePath).map(line => line.level)).toEqual(['warn', 'error']);
  });

  it('uses one shared conversation debug window across child loggers', async () => {
    const control = createLogLevelControl('warn');
    const logger = createFileLogger({
      dir: tempDir(),
      alsoConsole: false,
      logControl: control,
    });
    const child = logger.child({ conversationId: 'conv-debug' });

    child.info({}, 'hidden before open');
    control.enableConversationDebug('conv-debug', Date.now() + 60_000);
    child.debug({}, 'visible child debug');
    logger.info({ conversationId: 'conv-debug' }, 'visible direct info');
    logger.info({ conversationId: 'other' }, 'hidden other info');
    await logger.close();

    expect(readLines(logger.filePath).map(line => line.msg)).toEqual([
      'visible child debug',
      'visible direct info',
    ]);
  });

  it('keeps CLI audit metrics visible at warn-level default', async () => {
    const loggers = createCategorizedLoggers({
      dir: tempDir(),
      alsoConsole: false,
      logControl: createLogLevelControl('warn'),
    });

    loggers.cli.info({ category: 'cli.invoke', status: 'success' }, 'cli.invoke');
    loggers.cli.warn(
      { category: 'cli.invoke', status: 'failure' },
      'cli.invoke',
    );
    loggers.cli.warn(
      { category: 'cli.preflight_failure', status: 'failure' },
      'cli.preflight_failure',
    );
    loggers.cli.info({ category: 'other.info' }, 'hidden info');
    loggers.system.info({ category: 'cli.invoke' }, 'hidden on system sink');
    await Promise.all([
      loggers.system.close(),
      loggers.agent.close(),
      loggers.cli.close(),
    ]);

    const cliLines = readLines(loggers.cli.filePath);
    expect(cliLines.map(line => line.category)).toEqual([
      'cli.invoke',
      'cli.invoke',
      'cli.preflight_failure',
    ]);
    expect(cliLines.map(line => line.level)).toEqual(['info', 'warn', 'warn']);
    expect(cliLines.map(line => line.status)).toEqual(['success', 'failure', 'failure']);
    expect(readLines(loggers.system.filePath)).toEqual([]);
  });

  it('redacts forbidden top-level field names at every level', async () => {
    const logger = createFileLogger({
      dir: tempDir(),
      alsoConsole: false,
      logControl: createLogLevelControl('debug'),
    });

    logger.debug(
      {
        conversationId: 'c1',
        text: 'SECRET-TEXT',
        payload: 'SECRET-PAYLOAD',
        env: { TOKEN: 'SECRET-ENV-OBJECT' },
        env_TOKEN: 'SECRET-ENV',
        stdout: 'SECRET-STDOUT',
        nested: { prompt: 'SECRET-PROMPT', keep: 'visible' },
        ok: true,
      },
      'redaction check',
    );
    await logger.close();

    const serialized = JSON.stringify(readLines(logger.filePath)[0]);
    expect(serialized).toContain('"ok":true');
    expect(serialized).toContain('"keep":"visible"');
    expect(serialized).toContain('"redactedFieldCount":6');
    expect(serialized).not.toContain('SECRET-TEXT');
    expect(serialized).not.toContain('SECRET-PAYLOAD');
    expect(serialized).not.toContain('SECRET-ENV-OBJECT');
    expect(serialized).not.toContain('SECRET-ENV');
    expect(serialized).not.toContain('SECRET-STDOUT');
    expect(serialized).not.toContain('SECRET-PROMPT');
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain('"env"');
    expect(serialized).not.toContain('"env_TOKEN"');
    expect(serialized).not.toContain('"stdout"');
    expect(serialized).not.toContain('"prompt"');
  });
});
