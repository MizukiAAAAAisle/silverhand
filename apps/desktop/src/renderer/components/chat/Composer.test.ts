import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  AgentDto,
  ChannelConversationDto,
  Locator,
  WorkspaceHumanMemberDto,
} from '@silverhand/shared';
import {
  canonicalizeStoredConversationTitle,
  canonicalizeStoredWorkspaceName,
  formatLocator,
  formatLocatorToken,
  parseLocator,
} from '@silverhand/shared';
import {
  buildMentionHumans,
  buildShorthandResolver,
  canResolveShorthandNow,
  detectTrigger,
  filterChannels,
  filterMentionPeople,
  formatPickInsertion,
  selectMentionCandidates,
  type HumanMentionCandidate,
} from './Composer';

/**
 * Locks the branches `formatPickInsertion` can produce so the mention
 * picker never inserts a string the renderer can't turn into a working
 * chip — and, for a channel, that the semantic locator it emits round-trips
 * through the shared parser for EVERY character class a real title carries.
 *
 * History:
 * - Original implementation always inserted `#<title>` — broke on the
 *   common case of CJK / spaces / slashes / leading digits. (#task:502.)
 * - Then the picker always inserted `#conv:<id>`: id-precise, but the wire
 *   form is opaque in prose — a human reading the body can't see which
 *   channel it points at.
 * - #task:2126: the picker now spells the shipped SEMANTIC LOCATOR
 *   `<silverhand://workspace/<ws>/<title>>` (#task:2119 grammar) via the
 *   shared formatter + canonical name constructors, so the body stays
 *   agent- and human-readable. The renderer still parses `#conv:<id>` for
 *   every existing body, and the picker falls back to it when the workspace
 *   name is absent (a state the `#` picker does not reach today).
 *
 * The percent-escaping of a title's `/`, `%`, `#`, `?`, `<`, `>` and spaces
 * is the shared URI codec's job; these cases prove the picker delegates to
 * it and never reimplements it — the emitted token parses back to exactly
 * the coordinate that was built from the raw names.
 */

/** Build the locator the picker MUST emit for `(rawTitle, workspaceName)`, then
 *  assert (a) the picker emits its canonical prose token verbatim and (b) that
 *  token round-trips through `parseLocator` back to the same coordinate — the
 *  proof the name-segment escaping is exact for this title's characters. */
function expectChannelLocator(rawTitle: string, workspaceName: string): void {
  const expected: Locator = {
    kind: 'channel',
    workspace: canonicalizeStoredWorkspaceName(workspaceName),
    channel: canonicalizeStoredConversationTitle(rawTitle),
    threadRootId: null,
  };
  const emitted = formatPickInsertion(
    // `id` is deliberately ignored by the locator arm — the coordinate is the
    // name, not the opaque id — so a distinctive value proves it isn't leaking in.
    { kind: 'channel', channel: channel({ id: 'IGNORED_00000000', title: rawTitle }) },
    workspaceName,
  );
  expect(emitted).toBe(formatLocatorToken(expected));
  // Autolink brackets are load-bearing (custom scheme has no bare autolink);
  // strip them to feed the parser the author's raw bytes it expects.
  expect(emitted.startsWith('<') && emitted.endsWith('>')).toBe(true);
  expect(parseLocator(emitted.slice(1, -1))).toEqual(expected);
  // The picker never falls back to the opaque wire id when a name is available.
  expect(emitted).not.toContain('#conv:');
}

function agent(overrides: Partial<AgentDto> = {}): AgentDto {
  return {
    id: 'a-1',
    name: 'alice',
    display_name: 'Alice',
    runtime: 'claude',
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as AgentDto;
}

function channel(overrides: Partial<ChannelConversationDto> = {}): ChannelConversationDto {
  return {
    id: 'qdQwBXDqcq_GE63-',
    workspace_id: 'w-1',
    placement_kind: 'workspace',
    roster_policy: 'open',
    title: 'general',
    status: 'open',
    spawned_by_agent_id: null,
    closed_at: null,
    close_summary: null,
    archived_at: null,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  } as ChannelConversationDto;
}

function human(
  overrides: Partial<HumanMentionCandidate> = {},
): HumanMentionCandidate {
  return {
    id: 'u-1',
    name: 'shiki',
    display_name: 'Shiki',
    avatar_url: null,
    ...overrides,
  };
}

function wsHuman(
  overrides: Partial<WorkspaceHumanMemberDto> = {},
): WorkspaceHumanMemberDto {
  return {
    id: 'u-1',
    name: 'shiki',
    display_name: 'Shiki',
    avatar_url: null,
    created_at: 0,
    updated_at: 0,
    workspace_id: 'w-1',
    user_id: 'u-1',
    joined_at: 0,
    role: 'member',
    ...overrides,
  } as WorkspaceHumanMemberDto;
}

describe('formatPickInsertion', () => {
  it('agent → @<name> (handle is always url-safe by schema)', () => {
    expect(
      formatPickInsertion(
        { kind: 'agent', agent: agent(), inConversation: true },
        'silverhand',
      ),
    ).toBe('@alice');
  });

  it('human → @<name> (same mention namespace as agents)', () => {
    expect(
      formatPickInsertion(
        { kind: 'human', human: human(), inConversation: true },
        'silverhand',
      ),
    ).toBe('@shiki');
  });

  it('channel with handle-safe title → semantic locator (no #conv shortcut)', () => {
    expectChannelLocator('general', 'silverhand');
  });

  it('channel with CJK + spaces in title → percent-escaped locator', () => {
    // The CreateChannelDialog placeholder is literally `修复 login bug`, so
    // CJK-with-spaces is the common case, not a corner: CJK stays raw, the
    // space becomes `%20`.
    expectChannelLocator('修复 login bug', 'silverhand');
  });

  it('channel with slash in title → structural / stays, title / escapes', () => {
    // `/` inside a name must escape to `%2F` or it would forge an extra path
    // segment; the segment separators between root/ws/title stay raw.
    expectChannelLocator('feature/cli design', 'silverhand');
  });

  it('channel with percent, hash and question mark in title → escaped locator', () => {
    // `%` must escape first (`%25`) or every other escape becomes ambiguous;
    // `#`/`?` are URI structural (fragment/query) and must not leak.
    expectChannelLocator('100% done? #ship', 'silverhand');
  });

  it('channel with angle brackets in title → escaped locator', () => {
    // `<`/`>` are the autolink delimiters themselves; unescaped they would
    // truncate the token and kill the chip.
    expectChannelLocator('a<b>c', 'silverhand');
  });

  it('channel with every reserved class at once → still round-trips', () => {
    // One title exercising CJK, space, `/`, `%`, `#`, `?`, `<`, `>` together.
    expectChannelLocator('UI/UX 100%? <设计>#1', 'silverhand');
  });

  it('workspace name also percent-escapes (same codec, both segments)', () => {
    // The workspace segment is escaped by the same codec as the title, so a
    // space in the workspace name must round-trip too.
    expectChannelLocator('general', 'my workspace');
  });

  it('null workspace name → falls back to #conv:<id> (totality)', () => {
    // The `#` picker is gated on a resolved workspace so it does not reach
    // this arm today, but the producer stays total rather than throwing, and
    // `#conv:` is the documented fallback the renderer still parses.
    expect(
      formatPickInsertion(
        {
          kind: 'channel',
          channel: channel({ id: 'feat0000000clidg', title: 'feature/cli design' }),
        },
        null,
      ),
    ).toBe('#conv:feat0000000clidg');
  });
});

describe('filterMentionPeople', () => {
  it('tags conversation-member humans with inConversation:true', () => {
    const { items } = filterMentionPeople(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      [human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
      new Set(),
      new Set(['u-1']),
      'shi',
    );

    expect(items).toEqual([
      {
        kind: 'human',
        human: human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' }),
        inConversation: true,
      },
    ]);
  });

  it('tags non-member humans with inConversation:false', () => {
    const { items } = filterMentionPeople(
      [],
      [human({ id: 'u-2', name: 'muou', display_name: 'Muou' })],
      new Set(),
      new Set(),
      'mu',
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      kind: 'human',
      human: human({ id: 'u-2', name: 'muou', display_name: 'Muou' }),
      inConversation: false,
    });
  });

  it('puts the IN section before the NOT IN section (humans-first within each)', () => {
    // Mixed cast: one in-member agent, one in-member human, one out
    // agent, one out human. Locks the section ordering: IN section
    // (humans then agents), then NOT IN section (humans then agents).
    const inAgent = agent({ id: 'a-in', name: 'inalice', display_name: 'InAlice' });
    const outAgent = agent({ id: 'a-out', name: 'outagent', display_name: 'OutAgent' });
    const inHuman = human({ id: 'u-in', name: 'inhuman', display_name: 'InHuman' });
    const outHuman = human({ id: 'u-out', name: 'outhuman', display_name: 'OutHuman' });
    const { items } = filterMentionPeople(
      [inAgent, outAgent],
      [inHuman, outHuman],
      new Set(['a-in']),
      new Set(['u-in']),
      '',
    );

    expect(items.map(item => ({
      kind: item.kind,
      id: item.kind === 'agent' ? item.agent.id : item.kind === 'human' ? item.human.id : 'n/a',
      inConversation: item.kind === 'channel' ? null : item.inConversation,
    }))).toEqual([
      { kind: 'human', id: 'u-in', inConversation: true },
      { kind: 'agent', id: 'a-in', inConversation: true },
      { kind: 'human', id: 'u-out', inConversation: false },
      { kind: 'agent', id: 'a-out', inConversation: false },
    ]);
  });

  it('caps each section independently at 5 entries (10 max combined)', () => {
    // Build 8 in-members + 8 out-members; verify the picker returns
    // 5 from each section in order, never spilling extras from one
    // section into the other.
    const mkAgent = (n: number) => agent({ id: `a-${n}`, name: `a${n}`, display_name: `A${n}` });
    const inAgents = Array.from({ length: 8 }, (_, i) => mkAgent(i));
    const outAgents = Array.from({ length: 8 }, (_, i) => mkAgent(100 + i));
    const { items, hiddenCount } = filterMentionPeople(
      [...inAgents, ...outAgents],
      [],
      new Set(inAgents.map(a => a.id)),
      new Set(),
      '',
    );
    expect(items).toHaveLength(10);
    expect(items.slice(0, 5).every(item => item.kind === 'agent' && item.inConversation)).toBe(true);
    expect(items.slice(5).every(item => item.kind === 'agent' && !item.inConversation)).toBe(true);
    // 16 matched (8 IN + 8 OUT), 10 shown → 6 dropped, surfaced as the
    // "+N more" footer count (#task:1206).
    expect(hiddenCount).toBe(6);
  });

  it('reports hiddenCount = 0 when nothing is truncated', () => {
    const { items, hiddenCount } = filterMentionPeople(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      [human({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
      new Set(['a-1']),
      new Set(['u-1']),
      '',
    );
    expect(items).toHaveLength(2);
    expect(hiddenCount).toBe(0);
  });

  it('counts truncation per section, not just overall (IN under cap, OUT over)', () => {
    // 2 IN (under the 5 cap → 0 dropped there) + 9 OUT (over → 4 dropped).
    // hiddenCount must reflect only the OUT overflow, proving the count is
    // computed per-section then summed, not from a single global slice.
    const mkAgent = (n: number) => agent({ id: `a-${n}`, name: `a${n}`, display_name: `A${n}` });
    const inAgents = [mkAgent(1), mkAgent(2)];
    const outAgents = Array.from({ length: 9 }, (_, i) => mkAgent(100 + i));
    const { items, hiddenCount } = filterMentionPeople(
      [...inAgents, ...outAgents],
      [],
      new Set(inAgents.map(a => a.id)),
      new Set(),
      '',
    );
    expect(items).toHaveLength(7); // 2 IN + 5 OUT (OUT capped at 5)
    expect(hiddenCount).toBe(4); // 9 OUT − 5 shown
  });

  it('honors the search query across both IN and NOT IN sections', () => {
    const { items } = filterMentionPeople(
      [
        agent({ id: 'a-in-bob', name: 'bob', display_name: 'Bob' }),
        agent({ id: 'a-out-bobby', name: 'bobby', display_name: 'Bobby' }),
        agent({ id: 'a-out-other', name: 'carol', display_name: 'Carol' }),
      ],
      [],
      new Set(['a-in-bob']),
      new Set(),
      'bob',
    );

    expect(items.map(item => (item.kind === 'agent' ? item.agent.id : null))).toEqual([
      'a-in-bob',
      'a-out-bobby',
    ]);
  });
});

describe('filterChannels', () => {
  it('caps at 8 channels and reports the truncated remainder', () => {
    const channels = Array.from({ length: 11 }, (_, i) =>
      channel({ id: `c-${i}`, title: `chan-${i}` }),
    );
    const { items, hiddenCount } = filterChannels(channels, '');
    expect(items).toHaveLength(8);
    // 11 live matched − 8 shown → 3 surfaced as the "+N more" footer count.
    expect(hiddenCount).toBe(3);
    expect(items.every(item => item.kind === 'channel')).toBe(true);
  });
  it('excludes archived/closed channels from both the list AND the count', () => {
    // The hidden count must reflect only *offerable* candidates: an
    // archived/closed channel is never a mentionable row, so it must not
    // inflate "+N more" into promising candidates the user can't reach.
    const channels = [
      channel({ id: 'live', title: 'general' }),
      channel({ id: 'arch', title: 'archived-thing', archived_at: 1 }),
      channel({ id: 'closed', title: 'closed-thing', closed_at: 1 }),
    ];
    const { items, hiddenCount } = filterChannels(channels, '');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'live',
    ]);
    expect(hiddenCount).toBe(0);
  });

  it('filters by an ASCII substring of the title, case-insensitively', () => {
    const channels = [
      channel({ id: 'a', title: 'UI polish' }),
      channel({ id: 'b', title: 'backend' }),
    ];
    const { items } = filterChannels(channels, 'POL');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'a',
    ]);
  });

  it('filters by a CJK substring of the title (#task:1720)', () => {
    // The channel title is real display text, so the matcher runs on the
    // raw title — a CJK query must select CJK titles both as a prefix and
    // mid-string, exactly like ASCII. (The upstream trigger fix in
    // detectTrigger is what lets a CJK query reach this matcher at all.)
    const channels = [
      channel({ id: 'design', title: '设计评审' }),
      channel({ id: 'polish', title: 'UI 优化' }),
      channel({ id: 'backend', title: 'backend' }),
    ];
    expect(
      filterChannels(channels, '设计').items.map(i =>
        i.kind === 'channel' ? i.channel.id : null,
      ),
    ).toEqual(['design']);
    // Mid-string CJK match: '优化' is the tail of 'UI 优化'.
    expect(
      filterChannels(channels, '优化').items.map(i =>
        i.kind === 'channel' ? i.channel.id : null,
      ),
    ).toEqual(['polish']);
  });
});

describe('detectTrigger', () => {
  it('captures an ASCII @ query up to the caret', () => {
    // "@al" with caret at end → mention trigger, query "al".
    expect(detectTrigger('hi @al', 6)).toEqual({ kind: '@', pos: 3, query: 'al' });
  });

  it('captures an ASCII # query up to the caret', () => {
    expect(detectTrigger('see #gen', 8)).toEqual({ kind: '#', pos: 4, query: 'gen' });
  });

  it('keeps walking through a CJK # query instead of bailing (#task:1720)', () => {
    // The ASCII-only handle class used to bail on the first CJK char, so
    // the menu never opened for '#设计'. The Unicode class must walk past
    // '计' and '设' back to the '#'.
    const text = '去 #设计';
    expect(detectTrigger(text, text.length)).toEqual({
      kind: '#',
      pos: 2,
      query: '设计',
    });
  });

  it('keeps walking through a CJK @ query (@张三) (#task:1720)', () => {
    const text = 'cc @张三';
    expect(detectTrigger(text, text.length)).toEqual({
      kind: '@',
      pos: 3,
      query: '张三',
    });
  });

  it('captures a query mixing CJK and ASCII', () => {
    const text = '#设计x';
    expect(detectTrigger(text, text.length)).toEqual({
      kind: '#',
      pos: 0,
      query: '设计x',
    });
  });

  it('does not trigger when the char before @ extends a handle (email)', () => {
    // 'me@example.com' — the char before '@' is a letter, so '@' is part
    // of a token, not a mention trigger.
    expect(detectTrigger('me@example', 10)).toBeNull();
  });

  it('opens right after CJK prose with no separating space (#task:1822)', () => {
    // Chinese/Japanese prose has no inter-word spaces, so requiring one
    // before `@` made the picker unusable there. Both parsers that decide
    // what a bare `@handle` becomes (`PLAIN_MENTION_PATTERN`, `canStartRef`)
    // treat a preceding CJK char as a boundary and do produce `@alice` here —
    // the picker must not be stricter than the message it would send.
    const text = '谢谢@alice';
    expect(detectTrigger(text, text.length)).toEqual({
      kind: '@',
      pos: 2,
      query: 'alice',
    });
  });

  it('opens for a CJK channel ref right after CJK prose (#task:1822)', () => {
    const text = '搬到#设计';
    expect(detectTrigger(text, text.length)).toEqual({
      kind: '#',
      pos: 2,
      query: '设计',
    });
  });

  it('does not trigger across a slash (path-like)', () => {
    expect(detectTrigger('path/@x', 7)).toBeNull();
  });

  it('bails on whitespace between the caret and any trigger', () => {
    expect(detectTrigger('hello world', 11)).toBeNull();
  });

  it('returns null for an out-of-range caret', () => {
    expect(detectTrigger('@a', 0)).toBeNull();
    expect(detectTrigger('@a', 3)).toBeNull();
  });
});

describe('buildMentionHumans', () => {
  it('drops the viewer and maps members to mention candidates', () => {
    const out = buildMentionHumans(
      [
        wsHuman({ id: 'u-me', name: 'me', display_name: 'Me' }),
        wsHuman({ id: 'u-2', name: 'other', display_name: 'Other' }),
      ],
      'u-me',
    );
    expect(out).toEqual([
      { id: 'u-2', name: 'other', display_name: 'Other', avatar_url: null },
    ]);
  });

  it('keeps everyone when there is no viewer id', () => {
    const out = buildMentionHumans([wsHuman({ id: 'u-1' })], null);
    expect(out.map(h => h.id)).toEqual(['u-1']);
  });
});

/**
 * #task:2001 — which bare handles the send-time rewrite converts. Behaviour, not
 * painting: the resolver decides what the STORED body says, and every wrong
 * answer here is silent (a chip that addresses nobody, or a chip that addresses
 * the wrong principal).
 */
describe('buildShorthandResolver', () => {
  it('resolves each kind of workspace member', () => {
    const resolve = buildShorthandResolver(
      [agent({ name: 'alice' })],
      [wsHuman({ name: 'shiki' })],
    );
    expect(resolve('alice')).toBe('agent');
    expect(resolve('shiki')).toBe('human');
  });

  it('refuses a handle nobody in this workspace has', () => {
    // `null` is what leaves the shorthand as authored — a chip that addresses
    // nobody, which is the truth.
    const resolve = buildShorthandResolver([agent({ name: 'alice' })], []);
    expect(resolve('elsewhere')).toBeNull();
  });

  it('is case-sensitive, like every other handle resolver', () => {
    const resolve = buildShorthandResolver([agent({ name: 'alice' })], []);
    expect(resolve('Alice')).toBeNull();
  });

  it('resolves a colliding handle to the agent, matching the renderer', () => {
    // `Markdown.tsx` consults `agentsByName` before `humansByName`. If this
    // disagreed, the chip would show an agent while the body delivered to a
    // human.
    const resolve = buildShorthandResolver(
      [agent({ name: 'shiki' })],
      [wsHuman({ name: 'shiki' })],
    );
    expect(resolve('shiki')).toBe('agent');
  });

  it('resolves nothing when the workspace is known to have nobody by that name', () => {
    // Empty lists mean an ANSWERED roster with no such member. Whether the
    // roster has answered at all is a separate question the send path asks
    // first — see `canResolveShorthandNow`; this resolver cannot express it.
    const resolve = buildShorthandResolver([], []);
    expect(resolve('alice')).toBeNull();
  });
});

/**
 * #task:2001 review — the gate that keeps an UNLOADED roster from being read as
 * an empty one. Behaviour, and the failure it prevents has no other detector: a
 * body sent in the cold window keeps its `@Alice` spelling, renders a chip,
 * reports success, and addresses nobody — on the main line it still reaches every
 * member but loses its targeting (no notification, no CC, read as undirected); in
 * a thread reply, where delivery is follower-gated, the named member may not
 * receive it at all. The server never rewrites a body, so this is the only place
 * it can be caught.
 */
describe('canResolveShorthandNow', () => {
  it('lets an ordinary body through whatever the roster state', () => {
    expect(canResolveShorthandNow('ship it', false)).toBe(true);
    expect(canResolveShorthandNow('ship it', true)).toBe(true);
  });

  it('waits when the roster is unknown and the body names someone', () => {
    expect(canResolveShorthandNow('cc @Alice please', false)).toBe(false);
  });

  it('goes straight out once the roster is known', () => {
    // Including the case where that roster turns out not to contain them: an
    // answered "nobody by that name" is a fact, and leaving the shorthand as
    // authored is the honest outcome.
    expect(canResolveShorthandNow('cc @Alice please', true)).toBe(true);
  });

  it('does not stall on an @ that could never have addressed anyone', () => {
    // The position predicate is the rewrite's own, so an email address, a code
    // span, a quote, or a link label cannot hold a send hostage.
    for (const body of [
      'mail me@example.com',
      'write `@Alice`',
      '> @Alice said so',
      '[ask @Alice](https://example.com)',
    ]) {
      expect(canResolveShorthandNow(body, false), body).toBe(true);
    }
  });
});

describe('selectMentionCandidates', () => {
  const members = {
    agents: [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
    humans: [wsHuman({ id: 'u-1', name: 'shiki', display_name: 'Shiki' })],
    viewerRole: null,
  };

  it('fails closed to empty when the workspace member lists have not resolved', () => {
    // No member-list data = workspace unresolved (or workspaceId still
    // null). Must NOT fall back to a global directory (#task:1720): both
    // undefined and null yield an empty picker.
    expect(
      selectMentionCandidates(undefined, true, new Set(), new Set(), null, ''),
    ).toEqual({ items: [], hiddenCount: 0 });
    expect(
      selectMentionCandidates(null, true, new Set(), new Set(), null, ''),
    ).toEqual({ items: [], hiddenCount: 0 });
  });

  it('fails closed to empty while the conversation roster is unresolved', () => {
    // Empty member-id sets with an unresolved roster mean membership is
    // UNKNOWN, not "nobody in this channel" — emitting now would file
    // in-channel members under "Other channels" and jump them into "In
    // this channel" the instant the roster arrives (#task:1720 review).
    expect(
      selectMentionCandidates(members, false, new Set(), new Set(), null, ''),
    ).toEqual({ items: [], hiddenCount: 0 });
  });

  it('once both are resolved, drops the viewer and groups by the roster', () => {
    const memberLists = {
      agents: [
        agent({ id: 'a-in', name: 'inagent', display_name: 'InAgent' }),
        agent({ id: 'a-out', name: 'outagent', display_name: 'OutAgent' }),
      ],
      humans: [
        wsHuman({ id: 'u-me', name: 'me', display_name: 'Me' }),
        wsHuman({ id: 'u-in', name: 'inhuman', display_name: 'InHuman' }),
        wsHuman({ id: 'u-out', name: 'outhuman', display_name: 'OutHuman' }),
      ],
      viewerRole: null,
    };
    const { items } = selectMentionCandidates(
      memberLists,
      true,
      new Set(['a-in']),
      new Set(['u-in']),
      'u-me',
      '',
    );
    expect(
      items.map(item => ({
        kind: item.kind,
        id:
          item.kind === 'agent'
            ? item.agent.id
            : item.kind === 'human'
              ? item.human.id
              : 'n/a',
        inConversation: item.kind === 'channel' ? null : item.inConversation,
      })),
    ).toEqual([
      { kind: 'human', id: 'u-in', inConversation: true },
      { kind: 'agent', id: 'a-in', inConversation: true },
      { kind: 'human', id: 'u-out', inConversation: false },
      { kind: 'agent', id: 'a-out', inConversation: false },
    ]);
    // The viewer never surfaces in either group.
    expect(items.some(i => i.kind === 'human' && i.human.id === 'u-me')).toBe(
      false,
    );
  });
});

describe('mention source wiring (falsifier for the workspace-scoped boundary)', () => {
  // selectMentionCandidates / filterMentionPeople accept any arrays, so
  // reverting the composer to the global useUsers()/useAgents() directories
  // would leave every pure test above green. This fence pins the ONE wiring
  // fact that makes the candidate boundary real: the composer feeds the `@`
  // picker from the workspace-scoped member lists, never the global
  // directories (#task:1720). Source-text, not a DOM/structure assertion.
  const src = readFileSync(
    fileURLToPath(new URL('./Composer.tsx', import.meta.url)),
    'utf8',
  );

  it('sources @ candidates from useWorkspaceMemberLists(workspaceId)', () => {
    expect(src).toContain('useWorkspaceMemberLists(workspaceId)');
  });

  it('never reads the global user / agent directories', () => {
    expect(src).not.toContain('useUsers');
    expect(src).not.toContain('useAgents');
  });

  // #task:2001 review: `canResolveShorthandNow` is pure, so every branch test
  // above stays green if `submit()` stops asking it — and the regression is
  // invisible (a message that sends, renders a chip, and addresses nobody). These
  // pin the three wiring facts that make the gate real.
  it('gates the send on the gate, and on the roster having answered', () => {
    expect(src).toContain(
      'canResolveShorthandNow(content, workspaceRosterKnown)',
    );
    expect(src).toContain('const workspaceRosterKnown = memberLists.data !==');
  });

  it('waits for the authoritative roster instead of sending unresolved', () => {
    // The waiting path must both refetch and rewrite with the roster it got back
    // — rewriting with the stale closure resolver would defeat the wait.
    expect(src).toContain('memberLists\n      .refetch()');
    expect(src).toContain('buildShorthandResolver(roster.agents, roster.humans)');
  });

  it('hands the draft back rather than sending when the roster cannot be had', () => {
    expect(src).toContain('restoreDraft()');
  });
});
