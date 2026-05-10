import { describe, expect, it } from 'vitest';
import {
  flagBool,
  flagNumber,
  flagNumberArray,
  flagString,
  flagStringArray,
  parseArgs,
} from '../src/parse.js';

describe('parseArgs', () => {
  it('separates positional from flags', () => {
    const r = parseArgs(['send', '--content', 'hi', 'extra']);
    expect(r.positional).toEqual(['send', 'extra']);
    expect(flagString(r, 'content')).toBe('hi');
  });

  it('supports --flag=value form', () => {
    const r = parseArgs(['--name=alice', '--age=30']);
    expect(flagString(r, 'name')).toBe('alice');
    expect(flagNumber(r, 'age')).toBe(30);
  });

  it('treats bare --flag as boolean true and --no-flag as false', () => {
    const r = parseArgs(['--verbose', '--no-color']);
    expect(flagBool(r, 'verbose')).toBe(true);
    expect(flagBool(r, 'color')).toBe(false);
  });

  it('does not consume the next token for a declared boolean flag', () => {
    const r = parseArgs(['--posted-to-parent', '--summary', 'done'], {
      booleanFlags: ['posted-to-parent'],
    });
    expect(flagBool(r, 'posted-to-parent')).toBe(true);
    expect(flagString(r, 'summary')).toBe('done');
  });

  it('collects repeated flags into arrays', () => {
    const r = parseArgs(['--id', 'a', '--id', 'b', '--id', 'c']);
    expect(flagStringArray(r, 'id')).toEqual(['a', 'b', 'c']);
  });

  it('parses numeric arrays', () => {
    const r = parseArgs(['--n', '1', '--n', '2', '--n', '3']);
    expect(flagNumberArray(r, 'n')).toEqual([1, 2, 3]);
  });

  it('throws when --flag-number gets a non-numeric value', () => {
    const r = parseArgs(['--n', 'banana']);
    expect(() => flagNumber(r, 'n')).toThrow(/expects a number/);
  });

  it('returns undefined for missing flags', () => {
    const r = parseArgs(['--other', 'value']);
    expect(flagString(r, 'missing')).toBeUndefined();
    expect(flagBool(r, 'missing')).toBeUndefined();
    expect(flagNumber(r, 'missing')).toBeUndefined();
  });

  it('passes everything after `--` into rest', () => {
    const r = parseArgs(['cmd', '--', '--not-a-flag', 'foo']);
    expect(r.rest).toEqual(['--not-a-flag', 'foo']);
    expect(r.flags).toEqual({});
  });
});
