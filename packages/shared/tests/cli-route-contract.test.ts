import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import routes from '../src/cli-route-contract.json';
import { internalPaths } from '../src/api/paths';
import { SILVERHAND_COMMAND_DOMAINS } from '../src/cli-command-manifest';

describe('CLI audit route contract', () => {
  it('covers the public internal paths in both directions', () => {
    const excluded = new Set(['agentCliTrace', 'agentUploadAvatar', 'agentDeleteAvatar']);
    const expected = new Set(
      Object.entries(internalPaths)
        .filter(([name]) => !excluded.has(name))
        .map(([, build]) =>
          build('AGENT', 'ATT').replace('/internal/agents/AGENT/', '').replace('ATT', '*'),
        ),
    );
    expect(new Set(routes.map((route) => route.suffix))).toEqual(expected);
    expect(new Set(routes.map((route) => `${route.method} ${route.suffix}`)).size).toBe(
      routes.length,
    );
  });

  it('attributes every route to a discoverable CLI command', () => {
    const known = new Set<string>();
    for (const domain of SILVERHAND_COMMAND_DOMAINS) {
      for (const noun of domain.nouns) {
        for (const verb of noun.verbs) known.add(`${noun.noun} ${verb}`);
        if ('facets' in noun) {
          for (const facet of noun.facets) {
            for (const verb of facet.verbs) known.add(`${noun.noun} ${facet.facet} ${verb}`);
          }
        }
      }
    }
    for (const route of routes) expect(known).toContain(`${route.noun} ${route.verb}`);
  });
});

// Retirement must not leave an installable empty server or a Desktop dependency.
it('retired TS server packages cannot re-enter the workspace', () => {
  const root = resolve(import.meta.dirname, '../../..');
  for (const name of ['backend', 'server']) {
    expect(existsSync(resolve(root, `packages/${name}/package.json`))).toBe(false);
  }
  const desktop = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8'));
  for (const deps of [desktop.dependencies, desktop.devDependencies]) {
    expect(deps).not.toHaveProperty('@silverhand/backend');
    expect(deps).not.toHaveProperty('@silverhand/server');
  }
});
