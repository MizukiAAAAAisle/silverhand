/**
 * #task:2021 (P4-2) — delivery-target RESOLUTION: an address becomes a stream.
 *
 * P4-1's suite owns the grammar (which strings are addresses). This file owns
 * what the grammar cannot decide, and every block below is a way resolution can
 * be WRONG rather than a feature it has:
 *
 *   1. UNKNOWN AND UNAUTHORIZED ARE ONE OUTCOME. A resolver that distinguishes
 *      them is an existence oracle over every conversation in the installation.
 *   2. READS NEVER ALLOCATE. `dm:@handle` on a write may open the pair; a read
 *      that created its subject would turn a typo into a permanent empty
 *      conversation and make "no such stream" unobservable on the retry.
 *   3. AN INBOX IS NOT A WRITE DESTINATION, and the refusal arrives before any
 *      side effect — while someone ELSE's inbox is refused as unresolved, so the
 *      typed inbox refusal cannot be used to probe for one.
 *   4. A THREAD SUFFIX MUST NAME A ROOT OF THE RESOLVED CONVERSATION, with no
 *      normalization of a mid-thread id: two addresses naming one stream is how
 *      an address stops being a coordinate.
 *   5. THE ADDRESS ROUND-TRIPS, for every placement, main line and thread — the
 *      property the delivery header depends on (an agent copies the token it
 *      received back into `--target`).
 *
 * The ports are satisfied by the PRODUCTION repositories, passed directly: the
 * structural port shapes are only worth having if the real adapters fit them, and
 * a hand-written double would let the participation authority drift away from the
 * SQL every other face reads. The one exception is the grammar block, which uses
 * throwing ports on purpose — "no lookup happened" is not observable any other
 * way.
 */
import { describe, expect, it } from 'vitest';
import { formatDeliveryTarget, type ConversationEndpointIdentity } from '@silverhand/shared';
import {
  resolveDeliveryTarget,
  type DeliveryIntent,
  type DeliveryTargetPorts,
  type DeliveryTargetResolution,
} from '../src/application/delivery-target-resolution.js';
import { AgentRepo } from '../src/repos/agent-repo.js';
import { ConversationRepo } from '../src/repos/conversation-repo.js';
import { HostRepo } from '../src/repos/host-repo.js';
import { MessageRepo } from '../src/repos/message-repo.js';
import { UserRepo } from '../src/repos/user-repo.js';
import { WorkspaceRepo } from '../src/repos/workspace-repo.js';
import { buildTestApp, type TestApp } from './utils/app.js';

const NOW = 1_700_000_000_000;
/** A well-formed id (16 base64url characters) that names no row — the "unknown"
 *  half of property 1. Shaped like a real id because a malformed one would be
 *  refused by the grammar and never reach a lookup. */
const MISSING_ID = 'zzzzMISSINGzzz01';

interface Fixture {
  readonly t: TestApp;
  readonly ports: DeliveryTargetPorts;
  readonly conversations: ConversationRepo;
  readonly messages: MessageRepo;
  /** The authenticated principal of every resolution below. */
  readonly alice: { id: string; handle: string };
  /** A second agent: the other end of a DM, and the owner of an inbox alice may
   *  not name. */
  readonly bob: { id: string; handle: string };
  readonly stranger: { id: string; handle: string };
  readonly viewer: { id: string; handle: string };
  /** A workspace channel alice is a member of, and one she is not. */
  readonly room: string;
  readonly secret: string;
  readonly aliceInbox: string;
  readonly bobInbox: string;
}

function setup(): Fixture {
  // Memberships are not fixture-seeded: this file asks who may resolve what, so a
  // trigger that snapshots every fixture principal into every conversation would
  // answer before the code under test does.
  const t = buildTestApp({ seedAllFixtureMemberships: false });
  const agents = new AgentRepo(t.ctx.db);
  const users = new UserRepo(t.ctx.db);
  const conversations = new ConversationRepo(t.ctx.db);
  const messages = new MessageRepo(t.ctx.db);
  const hostId = new HostRepo(t.ctx.db).ensureLocal().id;
  const agent = (handle: string) => ({
    id: agents.create({ name: handle, runtime: 'claude' }, hostId, t.viewerUserId).id,
    handle,
  });
  const alice = agent('dt-alice');
  const bob = agent('dt-bob');
  const stranger = agent('dt-stranger');
  const viewerRow = users.get(t.viewerUserId);
  if (!viewerRow) throw new Error('fixture viewer is missing');

  const ws = new WorkspaceRepo(t.ctx.db).insert({ name: 'dt-ws', description: null });
  const room = conversations.insertChannel({
    workspaceId: ws.id,
    title: 'room',
    name: 'room',
    visibility: 'public',
  }).id;
  conversations.addAgent(room, alice.id);
  // Public visibility on purpose: alice must be refused for NOT PARTICIPATING,
  // not for a visibility rule that would hide the row from any reader.
  const secret = conversations.insertChannel({
    workspaceId: ws.id,
    title: 'secret',
    name: 'secret',
    visibility: 'public',
  }).id;
  conversations.addAgent(secret, bob.id);

  return {
    t,
    ports: { conversations, messages, agents, users },
    conversations,
    messages,
    alice,
    bob,
    stranger,
    viewer: { id: viewerRow.id, handle: viewerRow.name },
    room,
    secret,
    aliceInbox: conversations.insertAgentInbox(alice.id, NOW).id,
    bobInbox: conversations.insertAgentInbox(bob.id, NOW).id,
  };
}

function resolveAs(
  f: Fixture,
  address: string,
  intent: DeliveryIntent,
  agentId?: string,
): DeliveryTargetResolution {
  return resolveDeliveryTarget(f.ports, {
    address,
    principal: { kind: 'agent', id: agentId ?? f.alice.id },
    intent,
    now: NOW,
  });
}

/** The resolved stream, or a failing assertion naming the refusal. */
function expectResolved(result: DeliveryTargetResolution) {
  if (!result.ok) {
    throw new Error(`expected a resolved target, got ${JSON.stringify(result.refusal)}`);
  }
  return result.target;
}

function expectRefusal(result: DeliveryTargetResolution) {
  if (result.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.target)}`);
  }
  return result.refusal;
}

/** How many conversations exist at all — the "a read allocated nothing" oracle.
 *  `list()` is unfiltered (every placement, archived or not), which is what this
 *  assertion needs: a row created behind a refusal must be counted no matter
 *  which arm it landed on. */
function conversationCount(f: Fixture): number {
  return f.conversations.list().length;
}

/** Insert a main-line message and return its id: a reply cluster's root. */
function root(f: Fixture, conversationId: string, content = 'root'): string {
  return f.messages.insertForConversation({
    conversationId,
    fromKind: 'agent',
    fromAgentId: f.alice.id,
    content,
  }).id;
}

describe('the grammar decides first, before any lookup', () => {
  it('refuses a non-address without touching a single port', () => {
    // "No lookup happened" is only observable through the capability itself, so
    // every port here throws. This is also the one property that keeps a
    // malformed string from being a probe: a resolver that looked something up
    // first could time or log a difference.
    const forbidden = (name: string) => (): never => {
      throw new Error(`the resolver reached ${name} for a malformed address`);
    };
    const throwing: DeliveryTargetPorts = {
      conversations: {
        getIdentity: forbidden('getIdentity'),
        isAgentParticipant: forbidden('isAgentParticipant'),
        findDirectPair: forbidden('findDirectPair'),
        getOrCreateDirectPair: forbidden('getOrCreateDirectPair'),
      },
      messages: { getInConversation: forbidden('getInConversation') },
      agents: { getByName: forbidden('agents.getByName') },
      users: { getByName: forbidden('users.getByName') },
    };
    for (const address of [
      '',
      'channel', // the ambient token P4 retires
      `conversation:${MISSING_ID}`, // the pre-P4 `history --target` spelling
      '#conv:c1', // a fixture-shaped id is not a product id
      'dm:shiki', // the handle sigil is part of the grammar
      `#conv:${MISSING_ID} `,
    ]) {
      for (const intent of ['read', 'write'] as const) {
        const refusal = expectRefusal(
          resolveDeliveryTarget(throwing, {
            address,
            principal: { kind: 'agent', id: 'dt-agent' },
            intent,
            now: NOW,
          }),
        );
        expect(refusal, `${address} @ ${intent}`).toEqual({
          code: 'target_malformed',
          operatorReason: 'grammar',
        });
      }
    }
  });
});

describe('unknown and unauthorized are one outcome', () => {
  it('gives the actor the same refusal for a missing id and for someone else’s channel', () => {
    const f = setup();
    try {
      const unknown = expectRefusal(resolveAs(f, `#conv:${MISSING_ID}`, 'read'));
      const unauthorized = expectRefusal(resolveAs(f, `#conv:${f.secret}`, 'read'));
      // The ACTOR-facing part is the code, and it is identical. Asserted together
      // with the refusal's SHAPE: the collapse is only real if a route cannot
      // serialize a second distinguishing field by accident, so a new field would
      // fail here and have to be justified.
      expect(Object.keys(unknown).sort()).toEqual(['code', 'operatorReason']);
      expect(unknown.code).toBe('target_unresolved');
      expect(unauthorized.code).toBe(unknown.code);
      // The OPERATOR can still tell them apart in a log — that is what the second
      // field is for, and it is why the first assertion is not vacuous.
      expect(unknown.operatorReason).toBe('conversation_not_found');
      expect(unauthorized.operatorReason).toBe('not_participant');
    } finally {
      f.t.cleanup();
    }
  });

  it('applies the same collapse to a DM between two other principals', () => {
    const f = setup();
    try {
      const theirs = f.conversations.getOrCreateDirectPair(
        { kind: 'agent', id: f.bob.id },
        { kind: 'agent', id: f.stranger.id },
        NOW,
      ).conversation.id;
      // A DM's id is as pasteable as a channel's, and its participant rule is a
      // different SQL arm — so the arm, not just the code path, has to collapse.
      for (const intent of ['read', 'write'] as const) {
        expect(expectRefusal(resolveAs(f, `#conv:${theirs}`, intent))).toEqual({
          code: 'target_unresolved',
          operatorReason: 'not_participant',
        });
      }
      // …and the endpoints themselves still resolve it, so the gate did not simply
      // refuse the placement.
      expect(expectResolved(resolveAs(f, `#conv:${theirs}`, 'write', f.bob.id)).stream)
        .toEqual({ conversationId: theirs, threadRootId: null });
    } finally {
      f.t.cleanup();
    }
  });

  it('resolves a channel through its roster and a DM through its endpoints', () => {
    const f = setup();
    try {
      expect(expectResolved(resolveAs(f, `#conv:${f.room}`, 'write'))).toEqual({
        stream: { conversationId: f.room, threadRootId: null },
        placementKind: 'workspace',
        created: false,
      });
      const pair = expectResolved(resolveAs(f, `dm:@${f.bob.handle}`, 'write'));
      expect(pair.placementKind).toBe('direct_pair');
      expect(expectResolved(resolveAs(f, `#conv:${pair.stream.conversationId}`, 'read')))
        .toEqual({ ...pair, created: false });
    } finally {
      f.t.cleanup();
    }
  });
});

describe('a write may open a direct pair; a read never allocates', () => {
  it('opens the pair once, for either principal kind, and says so exactly once', () => {
    const f = setup();
    try {
      for (const handle of [f.bob.handle, f.viewer.handle]) {
        const opened = expectResolved(resolveAs(f, `dm:@${handle}`, 'write'));
        expect(opened.created, handle).toBe(true);
        const again = expectResolved(resolveAs(f, `dm:@${handle}`, 'write'));
        expect(again.created, handle).toBe(false);
        expect(again.stream, handle).toEqual(opened.stream);
        // One aggregate for `agent↔agent` and `agent↔human` alike: the endpoint
        // kind is data, not a second mechanism.
        expect(again.placementKind, handle).toBe('direct_pair');
      }
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses a read for a pair that does not exist, and writes no row', () => {
    const f = setup();
    try {
      const before = conversationCount(f);
      expect(expectRefusal(resolveAs(f, `dm:@${f.stranger.handle}`, 'read'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'direct_pair_not_found',
      });
      expect(conversationCount(f)).toBe(before);
      // And the refusal is not a one-shot: a resolver that allocated would let the
      // second attempt succeed, which is precisely how "no such stream" would stop
      // being observable.
      expect(expectRefusal(resolveAs(f, `dm:@${f.stranger.handle}`, 'read')).operatorReason)
        .toBe('direct_pair_not_found');
      expect(conversationCount(f)).toBe(before);
    } finally {
      f.t.cleanup();
    }
  });

  it('does not open a pair in order to refuse its thread', () => {
    const f = setup();
    try {
      const before = conversationCount(f);
      // A brand-new pair has no reply cluster, so creating it first would leave a
      // conversation behind a refusal: the resolver's one side effect must not
      // outlive a rejected resolution.
      expect(
        expectRefusal(resolveAs(f, `dm:@${f.stranger.handle}/thread:${MISSING_ID}`, 'write')),
      ).toEqual({ code: 'target_unresolved', operatorReason: 'direct_pair_not_found' });
      expect(conversationCount(f)).toBe(before);
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses a DM with yourself, and a handle nobody holds, without writing', () => {
    const f = setup();
    try {
      const before = conversationCount(f);
      expect(expectRefusal(resolveAs(f, `dm:@${f.alice.handle}`, 'write'))).toEqual({
        code: 'self_pair_not_addressable',
        operatorReason: 'self_pair',
      });
      expect(expectRefusal(resolveAs(f, 'dm:@nobody', 'write'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'unknown_handle',
      });
      expect(conversationCount(f)).toBe(before);
    } finally {
      f.t.cleanup();
    }
  });
});

describe('an inbox is a read face, not a write destination', () => {
  it('resolves the agent’s own inbox for a read and refuses the write', () => {
    const f = setup();
    try {
      expect(expectResolved(resolveAs(f, `#conv:${f.aliceInbox}`, 'read'))).toEqual({
        stream: { conversationId: f.aliceInbox, threadRootId: null },
        placementKind: 'agent_inbox',
        created: false,
      });
      const before = conversationCount(f);
      expect(expectRefusal(resolveAs(f, `#conv:${f.aliceInbox}`, 'write'))).toEqual({
        code: 'inbox_not_writable',
        operatorReason: 'inbox_write',
      });
      // The typed refusal arrives before any effect. Structurally it must: the
      // resolver's only side-effecting port is the pair constructor, which this
      // arm never reaches — asserted rather than argued.
      expect(conversationCount(f)).toBe(before);
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses someone else’s inbox as unresolved, so the typed refusal is not a probe', () => {
    const f = setup();
    try {
      // If a non-participant got `inbox_not_writable` here, the refusal code would
      // report "this id is an inbox" about a row they may not see.
      for (const intent of ['read', 'write'] as const) {
        expect(expectRefusal(resolveAs(f, `#conv:${f.bobInbox}`, intent))).toEqual({
          code: 'target_unresolved',
          operatorReason: 'not_participant',
        });
      }
    } finally {
      f.t.cleanup();
    }
  });
});

describe('a thread suffix names a root of the resolved conversation', () => {
  it('resolves a root of this conversation', () => {
    const f = setup();
    try {
      const rootId = root(f, f.room);
      expect(expectResolved(resolveAs(f, `#conv:${f.room}/thread:${rootId}`, 'write'))).toEqual({
        stream: { conversationId: f.room, threadRootId: rootId },
        placementKind: 'workspace',
        created: false,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses a root that belongs to another conversation, or to nothing', () => {
    const f = setup();
    try {
      const elsewhere = root(f, f.secret, 'not alice’s room');
      for (const rootId of [elsewhere, MISSING_ID]) {
        expect(
          expectRefusal(resolveAs(f, `#conv:${f.room}/thread:${rootId}`, 'write')),
          rootId,
        ).toEqual({ code: 'thread_not_in_target', operatorReason: 'thread_root_not_found' });
      }
      // Both cases are ONE refusal: the message lookup is scoped by conversation,
      // so "that root is in a channel you are not in" is never distinguishable
      // from "no such message" — the same collapse as an unknown conversation.
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses a mid-thread reply id instead of normalizing it to its root', () => {
    const f = setup();
    try {
      const rootId = root(f, f.room);
      const reply = f.messages.insertForConversation({
        conversationId: f.room,
        fromKind: 'agent',
        fromAgentId: f.alice.id,
        content: 'reply',
        threadRootId: rootId,
      }).id;
      expect(expectRefusal(resolveAs(f, `#conv:${f.room}/thread:${reply}`, 'write'))).toEqual({
        code: 'thread_not_in_target',
        operatorReason: 'thread_root_not_a_root',
      });
      // Repairing this to `rootId` would make two different addresses name one
      // stream, and the repaired one would round-trip to the OTHER spelling — an
      // address that is not a coordinate.
      expect(expectResolved(resolveAs(f, `#conv:${f.room}/thread:${rootId}`, 'write')).stream)
        .toEqual({ conversationId: f.room, threadRootId: rootId });
    } finally {
      f.t.cleanup();
    }
  });
});

describe('the address round-trips, for every placement', () => {
  it('re-resolves its own rendered form, main line and thread alike', () => {
    const f = setup();
    try {
      const pair = expectResolved(resolveAs(f, `dm:@${f.bob.handle}`, 'write')).stream
        .conversationId;
      // Every placement the product has (§4.1), each in both streams. `read`
      // throughout: the inbox arm refuses a write by rule, and round-tripping is a
      // property of the ADDRESS, not of the intent.
      const cases: Array<[string, string]> = [
        ['workspace', f.room],
        ['direct_pair', pair],
        ['agent_inbox', f.aliceInbox],
      ];
      for (const [placement, conversationId] of cases) {
        for (const threadRootId of [null, root(f, conversationId)]) {
          const address = threadRootId === null
            ? `#conv:${conversationId}`
            : `#conv:${conversationId}/thread:${threadRootId}`;
          const first = expectResolved(resolveAs(f, address, 'read'));
          expect(first.placementKind, placement).toBe(placement);
          expect(first.stream, address).toEqual({ conversationId, threadRootId });
          // The header renders this, the agent copies it back, and it must land on
          // the same stream — the whole reason the target is a value object.
          const rendered = formatDeliveryTarget(first.stream);
          expect(rendered, address).toBe(address);
          expect(expectResolved(resolveAs(f, rendered, 'read')).stream, rendered)
            .toEqual(first.stream);
        }
      }
    } finally {
      f.t.cleanup();
    }
  });

  it('resolves the pair the same way from either endpoint’s first person', () => {
    const f = setup();
    try {
      const fromAlice = expectResolved(resolveAs(f, `dm:@${f.bob.handle}`, 'write')).stream;
      const fromBob = expectResolved(
        resolveAs(f, `dm:@${f.alice.handle}`, 'write', f.bob.id),
      ).stream;
      // One aggregate, two first persons: the shorthand is viewer-relative and the
      // canonical address is not, which is exactly why only the latter may reach a
      // header.
      expect(fromBob).toEqual(fromAlice);
      const endpoints: ConversationEndpointIdentity[] = [
        { kind: 'agent', id: f.alice.id },
        { kind: 'agent', id: f.bob.id },
      ];
      expect(f.conversations.findDirectPair(endpoints[0]!, endpoints[1]!)?.id)
        .toBe(fromAlice.conversationId);
    } finally {
      f.t.cleanup();
    }
  });
});
