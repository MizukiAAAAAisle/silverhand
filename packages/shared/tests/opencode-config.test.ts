import { describe, expect, it } from 'vitest';

import {
  SILVERHAND_OPENCODE_AGENT,
  buildOpencodeConfigContent,
} from '../src/opencode-config.js';

/**
 * `OPENCODE_CONFIG_CONTENT` assembly (#task:1405). opencode deep-merges this
 * over the user's on-disk config (env wins on conflicting leaves), so we emit
 * ONLY our own keys and only the sections that actually have content:
 *  - standing prompt → a custom agent (`agent.<SILVERHAND_OPENCODE_AGENT>.prompt`)
 *    the ACP driver selects via the session `mode` config option.
 *  - profile MCP → domain-prefixed servers under `mcp`.
 */
describe('buildOpencodeConfigContent', () => {
  it('injects the standing prompt under the silverhand agent', () => {
    const content = buildOpencodeConfigContent({ standingPrompt: 'MANUAL' });
    expect(JSON.parse(content!)).toEqual({
      agent: { [SILVERHAND_OPENCODE_AGENT]: { prompt: 'MANUAL' } },
    });
  });

  it('merges standing prompt AND mcp into one fragment', () => {
    const content = buildOpencodeConfigContent({
      standingPrompt: 'MANUAL',
      mcpConfig: {
        mcp: {
          silverhand_profile__fs: { type: 'local', command: ['npx'] },
        },
      },
    });
    expect(JSON.parse(content!)).toEqual({
      agent: { silverhand: { prompt: 'MANUAL' } },
      mcp: { silverhand_profile__fs: { type: 'local', command: ['npx'] } },
    });
  });

  it('omits the mcp section entirely when there are no servers', () => {
    const content = buildOpencodeConfigContent({
      standingPrompt: 'MANUAL',
      mcpConfig: null,
    });
    expect(JSON.parse(content!).mcp).toBeUndefined();
  });

  it('omits the agent section when the standing prompt is blank', () => {
    const content = buildOpencodeConfigContent({
      standingPrompt: '   ',
      mcpConfig: { mcp: { s: { type: 'local', command: ['x'] } } },
    });
    const parsed = JSON.parse(content!);
    expect(parsed.agent).toBeUndefined();
    expect(parsed.mcp).toBeDefined();
  });

  it('returns null when there is nothing to inject (pure user config)', () => {
    expect(buildOpencodeConfigContent({})).toBeNull();
    expect(
      buildOpencodeConfigContent({ standingPrompt: '', mcpConfig: null }),
    ).toBeNull();
  });
});
