import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('runtime slot authority static guard (#task:2013)', () => {
  it('keeps runtime mutation APIs out of membership persistence', () => {
    const production = sourceFiles(join(backendRoot, 'src'))
      .map(path => readFileSync(path, 'utf8'))
      .join('\n');
    const conversationRepo = readFileSync(
      join(backendRoot, 'src/repos/conversation-repo.ts'),
      'utf8',
    );

    expect(production).not.toMatch(/\bupdateAgentRuntime\s*\(/);
    expect(conversationRepo).not.toMatch(/UPDATE\s+conversation_agents/i);
    expect(conversationRepo).not.toMatch(
      /INSERT\s+INTO\s+conversation_agents\s*\([^)]*(?:status|pid|cli_session_id)/i,
    );
    expect(conversationRepo).toContain('JOIN agent_runtime_slots');
  });
});
