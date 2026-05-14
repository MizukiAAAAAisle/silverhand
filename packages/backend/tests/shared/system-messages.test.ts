import { describe, expect, it } from 'vitest';
import {
  LEGACY_SUBTYPES,
  SYSTEM_SUBTYPES,
  TASK_MUTATION_KINDS,
  TASK_SUBTYPES,
  readSessionClearedMetadata,
  readSubtype,
  readTaskSystemMetadata,
  readTaskSystemMetadataPartial,
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

describe('readTaskSystemMetadata + readTaskSystemMetadataPartial', () => {
  const validFull = {
    subtype: 'task_create',
    task_number: 1,
    task_status: 'todo',
    task_message_id: 'msg-1',
    task_title: 'wire it up',
    task_assignee: null,
    actor: { kind: 'agent' as const, id: 'a-1', name: 'Alice' },
  };

  it('full parse passes for enriched metadata', () => {
    const m = readTaskSystemMetadata(validFull);
    expect(m).not.toBeNull();
    expect(m!.task_number).toBe(1);
    expect(m!.actor.kind).toBe('agent');
  });

  it('full parse fails when actor is missing', () => {
    const partial = { ...validFull, actor: undefined };
    expect(readTaskSystemMetadata(partial)).toBeNull();
  });

  it('partial parse passes on legacy {subtype, task_number, task_status} triple', () => {
    const legacy = {
      subtype: 'task_claim',
      task_number: 9,
      task_status: 'in_progress',
    };
    const p = readTaskSystemMetadataPartial(legacy);
    expect(p).toEqual(legacy);
    expect(readTaskSystemMetadata(legacy)).toBeNull();
  });

  it('partial parse fails when task_status is missing', () => {
    expect(
      readTaskSystemMetadataPartial({ subtype: 'task_create', task_number: 1 }),
    ).toBeNull();
  });

  it('partial parse rejects non-task subtypes', () => {
    expect(
      readTaskSystemMetadataPartial({
        subtype: 'mention_cc',
        task_number: 1,
        task_status: 'todo',
      }),
    ).toBeNull();
  });

  it('both parsers return null for null/undefined', () => {
    expect(readTaskSystemMetadata(null)).toBeNull();
    expect(readTaskSystemMetadata(undefined)).toBeNull();
    expect(readTaskSystemMetadataPartial(null)).toBeNull();
    expect(readTaskSystemMetadataPartial(undefined)).toBeNull();
  });
});

describe('readSessionClearedMetadata', () => {
  it('parses full session_cleared metadata', () => {
    const m = readSessionClearedMetadata({
      subtype: 'session_cleared',
      agent_id: 'a-alice',
      agent_name: 'Alice',
      actor_user_id: 'local',
      previous_cli_session_id_prefix: 'fbe21c8a',
      was_running: true,
    });
    expect(m).not.toBeNull();
    expect(m!.agent_name).toBe('Alice');
    expect(m!.was_running).toBe(true);
    expect(m!.previous_cli_session_id_prefix).toBe('fbe21c8a');
  });

  it('accepts null prev session prefix and null actor', () => {
    const m = readSessionClearedMetadata({
      subtype: 'session_cleared',
      agent_id: 'a-bob',
      agent_name: 'Bob',
      actor_user_id: null,
      previous_cli_session_id_prefix: null,
      was_running: false,
    });
    expect(m).not.toBeNull();
    expect(m!.actor_user_id).toBeNull();
    expect(m!.previous_cli_session_id_prefix).toBeNull();
  });

  it('rejects rows missing required fields', () => {
    expect(
      readSessionClearedMetadata({
        subtype: 'session_cleared',
        agent_name: 'Alice',
      }),
    ).toBeNull();
  });

  it('rejects rows with wrong subtype literal', () => {
    expect(
      readSessionClearedMetadata({
        subtype: 'mention_cc',
        agent_id: 'a',
        agent_name: 'A',
        actor_user_id: null,
        previous_cli_session_id_prefix: null,
        was_running: false,
      }),
    ).toBeNull();
  });

  it('returns null for null/undefined metadata', () => {
    expect(readSessionClearedMetadata(null)).toBeNull();
    expect(readSessionClearedMetadata(undefined)).toBeNull();
  });
});
