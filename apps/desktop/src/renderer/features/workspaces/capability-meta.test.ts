import { describe, expect, it } from 'vitest';
import { AGENT_CAPABILITIES } from '@silverhand/shared';
import {
  buildCapabilityGroups,
  CAPABILITY_COUNT,
} from './capability-meta';

describe('capability-meta', () => {
  it('covers exactly the registry capabilities, once each', () => {
    const keys = buildCapabilityGroups().flatMap(g => g.items.map(i => i.key));
    // no duplicates
    expect(new Set(keys).size).toBe(keys.length);
    // same set as the single source of truth, no extras / no missing
    expect([...keys].sort()).toEqual([...AGENT_CAPABILITIES].sort());
  });

  it('never silently drops a registry key (fallback group catches drift)', () => {
    const covered = new Set(
      buildCapabilityGroups().flatMap(g => g.items.map(i => i.key)),
    );
    for (const cap of AGENT_CAPABILITIES) {
      expect(covered.has(cap)).toBe(true);
    }
  });

  it('CAPABILITY_COUNT matches the registry size', () => {
    expect(CAPABILITY_COUNT).toBe(AGENT_CAPABILITIES.length);
  });
});
