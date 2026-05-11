import { describe, expect, it } from 'vitest';
import { nounHelp, topLevelHelp, verbHelp } from '../src/help.js';
import { COMMAND_GROUPS } from '../src/commands/index.js';

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
    }
  });
});
