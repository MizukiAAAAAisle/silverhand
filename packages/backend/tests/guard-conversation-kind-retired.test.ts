import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(backendRoot, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [path] : [];
  });
}

function retiredConversationKindReasons(text: string): string[] {
  const reasons: string[] = [];
  if (/\bConversationKind(?:Schema)?\b/.test(text)) reasons.push('type/schema alias');
  if (/\bconversation_kind\b/.test(text)) reasons.push('wire/row field');
  if (/\bconversations\.kind\b/.test(text)) reasons.push('qualified SQL column');
  if (
    /^\s*(?:SELECT|WHERE|JOIN|AND|OR|WHEN)\b[^\n;`]*\b(?:c|tc)\.kind\b/gim.test(text)
    || /['"`](?:c|tc)\.kind['"`]/.test(text)
  ) {
    reasons.push('conversation SQL alias read');
  }
  if (
    /z\.literal\(\s*['"]dm_channel['"]\s*\)/s.test(text)
    || /z\.enum\(\s*\[[^\]]*['"]dm_channel['"][^\]]*\]/s.test(text)
  ) {
    reasons.push('inline classifier schema');
  }
  return reasons;
}

describe('retired conversations.kind static guard (#task:2023)', () => {
  it('keeps the retired classifier out of production source and wire names', () => {
    const roots = [
      join(repoRoot, 'packages/shared/src'),
      join(repoRoot, 'packages/backend/src'),
      join(repoRoot, 'packages/host/src'),
      join(repoRoot, 'packages/cli/src'),
      join(repoRoot, 'packages/server/src'),
      join(repoRoot, 'apps/desktop/src'),
    ];
    const historical = new Set([
      join(repoRoot, 'packages/shared/src/db/baseline-schema.ts'),
      join(repoRoot, 'packages/shared/src/db/migrations.ts'),
    ]);
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        if (historical.has(file)) continue;
        const text = readFileSync(file, 'utf8');
        const reasons = retiredConversationKindReasons(text);
        if (reasons.length > 0) {
          offenders.push(`${relative(repoRoot, file)}: ${reasons.join(', ')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('proves the guard sees each retired shape instead of passing vacuously', () => {
    const probe = `
      const ConversationKindSchema = z.enum(['channel', 'dm_channel']);
      type Row = { conversation_kind: string };
      SELECT conversations.kind FROM conversations;
      SELECT c.id FROM conversations c WHERE c.workspace_id = ? AND c.kind = 'channel';
      const injectedColumn = 'tc.kind';
      const retiredWire = z.literal('dm_channel');
    `;
    expect(retiredConversationKindReasons(probe)).toEqual([
      'type/schema alias',
      'wire/row field',
      'qualified SQL column',
      'conversation SQL alias read',
      'inline classifier schema',
    ]);
  });
});
