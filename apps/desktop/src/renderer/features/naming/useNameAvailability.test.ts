import { describe, expect, it } from 'vitest';
import { nameAvailabilityView, nameFormatIssue, nameFormatMessage } from './useNameAvailability';

const base = {
  kind: 'agent',
  touched: true,
  name: 'alice',
  formatIssue: null,
  inSync: true,
  data: null,
  isError: false,
  isFetching: false,
} as const;

describe('nameFormatIssue', () => {
  it('accepts a well-formed participant name', () => {
    expect(nameFormatIssue('agent', 'my-agent_1')).toBeNull();
  });

  it('requires agent names to start with a letter without constraining workspaces', () => {
    expect(nameFormatIssue('agent', '2b')).toBe('charset');
    expect(nameFormatIssue('workspace', '2b')).toBeNull();
  });

  it('reports charset for illegal characters in either current schema', () => {
    expect(nameFormatIssue('agent', 'bad name!')).toBe('charset');
    // A workspace name is a label (#task:1827): Chinese and internal spaces are
    // legal, so its reachable charset rejection is an invisible code point —
    // here a zero-width space, which the field renders as nothing.
    expect(nameFormatIssue('workspace', '空格 name')).toBeNull();
    expect(nameFormatIssue('workspace', '空格\u200Bname')).toBe('charset');
  });

  it('reports length before charset for an over-long name', () => {
    expect(nameFormatIssue('agent', 'a'.repeat(65))).toBe('length');
    // 65 astral characters are 130 UTF-16 units; the workspace limit counts
    // code points, so this must read as length — not charset.
    expect(nameFormatIssue('workspace', '𠮷'.repeat(65))).toBe('length');
    expect(nameFormatIssue('workspace', '𠮷'.repeat(64))).toBeNull();
  });

  it('says nothing for an empty field (idle, not invalid)', () => {
    expect(nameFormatIssue('agent', '')).toBeNull();
  });
});

// The rename seam (#task:1827). `WorkspaceSettingsDialog.handleRename` consumes
// `nameFormatMessage` — these three assertions are what stop a second local
// regex from coming back and refusing a name create already accepted. No DOM
// test: the dialog contributes only the empty-field message and the mutation.
describe('nameFormatMessage — workspace rename', () => {
  it('accepts a Chinese label with an internal space', () => {
    expect(nameFormatMessage('workspace', '设计 评审')).toBeNull();
  });

  it('rejects invisible and control characters, naming the cause', () => {
    expect(nameFormatMessage('workspace', '设计\u200B评审')).toBe(
      'No control or invisible characters',
    );
    expect(nameFormatMessage('workspace', 'eng\u0007')).toBe(
      'No control or invisible characters',
    );
  });

  it('reports 65 astral characters as length, not charset', () => {
    expect(nameFormatMessage('workspace', '𠮷'.repeat(65))).toBe(
      'Up to 64 characters',
    );
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
