import { describe, expect, it } from 'vitest';

import {
  EMPTY_MCP_CONFIG,
  parseMcpConfig,
  runtimeMcpServerName,
  serializeTomlValue,
  toClaudeMcpConfig,
  toCodexMcpOverrides,
  toOpencodeMcpConfig,
} from '../src/mcp-config.js';

describe('parseMcpConfig', () => {
  it('parses a stdio server', () => {
    const r = parseMcpConfig(
      JSON.stringify({
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'srv'], env: { T: '1' } },
        },
      }),
    );
    expect(r).toEqual({
      ok: true,
      config: {
        mcpServers: {
          github: { command: 'npx', args: ['-y', 'srv'], env: { T: '1' } },
        },
      },
    });
  });

  it('parses an http server', () => {
    const r = parseMcpConfig(
      JSON.stringify({
        mcpServers: { linear: { type: 'http', url: 'https://x.test/sse' } },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('treats empty/whitespace body as the empty config', () => {
    expect(parseMcpConfig('')).toEqual({ ok: true, config: EMPTY_MCP_CONFIG });
    expect(parseMcpConfig('   \n')).toEqual({ ok: true, config: EMPTY_MCP_CONFIG });
  });

  it('fails loud on invalid JSON', () => {
    const r = parseMcpConfig('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/);
  });

  it('rejects unknown server keys (strict)', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { a: { command: 'x', bogus: 1 } } }));
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown top-level key (strict)', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: {}, extra: 1 }));
    expect(r.ok).toBe(false);
  });

  it('rejects a bad server name', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { 'bad name!': { command: 'x' } } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/server name/);
  });

  it('rejects a stdio server with no command', () => {
    const r = parseMcpConfig(JSON.stringify({ mcpServers: { a: { args: [] } } }));
    expect(r.ok).toBe(false);
  });
});

describe('runtimeMcpServerName', () => {
  it('prefixes with the scope domain', () => {
    expect(runtimeMcpServerName('profile', 'github')).toBe('silverhand_profile__github');
    expect(runtimeMcpServerName('workspace', 'github')).toBe('silverhand_workspace__github');
  });
});

describe('toClaudeMcpConfig', () => {
  it('rewrites server keys to prefixed runtime names, body unchanged', () => {
    const config = {
      mcpServers: { github: { command: 'npx', args: ['srv'] } },
    };
    expect(toClaudeMcpConfig(config)).toEqual({
      mcpServers: {
        silverhand_profile__github: { command: 'npx', args: ['srv'] },
      },
    });
  });

  it('returns null when there are no servers', () => {
    expect(toClaudeMcpConfig(EMPTY_MCP_CONFIG)).toBeNull();
  });
});

describe('toCodexMcpOverrides', () => {
  it('emits one prefixed inline-table override per server', () => {
    const config = {
      mcpServers: {
        github: { command: 'npx', args: ['-y', 'srv'], env: { TOK: 'v' } },
      },
    };
    expect(toCodexMcpOverrides(config)).toEqual([
      'mcp_servers.silverhand_profile__github={command = "npx", args = ["-y", "srv"], env = {TOK = "v"}}',
    ]);
  });

  it('projects a stdio server to command/args/env and drops the type marker', () => {
    const config = {
      mcpServers: { fs: { type: 'stdio' as const, command: 'npx' } },
    };
    // `type` is a canonical marker, NOT a Codex key — it must not appear.
    expect(toCodexMcpOverrides(config)).toEqual([
      'mcp_servers.silverhand_profile__fs={command = "npx"}',
    ]);
  });

  it('projects an http server to Codex native keys (url + http_headers, no type/headers)', () => {
    // Cindy #task:1135 Blocker 2: Codex uses `url` + `http_headers`, has no
    // `type` discriminator and no `headers` key. Pin the exact projection so
    // a regression to verbatim canonical serialization fails here.
    const config = {
      mcpServers: {
        remote: {
          type: 'http' as const,
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
      },
    };
    expect(toCodexMcpOverrides(config)).toEqual([
      'mcp_servers.silverhand_profile__remote={url = "https://example.com/mcp", http_headers = {Authorization = "Bearer x"}}',
    ]);
  });

  it('maps an sse server to the same url form (Codex remote transport is url-based)', () => {
    const config = {
      mcpServers: {
        stream: { type: 'sse' as const, url: 'https://example.com/sse' },
      },
    };
    expect(toCodexMcpOverrides(config)).toEqual([
      'mcp_servers.silverhand_profile__stream={url = "https://example.com/sse"}',
    ]);
  });

  it('returns [] when there are no servers', () => {
    expect(toCodexMcpOverrides(EMPTY_MCP_CONFIG)).toEqual([]);
  });
});

describe('toOpencodeMcpConfig', () => {
  it('projects a stdio server to a local launcher, command+args folded, env→environment', () => {
    const config = {
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server-fs'], env: { TOK: 'v' } },
      },
    };
    expect(toOpencodeMcpConfig(config)).toEqual({
      mcp: {
        silverhand_profile__fs: {
          type: 'local',
          command: ['npx', '-y', 'server-fs'],
          environment: { TOK: 'v' },
        },
      },
    });
  });

  it('projects a stdio server with no args/env to a bare command array', () => {
    const config = {
      mcpServers: { fs: { type: 'stdio' as const, command: 'npx' } },
    };
    expect(toOpencodeMcpConfig(config)).toEqual({
      mcp: { silverhand_profile__fs: { type: 'local', command: ['npx'] } },
    });
  });

  it('projects http/sse servers to the remote form (url + headers, no type leakage)', () => {
    const config = {
      mcpServers: {
        remote: {
          type: 'http' as const,
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
        stream: { type: 'sse' as const, url: 'https://example.com/sse' },
      },
    };
    expect(toOpencodeMcpConfig(config)).toEqual({
      mcp: {
        silverhand_profile__remote: {
          type: 'remote',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer x' },
        },
        silverhand_profile__stream: {
          type: 'remote',
          url: 'https://example.com/sse',
        },
      },
    });
  });

  it('returns null when there are no servers', () => {
    expect(toOpencodeMcpConfig(EMPTY_MCP_CONFIG)).toBeNull();
  });
});

describe('serializeTomlValue', () => {
  it('serializes strings with escaping', () => {
    expect(serializeTomlValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
  it('serializes arrays and nested tables', () => {
    expect(serializeTomlValue({ a: [1, 'x'], b: { c: true } })).toBe(
      '{a = [1, "x"], b = {c = true}}',
    );
  });
  it('skips undefined object values', () => {
    expect(serializeTomlValue({ a: 1, b: undefined })).toBe('{a = 1}');
  });
  it('throws on non-finite numbers', () => {
    expect(() => serializeTomlValue(Number.POSITIVE_INFINITY)).toThrow();
  });
});
