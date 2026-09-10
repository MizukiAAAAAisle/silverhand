import { describe, expect, it } from 'vitest';
import {
  projectProfileMcpForRuntime,
  RUNTIME_CATALOG,
  toAcpMcpServers,
  type McpConfig,
} from '../src/index.js';

const config: McpConfig = {
  mcpServers: {
    local: { command: 'fixture', args: ['--test'], env: { TOKEN: 'fixture-value' } },
    http: {
      type: 'http',
      url: 'http://localhost/mcp',
      headers: { Authorization: 'fixture-value' },
    },
    sse: { type: 'sse', url: 'http://localhost/sse' },
  },
};

describe('shared profile MCP projection authority', () => {
  it('matches every catalog capability without renderer-side runtime branches', () => {
    for (const runtime of RUNTIME_CATALOG) {
      const project = () => projectProfileMcpForRuntime(config, runtime.kind);
      if (runtime.supportsProfileMcp) expect(project).not.toThrow();
      else expect(project).toThrow('Profile MCP is not loaded');
    }
  });

  it('projects all ACP transports additively without changing canonical config', () => {
    const before = JSON.stringify(config);
    expect(projectProfileMcpForRuntime(config, 'grok')).toEqual({
      kind: 'acp',
      servers: toAcpMcpServers(config, 'profile'),
    });
    expect(toAcpMcpServers(config, 'profile')).toEqual([
      {
        name: 'silverhand_profile__local',
        command: 'fixture',
        args: ['--test'],
        env: [{ name: 'TOKEN', value: 'fixture-value' }],
      },
      {
        name: 'silverhand_profile__http',
        type: 'http',
        url: 'http://localhost/mcp',
        headers: [{ name: 'Authorization', value: 'fixture-value' }],
      },
      { name: 'silverhand_profile__sse', type: 'sse', url: 'http://localhost/sse', headers: [] },
    ]);
    expect(JSON.stringify(config)).toBe(before);
    expect(toAcpMcpServers({ mcpServers: {} }, 'profile')).toEqual([]);
  });
});
