import { describe, expect, it } from 'vitest';
import type { AgentAuditChatSummary } from '@silverhand/shared';
import {
  collectMemberConversationIds,
  decideAgentChatRowAccess,
  participationWorkspaceIds,
  viewerAuthoritiesSettled,
  viewerWorkspaceForChat,
  type ViewerParticipation,
} from './audit-participation';

// #task:2040 — the one judgment the flattened Chats list rests on: may the VIEWER
// open this row as themselves. Two traps it exists to make unrepresentable:
//   1. answering from the owner-audit read, the only authority the page itself
//      holds — it lists conversations the viewer may have no part in, so any
//      "it's in the list" reasoning opens a door the backend then slams;
//   2. answering "you're not in it" when no authority ANSWERED (@Cindy's review):
//      fail-closed licenses disabling the row, never the claim.

function workspaceChat(
  over: Partial<Extract<AgentAuditChatSummary, { placement_kind: 'workspace' }>> = {},
): AgentAuditChatSummary {
  return {
    placement_kind: 'workspace',
    conversation_id: 'c-1',
    roster_policy: 'open',
    title: 'general',
    workspace_id: 'w-1',
    workspace_name: 'Acme',
    workspace_kind: 'regular',
    archived_at: null,
    created_at: 1,
    ...over,
  };
}

function pairChat(
  over: Partial<Extract<AgentAuditChatSummary, { placement_kind: 'direct_pair' }>> = {},
): AgentAuditChatSummary {
  return {
    placement_kind: 'direct_pair',
    conversation_id: 'c-pair',
    counterpart: {
      status: 'active',
      kind: 'human',
      id: 'u-1',
      name: 'shiki',
      display_name: 'shiki',
      avatar_url: null,
      runtime: null,
    },
    read_only: false,
    archived_at: null,
    created_at: 1,
    ...over,
  };
}

/** A viewer whose authorities have all ANSWERED, holding `w-1` and nothing in it.
 *  Overrides express the interesting states: `null` for an authority that did not
 *  answer, ids for what it answered. */
function viewer(over: Partial<ViewerParticipation> = {}): ViewerParticipation {
  return {
    workspaces: [{ id: 'w-1' }],
    resolvedWorkspaceIds: new Set(['w-1']),
    memberConversationIds: new Set(),
    directPairIds: new Set(),
    ...over,
  };
}

describe('collectMemberConversationIds — joined rows only, never "it was in the list"', () => {
  it('keeps is_member: true rows across several lists', () => {
    expect(
      Array.from(
        collectMemberConversationIds([
          [{ id: 'c-a', is_member: true }],
          [{ id: 'c-b', is_member: true }],
        ]),
      ).sort(),
    ).toEqual(['c-a', 'c-b']);
  });

  it('drops browse-only public channels', () => {
    // The active channel list is a DISCOVERY UNION: a public channel the viewer
    // has not joined is present with `is_member: false`. Treating presence as
    // participation is the exact fail-open this module exists to prevent.
    expect(
      collectMemberConversationIds([
        [
          { id: 'c-joined', is_member: true },
          { id: 'c-browse', is_member: false },
        ],
      ]),
    ).toEqual(new Set(['c-joined']));
  });

  it('drops rows whose membership is UNKNOWN — an absent field is not a yes', () => {
    expect(collectMemberConversationIds([[{ id: 'c-old' }]]).size).toBe(0);
  });

  it('ignores lists that have not answered (or failed)', () => {
    expect(
      collectMemberConversationIds([undefined, [{ id: 'c-a', is_member: true }], undefined]),
    ).toEqual(new Set(['c-a']));
    expect(collectMemberConversationIds([]).size).toBe(0);
  });
});

describe('decideAgentChatRowAccess — viewer participation, not owner audit', () => {
  it('opens a workspace row the viewer has joined, carrying its workspace', () => {
    expect(
      decideAgentChatRowAccess(
        workspaceChat(),
        viewer({ memberConversationIds: new Set(['c-1']) }),
      ),
    ).toEqual({ kind: 'open', conversationId: 'c-1', workspaceId: 'w-1' });
  });

  it('blocks a workspace row the viewer has not joined', () => {
    // The row is on the page because the OWNER may audit it. That says nothing
    // about the viewer being in it — and here the authority DID answer, so the
    // negative is a claim we may make.
    expect(decideAgentChatRowAccess(workspaceChat(), viewer())).toEqual({
      kind: 'blocked',
      reason: 'not-a-participant',
    });
  });

  it('blocks a row in a workspace the viewer does not hold — proven, no table needed', () => {
    expect(
      decideAgentChatRowAccess(
        workspaceChat({ workspace_id: 'w-other' }),
        viewer({ memberConversationIds: new Set(['c-1']) }),
      ),
    ).toEqual({ kind: 'blocked', reason: 'not-a-participant' });
  });

  it('opens a pair the viewer is an endpoint of, with NO workspace', () => {
    // A pair has no container, which is why it routes differently — the null is
    // the placement, not a missing value.
    expect(
      decideAgentChatRowAccess(
        pairChat(),
        viewer({ directPairIds: new Set(['c-pair']) }),
      ),
    ).toEqual({ kind: 'open', conversationId: 'c-pair', workspaceId: null });
  });

  it('blocks the agent’s pair with SOMEONE ELSE', () => {
    // The headline case: an owner auditing their agent's DMs with a third party.
    // Readable as audit, never walkable as the viewer.
    expect(
      decideAgentChatRowAccess(
        pairChat({ conversation_id: 'c-theirs' }),
        viewer({ directPairIds: new Set(['c-mine']) }),
      ),
    ).toEqual({ kind: 'blocked', reason: 'not-a-participant' });
  });

  it('never crosses the two authorities', () => {
    // A pair id in the channel-membership set (and vice versa) must not open
    // anything: each placement has exactly one authority.
    expect(
      decideAgentChatRowAccess(
        pairChat(),
        viewer({ memberConversationIds: new Set(['c-pair']) }),
      ),
    ).toMatchObject({ kind: 'blocked' });
    expect(
      decideAgentChatRowAccess(
        workspaceChat(),
        viewer({ directPairIds: new Set(['c-1']) }),
      ),
    ).toMatchObject({ kind: 'blocked' });
  });

  it('opens the dm_channel the viewer reaches through their own home', () => {
    // The row's own `workspace_id` is the AGENT's home; the open verdict must
    // carry the container the VIEWER holds, which is what navigation uses.
    expect(
      decideAgentChatRowAccess(
        workspaceChat({ conversation_id: 'c-dm', workspace_id: 'w-agent' }),
        viewer({
          workspaces: [{ id: 'w-home', dm_channel_ids: ['c-dm'] }],
          resolvedWorkspaceIds: new Set(['w-home']),
          memberConversationIds: new Set(['c-dm']),
        }),
      ),
    ).toEqual({ kind: 'open', conversationId: 'c-dm', workspaceId: 'w-home' });
  });
});

describe('decideAgentChatRowAccess — archive is a conversation state, not an authority', () => {
  it('opens an archived channel the viewer belongs to', () => {
    // Both channel tables carry the same viewer-scoped `is_member` (#task:1691)
    // and the archived set is membership-filtered, so a joined-then-archived
    // channel is provable — it just lives in the other table.
    expect(
      decideAgentChatRowAccess(
        workspaceChat({ archived_at: 5 }),
        viewer({ memberConversationIds: new Set(['c-1']) }),
      ),
    ).toEqual({ kind: 'open', conversationId: 'c-1', workspaceId: 'w-1' });
  });

  it('opens an archived pair the viewer is an endpoint of', () => {
    // The viewer's pair list has no archived filter, so the same set answers.
    expect(
      decideAgentChatRowAccess(
        pairChat({ archived_at: 5, read_only: true }),
        viewer({ directPairIds: new Set(['c-pair']) }),
      ),
    ).toEqual({ kind: 'open', conversationId: 'c-pair', workspaceId: null });
  });

  it('still blocks an archived row the viewer is not in', () => {
    expect(
      decideAgentChatRowAccess(workspaceChat({ archived_at: 5 }), viewer()),
    ).toEqual({ kind: 'blocked', reason: 'not-a-participant' });
  });
});

describe('decideAgentChatRowAccess — an unanswered authority is never a negative', () => {
  it('does not call the viewer a non-participant when the pair read failed', () => {
    // The row may well be the viewer's OWN line; an empty-set stand-in would
    // have said otherwise, in a tooltip, as a fact.
    expect(decideAgentChatRowAccess(pairChat(), viewer({ directPairIds: null }))).toEqual({
      kind: 'blocked',
      reason: 'unverified',
    });
  });

  it('does not judge workspace rows before the viewer’s workspace list answers', () => {
    // The cold window @Cindy caught: with no workspace list there is nothing to
    // fan out over, and an empty fan-out must not read as "asked and answered".
    expect(decideAgentChatRowAccess(workspaceChat(), viewer({ workspaces: null }))).toEqual({
      kind: 'blocked',
      reason: 'unverified',
    });
  });

  it('does not judge a row whose channel tables failed', () => {
    expect(
      decideAgentChatRowAccess(workspaceChat(), viewer({ resolvedWorkspaceIds: new Set() })),
    ).toEqual({ kind: 'blocked', reason: 'unverified' });
  });

  it('judges only the rows whose own authority answered', () => {
    // Half-resolved fan-out: `w-1` answered, `w-2` did not. Two rows, two
    // different reasons — the failure must not spread.
    const partial = viewer({
      workspaces: [{ id: 'w-1' }, { id: 'w-2' }],
      resolvedWorkspaceIds: new Set(['w-1']),
    });
    expect(decideAgentChatRowAccess(workspaceChat(), partial)).toMatchObject({
      reason: 'not-a-participant',
    });
    expect(
      decideAgentChatRowAccess(
        workspaceChat({ conversation_id: 'c-2', workspace_id: 'w-2' }),
        partial,
      ),
    ).toMatchObject({ reason: 'unverified' });
  });
});

describe('viewerAuthoritiesSettled — readiness covers the whole chain, in order', () => {
  it('is NOT settled while the viewer’s workspace list is pending', () => {
    // The ordering counter-example: the fan-out is empty precisely because the
    // workspace list hasn't answered, and `[].every(...)` is vacuously true. A
    // rule that read only the fan-out would call this ready.
    expect(
      viewerAuthoritiesSettled({
        workspacesPending: true,
        pairsPending: false,
        channelTablesPending: [],
      }),
    ).toBe(false);
  });

  it('is NOT settled once the fan-out exists but its tables are still loading', () => {
    expect(
      viewerAuthoritiesSettled({
        workspacesPending: false,
        pairsPending: false,
        channelTablesPending: [false, true],
      }),
    ).toBe(false);
  });

  it('is NOT settled while the pair list is pending', () => {
    expect(
      viewerAuthoritiesSettled({
        workspacesPending: false,
        pairsPending: true,
        channelTablesPending: [false],
      }),
    ).toBe(false);
  });

  it('is settled when every authority has answered — or failed', () => {
    // Failure is settled: those rows come out `unverified`, which is a verdict.
    // Waiting for success instead would hang the pane forever.
    expect(
      viewerAuthoritiesSettled({
        workspacesPending: false,
        pairsPending: false,
        channelTablesPending: [false, false],
      }),
    ).toBe(true);
  });

  it('is settled when the viewer holds no workspace to read', () => {
    expect(
      viewerAuthoritiesSettled({
        workspacesPending: false,
        pairsPending: false,
        channelTablesPending: [],
      }),
    ).toBe(true);
  });
});

describe('viewerWorkspaceForChat — one mapping, shared by the fan-out and the verdict', () => {
  it('prefers the row’s own workspace when the viewer holds it', () => {
    expect(viewerWorkspaceForChat(workspaceChat(), [{ id: 'w-1' }])).toBe('w-1');
  });

  it('falls back to the home that fronts a dm_channel', () => {
    expect(
      viewerWorkspaceForChat(workspaceChat({ conversation_id: 'c-dm', workspace_id: 'w-agent' }), [
        { id: 'w-home', dm_channel_ids: ['c-dm'] },
      ]),
    ).toBe('w-home');
  });

  it('has no answer for a pair, which needs no container', () => {
    expect(viewerWorkspaceForChat(pairChat(), [{ id: 'w-1' }])).toBeNull();
  });
});

describe('participationWorkspaceIds — which channel lists to read', () => {
  it('takes the row’s own workspace when the viewer holds it', () => {
    expect(
      participationWorkspaceIds([workspaceChat()], [{ id: 'w-1' }, { id: 'w-2' }]),
    ).toEqual(['w-1']);
  });

  it('skips a workspace the viewer is not in — that list would be refused', () => {
    expect(participationWorkspaceIds([workspaceChat()], [{ id: 'w-2' }])).toEqual([]);
  });

  it('resolves a dm_channel through the home that fronts it', () => {
    // A `dm_channel`'s own `workspace_id` is the AGENT's home, which the viewer
    // does not hold; they reach the conversation through their own home, whose
    // `dm_channel_ids` names it.
    expect(
      participationWorkspaceIds(
        [
          workspaceChat({
            conversation_id: 'c-dm',
            workspace_id: 'w-agent',
            workspace_kind: 'agent_home',
          }),
        ],
        [{ id: 'w-home', dm_channel_ids: ['c-dm'] }, { id: 'w-1' }],
      ),
    ).toEqual(['w-home']);
  });

  it('includes ARCHIVED rows — they are judged by the same two tables', () => {
    expect(
      participationWorkspaceIds(
        [workspaceChat({ conversation_id: 'c-4', workspace_id: 'w-3', archived_at: 9 })],
        [{ id: 'w-3' }],
      ),
    ).toEqual(['w-3']);
  });

  it('ignores pairs, and dedupes + sorts', () => {
    expect(
      participationWorkspaceIds(
        [
          pairChat(),
          workspaceChat({ conversation_id: 'c-1', workspace_id: 'w-2' }),
          workspaceChat({ conversation_id: 'c-2', workspace_id: 'w-1' }),
          workspaceChat({ conversation_id: 'c-3', workspace_id: 'w-1' }),
        ],
        [{ id: 'w-1' }, { id: 'w-2' }],
      ),
    ).toEqual(['w-1', 'w-2']);
  });

  it('asks for nothing while the chats list is cold', () => {
    expect(participationWorkspaceIds(undefined, [{ id: 'w-1' }])).toEqual([]);
    expect(participationWorkspaceIds([], [{ id: 'w-1' }])).toEqual([]);
  });
});
