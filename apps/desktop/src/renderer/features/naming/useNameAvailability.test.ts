import { describe, expect, it } from 'vitest';
import { nameAvailabilityView, nameFormatIssue } from './useNameAvailability';

const base = {
  touched: true,
  name: 'alice',
  formatIssue: null,
  inSync: true,
  data: null,
  isError: false,
  isFetching: false,
} as const;

describe('nameFormatIssue', () => {
  it('accepts a well-formed name', () => {
    expect(nameFormatIssue('my-agent_1')).toBeNull();
  });

  it('reports charset for illegal characters', () => {
    expect(nameFormatIssue('bad name!')).toBe('charset');
    expect(nameFormatIssue('空格 name')).toBe('charset');
  });

  it('reports length before charset for an over-long name', () => {
    expect(nameFormatIssue('a'.repeat(65))).toBe('length');
  });

  it('says nothing for an empty field (idle, not invalid)', () => {
    expect(nameFormatIssue('')).toBeNull();
  });
});

describe('nameAvailabilityView', () => {
  it('is idle + non-blocking when untouched', () => {
    expect(nameAvailabilityView({ ...base, touched: false })).toEqual({
      status: 'idle',
      message: null,
      blocking: false,
    });
  });

  it('is idle when the field is empty even if touched', () => {
    expect(nameAvailabilityView({ ...base, name: '' })).toMatchObject({
      status: 'idle',
      blocking: false,
    });
  });

  it('blocks with a format message on an invalid name', () => {
    const view = nameAvailabilityView({ ...base, formatIssue: 'charset' });
    expect(view.status).toBe('invalid');
    expect(view.blocking).toBe(true);
    // A blocking format issue surfaces some guidance message (copy is visual).
    expect(view.message).not.toBeNull();
  });

  it('shows checking (non-blocking) while the debounce lags input', () => {
    expect(nameAvailabilityView({ ...base, inSync: false })).toMatchObject({
      status: 'checking',
      blocking: false,
    });
  });

  it('shows checking (non-blocking) while the probe is in flight', () => {
    expect(nameAvailabilityView({ ...base, isFetching: true })).toMatchObject({
      status: 'checking',
      blocking: false,
    });
  });

  it('is available + non-blocking when the probe says so', () => {
    expect(
      nameAvailabilityView({ ...base, data: { available: true, reason: 'available' } }),
    ).toMatchObject({ status: 'available', blocking: false });
  });

  it('keeps a settled verdict during a background refetch (freshness ≠ fact, #1376)', () => {
    // isFetching true + data present = window-focus / staleTime refetch. The
    // settled fact must NOT blink back to "checking".
    expect(
      nameAvailabilityView({
        ...base,
        isFetching: true,
        data: { available: true, reason: 'available' },
      }),
    ).toMatchObject({ status: 'available', blocking: false });
    expect(
      nameAvailabilityView({
        ...base,
        isFetching: true,
        data: { available: false, reason: 'taken' },
      }),
    ).toMatchObject({ status: 'taken', blocking: true });
  });

  it('blocks as taken when the probe reports a collision', () => {
    const view = nameAvailabilityView({
      ...base,
      data: { available: false, reason: 'taken' },
    });
    expect(view.status).toBe('taken');
    expect(view.blocking).toBe(true);
    // A collision surfaces a blocking message (copy is visual).
    expect(view.message).not.toBeNull();
  });

  it('stays silent + non-blocking on a probe network error (create backstops)', () => {
    expect(nameAvailabilityView({ ...base, isError: true })).toEqual({
      status: 'error',
      message: null,
      blocking: false,
    });
  });

  it('format issue wins over a stale available probe result', () => {
    // e.g. name was valid+free, user appends a bad char before the probe settles
    const view = nameAvailabilityView({
      ...base,
      formatIssue: 'charset',
      data: { available: true, reason: 'available' },
    });
    expect(view.status).toBe('invalid');
    expect(view.blocking).toBe(true);
  });
});
