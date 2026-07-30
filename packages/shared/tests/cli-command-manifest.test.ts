import { describe, expect, it } from 'vitest';
import {
  SILVERHAND_COMMAND_DOMAINS,
  silverhandCommandNouns,
} from '../src/cli-command-manifest.js';

describe('Silverhand command discovery manifest', () => {
  it('uses unique domains and nouns with non-empty discovery triggers', () => {
    const domains = SILVERHAND_COMMAND_DOMAINS.map(domain => domain.domain);
    const nouns = silverhandCommandNouns().map(noun => noun.noun);
    expect(new Set(domains).size).toBe(domains.length);
    expect(new Set(nouns).size).toBe(nouns.length);
    for (const domain of SILVERHAND_COMMAND_DOMAINS) {
      expect(domain.when.trim()).not.toBe('');
      expect(domain.nouns.length).toBeGreaterThan(0);
    }
  });

  it('uses unique verbs and keeps flat verbs distinct from facets', () => {
    for (const noun of silverhandCommandNouns()) {
      expect(
        new Set(noun.verbs).size,
        `${noun.noun} has duplicate verbs`,
      ).toBe(noun.verbs.length);
      const facets = noun.facets ?? [];
      expect(new Set(facets.map(facet => facet.facet)).size)
        .toBe(facets.length);
      for (const facet of facets) {
        expect(
          noun.verbs,
          `${noun.noun} verb collides with facet ${facet.facet}`,
        ).not.toContain(facet.facet);
        expect(
          new Set(facet.verbs).size,
          `${noun.noun} ${facet.facet} has duplicate verbs`,
        ).toBe(facet.verbs.length);
      }
    }
  });
});
