import { describe, expect, it } from 'vitest';
import {
  parseLocator,
  type DirectPairListItem,
  type Locator,
} from '@silverhand/shared';
import {
  locatorChannelListWorkspaceId,
  locatorCounterpartHandle,
  resolveLocatorPairConversationId,
  resolveLocatorTarget,
  resolveLocatorWorkspaceId,
  type LocatorFacts,
} from './locator-target';

/**
 * #task:2120 — the navigability rulings, asserted where they are decided.
 *
 * Every case below is a PRODUCT ruling rather than a shape: which coordinates become
 * a live control, which degrade to the inert sigil, and — the one that cannot be
 * recovered once lost — that a degradation never distinguishes "no such name" from
 * "not yours". The chip paints this function's answer, so asserting these through
 * rendered DOM would be asserting the painting instead.
 *
 * Locators are built by the real parser, never by an object literal: three of the
 * four fields are branded values only their own module can construct, and a literal
 * would be a second, unvalidated authority on what a locator is. `loc` therefore
 * throws — a fixture this parser refuses is a bug in this file, not a case to skip.
 */
function loc(href: string): Locator {
  const parsed = parseLocator(href);
  if (parsed === null) throw new Error(`fixture is not a locator: ${href}`);
  return parsed;
}

/** A 16-character message id, the only spelling `addressableId` admits. */
const THREAD_ROOT = 'BmgJYofni2Q9Glth';

function activePair(conversationId: string, handle: string): DirectPairListItem {
  return {
    conversation_id: conversationId,
    counterpart: {
      status: 'active',
      kind: 'human',
      id: `u_${handle}`,
      name: handle,
      display_name: handle,
      avatar_url: null,
      runtime: null,
    },
    unread_count: 0,
    read_only: false,
    created_at: 1,
  };
}

/** A pair whose other endpoint is gone. The arm carries NO name — that is the fact
 *  under test, not an omission in the fixture. */
function deletedPair(conversationId: string): DirectPairListItem {
  return {
    conversation_id: conversationId,
    counterpart: { status: 'deleted', kind: 'human', id: 'u_gone' },
    unread_count: 0,
    read_only: true,
    created_at: 1,
  };
}

const NO_FACTS: LocatorFacts = {
  workspaceId: null,
  channels: [],
  viewerHandle: null,
  pairs: [],
};

/** A regular workspace row — the only kind whose name this grammar spells. */
function regular(id: string, name: string) {
  return { id, name, owner_agent_id: null };
}

/** An Agent Space: same shape, owned by an agent. Its name lives in a different
 *  namespace (no fold-key uniqueness), so resolution must not see it at all. */
function agentSpace(id: string, name: string) {
  return { id, name, owner_agent_id: 'a_1' };
}

describe('resolveLocatorWorkspaceId', () => {
  it('matches a row whose stored name only folds to the locator segment', () => {
    // The store enforces workspace-name uniqueness on the fold key, so `Silverhand`
    // and `silverhand` ARE one name and a locator written either way must arrive.
    expect(
      resolveLocatorWorkspaceId(loc('silverhand://workspace/silverhand'), [
        regular('w1', 'Silverhand'),
      ]),
    ).toBe('w1');
  });

  it('does not resolve an Agent Space that bears the name', () => {
    // The uniqueness index covers `owner_agent_id IS NULL` only, so an Agent Space is
    // not in this namespace: a coordinate spelling its name names nothing, and making
    // it navigable would send the reader into a container the author never wrote.
    expect(
      resolveLocatorWorkspaceId(loc('silverhand://workspace/norman'), [
        agentSpace('w_agent', 'Norman'),
      ]),
    ).toBe(null);
  });

  it('resolves the regular workspace even beside a same-named Agent Space', () => {
    // The pairing that made the omission visible: with the Agent Space counted, this
    // list read as ambiguous and demoted the ONE legitimate target to inert.
    for (const rows of [
      [regular('w1', 'Silverhand'), agentSpace('w_agent', 'silverhand')],
      [agentSpace('w_agent', 'silverhand'), regular('w1', 'Silverhand')],
    ]) {
      expect(
        resolveLocatorWorkspaceId(loc('silverhand://workspace/silverhand'), rows),
      ).toBe('w1');
    }
  });

  it('refuses when two regular rows fold to the same key', () => {
    // A fence, not a live case: the index makes this unreachable inside the regular
    // namespace, so reaching it means the fold no longer decides what a name is —
    // and picking either row would send the reader somewhere nobody named.
    expect(
      resolveLocatorWorkspaceId(loc('silverhand://workspace/silverhand'), [
        regular('w1', 'Silverhand'),
        regular('w2', 'silverhand'),
      ]),
    ).toBe(null);
  });

  it('is null for a name no row bears, exactly as for a name two rows bear', () => {
    // The single-outcome ruling in its smallest form: absent and ambiguous are the
    // same answer here, so no caller can tell them apart downstream.
    expect(
      resolveLocatorWorkspaceId(loc('silverhand://workspace/other'), [
        regular('w1', 'Silverhand'),
      ]),
    ).toBe(null);
  });

  it('is null for a DM locator, which spells no workspace', () => {
    expect(
      resolveLocatorWorkspaceId(loc('silverhand://dm/Cindy/shiki'), [
        regular('w1', 'Silverhand'),
      ]),
    ).toBe(null);
  });
});

describe('locatorChannelListWorkspaceId', () => {
  it('asks for a list only for a channel locator whose workspace resolved', () => {
    // The cost fence: every other combination must not mount a query at all, and
    // getting it wrong is silent — the chip still renders, it just pays for a list
    // it never reads.
    const channel = loc('silverhand://workspace/silverhand/design');
    expect(locatorChannelListWorkspaceId(channel, 'w1')).toBe('w1');
    expect(locatorChannelListWorkspaceId(channel, null)).toBe(null);
    expect(
      locatorChannelListWorkspaceId(loc('silverhand://workspace/silverhand'), 'w1'),
    ).toBe(null);
    expect(
      locatorChannelListWorkspaceId(loc('silverhand://dm/Cindy/shiki'), 'w1'),
    ).toBe(null);
  });
});

describe('locatorCounterpartHandle', () => {
  it('finds the viewer in either position', () => {
    // The parsed pair is sorted by handle, never by viewer, so both positions have
    // to be checked — the grammar has no "me" slot.
    const pair = loc('silverhand://dm/Cindy/shiki');
    expect(locatorCounterpartHandle(pair, 'shiki')).toBe('Cindy');
    expect(locatorCounterpartHandle(pair, 'Cindy')).toBe('shiki');
  });

  it('is null when the viewer is not an endpoint', () => {
    // A line between two other principals is not a container this viewer has a door
    // to — and refusing it is also what keeps a DM locator posted in a public
    // channel from reporting whether those two have ever talked.
    expect(locatorCounterpartHandle(loc('silverhand://dm/Cindy/Alice'), 'shiki')).toBe(
      null,
    );
  });

  it('is null while the viewer record is cold, and for a non-DM locator', () => {
    expect(locatorCounterpartHandle(loc('silverhand://dm/Cindy/shiki'), null)).toBe(
      null,
    );
    expect(
      locatorCounterpartHandle(loc('silverhand://workspace/silverhand'), 'shiki'),
    ).toBe(null);
  });

  it('compares handles byte-for-byte, as the grammar does', () => {
    // No fold: the product stores no fold key for participant handles, so inventing
    // one here would be a second authority on who a name is.
    expect(locatorCounterpartHandle(loc('silverhand://dm/Cindy/shiki'), 'Shiki')).toBe(
      null,
    );
  });
});

describe('resolveLocatorPairConversationId', () => {
  const pair = loc('silverhand://dm/Cindy/shiki');

  it('returns the existing line with the other endpoint', () => {
    expect(
      resolveLocatorPairConversationId(pair, 'shiki', [
        activePair('c_other', 'Alice'),
        activePair('c_cindy', 'Cindy'),
      ]),
    ).toBe('c_cindy');
  });

  it('is null when the viewer has no line with that handle', () => {
    // The pair list is the COMPLETE set of the viewer's pairs, so an absence is
    // decisive. It must not fall back to the draft route: following a coordinate
    // someone wrote would then open a line rather than read one.
    expect(
      resolveLocatorPairConversationId(pair, 'shiki', [activePair('c_other', 'Alice')]),
    ).toBe(null);
  });

  it('cannot match a deleted counterpart', () => {
    // That arm snapshots no name, and the handle of a deleted principal is released:
    // the locator points at whoever holds it now, which is nobody.
    expect(resolveLocatorPairConversationId(pair, 'shiki', [deletedPair('c_gone')])).toBe(
      null,
    );
  });
});

describe('resolveLocatorTarget', () => {
  it('opens a workspace once its name resolved', () => {
    expect(
      resolveLocatorTarget(loc('silverhand://workspace/silverhand'), {
        ...NO_FACTS,
        workspaceId: 'w1',
      }),
    ).toEqual({ kind: 'workspace', workspaceId: 'w1' });
  });

  it('opens a channel by folded title, carrying the thread root through', () => {
    // The root id is opaque here on purpose: navigability is the CONTAINER's, and
    // the thread pane renders its own not-found state. Asking whether a root message
    // exists would be one request per chip to answer a question the destination
    // already answers.
    expect(
      resolveLocatorTarget(
        loc(`silverhand://workspace/silverhand/UI%2FUX%20优化/${THREAD_ROOT}`),
        {
          ...NO_FACTS,
          workspaceId: 'w1',
          channels: [{ id: 'c1', title: 'ui/ux 优化' }],
        },
      ),
    ).toEqual({
      kind: 'channel',
      workspaceId: 'w1',
      conversationId: 'c1',
      threadRootId: THREAD_ROOT,
      closed: false,
    });
  });

  it('keeps a closed or archived channel navigable, marked quieter', () => {
    // A locator is durable prose and archiving is a normal end-state, not a
    // transition window: the container is still reachable, so the chip dims rather
    // than dies (`ChannelRef` precedent). Both tables are read for the same reason.
    for (const row of [
      { id: 'c1', title: 'design', closed_at: 5 },
      { id: 'c1', title: 'design', archived_at: 5 },
    ]) {
      expect(
        resolveLocatorTarget(loc('silverhand://workspace/silverhand/design'), {
          ...NO_FACTS,
          workspaceId: 'w1',
          channels: [row],
        }),
      ).toMatchObject({ kind: 'channel', conversationId: 'c1', closed: true });
    }
  });

  it('is null for a channel whose workspace has not resolved', () => {
    // Ordering matters: without the workspace there is no list to have read, so a
    // title match here would be a match against some OTHER workspace's channels.
    expect(
      resolveLocatorTarget(loc('silverhand://workspace/silverhand/design'), {
        ...NO_FACTS,
        channels: [{ id: 'c1', title: 'design' }],
      }),
    ).toBe(null);
  });

  it('is null for a channel title no row bears, and for two that do', () => {
    const locator = loc('silverhand://workspace/silverhand/design');
    expect(
      resolveLocatorTarget(locator, {
        ...NO_FACTS,
        workspaceId: 'w1',
        channels: [{ id: 'c1', title: 'other' }],
      }),
    ).toBe(null);
    expect(
      resolveLocatorTarget(locator, {
        ...NO_FACTS,
        workspaceId: 'w1',
        channels: [
          { id: 'c1', title: 'design' },
          { id: 'c2', title: 'Design' },
        ],
      }),
    ).toBe(null);
  });

  it('opens a DM the viewer is an endpoint of, thread root and all', () => {
    expect(
      resolveLocatorTarget(loc(`silverhand://dm/Cindy/shiki/${THREAD_ROOT}`), {
        ...NO_FACTS,
        viewerHandle: 'shiki',
        pairs: [activePair('c_cindy', 'Cindy')],
      }),
    ).toEqual({
      kind: 'direct_pair',
      conversationId: 'c_cindy',
      threadRootId: THREAD_ROOT,
    });
  });

  it('is null for a DM between two other principals', () => {
    expect(
      resolveLocatorTarget(loc('silverhand://dm/Cindy/Alice'), {
        ...NO_FACTS,
        viewerHandle: 'shiki',
        pairs: [activePair('c_cindy', 'Cindy')],
      }),
    ).toBe(null);
  });

  it('is null for every arm when nothing is resolved yet', () => {
    // The cold-read direction is fail-CLOSED: an inert sigil that becomes a chip is
    // an ordinary reveal; a chip that navigates nowhere is a broken control.
    for (const href of [
      'silverhand://workspace/silverhand',
      'silverhand://workspace/silverhand/design',
      'silverhand://dm/Cindy/shiki',
    ]) {
      expect(resolveLocatorTarget(loc(href), NO_FACTS), href).toBe(null);
    }
  });
});
