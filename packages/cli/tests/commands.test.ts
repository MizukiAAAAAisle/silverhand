import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AVATAR_MAX_BYTES } from '@silverhand/shared';
import {
  COMMAND_GROUPS,
  findCommand,
  findFacet,
  findFacetCommand,
  findGroup,
} from '../src/commands/index.js';
import type { BackendClient } from '../src/client.js';

/** Every leaf command, whether flat (`noun verb`) or faceted
 *  (`noun facet verb`), with a human label for assertion messages. */
function allCommands(): Array<{ label: string; cmd: import('../src/commands/index.js').Command }> {
  const out: Array<{ label: string; cmd: import('../src/commands/index.js').Command }> = [];
  for (const g of COMMAND_GROUPS) {
    for (const c of g.commands) out.push({ label: `${g.noun} ${c.verb}`, cmd: c });
    for (const f of g.facets ?? []) {
      for (const c of f.commands)
        out.push({ label: `${g.noun} ${f.facet} ${c.verb}`, cmd: c });
    }
  }
  return out;
}

describe('command catalogue', () => {
  it('exposes the nine nouns we promised in the prompt', () => {
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
      'profile',
    ]);
  });

  it('matches every MCP tool with exactly one CLI verb', () => {
    // The 23 backend internal routes that MCP currently exposes.
    // If you add a route, add a CLI command, and add it here.
    const expected: Array<[string, string]> = [
      ['message', 'send'],
      ['message', 'stale-resolve'],
      ['message', 'stale-receive'],
      ['message', 'react'],
      ['message', 'history'],
      ['message', 'search'],
      ['task', 'list'],
      ['task', 'create'],
      ['task', 'claim'],
      ['task', 'unclaim'],
      ['task', 'status'],
      ['task', 'edit'],
      ['task', 'detail'],
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
      ['profile', 'get'],
      ['profile', 'update'],
    ];
    for (const [noun, verb] of expected) {
      const cmd = findCommand(noun, verb);
      expect(cmd, `${noun} ${verb}`).toBeDefined();
    }
    const total = COMMAND_GROUPS.reduce((acc, g) => acc + g.commands.length, 0);
    expect(total).toBe(26);
  });

  it('every command has a non-empty help block', () => {
    for (const { label, cmd } of allCommands()) {
      expect(cmd.help, label).toMatch(/silverhand /);
      expect(cmd.summary.length, label).toBeGreaterThan(0);
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
    for (const { label, cmd } of allCommands()) {
      expect(cmd.flags, `${label} missing flags declaration`).toBeDefined();
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
    for (const { label, cmd } of allCommands()) {
      for (const re of forbidden) {
        expect(cmd.help, `${label} help leaks "${re}"`).not.toMatch(re);
      }
    }
  });
});

describe('profile facet (3-level: profile mcp <verb>)', () => {
  it('exposes the mcp facet with get/set/add/remove/clear/validate/probe', () => {
    const facet = findFacet('profile', 'mcp');
    expect(facet).toBeDefined();
    const verbs = facet!.commands.map(c => c.verb);
    expect(verbs).toEqual([
      'get',
      'set',
      'add',
      'remove',
      'clear',
      'validate',
      'probe',
    ]);
  });

  it('resolves a facet command by (noun, facet, verb)', () => {
    expect(findFacetCommand('profile', 'mcp', 'get')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'set')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'add')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'remove')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'clear')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'validate')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'probe')).toBeDefined();
    expect(findFacetCommand('profile', 'mcp', 'bogus')).toBeUndefined();
    expect(findFacet('profile', 'bogus')).toBeUndefined();
  });

  it('the profile noun carries BOTH flat verbs and the mcp facet (#task:1178)', () => {
    // Flat `profile get|update` coexist with the `mcp` facet — the
    // dispatcher tries the facet token first, then falls through to a
    // flat verb, so `profile mcp get` and `profile get` never collide.
    const flat = findGroup('profile')?.commands.map(c => c.verb);
    expect(flat).toEqual(['get', 'update']);
    expect(findCommand('profile', 'get')).toBeDefined();
    expect(findCommand('profile', 'update')).toBeDefined();
    // The facet is unaffected.
    expect(findFacetCommand('profile', 'mcp', 'get')).toBeDefined();
  });

  it('validate is CLI-local: parses stdin and reports server_count, no backend call', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'validate')!;
    const raw = JSON.stringify({
      mcpServers: { a: { command: 'x' }, b: { type: 'http', url: 'https://e/' } },
    });
    const result = await runWithStdin(cmd, raw, {} as BackendClient);
    expect(result).toEqual({ ok: true, server_count: 2 });
  });

  it('validate rejects bad JSON with validation_error (no backend call)', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'validate')!;
    await expect(
      runWithStdin(cmd, '{ not json', {} as BackendClient),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('set pipes raw stdin verbatim to the client', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'set')!;
    let captured: string | undefined;
    const client = {
      setProfileMcp: async (raw: string) => {
        captured = raw;
        return { ok: true, bytes_written: raw.length };
      },
    } as unknown as BackendClient;
    const raw = '{"mcpServers":{"a":{"command":"x"}}}';
    const result = await runWithStdin(cmd, raw, client);
    expect(captured).toBe(raw);
    expect(result).toMatchObject({ ok: true });
  });

  // add/remove/clear are CLI-orchestrated over get+set (the host stays an
  // opaque verbatim writer — #task:1135). Their merge / collision /
  // not-found logic lives ONLY here, so it is unit-tested here.

  /** Mock client whose getProfileMcp returns `existingRaw` and whose
   *  setProfileMcp records the written text. */
  function mcpClient(existingRaw: string | null) {
    const calls: { wrote?: string } = {};
    const client = {
      getProfileMcp: async () => ({ raw: existingRaw }),
      setProfileMcp: async (raw: string) => {
        calls.wrote = raw;
        return { ok: true, bytes_written: raw.length };
      },
    } as unknown as BackendClient;
    return { client, calls };
  }

  it('add merges a new server, preserving existing ones', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'add')!;
    const { client, calls } = mcpClient('{"mcpServers":{"a":{"command":"x"}}}');
    const result = await runWithStdin(
      cmd,
      '{"mcpServers":{"b":{"type":"http","url":"https://e/"}}}',
      client,
    );
    expect(result).toEqual({ ok: true, added: ['b'], total: 2 });
    expect(JSON.parse(calls.wrote!)).toEqual({
      mcpServers: {
        a: { command: 'x' },
        b: { type: 'http', url: 'https://e/' },
      },
    });
  });

  it('add fails with conflict on a same-named server and writes nothing', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'add')!;
    const { client, calls } = mcpClient('{"mcpServers":{"a":{"command":"x"}}}');
    await expect(
      runWithStdin(cmd, '{"mcpServers":{"a":{"command":"y"}}}', client),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(calls.wrote).toBeUndefined();
  });

  it('add --replace overwrites only the named server, keeping the rest', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'add')!;
    const { client, calls } = mcpClient(
      '{"mcpServers":{"a":{"command":"old"},"b":{"command":"keep"}}}',
    );
    const result = await runWithStdin(
      cmd,
      '{"mcpServers":{"a":{"command":"new"}}}',
      client,
      { replace: true },
    );
    expect(result).toEqual({ ok: true, added: ['a'], total: 2 });
    expect(JSON.parse(calls.wrote!)).toEqual({
      mcpServers: { a: { command: 'new' }, b: { command: 'keep' } },
    });
  });

  it('add onto an unset config writes just the new servers', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'add')!;
    const { client, calls } = mcpClient(null);
    const result = await runWithStdin(cmd, '{"mcpServers":{"a":{"command":"x"}}}', client);
    expect(result).toEqual({ ok: true, added: ['a'], total: 1 });
    expect(JSON.parse(calls.wrote!)).toEqual({ mcpServers: { a: { command: 'x' } } });
  });

  it('remove deletes the named server and keeps the others', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'remove')!;
    const { client, calls } = mcpClient(
      '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}',
    );
    const result = await runWithStdin(cmd, '', client, { server: 'a' });
    expect(result).toEqual({ ok: true, removed: 'a', remaining: 1 });
    expect(JSON.parse(calls.wrote!)).toEqual({ mcpServers: { b: { command: 'y' } } });
  });

  it('remove fails with not_found for an absent server (no write)', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'remove')!;
    const { client, calls } = mcpClient('{"mcpServers":{"a":{"command":"x"}}}');
    await expect(
      runWithStdin(cmd, '', client, { server: 'zzz' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(calls.wrote).toBeUndefined();
  });

  it('remove fails with not_found when no config is set', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'remove')!;
    const { client } = mcpClient(null);
    await expect(
      runWithStdin(cmd, '', client, { server: 'a' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('clear writes an empty config', async () => {
    const cmd = findFacetCommand('profile', 'mcp', 'clear')!;
    const { client, calls } = mcpClient('{"mcpServers":{"a":{"command":"x"}}}');
    const result = await runWithStdin(cmd, '', client);
    expect(result).toEqual({ ok: true, cleared: true });
    expect(JSON.parse(calls.wrote!)).toEqual({ mcpServers: {} });
  });
});

/** Run a command whose `run` reads stdin, by feeding `input` through a
 *  faked `process.stdin` async-iterator (the same shape the command's
 *  `for await (const chunk of process.stdin)` consumes). */
async function runWithStdin(
  cmd: import('../src/commands/index.js').Command,
  input: string,
  client: BackendClient,
  flags: Record<string, unknown> = {},
): Promise<unknown> {
  const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
  const fake = {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(input, 'utf8');
    },
  };
  Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
  try {
    return await cmd.run({
      env: {
        conversationId: 'conv',
        agentId: 'agent',
        serverUrl: 'http://127.0.0.1:4488',
        authToken: 'token',
      },
      client,
      args: { flags, positional: [], rest: [] },
    } as any);
  } finally {
    if (realStdin) Object.defineProperty(process, 'stdin', realStdin);
  }
}

describe('profile update behavior (#task:1178)', () => {
  // Magic-byte PNG header — enough for `sniffImageMime` to classify it as
  // image/png (it reads only the leading signature, not a full decode).
  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);

  function profileUpdateCmd(): import('../src/commands/index.js').Command {
    const cmd = findCommand('profile', 'update');
    expect(cmd).toBeDefined();
    return cmd!;
  }

  /** A client that records every `updateProfile` call and returns `profile`
   *  (the command unwraps `{ profile }` and prints the bare DTO). */
  function captureUpdateClient(
    profile: Record<string, unknown> = {
      id: 'agent',
      name: 'a',
      display_name: 'A',
      description: null,
      avatar_url: null,
    },
  ) {
    const calls: { count: number; input?: any } = { count: 0 };
    const client = {
      updateProfile: async (input: unknown) => {
        calls.count++;
        calls.input = input;
        return { profile };
      },
    } as unknown as BackendClient;
    return { client, calls };
  }

  function runProfileUpdate(
    flags: Record<string, unknown>,
    client: BackendClient,
  ): Promise<unknown> {
    return profileUpdateCmd().run({
      env: {
        conversationId: 'conv',
        agentId: 'agent',
        serverUrl: 'http://127.0.0.1:4488',
        authToken: 'token',
      },
      client,
      args: { flags, positional: [], rest: [] },
    } as any);
  }

  it('rejects more than one avatar action and never calls the client', async () => {
    const { client, calls } = captureUpdateClient();
    await expect(
      runProfileUpdate({ 'avatar-file': '/abs/a.png', 'clear-avatar': true }, client),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(calls.count).toBe(0);
  });

  it('rejects an empty update (no flags) without calling the client', async () => {
    const { client, calls } = captureUpdateClient();
    await expect(runProfileUpdate({}, client)).rejects.toMatchObject({
      code: 'validation_error',
    });
    expect(calls.count).toBe(0);
  });

  it('rejects a non-absolute --avatar-file before any client call', async () => {
    const { client, calls } = captureUpdateClient();
    await expect(
      runProfileUpdate({ 'avatar-file': 'relative.png' }, client),
    ).rejects.toMatchObject({ code: 'validation_error' });
    expect(calls.count).toBe(0);
  });

  it('--avatar-file sends text + sniffed avatar bytes in one update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'silverhand-avatar-file-'));
    try {
      const p = join(dir, 'a.png');
      await writeFile(p, PNG_BYTES);
      const fresh = {
        id: 'agent',
        name: 'a',
        display_name: 'Alice',
        description: 'd',
        avatar_url: '/api/agents/agent/avatar?v=1',
      };
      const { client, calls } = captureUpdateClient(fresh);
      const result = await runProfileUpdate(
        { 'display-name': 'Alice', 'avatar-file': p },
        client,
      );
      expect(calls.count).toBe(1);
      expect(calls.input.display_name).toBe('Alice');
      expect(calls.input.avatar).toMatchObject({
        action: 'set',
        filename: 'a.png',
        contentType: 'image/png',
      });
      expect(Buffer.isBuffer(calls.input.avatar.buffer)).toBe(true);
      expect((calls.input.avatar.buffer as Buffer).equals(PNG_BYTES)).toBe(true);
      // The command unwraps `{ profile }` → returns the bare DTO.
      expect(result).toEqual(fresh);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--clear-avatar sends a clear action and no bytes', async () => {
    const { client, calls } = captureUpdateClient();
    await runProfileUpdate({ 'clear-avatar': true }, client);
    expect(calls.count).toBe(1);
    expect(calls.input.avatar).toEqual({ action: 'clear' });
  });

  it('--avatar-url downloads CLI-side and uploads the sniffed blob', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(PNG_BYTES, { status: 200 })) as typeof fetch;
    try {
      const { client, calls } = captureUpdateClient();
      await runProfileUpdate({ 'avatar-url': 'https://example.test/a.png' }, client);
      expect(calls.count).toBe(1);
      expect(calls.input.avatar).toMatchObject({
        action: 'set',
        contentType: 'image/png',
      });
      expect((calls.input.avatar.buffer as Buffer).equals(PNG_BYTES)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('--avatar-url that 404s never calls the client', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as typeof fetch;
    try {
      const { client, calls } = captureUpdateClient();
      await expect(
        runProfileUpdate({ 'avatar-url': 'https://example.test/x.png' }, client),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(calls.count).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('--avatar-url that exceeds the redirect cap never calls the client', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.test/next' },
      })) as typeof fetch;
    try {
      const { client, calls } = captureUpdateClient();
      await expect(
        runProfileUpdate({ 'avatar-url': 'https://example.test/a.png' }, client),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(calls.count).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('--avatar-url over the size cap aborts the download, no client call', async () => {
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1024);
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(big, { status: 200 })) as typeof fetch;
    try {
      const { client, calls } = captureUpdateClient();
      await expect(
        runProfileUpdate({ 'avatar-url': 'https://example.test/big.png' }, client),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(calls.count).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('thread legacy verbs', () => {
  it('removes create/close and keeps explicit migration hints', () => {
    expect(findCommand('thread', 'create')).toBeUndefined();
    expect(findCommand('thread', 'close')).toBeUndefined();
    const group = findGroup('thread');
    expect(group?.removedVerbs?.create).toMatchObject({
      replacement: 'follow',
    });
    expect(group?.removedVerbs?.create?.hint).toContain('--target thread:');
    expect(group?.removedVerbs?.close).toMatchObject({
      replacement: 'unfollow',
    });
    expect(group?.removedVerbs?.close?.hint).toContain('thread unfollow');
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

describe('task create --target thread:<message_id>', () => {
  // Locks the load-bearing contract: the optional thread target must
  // reach the wire as the public `target` object, and OMITTING it must
  // leave the field absent entirely (so the backend keeps the main-line
  // default `thread_root_id = NULL`). Without this, the flag could
  // silently regress to "accepted but never forwarded" — backend/schema/
  // typecheck would all stay green (#task:1056 review).
  function captureCreateTasks(flags: Record<string, string>) {
    const cmd = findCommand('task', 'create');
    expect(cmd).toBeDefined();
    let captured: unknown;
    const client = {
      createTasks: async (input: unknown) => {
        captured = input;
        return { tasks: [] };
      },
    } as unknown as BackendClient;
    return cmd!
      .run({
        env: {
          conversationId: 'conv',
          agentId: 'agent',
          serverUrl: 'http://127.0.0.1:4488',
          authToken: 'token',
        },
        client,
      args: { flags, positional: [], rest: [] },
    } as any)
      .then(() => captured as { tasks: unknown[]; target?: unknown; reply_to_message_id?: string });
  }

  it('keeps --reply-to as a hidden compatibility alias for the public thread target', async () => {
    const input = await captureCreateTasks({ title: 'T', 'reply-to': 'm1' });
    expect(input.tasks).toEqual([{ title: 'T' }]);
    expect(input.target).toEqual({ kind: 'thread', message_id: 'm1' });
    expect('reply_to_message_id' in input).toBe(false);
  });

  it('forwards --target thread:<message_id> as the public thread target', async () => {
    const input = await captureCreateTasks({ title: 'T', target: 'thread:m1' });
    expect(input.tasks).toEqual([{ title: 'T' }]);
    expect(input.target).toEqual({ kind: 'thread', message_id: 'm1' });
    expect('reply_to_message_id' in input).toBe(false);
  });

  it('treats --target channel as the explicit main-line destination', async () => {
    const input = await captureCreateTasks({ title: 'T', target: 'channel' });
    expect(input.tasks).toEqual([{ title: 'T' }]);
    expect(input.target).toEqual({ kind: 'channel' });
    expect('reply_to_message_id' in input).toBe(false);
  });

  it('rejects --reply-to with --target as mutually_exclusive', async () => {
    const cmd = findCommand('task', 'create');
    await expect(
      cmd!.run({
        env: {
          conversationId: 'conv',
          agentId: 'agent',
          serverUrl: 'http://127.0.0.1:4488',
          authToken: 'token',
        },
        client: {} as BackendClient,
        args: {
          flags: { title: 'T', target: 'thread:m1', 'reply-to': 'm2' },
          positional: [],
          rest: [],
        },
      } as any),
    ).rejects.toMatchObject({ subkind: 'mutually_exclusive' });
  });

  it('omits target and reply_to_message_id when no target is provided (main-line default)', async () => {
    const input = await captureCreateTasks({ title: 'T' });
    expect(input.tasks).toEqual([{ title: 'T' }]);
    expect('target' in input).toBe(false);
    expect('reply_to_message_id' in input).toBe(false);
  });
});
