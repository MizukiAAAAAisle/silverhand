import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPromptContextFromRuntimeStartOptions } from '../src/daemon/prompt-context.js';
import { resolveRuntimeStartPaths } from '../src/daemon/runtime-start-resolve.js';
import {
  testRuntimeStartResolveDeps,
  testStartOptions,
} from './_helpers/runtime-start-options.js';

describe('buildPromptContextFromRuntimeStartOptions', () => {
  it('uses the daemon-resolved agent home as the prompt-facing L1 authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'silverhand-prompt-context-'));
    try {
      const agentsRoot = join(root, 'computers', 'computer-1', 'agents');
      const agentHome = join(agentsRoot, 'a1');
      mkdirSync(agentHome, { recursive: true });
      writeFileSync(join(agentHome, 'system_prompt.md'), 'resolved role');

      const resolved = await resolveRuntimeStartPaths(
        testStartOptions(),
        testRuntimeStartResolveDeps({
          agentHomeRootDir: agentsRoot,
          computerId: 'computer-1',
        }),
      );
      const context =
        await buildPromptContextFromRuntimeStartOptions(resolved);

      expect(context.roleSystemPrompt).toBe('resolved role');
      expect(context.roleSystemPromptPath).toBe(
        join(agentHome, 'system_prompt.md'),
      );
      expect(context.roleSystemPromptPath).not.toContain(
        join(root, 'agents', 'a1'),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
