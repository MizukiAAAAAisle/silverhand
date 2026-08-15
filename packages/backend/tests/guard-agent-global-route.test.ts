import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatAgentRuntimeScopeBanner } from '@silverhand/shared';

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(backendRoot, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function sourceOf(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('agent-global route authority static guard (#task:2030)', () => {
  it('has one principal verifier and one canonical internal-agent mount', () => {
    const composition = sourceOf(join(backendRoot, 'src/routes/internal-agent.ts'));

    expect(composition.match(/installInternalPrincipalMiddleware\s*\(/g)).toHaveLength(1);
    expect(composition.match(/new\s+RuntimePrincipalVerifier\s*\(/g)).toHaveLength(1);
    expect(composition.match(/app\.route\(\s*['"]\/internal\/agents\/:aid['"]/g))
      .toHaveLength(1);
    expect(composition).not.toMatch(/\/conversations\/:cid/);
  });

  it('keeps the retired route coordinate out of every production surface', () => {
    const productionRoots = [
      join(repoRoot, 'packages/backend/src'),
      join(repoRoot, 'packages/shared/src'),
      join(repoRoot, 'packages/host/src'),
      join(repoRoot, 'packages/cli/src'),
    ];
    const retiredFlagOwners: string[] = [];
    const retiredPathOwners: string[] = [];

    for (const root of productionRoots) {
      for (const file of sourceFiles(root)) {
        const text = sourceOf(file);
        // The one permitted occurrence is the typed removed-flag registry: it
        // exists only to reject an old client loudly and is not a route input.
        if (
          text.includes('route-conversation-id')
          && file !== join(repoRoot, 'packages/cli/src/strict-flags.ts')
        ) {
          retiredFlagOwners.push(file);
        }
        if (
          /\/internal\/agents\/[^\s'"`]*\/conversations|\/internal\/conversations\/[^\s'"`]*\/agents/.test(
            text,
          )
        ) {
          retiredPathOwners.push(file);
        }
      }
    }

    expect(retiredFlagOwners).toEqual([]);
    expect(retiredPathOwners).toEqual([]);
  });

  it('keeps the AgentSlot banner semantic-only: scope plus per-delivery workdir', () => {
    const source = sourceOf(
      join(repoRoot, 'packages/shared/src/runtime-scope-banner.ts'),
    );
    const banner = formatAgentRuntimeScopeBanner('/tmp/worktree');

    expect(banner).toContain('runtime_scope=agent');
    expect(banner).toContain('workdir=');
    expect(banner).not.toContain('target=');
    expect(source).not.toContain('ROUTE_PLACEHOLDER');
  });
});
