import { describe, expect, it } from 'vitest';
import {
  facetHelp,
  facetVerbHelp,
  nounHelp,
  topLevelHelp,
  verbHelp,
} from '../src/help.js';
import { COMMAND_GROUPS } from '../src/commands/index.js';
import { silverhandCommandNouns } from '@silverhand/shared/cli-command-manifest';

describe('top-level help text', () => {
  it('describes JSON as the default and notes --json is accepted', () => {
    const text = topLevelHelp();
    expect(text).toContain('machine-readable JSON on stdout');
    expect(text).toContain('--json');
    expect(text.toLowerCase()).toContain('no-op');
  });

  it('does not leak transport/credential semantics to agents', () => {
    // The CLI is configured by the backend; help text agents read must
    // not advertise SILVERHAND_* env vars, AUTH_TOKEN, or "auth"-flavored
    // exit-code descriptions. Those layers are kept transparent on
    // purpose (see platform-prompt sweep + #205/#207 review).
    const text = topLevelHelp();
    expect(text).not.toMatch(/SILVERHAND_/);
    expect(text).not.toMatch(/AUTH_TOKEN/);
    expect(text).not.toMatch(/\bauth failure\b/i);
    // The legacy "3 = auth" exit code line was the original leak; the
    // replacement uses a neutral term.
    expect(text).not.toMatch(/^\s*3\s*=\s*auth\b/m);
  });

  it('lists every registered noun', () => {
    const text = topLevelHelp();
    for (const g of COMMAND_GROUPS) {
      expect(text).toContain(g.noun);
    }
  });

  it('binds every shared manifest noun and verb into the CLI tree', () => {
    const expected = silverhandCommandNouns().map(noun => ({
      noun: noun.noun,
      verbs: [...noun.verbs],
      facets: (noun.facets ?? []).map(facet => ({
        facet: facet.facet,
        verbs: [...facet.verbs],
      })),
    }));
    const actual = COMMAND_GROUPS.map(group => ({
      noun: group.noun,
      verbs: group.commands.map(command => command.verb),
      facets: (group.facets ?? []).map(facet => ({
        facet: facet.facet,
        verbs: facet.commands.map(command => command.verb),
      })),
    }));
    expect(actual).toEqual(expected);
  });
});

describe('per-noun and per-verb help', () => {
  it('returns null for unknown nouns/verbs', () => {
    expect(nounHelp('bogus')).toBeNull();
    expect(verbHelp('message', 'bogus')).toBeNull();
  });

  it('renders a help block for every (noun, verb) we expose', () => {
    for (const g of COMMAND_GROUPS) {
      const noun = nounHelp(g.noun);
      expect(noun, `nounHelp(${g.noun})`).toBeTruthy();
      for (const c of g.commands) {
        const verb = verbHelp(g.noun, c.verb);
        expect(verb, `${g.noun} ${c.verb}`).toContain('silverhand ');
      }
      // Faceted nouns (3-level): each facet lists in the noun help, and
      // every facet verb has a help block reachable via facetVerbHelp.
      for (const f of g.facets ?? []) {
        expect(noun, `nounHelp(${g.noun}) lists facet ${f.facet}`).toContain(
          f.facet,
        );
        const fh = facetHelp(g.noun, f.facet);
        expect(fh, `facetHelp(${g.noun} ${f.facet})`).toContain('silverhand ');
        for (const c of f.commands) {
          const vh = facetVerbHelp(g.noun, f.facet, c.verb);
          expect(vh, `${g.noun} ${f.facet} ${c.verb}`).toContain('silverhand ');
        }
      }
    }
  });

  it('returns null for unknown facets/facet-verbs', () => {
    expect(facetHelp('profile', 'bogus')).toBeNull();
    expect(facetVerbHelp('profile', 'mcp', 'bogus')).toBeNull();
    expect(facetHelp('message', 'mcp')).toBeNull();
  });

  it('keeps chat reference grammar discoverable from message noun help', () => {
    const text = nounHelp('message');
    expect(text).toContain('@<handle>');
    expect(text).toContain('#conv:<id>');
    expect(text).toContain('#task:<n>');
  });
});
