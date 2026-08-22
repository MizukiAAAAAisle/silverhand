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
import type { ChannelListItem } from '@/features/workspaces/hooks';
import {
  buildMentionHumans,
  buildShorthandResolver,
  buildViewerShorthandResolver,
  canResolveShorthandNow,
  detectTrigger,
  filterChannels,
  filterMentionPeople,
  filterViewerChannels,
  formatPickInsertion,
  selectMentionCandidates,
  selectViewerMentionCandidates,
  type ChannelSlice,
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
    {
      kind: 'channel',
      channel: channel({ id: 'IGNORED_00000000', title: rawTitle }),
      workspaceName,
    },
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

/** A channel row as it arrives from `useChannelsAcrossWorkspaces` — carries the
 *  per-viewer `is_member` discovery bit the viewer `#` arm filters on. */
function viewerChannel(
  overrides: Partial<ChannelConversationDto> & { is_member?: boolean } = {},
): ChannelListItem {
  const { is_member, ...rest } = overrides;
  return { ...channel(rest), is_member } as ChannelListItem;
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
      formatPickInsertion({ kind: 'agent', agent: agent(), inConversation: true }),
    ).toBe('@alice');
  });

  it('human → @<name> (same mention namespace as agents)', () => {
    expect(
      formatPickInsertion({ kind: 'human', human: human(), inConversation: true }),
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
      formatPickInsertion({
        kind: 'channel',
        channel: channel({ id: 'feat0000000clidg', title: 'feature/cli design' }),
        workspaceName: null,
      }),
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
    const { items, hiddenCount } = filterChannels(channels, 'silverhand', '');
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
    const { items, hiddenCount } = filterChannels(channels, 'silverhand', '');
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
    const { items } = filterChannels(channels, 'silverhand', 'POL');
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
      filterChannels(channels, 'silverhand', '设计').items.map(i =>
        i.kind === 'channel' ? i.channel.id : null,
      ),
    ).toEqual(['design']);
    // Mid-string CJK match: '优化' is the tail of 'UI 优化'.
    expect(
      filterChannels(channels, 'silverhand', '优化').items.map(i =>
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

describe('selectViewerMentionCandidates', () => {
  // The viewer arm's `@` set (#task:2147): the viewer's own canonical-owned
  // agents, flat and agents-only — a direct_pair has no roster, so no humans and
  // no In/Other split.
  const mkAgent = (n: number) =>
    agent({ id: `a-${n}`, name: `a${n}`, display_name: `A${n}` });

  it('offers the owned agents flat, every row inConversation:true', () => {
    const { items, hiddenCount } = selectViewerMentionCandidates(
      [agent({ id: 'a-1', name: 'alice', display_name: 'Alice' })],
      '',
    );
    expect(items).toEqual([
      {
        kind: 'agent',
        agent: agent({ id: 'a-1', name: 'alice', display_name: 'Alice' }),
        inConversation: true,
      },
    ]);
    expect(hiddenCount).toBe(0);
  });

  it('matches by name and display_name, case-insensitively', () => {
    const { items } = selectViewerMentionCandidates(
      [
        agent({ id: 'a-1', name: 'alice', display_name: 'Alice' }),
        agent({ id: 'a-2', name: 'bob', display_name: 'Bob' }),
      ],
      'ALI',
    );
    expect(items.map(i => (i.kind === 'agent' ? i.agent.id : null))).toEqual([
      'a-1',
    ]);
  });

  it('caps at 10 and reports the truncated remainder', () => {
    const owned = Array.from({ length: 13 }, (_, i) => mkAgent(i));
    const { items, hiddenCount } = selectViewerMentionCandidates(owned, '');
    expect(items).toHaveLength(10);
    expect(hiddenCount).toBe(3);
    expect(items.every(i => i.kind === 'agent' && i.inConversation)).toBe(true);
  });
});

describe('buildViewerShorthandResolver', () => {
  // #task:2147 — mirrors buildShorthandResolver's "membership is the admission
  // test", but agents-only: a handle outside the owned set is left as authored.
  it('resolves an owned agent to agent, everyone else to null', () => {
    const resolve = buildViewerShorthandResolver([agent({ name: 'alice' })]);
    expect(resolve('alice')).toBe('agent');
    expect(resolve('elsewhere')).toBeNull();
  });

  it('is case-sensitive, like every other handle resolver', () => {
    const resolve = buildViewerShorthandResolver([agent({ name: 'alice' })]);
    expect(resolve('Alice')).toBeNull();
  });

  it('resolves nothing when the owned set is empty', () => {
    expect(buildViewerShorthandResolver([])('alice')).toBeNull();
  });
});

/**
 * #task:2148 — the viewer arm's `#` fan-out across every workspace the viewer
 * belongs to. Two facts live here and both fail silently:
 *  - **Alice's fail-closed seam.** `sourceKnown` is true ONLY when the workspace
 *    id list has settled AND every per-workspace slice succeeded. A slice still
 *    pending — or in ERROR — must leave it false; an error must NEVER read as
 *    "settled and empty", which would drop a whole workspace's channels and look
 *    downstream like a complete-but-smaller set.
 *  - **Per-candidate coordinate.** Each surviving row is stamped with its OWN
 *    workspace name (from its own `workspace_id`), so a cross-workspace locator
 *    spells the right coordinate and same-named channels stay distinguishable.
 * Items are PROGRESSIVE — built from whatever slices already succeeded — while
 * `sourceKnown` reports whole-set settlement; a `#` pick inserts a full canonical
 * locator, so a partial list never mis-addresses.
 */
describe('filterViewerChannels', () => {
  const names = new Map([
    ['w-1', 'silverhand'],
    ['w-2', 'Agent Space'],
  ]);
  const success = (data: ChannelListItem[]): ChannelSlice => ({
    status: 'success',
    data,
  });

  it('flattens is_member channels across workspaces, stamping each row its own name', () => {
    const slices: ChannelSlice[] = [
      success([
        viewerChannel({ id: 'c1', workspace_id: 'w-1', title: 'general', is_member: true }),
      ]),
      success([
        viewerChannel({ id: 'c2', workspace_id: 'w-2', title: 'design', is_member: true }),
      ]),
    ];
    const { items, sourceKnown } = filterViewerChannels(slices, true, names, '');
    expect(sourceKnown).toBe(true);
    expect(
      items.map(i =>
        i.kind === 'channel'
          ? { id: i.channel.id, ws: i.workspaceName }
          : null,
      ),
    ).toEqual([
      { id: 'c1', ws: 'silverhand' },
      { id: 'c2', ws: 'Agent Space' },
    ]);
  });

  it('excludes channels the viewer is not a member of', () => {
    const slices: ChannelSlice[] = [
      success([
        viewerChannel({ id: 'mine', title: 'a', is_member: true }),
        viewerChannel({ id: 'browsed', title: 'b', is_member: false }),
        // A row with no discovery bit at all is not "mine" either.
        viewerChannel({ id: 'nobit', title: 'c' }),
      ]),
    ];
    const { items } = filterViewerChannels(slices, true, names, '');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'mine',
    ]);
  });

  it('excludes archived/closed/non-open channels from both the list AND the count', () => {
    const slices: ChannelSlice[] = [
      success([
        viewerChannel({ id: 'live', title: 'general', is_member: true }),
        viewerChannel({ id: 'arch', title: 'x', is_member: true, archived_at: 1 }),
        viewerChannel({ id: 'closed', title: 'y', is_member: true, closed_at: 1 }),
      ]),
    ];
    const { items, hiddenCount } = filterViewerChannels(slices, true, names, '');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'live',
    ]);
    expect(hiddenCount).toBe(0);
  });

  it('a workspace name absent from the map → null (→ #conv fallback at insert time)', () => {
    const slices: ChannelSlice[] = [
      success([
        viewerChannel({ id: 'c1', workspace_id: 'w-unknown', title: 'general', is_member: true }),
        viewerChannel({ id: 'c2', workspace_id: null, title: 'floating', is_member: true }),
      ]),
    ];
    const { items } = filterViewerChannels(slices, true, names, '');
    expect(
      items.map(i => (i.kind === 'channel' ? i.workspaceName : 'n/a')),
    ).toEqual([null, null]);
  });

  it('caps at 8 and counts only offerable candidates into the remainder', () => {
    const data = Array.from({ length: 11 }, (_, i) =>
      viewerChannel({ id: `c-${i}`, title: `chan-${i}`, is_member: true }),
    );
    const { items, hiddenCount } = filterViewerChannels([success(data)], true, names, '');
    expect(items).toHaveLength(8);
    expect(hiddenCount).toBe(3);
  });

  it('filters by a title substring, case-insensitively, across all slices', () => {
    const slices: ChannelSlice[] = [
      success([viewerChannel({ id: 'a', title: 'UI polish', is_member: true })]),
      success([viewerChannel({ id: 'b', title: 'backend', is_member: true })]),
    ];
    const { items } = filterViewerChannels(slices, true, names, 'POL');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'a',
    ]);
  });

  it('fail-closed: a still-PENDING slice leaves sourceKnown false but keeps the settled items', () => {
    const slices: ChannelSlice[] = [
      success([viewerChannel({ id: 'c1', title: 'general', is_member: true })]),
      { status: 'pending' },
    ];
    const { items, sourceKnown } = filterViewerChannels(slices, true, names, '');
    // Progressive: the succeeded slice's channel is offered NOW…
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'c1',
    ]);
    // …but the whole set is not settled, so a hand-typed handle stays pending.
    expect(sourceKnown).toBe(false);
  });

  it('fail-closed: an ERROR slice is NOT folded into settled-empty (sourceKnown false)', () => {
    // The failure this pins: reading an error as "this workspace has no channels"
    // would drop it silently and report the smaller set as complete.
    const slices: ChannelSlice[] = [
      success([viewerChannel({ id: 'c1', title: 'general', is_member: true })]),
      { status: 'error' },
    ];
    const { items, sourceKnown } = filterViewerChannels(slices, true, names, '');
    expect(items.map(i => (i.kind === 'channel' ? i.channel.id : null))).toEqual([
      'c1',
    ]);
    expect(sourceKnown).toBe(false);
  });

  it('fail-closed: an unsettled workspace-id list leaves sourceKnown false even if every slice succeeded', () => {
    const slices: ChannelSlice[] = [
      success([viewerChannel({ id: 'c1', title: 'general', is_member: true })]),
    ];
    expect(filterViewerChannels(slices, false, names, '').sourceKnown).toBe(false);
  });

  it('settled-empty is a known answer: no slices, list settled → sourceKnown true', () => {
    const { items, sourceKnown } = filterViewerChannels([], true, names, '');
    expect(items).toEqual([]);
    expect(sourceKnown).toBe(true);
  });
});

describe('mention source wiring (falsifier for the per-arm candidate boundary)', () => {
  // The pure selectors accept any arrays, so reverting the composer to a global
  // directory — or wiring the wrong arm's source into the send gate — would leave
  // every pure test above green. This fence pins the wiring facts that make the
  // per-arm boundary real (#task:2147): the workspace arm feeds the `@` picker
  // from the workspace-scoped member lists, the viewer arm from the viewer's OWN
  // agents, and the send gate reads the SAME arm source the picker read.
  // Source-text, not a DOM/structure assertion.
  const src = readFileSync(
    fileURLToPath(new URL('./Composer.tsx', import.meta.url)),
    'utf8',
  );

  it('sources workspace-arm @ candidates from useWorkspaceMemberLists(armWorkspaceId)', () => {
    expect(src).toContain('useWorkspaceMemberLists(armWorkspaceId)');
  });

  it('sources viewer-arm @ candidates from the viewer OWNED agents, never a human directory', () => {
    // The viewer arm now legitimately reads agents — but only the owned scope,
    // and never the global human directory (a `direct_pair` names no humans
    // through a roster).
    expect(src).toContain("useAgents({ scope: 'owned'");
    expect(src).not.toContain('useUsers');
  });

  // #task:2001 / #task:2147: `canResolveShorthandNow` is pure, so every branch test
  // above stays green if `submit()` reads the wrong settle fact — and the regression
  // is invisible (a message that sends, renders a chip, and addresses nobody). These
  // pin the wiring facts that make the gate real AND arm-correct.
  it('gates the send on the SAME arm source the picker read', () => {
    expect(src).toContain(
      'canResolveShorthandNow(content, mentionSource.sourceKnown)',
    );
    // The workspace arm's three-value authority: data present ⇒ answered.
    expect(src).toContain('sourceKnown: memberLists.data !== undefined');
  });

  it('waits for the authoritative source per arm instead of sending unresolved', () => {
    // The waiting path must refetch the CURRENT arm's source and rewrite with the
    // resolver it got back — rewriting with the stale closure resolver, or waiting
    // on the wrong arm's query, would defeat the wait.
    expect(src).toContain('(await memberLists.refetch()).data');
    expect(src).toContain('buildShorthandResolver(roster.agents, roster.humans)');
    expect(src).toContain('(await ownedAgentsQuery.refetch()).data');
    expect(src).toContain('buildViewerShorthandResolver(owned)');
  });

  it('hands the draft back rather than sending when the source cannot be had', () => {
    expect(src).toContain('restoreDraft()');
  });
});
