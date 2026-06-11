import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_GROUPS, findCommand, findGroup } from '../src/commands/index.js';
import type { BackendClient } from '../src/client.js';

describe('command catalogue', () => {
  it('exposes the eight nouns we promised in the prompt', () => {
    const nouns = COMMAND_GROUPS.map(g => g.noun);
    expect(nouns).toEqual([
      'message',
      'task',
      'thread',
      'channel',
      'member',
      'workspace',
      'schedule',
      'file',
    ]);
  });

  it('matches every MCP tool with exactly one CLI verb', () => {
    // The 22 backend internal routes that MCP currently exposes.
    // If you add a route, add a CLI command, and add it here.
    const expected: Array<[string, string]> = [
      ['message', 'send'],
      ['message', 'stale-resolve'],
      ['message', 'history'],
      ['message', 'search'],
      ['task', 'list'],
      ['task', 'create'],
      ['task', 'claim'],
      ['task', 'unclaim'],
      ['task', 'status'],
      ['thread', 'create'],
      ['thread', 'close'],
      ['thread', 'follow'],
      ['thread', 'unfollow'],
      ['channel', 'create'],
      ['channel', 'list'],
      ['member', 'add'],
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
    expect(total).toBe(22);
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

  it('every command declares its allowed flags so the dispatcher can reject typos', () => {
    // Strict-flag validation lives in cli.ts but it consumes the
    // `flags` + `booleanFlags` arrays declared on each command. If a
    // command doesn't declare them, the dispatcher would silently accept
    // any flag and re-introduce the "agent typed a typo, got the full
    // board" footgun. Workspace.list legitimately takes nothing — it
    // declares an empty `flags: []`.
    for (const g of COMMAND_GROUPS) {
      for (const c of g.commands) {
        expect(c.flags, `${g.noun} ${c.verb} missing flags declaration`).toBeDefined();
      }
    }
  });

  it('command help blocks do not leak transport/credential semantics to agents', () => {
    // The CLI is already configured for the current session by the
    // backend. Help text the agent reads must not mention SILVERHAND_*
    // env vars, AUTH_TOKEN, or "auth"-flavored exit-code descriptions —
    // the prompt explicitly keeps these layers transparent. We match
    // the four known env vars by name (rather than `SILVERHAND_` as a
    // bare prefix) so unrelated tokens like the heredoc delimiter
    // `SILVERHAND_EOF` recommended in `silverhand message send` help
    // are not falsely flagged.
    const forbidden = [
      /SILVERHAND_(?:AUTH_TOKEN|CONVERSATION_ID|AGENT_ID|SERVER_URL)\b/,
      /AUTH_TOKEN/,
      /\bauth failure\b/i,
    ];
    for (const g of COMMAND_GROUPS) {
      for (const c of g.commands) {
        for (const re of forbidden) {
          expect(
            c.help,
            `${g.noun} ${c.verb} help leaks "${re}"`,
          ).not.toMatch(re);
        }
      }
    }
  });
});

describe('thread close flag plumbing', () => {
  it('forwards --allow-open-tasks to the client as allow_open_tasks: true', async () => {
    const cmd = findCommand('thread', 'close');
    expect(cmd).toBeDefined();
    expect(cmd!.booleanFlags).toContain('allow-open-tasks');
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      closeThread: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { thread: { id: 't' } };
      },
    } as unknown as BackendClient;
    await cmd!.run({
      client: fakeClient,
      args: {
        flags: { summary: 'done', 'allow-open-tasks': true },
        positional: [],
        rest: [],
      },
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ summary: 'done', allow_open_tasks: true });
  });

  it('omits allow_open_tasks when the flag is absent (back-compat default)', async () => {
    const cmd = findCommand('thread', 'close');
    expect(cmd).toBeDefined();
    const calls: Array<Record<string, unknown>> = [];
    const fakeClient = {
      closeThread: async (input: Record<string, unknown>) => {
        calls.push(input);
        return { thread: { id: 't' } };
      },
    } as unknown as BackendClient;
    await cmd!.run({
      client: fakeClient,
      args: {
        flags: { summary: 'done' },
        positional: [],
        rest: [],
      },
    } as any);
    expect(calls[0]).toEqual({ summary: 'done' });
    expect(calls[0]).not.toHaveProperty('allow_open_tasks');
  });
});

describe('file view command', () => {
  it('returns the zero-copy local path when the loopback backend path is readable', async () => {
    const cmd = findCommand('file', 'view');
    expect(cmd).toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-file-view-local-'));
    try {
      const localPath = join(dir, 'shot.png');
      await writeFile(localPath, Buffer.from('local-bytes'));
      let downloaded = false;
      const fakeClient = {
        locateAttachment: async () => ({
          storage: 'local',
          local_path: localPath,
          filename: 'shot.png',
          content_type: 'image/png',
        }),
        downloadAttachment: async () => {
          downloaded = true;
          return { buffer: Buffer.from('remote-bytes'), contentType: 'image/png' };
        },
      } as unknown as BackendClient;

      const result = await cmd!.run({
        env: {
          conversationId: 'conv-local',
          agentId: 'agent',
          serverUrl: 'http://127.0.0.1:4488',
          authToken: 'token',
        },
        client: fakeClient,
        args: {
          flags: { 'attachment-id': 'att-local' },
          positional: [],
          rest: [],
        },
      } as any);

      expect(downloaded).toBe(false);
      expect(result).toEqual({
        storage: 'local',
        local_path: localPath,
        filename: 'shot.png',
        content_type: 'image/png',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('downloads remote-backend attachments into a local cache path', async () => {
    const cmd = findCommand('file', 'view');
    expect(cmd).toBeDefined();
    const silverhandDir = await mkdtemp(join(tmpdir(), 'silverhand-file-view-cache-'));
    const previousSilverhandDir = process.env.SILVERHAND_DIR;
    try {
      process.env.SILVERHAND_DIR = silverhandDir;
      const result = await cmd!.run({
        env: {
          conversationId: 'conv-remote',
          agentId: 'agent',
          serverUrl: 'https://remote.example.test',
          authToken: 'token',
        },
        client: {
          locateAttachment: async () => ({
            storage: 'local',
            local_path: '/remote/server/blobs/shot.png',
            filename: 'shot.png',
            content_type: 'image/png',
          }),
          downloadAttachment: async () => ({
            buffer: Buffer.from('remote-bytes'),
            contentType: 'image/png',
          }),
        } as unknown as BackendClient,
        args: {
          flags: { 'attachment-id': 'att-remote' },
          positional: [],
          rest: [],
        },
      } as any) as {
        storage: 'local';
        local_path: string;
        filename: string;
        content_type: string;
      };

      expect(result.storage).toBe('local');
      expect(result.local_path).toContain(silverhandDir);
      expect(result.local_path).toContain('attachments-cache');
      expect(result.local_path).toContain('conv-remote');
      expect(result.local_path).toContain('att-remote');
      expect(result.filename).toBe('shot.png');
      expect(result.content_type).toBe('image/png');
      expect(await readFile(result.local_path, 'utf8')).toBe('remote-bytes');
    } finally {
      if (previousSilverhandDir === undefined) delete process.env.SILVERHAND_DIR;
      else process.env.SILVERHAND_DIR = previousSilverhandDir;
      await rm(silverhandDir, { recursive: true, force: true });
    }
  });
});
