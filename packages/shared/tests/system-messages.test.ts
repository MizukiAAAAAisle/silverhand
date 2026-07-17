import { describe, expect, it } from 'vitest';
import {
  SYSTEM_SUBTYPES,
  TASK_MUTATION_KINDS,
  TASK_SUBTYPES,
  readChannelContextMetadata,
  readChildContextMetadata,
  readRenameMetadata,
  readScheduleFireMetadata,
  readSessionClearedMetadata,
  readSubtype,
  readTaskSystemMetadata,
  readTaskSystemMetadataPartial,
  readThreadAnchorMetadata,
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

});

describe('systemSubtype helper', () => {
  it('returns the input unchanged (identity)', () => {
    expect(systemSubtype('mention_cc')).toBe('mention_cc');
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

  it('returns unknown for null/undefined/unfamiliar strings and deleted retired subtypes', () => {
    expect(resolveSubtype(null)).toEqual({ kind: 'unknown' });
    expect(resolveSubtype(undefined)).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('')).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('not_a_real_subtype')).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('join')).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('session_context')).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('child_summary')).toEqual({ kind: 'unknown' });
    expect(resolveSubtype('thread_summary')).toEqual({ kind: 'unknown' });
  });
});

describe('readSubtype', () => {
  it('extracts and resolves metadata.subtype', () => {
    expect(readSubtype({ subtype: 'onboarding' })).toEqual({
      kind: 'current',
      subtype: 'onboarding',
    });
    expect(readSubtype({ subtype: 'join' })).toEqual({ kind: 'unknown' });
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
    task_id: 'task-1',
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

});

interface ParserRejectionCase {
  parser: string;
  read: (metadata: Record<string, unknown> | null | undefined) => unknown | null;
  invalid?: Array<{
    name: string;
    metadata: Record<string, unknown> | null | undefined;
  }>;
  nullish?: boolean;
}

const parserRejectionCases: ParserRejectionCase[] = [
  {
    parser: 'readTaskSystemMetadata',
    read: readTaskSystemMetadata,
    nullish: true,
  },
  {
    parser: 'readTaskSystemMetadataPartial',
    read: readTaskSystemMetadataPartial,
    nullish: true,
  },
  {
    parser: 'readSessionClearedMetadata',
    read: readSessionClearedMetadata,
    invalid: [
      {
        name: 'rows missing required fields',
        metadata: {
          subtype: 'session_cleared',
          agent_name: 'Alice',
        },
      },
      {
        name: 'rows with wrong subtype literal',
        metadata: {
          subtype: 'mention_cc',
          agent_id: 'a',
          agent_name: 'A',
          actor_user_id: null,
          previous_cli_session_id_prefix: null,
          was_running: false,
        },
      },
    ],
    nullish: true,
  },
  {
    parser: 'readScheduleFireMetadata',
    read: readScheduleFireMetadata,
    invalid: [
      {
        name: 'bad spec_kind',
        metadata: {
          subtype: 'schedule_fire',
          schedule_id: 's-1',
          spec_kind: 'weekly',
          actual_fire_at: 1,
          planned_fire_at: null,
          missed_count: 0,
          next_fire_at: null,
        },
      },
      {
        name: 'rows missing required numeric fields',
        metadata: {
          subtype: 'schedule_fire',
          schedule_id: 's-1',
          spec_kind: 'interval',
          actual_fire_at: 1,
          planned_fire_at: null,
          missed_count: 0,
          // next_fire_at missing
        },
      },
    ],
    nullish: true,
  },
  {
    parser: 'readThreadAnchorMetadata',
    read: readThreadAnchorMetadata,
    invalid: [
      {
        name: 'unsupported quoted_from_kind values',
        metadata: {
          subtype: 'thread_anchor',
          quoted_message_id: 'msg-1',
          quoted_conversation_id: 'conv-1',
          quoted_channel_name: 'version3',
          quoted_content: 'Quoted body text',
          quoted_from_kind: 'bot',
          quoted_from_agent_id: null,
          quoted_from_user_id: 'local',
          quoted_agent_name: null,
          quoted_created_at: 1_700_000_000_000,
        },
      },
      {
        name: 'rows missing required fields',
        metadata: {
          subtype: 'thread_anchor',
          quoted_message_id: 'msg-1',
          quoted_conversation_id: 'conv-1',
          quoted_channel_name: 'version3',
          quoted_from_kind: 'user',
          quoted_from_agent_id: null,
          quoted_from_user_id: 'local',
          quoted_agent_name: null,
          quoted_created_at: 1_700_000_000_000,
        },
      },
    ],
    nullish: true,
  },
  {
    parser: 'readChildContextMetadata',
    read: readChildContextMetadata,
    invalid: [
      {
        name: 'rows missing summary',
        metadata: {
          subtype: 'child_context',
          parent_conversation_id: 'conv-parent',
          parent_title: 'feature/cli design',
        },
      },
      {
        name: 'rows with wrong subtype',
        metadata: {
          subtype: 'thread_anchor',
          parent_conversation_id: 'conv-parent',
          parent_title: 'feature/cli design',
          summary: 'PR-1 design discussed in 5 rounds...',
        },
      },
    ],
    nullish: true,
  },
  {
    parser: 'readChannelContextMetadata',
    read: readChannelContextMetadata,
    invalid: [
      {
        name: 'rows missing required source_conversation_id',
        metadata: {
          subtype: 'channel_context',
          created_by_agent_id: 'a-cindy',
        },
      },
    ],
    nullish: true,
  },
  {
    parser: 'readRenameMetadata',
    read: readRenameMetadata,
    invalid: [
      {
        name: 'rows missing old_name',
        metadata: { subtype: 'rename', new_name: 'b' },
      },
      {
        name: 'rows missing new_name',
        metadata: { subtype: 'rename', old_name: 'a' },
      },
      {
        name: 'rows with wrong subtype literal',
        metadata: {
          subtype: 'mention_cc',
          old_name: 'a',
          new_name: 'b',
        },
      },
    ],
    nullish: true,
  },
];

const invalidParserCases = parserRejectionCases.flatMap(testCase =>
  (testCase.invalid ?? []).map(invalid => ({
    parser: testCase.parser,
    read: testCase.read,
    ...invalid,
  })),
);

describe('metadata parser rejection matrix', () => {
  it.each(invalidParserCases)('$parser rejects $name', ({ read, metadata }) => {
    expect(read(metadata)).toBeNull();
  });

  it.each(parserRejectionCases.filter(testCase => testCase.nullish))(
    '$parser returns null for null/undefined',
    ({ read }) => {
      expect(read(null)).toBeNull();
      expect(read(undefined)).toBeNull();
    },
  );
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

});

describe('readScheduleFireMetadata', () => {
  it('parses full schedule_fire metadata', () => {
    const m = readScheduleFireMetadata({
      subtype: 'schedule_fire',
      schedule_id: 's-1',
      spec_kind: 'cron',
      spec_summary: 'cron */5 9-18 * * 1-5 (Asia/Shanghai)',
      body: 'review #task:294 status',
      actual_fire_at: 1_700_000_000_000,
      planned_fire_at: 1_700_000_000_000,
      missed_count: 0,
      next_fire_at: 1_700_000_300_000,
    });
    expect(m).not.toBeNull();
    expect(m!.spec_kind).toBe('cron');
    expect(m!.spec_summary).toBe('cron */5 9-18 * * 1-5 (Asia/Shanghai)');
    expect(m!.body).toBe('review #task:294 status');
  });

  it('accepts metadata without spec_summary or body (legacy rows)', () => {
    const m = readScheduleFireMetadata({
      subtype: 'schedule_fire',
      schedule_id: 's-1',
      spec_kind: 'once',
      actual_fire_at: 1_700_000_000_000,
      planned_fire_at: null,
      missed_count: 0,
      next_fire_at: null,
    });
    expect(m).not.toBeNull();
    expect(m!.spec_summary).toBeUndefined();
    expect(m!.body).toBeUndefined();
  });

});

describe('readThreadAnchorMetadata', () => {
  const valid = {
    subtype: 'thread_anchor',
    quoted_message_id: 'msg-1',
    quoted_conversation_id: 'conv-1',
    quoted_channel_name: 'version3',
    quoted_content: 'Quoted body text',
    quoted_from_kind: 'user' as const,
    quoted_from_agent_id: null,
    quoted_from_user_id: 'local',
    quoted_agent_name: null,
    quoted_created_at: 1_700_000_000_000,
  };

  it('parses full thread_anchor metadata', () => {
    const m = readThreadAnchorMetadata(valid);
    expect(m).not.toBeNull();
    expect(m!.quoted_channel_name).toBe('version3');
    expect(m!.quoted_from_kind).toBe('user');
  });

  it('accepts agent-authored quotes (agent id + name set, user id null)', () => {
    const m = readThreadAnchorMetadata({
      ...valid,
      quoted_from_kind: 'agent',
      quoted_from_agent_id: 'a-alice',
      quoted_from_user_id: null,
      quoted_agent_name: 'Alice',
    });
    expect(m).not.toBeNull();
    expect(m!.quoted_from_kind).toBe('agent');
    expect(m!.quoted_agent_name).toBe('Alice');
  });

});

describe('readChildContextMetadata', () => {
  const valid = {
    subtype: 'child_context',
    parent_conversation_id: 'conv-parent',
    parent_title: 'feature/cli design',
    summary: 'PR-1 design discussed in 5 rounds...',
  };

  it('parses full child_context metadata', () => {
    const m = readChildContextMetadata(valid);
    expect(m).not.toBeNull();
    expect(m!.parent_title).toBe('feature/cli design');
  });

});

describe('readChannelContextMetadata', () => {
  const valid = {
    subtype: 'channel_context',
    source_conversation_id: 'conv-source',
    source_conversation_title: 'version3',
    created_by_agent_id: 'a-cindy',
    created_by_agent_name: 'Cindy',
  };

  it('parses full channel_context metadata', () => {
    const m = readChannelContextMetadata(valid);
    expect(m).not.toBeNull();
    expect(m!.source_conversation_title).toBe('version3');
    expect(m!.created_by_agent_name).toBe('Cindy');
  });

  it('accepts legacy rows missing source_conversation_title / agent name', () => {
    const m = readChannelContextMetadata({
      subtype: 'channel_context',
      source_conversation_id: 'conv-source',
      created_by_agent_id: 'a-cindy',
    });
    expect(m).not.toBeNull();
    expect(m!.source_conversation_title).toBeUndefined();
    expect(m!.created_by_agent_name).toBeUndefined();
  });

});

describe('readRenameMetadata', () => {
  it('parses full rename metadata', () => {
    const m = readRenameMetadata({
      subtype: 'rename',
      old_name: 'version2',
      new_name: 'version3',
    });
    expect(m).not.toBeNull();
    expect(m!.old_name).toBe('version2');
    expect(m!.new_name).toBe('version3');
  });

});
