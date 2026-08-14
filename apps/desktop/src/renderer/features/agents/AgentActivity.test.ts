import { describe, expect, it } from 'vitest';
import type {
  AgentRuntimeParticipation,
  AgentRuntimeSeatDto,
  ConversationActivityEvent,
  ConversationAgentStatus,
  ConversationKind,
} from '@silverhand/shared';
import { partitionRoster } from './AgentActivityPane';
import { mergeActivityById } from './AgentActivityTimeline';
import { coalesceActivity, presentToolCall, taskNumberFromCommand } from './activityPresentation';

function conv(
  overrides: Partial<AgentRuntimeParticipation> = {},
): AgentRuntimeParticipation {
  return {
    conversation_id: 'c-1',
    workspace_id: 'w-1',
    workspace_name: 'silverhand',
    workspace_kind: 'regular',
    conversation_kind: 'channel' as ConversationKind,
    channel_id: 'c-1',
    channel_title: 'general',
    closed_at: null,
    ...overrides,
  };
}

function seat(
  conversationId: string,
  status: ConversationAgentStatus,
): AgentRuntimeSeatDto {
  return {
    scope: { kind: 'conversation', conversation_id: conversationId },
    generation: 1,
    status,
    pid: null,
    cli_session_id: null,
    focus: { kind: 'conversation', conversation_id: conversationId },
    queue_depth: 0,
  };
}

function ev(
  id: number,
  overrides: Partial<ConversationActivityEvent> = {},
): ConversationActivityEvent {
  return {
    id,
    conversation_id: 'c-1',
    agent_id: 'a-1',
    kind: 'text',
    payload: null,
    created_at: id * 1000,
    ...overrides,
  };
}

describe('partitionRoster', () => {
  it('drops out-of-allowlist kinds (defensive against unexpected conversation kinds)', () => {
    const rows = [
      conv({ conversation_id: 'ch', conversation_kind: 'channel' }),
      conv({ conversation_id: 'dm', conversation_kind: 'dm_channel' }),
      // A kind outside the {channel,dm_channel} allowlist should never
      // reach here, but the allowlist (not a denylist) must still drop it.
      conv({
        conversation_id: 'x',
        conversation_kind: 'thread' as unknown as ConversationKind,
      }),
    ];
    const { active, recent } = partitionRoster(rows, []);
    const ids = [...active, ...recent].map(r => r.conversation_id);
    expect(ids).toEqual(['ch', 'dm']);
    expect(ids).not.toContain('x');
  });

  it('splits active (running, not closed) from recent', () => {
    const rows = [
      conv({ conversation_id: 'a' }),
      conv({ conversation_id: 's' }),
      conv({ conversation_id: 'i' }),
      conv({ conversation_id: 'cr' }),
      conv({ conversation_id: 'cl', closed_at: 123 }),
    ];
    const seats = [
      seat('a', 'active'),
      seat('s', 'starting'),
      seat('i', 'idle'),
      seat('cr', 'crashed'),
      seat('cl', 'active'),
    ];
    const { active, recent } = partitionRoster(rows, seats);
    expect(active.map(r => r.conversation_id)).toEqual(['a', 's']);
    // closed wins over status: an `active`-status but closed row is recent.
    expect(recent.map(r => r.conversation_id)).toEqual(['i', 'cr', 'cl']);
  });
});

describe('mergeActivityById', () => {
  it('sorts ascending by id and dedupes (backfill/live race)', () => {
    const existing = [ev(2), ev(3)];
    const incoming = [ev(1), ev(3)]; // id 3 already present
    const merged = mergeActivityById(existing, incoming);
    expect(merged.map(e => e.id)).toEqual([1, 2, 3]);
  });

  it('orders by id even when created_at ties', () => {
    const a = ev(10, { created_at: 5000 });
    const b = ev(11, { created_at: 5000 });
    const merged = mergeActivityById([b], [a]);
    expect(merged.map(e => e.id)).toEqual([10, 11]);
  });

  it('keeps the longer text on a same-id collision (no short-clobbers-long)', () => {
    // update-in-place backend grows a block; a reordered shorter frame must
    // not regress the already-longer one.
    const long = ev(5, { kind: 'thinking', payload: { text: 'abcdef' } });
    const short = ev(5, { kind: 'thinking', payload: { text: 'abc' } });
    expect(mergeActivityById([long], [short])[0]!.payload).toEqual({ text: 'abcdef' });
    expect(mergeActivityById([short], [long])[0]!.payload).toEqual({ text: 'abcdef' });
  });
});

describe('presentToolCall', () => {
  it('Bash → verb + command, abbreviating $HOME', () => {
    expect(presentToolCall('Bash', { command: 'ls ~/work' })).toEqual({
      verb: 'Bash',
      arg: 'ls ~/work',
      detail: null,
    });
    expect(presentToolCall('Read', { file_path: '/Users/shiki/work/home.ts' })).toEqual({
      verb: 'Read',
      arg: '~/work/home.ts',
      detail: null,
    });
  });

  it('Edit → diff detail from old/new', () => {
    const p = presentToolCall('Edit', {
      file_path: '/x/a.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(p.verb).toBe('Edit');
    expect(p.arg).toBe('/x/a.ts');
    expect(p.detail).toEqual({ kind: 'diff', removed: 'a', added: 'b' });
  });

  it('Grep → "pattern in path"', () => {
    expect(presentToolCall('Grep', { pattern: 'foo', path: '/Users/shiki/src' }).arg).toBe(
      'foo in ~/src',
    );
  });

  it('recognises a silverhand CLI call as a product action (not raw Bash), incl. shell-wrapped', () => {
    // A `task status` call is recognised as an action (NOT surfaced as raw Bash),
    // and carries id + status change as arg metadata. The arg is extracted data,
    // not copy — kept exact; the verb label face is not pinned.
    const taskStatus = presentToolCall('Bash', {
      command: 'silverhand task status --task-number 1187 --status in_review',
    });
    expect(taskStatus.verb).not.toBe('Bash');
    expect(taskStatus.arg).toBe('#1187 → in_review');
    expect(taskStatus.detail).toBeNull();
    // recognised even when wrapped in a `zsh -lc "…"` launcher (heredoc dropped)
    const wrapped = presentToolCall('Bash', {
      command: `/bin/zsh -lc "silverhand message send <<'SILVERHAND_EOF'\nhi\nSILVERHAND_EOF"`,
    });
    expect(wrapped.verb).not.toBe('Bash');
    expect(wrapped.arg).toBeNull();
    // …and even when the broadcast cap truncated the launcher mid-heredoc, so
    // the closing quote is gone (relaxed unwrap is gated on the launcher head).
    const truncated = presentToolCall('Bash', {
      command: `/bin/zsh -lc "silverhand message send <<'SILVERHAND_EOF'\n@Norman body body body...<truncated 456 chars>`,
    });
    // plain / wrapped / truncated sends all resolve to the same action.
    expect(truncated.verb).toBe(wrapped.verb);
    // a stale-resolution send is a DISTINCT action from a plain send.
    const staleSend = presentToolCall('Bash', {
      command: 'silverhand message send --stale-resolution unaffected',
    });
    expect(staleSend.verb).not.toBe('Bash');
    expect(staleSend.verb).not.toBe(wrapped.verb);
    // but a `--anyway` in a compound SUFFIX is not this send's flag → not stale
    // (args stop at the separator; #task:1945, Cindy).
    const suffixSend = presentToolCall('Bash', {
      command: 'silverhand message send && echo --anyway',
    });
    expect(suffixSend.verb).toBe(wrapped.verb);
  });

  it('task actions surface task id + status change; never fabricate an id', () => {
    const claim = presentToolCall('Bash', { command: 'silverhand task claim --task-number 9' });
    expect(claim.verb).not.toBe('Bash');
    expect(claim.arg).toBe('#9');
    expect(claim.detail).toBeNull();
    const update = presentToolCall('Bash', {
      command: 'silverhand task status --task-number 42 --status done',
    });
    expect(update.arg).toBe('#42 → done');
    // claim and status-update are distinguishable actions.
    expect(update.verb).not.toBe(claim.verb);
    // promote-and-claim by message id → no task number, so no fabricated `#…`
    const byMessage = presentToolCall('Bash', { command: 'silverhand task claim --message-id abc123' });
    expect(byMessage.verb).not.toBe('Bash');
    expect(byMessage.arg).toBeNull();
    // #task:1945 CLI migration: point verbs take the number POSITIONALLY. The
    // reader recognises the new form identically to the retired flag, since
    // activity rows are immutable historical command text (both forms coexist).
    expect(presentToolCall('Bash', { command: 'silverhand task claim 9' }).arg).toBe('#9');
    expect(
      presentToolCall('Bash', { command: 'silverhand task status 42 --status done' }).arg,
    ).toBe('#42 → done');
    // create takes a source-message, never a task-number operand → no `#…`
    const create = presentToolCall('Bash', {
      command: 'silverhand task create --source-message-id abc --claim',
    });
    expect(create.verb).not.toBe('Bash');
    expect(create.arg).toBeNull();
    // MUST NOT leak a number from a compound prefix — only the identified
    // `silverhand task …` command's own args are read, not the wider shell
    // text (#task:1945, Cindy: `sleep 5 && …` must show #9, never #5).
    expect(
      presentToolCall('Bash', { command: 'sleep 5 && silverhand task claim 9' }).arg,
    ).toBe('#9');
    // …nor from a compound SUFFIX: args stop at the next unquoted separator, so
    // a trailing `&& echo --task-number 5` can't fake `#5` on a create.
    const createSuffix = presentToolCall('Bash', {
      command: 'silverhand task create && echo --task-number 5',
    });
    expect(createSuffix.verb).not.toBe('Bash');
    expect(createSuffix.arg).toBeNull();
  });

  it('does NOT mislabel a quoted "silverhand …" argument as a real action', () => {
    // silverhand only counts at command position — a search/echo argument that
    // merely contains the string must stay Bash/Shell (no fabricated action).
    expect(presentToolCall('Bash', { command: 'rg "silverhand message send"' }).verb).toBe('Bash');
    expect(presentToolCall('Bash', { command: "echo 'silverhand task status'" }).verb).toBe('Bash');
    expect(presentToolCall('shell', { command: 'grep -r silverhand src/' }).verb).toBe('Shell');
    // separators INSIDE a quoted argument must not count as command boundaries
    // (the scanner tracks quote state, not just the char class).
    expect(presentToolCall('Bash', { command: 'rg "(silverhand message send)"' }).verb).toBe(
      'Bash',
    );
    expect(presentToolCall('Bash', { command: "echo '; silverhand task status'" }).verb).toBe(
      'Bash',
    );
    // but a real call after an UNQUOTED separator IS recognised (not raw Bash)
    expect(presentToolCall('Bash', { command: 'cd /x && silverhand task claim' }).verb).not.toBe(
      'Bash',
    );
  });

  it('codex shell labels as Shell; unknown tool falls back to JSON', () => {
    expect(presentToolCall('shell', { command: 'echo hi' }).verb).toBe('Shell');
    const fb = presentToolCall('MysteryTool', { foo: 'bar' });
    expect(fb.verb).toBe('MysteryTool');
    expect(fb.detail?.kind).toBe('json');
  });
});

describe('taskNumberFromCommand', () => {
  // Behaviour-determining branches (flag ∪ canonical positional, verb
  // whitelist, first of a batch) live in a pure exported fn so a later
  // "simplify back to one regex" can't silently drop the positional form. The
  // arg is the command's `args` slice (after `task <verb>`), never the wider
  // shell text — compound-prefix leakage is covered end-to-end via presentToolCall.
  it('reads the retired --task-number flag for any verb (history compat)', () => {
    expect(taskNumberFromCommand('claim', '--task-number 9')).toBe('9');
    expect(taskNumberFromCommand('status', '--task-number=42 --status done')).toBe('42');
    // list keeps --task-number as a filter → still surfaced via the flag form.
    expect(taskNumberFromCommand('list', '--task-number 5')).toBe('5');
  });

  it('reads the new positional operand only for by-number verbs', () => {
    expect(taskNumberFromCommand('claim', '9')).toBe('9');
    expect(taskNumberFromCommand('detail', '1187')).toBe('1187');
    expect(taskNumberFromCommand('status', '42 --status done')).toBe('42');
    // non-by-number verbs never take a positional operand.
    expect(taskNumberFromCommand('list', '5')).toBeNull();
    expect(taskNumberFromCommand('create', '--source-message-id abc --claim')).toBeNull();
    expect(taskNumberFromCommand(undefined, '5')).toBeNull();
  });

  it('shows the first of a batch; relies on canonical operand-first shape', () => {
    expect(taskNumberFromCommand('claim', '42 43')).toBe('42');
    // no operand at all (message-id claim) → null, never fabricated.
    expect(taskNumberFromCommand('claim', '--message-id abc123')).toBeNull();
    // NON-canonical flags-before-operand yields null rather than a wrong guess:
    // we don't rebuild CLI flag parsing (`--clear-body`/`--json` are booleans).
    expect(taskNumberFromCommand('edit', '--clear-body 42')).toBeNull();
  });
});

describe('coalesceActivity', () => {
  function tev(id: number, kind: 'thinking' | 'text', text: string) {
    return ev(id, { kind, payload: { text } });
  }

  it('folds consecutive same-kind fragments, joining with empty string', () => {
    const items = coalesceActivity([tev(1, 'thinking', 'fin'), tev(2, 'thinking', 'ding')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'group', kind: 'thinking', text: 'finding', count: 2 });
  });

  it('breaks a run on a non-fragment event and on a thinking↔text switch', () => {
    const items = coalesceActivity([
      tev(1, 'thinking', 'a'),
      ev(2, { kind: 'tool_call', payload: { name: 'Bash' } }),
      tev(3, 'thinking', 'b'),
      tev(4, 'text', 'c'),
    ]);
    expect(items.map(i => (i.type === 'group' ? `g:${i.kind}` : `e:${i.event.kind}`))).toEqual([
      'g:thinking',
      'e:tool_call',
      'g:thinking',
      'g:text',
    ]);
  });

  it('folds a tool_output into its tool_call (✓ marker) by tool_call_id', () => {
    const items = coalesceActivity([
      ev(1, { kind: 'tool_call', payload: { name: 'Bash', tool_call_id: 'tc1', input: {} } }),
      ev(2, { kind: 'tool_output', payload: { name: 'Bash', tool_call_id: 'tc1' } }),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ type: 'event', completed: true });
    expect(item.type === 'event' && item.event.kind).toBe('tool_call');
  });

  it('keeps an orphan tool_output (no matching call) as a single light row', () => {
    const items = coalesceActivity([ev(1, { kind: 'tool_output', payload: { name: 'X' } })]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item).toMatchObject({ type: 'event' });
    expect(item.type === 'event' && item.event.kind).toBe('tool_output');
  });

  it('folds compaction_finished into its compaction_started (loading → done)', () => {
    const items = coalesceActivity([
      ev(1, { kind: 'compaction_started' }),
      ev(2, { kind: 'compaction_finished' }),
    ]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    // the started row carries the completion flag (rendered as the done marker)
    expect(item).toMatchObject({ type: 'event', completed: true });
    expect(item.type === 'event' && item.event.kind).toBe('compaction_started');
  });

  it('leaves an orphan compaction_started as a loading row (no fabricated done)', () => {
    const items = coalesceActivity([ev(1, { kind: 'compaction_started' })]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.type === 'event' && item.event.kind).toBe('compaction_started');
    expect(item.type === 'event' && item.completed).toBeFalsy();
  });

  it('keeps an orphan compaction_finished as a standalone done row', () => {
    const items = coalesceActivity([ev(1, { kind: 'compaction_finished' })]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.type === 'event' && item.event.kind).toBe('compaction_finished');
  });

  it('pairs multiple compactions FIFO (each finished closes the earliest open start)', () => {
    const items = coalesceActivity([
      ev(1, { kind: 'compaction_started' }),
      ev(2, { kind: 'compaction_finished' }),
      ev(3, { kind: 'compaction_started' }),
      ev(4, { kind: 'compaction_finished' }),
    ]);
    // both finishes fold into their starts → two done rows, no leftover finishes
    expect(items).toHaveLength(2);
    expect(
      items.map(i => (i.type === 'event' ? `${i.event.kind}:${i.completed ? 'done' : 'loading'}` : 'group')),
    ).toEqual(['compaction_started:done', 'compaction_started:done']);
  });
});
