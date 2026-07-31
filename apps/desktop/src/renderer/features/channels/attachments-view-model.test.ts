import { describe, expect, it } from 'vitest';
import type {
  AgentDto,
  AttachmentDto,
  AttachmentListItem,
  AttachmentListItemSource,
  UserDto,
} from '@silverhand/shared';
import { decodeMessageSeq } from '@silverhand/shared';
import {
  groupAttachmentsByDay,
  resolveAttachmentSender,
  resolveSenderIdentity,
} from './attachments-view-model';

// A fixed local time: 2026-07-13 15:00 in the runner's TZ. All day math in
// the SUT is TZ-relative, so pinning the base timestamp + always deriving
// offsets from it keeps the test deterministic across CI machines.
const NOW = new Date(2026, 6, 13, 15, 0, 0).getTime();

function source(
  overrides: Partial<AttachmentListItemSource> = {},
): AttachmentListItemSource {
  return {
    message_id: 'm1',
    conversation_id: 'c1',
    thread_root_id: null,
    message_seq: decodeMessageSeq(1),
    from_kind: 'user',
    from_user_id: 'u1',
    from_agent_id: null,
    appeared_at: NOW,
    ...overrides,
  };
}

function attachment(overrides: Partial<AttachmentDto> = {}): AttachmentDto {
  return {
    id: 'att_1',
    channel_id: 'c1',
    source_conversation_id: 'c1',
    filename: 'file.bin',
    size: 42,
    content_type: 'application/octet-stream',
    storage: 'local',
    content_revision: 1,
    created_by_kind: 'user',
    created_by_id: 'u1',
    created_at: NOW,
    ...overrides,
  };
}

function item(
  attachmentOverrides: Partial<AttachmentDto> = {},
  sourceOverrides: Partial<AttachmentListItemSource> = {},
): AttachmentListItem {
  return {
    attachment: attachment(attachmentOverrides),
    source: source(sourceOverrides),
  };
}

const AGENT_ONE = {
  id: 'a1',
  name: 'Alice',
  display_name: '  Alice the Engineer  ',
} as unknown as AgentDto;

const USER_ONE = {
  id: 'u1',
  name: 'shiki',
  display_name: 'Shiki the Human',
} as unknown as UserDto;

describe('resolveAttachmentSender', () => {
  it('prefers a trimmed agent display_name over agent.name', () => {
    const agentsById = new Map([[AGENT_ONE.id, AGENT_ONE]]);
    const humansById = new Map<string, UserDto>();
    const src = source({ from_kind: 'agent', from_agent_id: 'a1', from_user_id: null });

    const result = resolveAttachmentSender(src, { agentsById, humansById });

    expect(result.label).toBe('Alice the Engineer');
    expect(result.kind).toBe('agent');
    expect(result.agentId).toBe('a1');
    expect(result.userId).toBeNull();
  });

  it('falls back to agent.name when display_name is empty after trim', () => {
    const nameOnly: AgentDto = { ...AGENT_ONE, display_name: '   ' };
    const agentsById = new Map([[nameOnly.id, nameOnly]]);
    const humansById = new Map<string, UserDto>();
    const src = source({ from_kind: 'agent', from_agent_id: 'a1', from_user_id: null });

    const result = resolveAttachmentSender(src, { agentsById, humansById });

    expect(result.label).toBe('Alice');
  });

  it('falls back to human display_name → name, prefers trimmed display_name', () => {
    const agentsById = new Map<string, AgentDto>();
    const humansById = new Map([[USER_ONE.id, USER_ONE]]);
    const src = source({ from_kind: 'user', from_user_id: 'u1' });

    const result = resolveAttachmentSender(src, { agentsById, humansById });

    expect(result.label).toBe('Shiki the Human');
    expect(result.kind).toBe('user');
    expect(result.userId).toBe('u1');
    expect(result.agentId).toBeNull();
  });

  it('returns the raw id (never a generic placeholder) when the sender is missing from the roster', () => {
    const agentsById = new Map<string, AgentDto>();
    const humansById = new Map<string, UserDto>();

    const gone = resolveAttachmentSender(
      source({ from_kind: 'agent', from_agent_id: 'a_deleted', from_user_id: null }),
      { agentsById, humansById },
    );
    expect(gone.label).toBe('a_deleted');

    const goneHuman = resolveAttachmentSender(
      source({ from_kind: 'user', from_user_id: 'u_deleted' }),
      { agentsById, humansById },
    );
    expect(goneHuman.label).toBe('u_deleted');
  });

  it('returns label:null for a system-authored source (no identity axis)', () => {
    const agentsById = new Map<string, AgentDto>();
    const humansById = new Map<string, UserDto>();
    const src = source({ from_kind: 'system', from_user_id: null, from_agent_id: null });

    const result = resolveAttachmentSender(src, { agentsById, humansById });

    expect(result.label).toBeNull();
    expect(result.kind).toBe('system');
    expect(result.agentId).toBeNull();
    expect(result.userId).toBeNull();
  });
});

// The sender filter dropdown resolves a FACET (a discriminated-union actor
// carrying only from_kind + the one live id) through the SAME core the rows
// use, so an option reads identically to the row it filters.
describe('resolveSenderIdentity on a facet-shaped actor', () => {
  it('resolves an agent facet via the member map', () => {
    const r = resolveSenderIdentity(
      { from_kind: 'agent', from_user_id: null, from_agent_id: 'a1' },
      { agentsById: new Map([[AGENT_ONE.id, AGENT_ONE]]), humansById: new Map() },
    );
    expect(r.label).toBe('Alice the Engineer');
    expect(r.kind).toBe('agent');
    expect(r.agentId).toBe('a1');
  });

  it('resolves a user facet via the member map', () => {
    const r = resolveSenderIdentity(
      { from_kind: 'user', from_user_id: 'u1', from_agent_id: null },
      { agentsById: new Map(), humansById: new Map([[USER_ONE.id, USER_ONE]]) },
    );
    expect(r.label).toBe('Shiki the Human');
    expect(r.userId).toBe('u1');
  });

  it('a roster-removed facet actor falls back to its raw id, not a placeholder', () => {
    const r = resolveSenderIdentity(
      { from_kind: 'agent', from_user_id: null, from_agent_id: 'a_gone' },
      { agentsById: new Map(), humansById: new Map() },
    );
    expect(r.label).toBe('a_gone');
  });

  it('system facet → label:null', () => {
    const r = resolveSenderIdentity(
      { from_kind: 'system', from_user_id: null, from_agent_id: null },
      { agentsById: new Map(), humansById: new Map() },
    );
    expect(r.label).toBeNull();
    expect(r.kind).toBe('system');
  });
});

describe('groupAttachmentsByDay', () => {
  it('groups Today / Yesterday and preserves input order per group', () => {
    const yesterday = NOW - 24 * 60 * 60 * 1000;
    const items = [
      item({ id: 'a1' }, { appeared_at: NOW }),
      item({ id: 'a2' }, { appeared_at: NOW - 60 * 1000 }),
      item({ id: 'a3' }, { appeared_at: yesterday }),
    ];

    const groups = groupAttachmentsByDay(items, { now: NOW, locale: 'en-US' });

    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]!.items.map(i => i.attachment.id)).toEqual(['a1', 'a2']);
    expect(groups[1]!.items.map(i => i.attachment.id)).toEqual(['a3']);
  });

  it('labels older days with a localized date, not Today/Yesterday', () => {
    const older = NOW - 10 * 24 * 60 * 60 * 1000;
    const groups = groupAttachmentsByDay(
      [item({ id: 'x' }, { appeared_at: older })],
      { now: NOW, locale: 'en-US' },
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).not.toBe('Today');
    expect(groups[0]!.label).not.toBe('Yesterday');
    // Format is stable enough to assert both a comma-separated locale string
    // and the presence of the numeric year — either shape is acceptable.
    expect(groups[0]!.label).toMatch(/2026/);
  });

  it('is empty for empty input', () => {
    expect(groupAttachmentsByDay([], { now: NOW })).toEqual([]);
  });

  it('splits at the local midnight boundary — a same-hour cross-midnight pair opens two groups', () => {
    // Two items only 2 minutes apart, but crossing local midnight: they must
    // land in different day groups.
    const justBeforeMidnight = new Date(2026, 6, 13, 23, 59, 30).getTime();
    const justAfterMidnight = new Date(2026, 6, 14, 0, 0, 30).getTime();
    // "Now" pinned to just after the crossing so 07-14 becomes Today,
    // 07-13 becomes Yesterday.
    const now = justAfterMidnight + 60 * 1000;

    const groups = groupAttachmentsByDay(
      [
        item({ id: 'after' }, { appeared_at: justAfterMidnight }),
        item({ id: 'before' }, { appeared_at: justBeforeMidnight }),
      ],
      { now, locale: 'en-US' },
    );

    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]!.items.map(i => i.attachment.id)).toEqual(['after']);
    expect(groups[1]!.items.map(i => i.attachment.id)).toEqual(['before']);
  });
});
