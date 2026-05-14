import { describe, expect, it } from 'vitest';
import {
  LEGACY_SUBTYPES,
  SYSTEM_SUBTYPES,
  TASK_MUTATION_KINDS,
  TASK_SUBTYPES,
  readSubtype,
  resolveSubtype,
  systemSubtype,
  taskSystemSubtype,
} from '@silverhand/shared';

describe('system-messages constants', () => {
  it('SYSTEM_SUBTYPES is unique and non-empty', () => {
    const set = new Set(SYSTEM_SUBTYPES);
    expect(set.size).toBe(SYSTEM_SUBTYPES.length);
    expect(SYSTEM_SUBTYPES.length).toBeGreaterThan(0);
  });

  it('TASK_SUBTYPES is exactly task_${TaskMutationKind} for every kind', () => {
    const expected = TASK_MUTATION_KINDS.map((k) => `task_${k}` as const);
    expect([...TASK_SUBTYPES].sort()).toEqual([...expected].sort());
  });

  it('every TASK_SUBTYPES entry appears in SYSTEM_SUBTYPES', () => {
    for (const s of TASK_SUBTYPES) {
      expect(SYSTEM_SUBTYPES).toContain(s);
    }
  });

  it('LEGACY_SUBTYPES does not overlap with SYSTEM_SUBTYPES', () => {
    const live = new Set<string>(SYSTEM_SUBTYPES);
    for (const s of LEGACY_SUBTYPES) {
      expect(live.has(s)).toBe(false);
    }
  });
});

describe('systemSubtype helper', () => {
  it('returns the input unchanged (identity)', () => {
    expect(systemSubtype('mention_cc')).toBe('mention_cc');
    expect(systemSubtype('thread_summary')).toBe('thread_summary');
    expect(systemSubtype('task_create')).toBe('task_create');
  });
});

describe('taskSystemSubtype helper', () => {
  it('maps every TaskMutationKind to a member of TASK_SUBTYPES', () => {
    for (const kind of TASK_MUTATION_KINDS) {
      const out = taskSystemSubtype(kind);
      expect(TASK_SUBTYPES).toContain(out);
      expect(out).toBe(`task_${kind}`);
    }
  });

  it('produces results that all live in SYSTEM_SUBTYPES', () => {
    for (const kind of TASK_MUTATION_KINDS) {
      expect(SYSTEM_SUBTYPES).toContain(taskSystemSubtype(kind));
    }
  });
});

describe('resolveSubtype', () => {
  it('returns current for live subtypes', () => {
    expect(resolveSubtype('mention_cc')).toEqual({
      kind: 'current',
      subtype: 'mention_cc',
    });
    expect(resolveSubtype('task_status')).toEqual({
      kind: 'current',
      subtype: 'task_status',
    });
  });

  it('returns legacy for retired subtypes still in DB', () => {
    expect(resolveSubtype('join')).toEqual({
      kind: 'legacy',
      subtype: 'join',
    });
    expect(resolveSubtype('session_context')).toEqual({
      kind: 'legacy',
      subtype: 'session_context',
    });
    expect(resolveSubtype('child_summary')).toEqual({
      kind: 'legacy',
      subtype: 'child_summary',
    });
  });

  it('returns unknown for null/undefined/unfamiliar strings', () => {
    expect(resolveSubtype(null)).toEqual({ kind: 'unknown' });
    expect(resolveSubtype(undefined)).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('')).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('not_a_real_subtype')).toEqual({ kind: 'unknown' });
  });
});

describe('readSubtype', () => {
  it('extracts and resolves metadata.subtype', () => {
    expect(readSubtype({ subtype: 'onboarding' })).toEqual({
      kind: 'current',
      subtype: 'onboarding',
    });
    expect(readSubtype({ subtype: 'join' })).toEqual({
      kind: 'legacy',
      subtype: 'join',
    });
    expect(readSubtype({ subtype: 'mystery' })).toEqual({ kind: 'unknown' });
  });

  it('returns unknown for null/undefined metadata', () => {
    expect(readSubtype(null)).toEqual({ kind: 'unknown' });
    expect(readSubtype(undefined)).toEqual({ kind: 'unknown' });
  });

  it('returns unknown when subtype is missing or non-string', () => {
    expect(readSubtype({})).toEqual({ kind: 'unknown' });
    expect(readSubtype({ subtype: 42 as unknown as string })).toEqual({
      kind: 'unknown',
    });
    expect(readSubtype({ other: 'mention_cc' })).toEqual({ kind: 'unknown' });
  });
});
