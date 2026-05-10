import { describe, expect, it } from 'vitest';
import { COMMAND_GROUPS, findCommand, findGroup } from '../src/commands/index.js';

describe('command catalogue', () => {
  it('exposes the seven nouns we promised in the prompt', () => {
    const nouns = COMMAND_GROUPS.map(g => g.noun);
    expect(nouns).toEqual([
      'message',
      'task',
      'thread',
      'channel',
      'workspace',
      'schedule',
      'file',
    ]);
  });

  it('matches every MCP tool with exactly one CLI verb', () => {
    // The 18 backend internal routes that MCP currently exposes.
    // If you add a route, add a CLI command, and add it here.
    const expected: Array<[string, string]> = [
      ['message', 'send'],
      ['message', 'history'],
      ['message', 'search'],
      ['task', 'list'],
      ['task', 'create'],
      ['task', 'claim'],
      ['task', 'unclaim'],
      ['task', 'status'],
      ['thread', 'create'],
      ['thread', 'close'],
      ['channel', 'create'],
      ['channel', 'list'],
      ['workspace', 'list'],
      ['schedule', 'create'],
      ['schedule', 'list'],
      ['schedule', 'cancel'],
      ['file', 'upload'],
      ['file', 'view'],
    ];
    for (const [noun, verb] of expected) {
      const cmd = findCommand(noun, verb);
      expect(cmd, `${noun} ${verb}`).toBeDefined();
    }
    const total = COMMAND_GROUPS.reduce((acc, g) => acc + g.commands.length, 0);
    expect(total).toBe(18);
  });

  it('every command has a non-empty help block', () => {
    for (const g of COMMAND_GROUPS) {
      for (const c of g.commands) {
        expect(c.help, `${g.noun} ${c.verb}`).toMatch(/silverhand /);
        expect(c.summary.length, `${g.noun} ${c.verb}`).toBeGreaterThan(0);
      }
    }
  });

  it('returns undefined for unknown noun/verb (caller surfaces validation_error)', () => {
    expect(findGroup('bogus')).toBeUndefined();
    expect(findCommand('message', 'bogus')).toBeUndefined();
  });
});
