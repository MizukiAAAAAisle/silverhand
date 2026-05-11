import { describe, expect, it } from 'vitest';
import {
  assertKnownFlags,
  closestFlag,
  GLOBAL_NOOP_FLAGS,
  levenshtein,
} from '../src/strict-flags.js';
import { CliError } from '../src/errors.js';

describe('strict flag validation', () => {
  it('accepts only declared flags (booleans + value-bearing)', () => {
    expect(() =>
      assertKnownFlags(
        { 'task-number': '191', mine: true },
        {
          noun: 'task',
          verb: 'list',
          flags: ['task-number'],
          booleanFlags: ['mine'],
        },
      ),
    ).not.toThrow();
  });

  it('rejects an unknown flag with validation_error and exit-code 1 mapping', () => {
    let caught: unknown;
    try {
      assertKnownFlags(
        { 'task-numbers': '191' }, // common typo
        {
          noun: 'task',
          verb: 'list',
          flags: ['task-number'],
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    const e = caught as CliError;
    expect(e.code).toBe('validation_error');
    expect(e.retriable).toBe(false);
    expect(e.message).toContain('unknown flag --task-numbers');
    expect(e.message).toContain('did you mean --task-number?');
  });

  it('lists additional unknown flags after the first one in the message', () => {
    let caught: unknown;
    try {
      assertKnownFlags(
        { foo: 'a', bar: 'b', baz: 'c' },
        { noun: 'task', verb: 'list', flags: ['something-else'] },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliError);
    const msg = (caught as CliError).message;
    // First unknown is the leading one — the rest come in a parenthesized
    // tail so the agent sees every typo at once and doesn't keep retrying.
    expect(msg).toMatch(/unknown flag --foo/);
    expect(msg).toMatch(/also unrecognized: --bar, --baz/);
  });

  it('falls back to a generic help hint when no candidate is close enough', () => {
    let caught: unknown;
    try {
      assertKnownFlags(
        { 'completely-different-flag': 'x' },
        { noun: 'task', verb: 'list', flags: ['title', 'body'] },
      );
    } catch (err) {
      caught = err;
    }
    const msg = (caught as CliError).message;
    expect(msg).toContain('run `silverhand task list --help`');
    expect(msg).not.toContain('did you mean');
  });

  it('matches across flags and booleanFlags when suggesting', () => {
    // `--mines` -> closest is the boolean flag `--mine` (distance 1).
    let caught: unknown;
    try {
      assertKnownFlags(
        { mines: true },
        { noun: 'task', verb: 'list', flags: ['title'], booleanFlags: ['mine'] },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as CliError).message).toContain('did you mean --mine?');
  });

  it('treats commands with empty flag lists as accepting nothing', () => {
    expect(() =>
      assertKnownFlags(
        { foo: 'a' },
        { noun: 'workspace', verb: 'list', flags: [] },
      ),
    ).toThrow(/unknown flag --foo/);
  });

  it('accepts global no-op flags on every command without explicit declaration', () => {
    // `--json` is the documented default output mode — agents must be
    // able to pass it on any subcommand (or none) without tripping
    // strict validation. Verified directly + via a command that
    // declares NO flags at all.
    expect(GLOBAL_NOOP_FLAGS.has('json')).toBe(true);
    expect(() =>
      assertKnownFlags(
        { json: true },
        { noun: 'task', verb: 'list', flags: ['task-number'] },
      ),
    ).not.toThrow();
    expect(() =>
      assertKnownFlags(
        { json: true },
        { noun: 'workspace', verb: 'list', flags: [] },
      ),
    ).not.toThrow();
  });
});

describe('closestFlag (Levenshtein-bounded suggester)', () => {
  it('returns the closest candidate within edit distance 2', () => {
    const known = new Set(['task-number', 'status', 'limit']);
    expect(closestFlag('task-numbers', known)).toBe('task-number');
    expect(closestFlag('limt', known)).toBe('limit');
  });

  it('returns null when nothing is within distance 2', () => {
    const known = new Set(['task-number', 'status']);
    expect(closestFlag('verbose', known)).toBeNull();
  });

  it('prefers the smaller-distance candidate on ties', () => {
    const known = new Set(['attachment', 'attachment-id']);
    // `attachmen` is distance 1 from `attachment`, distance 4 from
    // `attachment-id` — should pick the closer.
    expect(closestFlag('attachmen', known)).toBe('attachment');
  });
});

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns the longer length when one side is empty', () => {
    expect(levenshtein('', 'abcd')).toBe(4);
    expect(levenshtein('abcd', '')).toBe(4);
  });

  it('counts a single insertion / deletion / substitution as 1', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
    expect(levenshtein('cats', 'cat')).toBe(1);
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('handles the canonical kitten→sitting example', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });
});
