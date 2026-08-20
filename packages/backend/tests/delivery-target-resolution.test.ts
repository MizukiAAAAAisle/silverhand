/**
 * #task:2021 (P4-2) — delivery-target RESOLUTION: an address becomes a stream.
 *
 * P4-1's suite owns the grammar (which strings are addresses). This file owns
 * what the grammar cannot decide, and every block below is a way resolution can
 * be WRONG rather than a feature it has:
 *
 *   1. UNKNOWN AND UNAUTHORIZED ARE ONE OUTCOME. A resolver that distinguishes
 *      them is an existence oracle over every conversation in the installation —
 *      so the answer holds the code ALONE (two refusals sharing a code are
 *      byte-identical) and the branch leaves through an operator-only port.
 *   2. READS NEVER ALLOCATE. `dm:@handle` on a write may open the pair; a read
 *      that created its subject would turn a typo into a permanent empty
 *      conversation and make "no such stream" unobservable on the retry.
 *   3. A THREAD SUFFIX MUST NAME A ROOT OF THE RESOLVED CONVERSATION, with no
 *      normalization of a mid-thread id: two addresses naming one stream is how
 *      an address stops being a coordinate.
 *   4. THE ADDRESS ROUND-TRIPS, for every placement, main line and thread — the
 *      property the delivery header depends on (an agent copies the token it
 *      received back into `--target`).
 *
 * Property 1 is enforced on EVERY case rather than in one block: `expectRefusal`
 * asserts the actor-facing key set and reads the branch from the recorded operator
 * report, so a test cannot even name a reason without going through the port that
 * the actor has no access to.
 *
 * The ports are satisfied by the PRODUCTION repositories, passed directly: the
 * structural port shapes are only worth having if the real adapters fit them, and
 * a hand-written double would let the participation authority drift away from the
 * SQL every other face reads. The one exception is the grammar block, which uses
 * throwing ports on purpose — "no lookup happened" is not observable any other
 * way.
 */
import { fixedWorkspaceName } from '@silverhand/shared';
import { describe, expect, it } from 'vitest';
import {
  fixedConversationTitle,
  formatDeliveryTarget,
  type ConversationEndpointIdentity,
} from '@silverhand/shared';
import {
  resolveDeliveryTarget,
  type DeliveryAllocation,
  type DeliveryIntent,
  type DeliveryTargetPorts,
  type DeliveryTargetRefusalReport,
  type DeliveryTargetResolution,
} from '../src/application/delivery-target-resolution.js';
import { deliveryTargetWorkspacesPort } from '../src/application/workspace-address-resolution.js';
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
  /** Every refusal the resolver reported to the OPERATOR, in order. Drained one
   *  at a time by `expectRefusal`: the actor's object cannot answer "which
   *  branch", so this queue is the only place a test can read it. */
  readonly observed: DeliveryTargetRefusalReport[];
  /** Every pair this fixture's resolutions ANNOUNCED, in order — the conversation
   *  ids passed to the required allocation port. Since #task:2035 (@Cindy B4) the
   *  announcement is the second half of the mint rather than a `created` flag on
   *  the answer, so this queue, not a field, is where a test reads "this call
   *  opened the line". */
  readonly announced: string[];
  readonly conversations: ConversationRepo;
  readonly messages: MessageRepo;
  /** The authenticated principal of every resolution below. */
  readonly alice: { id: string; handle: string };
  /** A second agent: the other end of a DM alice may open. */
  readonly bob: { id: string; handle: string };
  readonly stranger: { id: string; handle: string };
  readonly viewer: { id: string; handle: string };
  /** A workspace channel alice is a member of, and one she is not. */
  readonly room: string;
  readonly secret: string;
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

  const workspaces = new WorkspaceRepo(t.ctx.db);
  const ws = workspaces.insert({ name: fixedWorkspaceName('dt-ws'), description: null });
  const room = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('room'),
    visibility: 'public',
  }).id;
  conversations.addAgent(room, alice.id);
  // Public visibility on purpose: alice must be refused for NOT PARTICIPATING,
  // not for a visibility rule that would hide the row from any reader.
  const secret = conversations.insertChannel({
    workspaceId: ws.id,
    title: fixedConversationTitle('secret'),
    visibility: 'public',
  }).id;
  conversations.addAgent(secret, bob.id);

  const observed: DeliveryTargetRefusalReport[] = [];
  const announced: string[] = [];

  return {
    t,
    ports: {
      conversations,
      workspaces: deliveryTargetWorkspacesPort({ workspaces, logger: t.ctx.logger }),
      messages,
      agents,
      users,
      observer: {
        refused: (report) => {
          observed.push(report);
        },
      },
      allocations: {
        directPairOpened: (conversationId) => {
          announced.push(conversationId);
        },
      },
    },
    observed,
    announced,
    conversations,
    messages,
    alice,
    bob,
    stranger,
    viewer: { id: viewerRow.id, handle: viewerRow.name },
    room,
    secret,
  };
}

function resolveAs(
  f: Fixture,
  address: string,
  intent: DeliveryIntent,
  agentId?: string,
  allocation: DeliveryAllocation = 'permitted',
): DeliveryTargetResolution {
  return resolveDeliveryTarget(f.ports, {
    address,
    principal: { kind: 'agent', id: agentId ?? f.alice.id },
    intent,
    allocation,
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

/**
 * A refusal, read the way the two audiences read it: the CODE from the answer and
 * the BRANCH from the operator report, joined only here in the test.
 *
 * Asserts on the way through that the actor's object holds nothing but the code,
 * and that the refusal produced exactly one operator record — so every case in
 * this file re-proves the collapse instead of trusting one dedicated block.
 */
function expectRefusal(
  f: Fixture,
  result: DeliveryTargetResolution,
): Pick<DeliveryTargetRefusalReport, 'code' | 'operatorReason'> {
  if (result.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.target)}`);
  }
  expect(Object.keys(result.refusal)).toEqual(['code']);
  const report = f.observed.shift();
  if (report === undefined) {
    throw new Error(`refused ${result.refusal.code} without telling the operator`);
  }
  expect(f.observed, 'one refusal, one operator record').toHaveLength(0);
  expect(report.code).toBe(result.refusal.code);
  return { code: result.refusal.code, operatorReason: report.operatorReason };
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
    // The observer is the one port a refusal DOES reach: it is not a lookup, it is
    // where the branch goes instead of into the answer.
    const observed: DeliveryTargetRefusalReport[] = [];
    const throwing: DeliveryTargetPorts = {
      conversations: {
        getIdentity: forbidden('getIdentity'),
        findWorkspaceTitle: forbidden('findWorkspaceTitle'),
        isAgentParticipant: forbidden('isAgentParticipant'),
        findDirectPair: forbidden('findDirectPair'),
        getOrCreateDirectPair: forbidden('getOrCreateDirectPair'),
      },
      workspaces: { resolveRegularRoot: forbidden('resolveRegularRoot') },
      messages: { getInConversation: forbidden('getInConversation') },
      agents: { getByName: forbidden('agents.getByName') },
      users: { getByName: forbidden('users.getByName') },
      observer: {
        refused: (report) => {
          observed.push(report);
        },
      },
      allocations: {
        // A malformed address must not reach the effect either: the announcement
        // is the mint's second half, so "no lookup happened" now also means
        // "nothing was announced".
        directPairOpened: forbidden('directPairOpened'),
      },
    };
    for (const address of [
      '',
      'channel', // the ambient token P4 retires
      `conversation:${MISSING_ID}`, // the pre-P4 `history --target` spelling
      '#conv:c1', // a fixture-shaped id is not a product id
      'dm:shiki', // the handle sigil is part of the grammar
      `#conv:${MISSING_ID} `,
      '#dt-ws', // a root with no channel names nothing
      '#dt-ws/room/extra',
      '#dt-ws/%2Groom', // not a canonical escape
    ]) {
      for (const intent of ['read', 'write'] as const) {
        const result = resolveDeliveryTarget(throwing, {
          address,
          principal: { kind: 'agent', id: 'dt-agent' },
          intent,
          allocation: 'permitted',
          now: NOW,
        });
        expect(result.ok, `${address} @ ${intent}`).toBe(false);
        if (result.ok) continue;
        // Malformed stays DISTINCT from unresolved: telling the actor their string
        // is not an address is the only way they can fix it, and it is exactly the
        // case where nothing was looked up.
        expect(result.refusal, `${address} @ ${intent}`).toEqual({ code: 'target_malformed' });
        expect(observed.shift(), `${address} @ ${intent}`).toEqual({
          code: 'target_malformed',
          operatorReason: 'grammar',
          address,
          principalId: 'dt-agent',
          intent,
        });
      }
    }
    expect(observed).toHaveLength(0);
  });
});

describe('unknown and unauthorized are one outcome', () => {
  it('gives the actor the same refusal for a missing id and for someone else’s channel', () => {
    const f = setup();
    try {
      const unknown = resolveAs(f, `#conv:${MISSING_ID}`, 'read');
      const unauthorized = resolveAs(f, `#conv:${f.secret}`, 'read');
      // (1) The two ANSWERS are the same object, not merely the same code: no
      // field distinguishes them, so a route cannot leak the distinction by
      // serializing what it was given, and nobody has to remember to strip
      // anything. Compared as JSON as well, because that is literally what a
      // route does with it.
      expect(unknown).toEqual(unauthorized);
      expect(JSON.stringify(unknown)).toBe(JSON.stringify(unauthorized));
      expect(unknown.ok).toBe(false);
      if (unknown.ok) return;
      expect(Object.keys(unknown.refusal)).toEqual(['code']);
      expect(unknown.refusal.code).toBe('target_unresolved');
      // (2) The OPERATOR still gets the branch, through the port — which is why
      // the collapse above costs no observability.
      expect(f.observed.map((r) => r.operatorReason)).toEqual([
        'conversation_not_found',
        'not_participant',
      ]);
      expect(f.observed.map((r) => r.address)).toEqual([
        `#conv:${MISSING_ID}`,
        `#conv:${f.secret}`,
      ]);
      f.observed.length = 0;
    } finally {
      f.t.cleanup();
    }
  });

  it('makes every pair of branches that share a code indistinguishable to the actor', () => {
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
      // Every branch the resolver has, addressed by the way it is reached. The
      // collapse is a property of the RETURN TYPE, so it has to hold for all of
      // them at once — not just for the conversation lookup that motivated it.
      const branches: Array<[string, DeliveryIntent, string]> = [
        [`#conv:${MISSING_ID}`, 'read', 'conversation_not_found'],
        [`#conv:${f.secret}`, 'read', 'not_participant'],
        ['dm:@nobody', 'write', 'unknown_handle'],
        [`dm:@${f.stranger.handle}`, 'read', 'direct_pair_not_found'],
        [`#conv:${f.room}/thread:${MISSING_ID}`, 'read', 'thread_root_not_found'],
        [`#conv:${f.room}/thread:${reply}`, 'read', 'thread_root_not_a_root'],
        [`dm:@${f.alice.handle}`, 'write', 'self_pair'],
      ];
      const answers = new Map<string, string[]>();
      for (const [address, intent, operatorReason] of branches) {
        const result = resolveAs(f, address, intent);
        const refusal = expectRefusal(f, result);
        expect(refusal.operatorReason, address).toBe(operatorReason);
        const serialized = JSON.stringify(result);
        const seen = answers.get(refusal.code) ?? [];
        seen.push(serialized);
        answers.set(refusal.code, seen);
      }
      // Four branches answer `target_unresolved` and two answer
      // `thread_not_in_target`; within a code every answer is byte-identical.
      expect([...answers.keys()].sort()).toEqual([
        'self_pair_not_addressable',
        'target_unresolved',
        'thread_not_in_target',
      ]);
      expect(answers.get('target_unresolved')).toHaveLength(4);
      expect(answers.get('thread_not_in_target')).toHaveLength(2);
      for (const [code, serialized] of answers) {
        expect(new Set(serialized).size, code).toBe(1);
      }
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
        expect(expectRefusal(f, resolveAs(f, `#conv:${theirs}`, intent))).toEqual({
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
      });
      const pair = expectResolved(resolveAs(f, `dm:@${f.bob.handle}`, 'write'));
      expect(pair.placementKind).toBe('direct_pair');
      expect(expectResolved(resolveAs(f, `#conv:${pair.stream.conversationId}`, 'read')))
        .toEqual(pair);
    } finally {
      f.t.cleanup();
    }
  });
});

describe('a readable head resolves through two authorities', () => {
  const named = (workspace: string, title: string, thread?: string) =>
    `#${workspace}/${title}${thread === undefined ? '' : `/thread:${thread}`}`;

  it('names the same stream the id form names', () => {
    const f = setup();
    try {
      const rootId = root(f, f.room);
      for (const intent of ['read', 'write'] as const) {
        expect(expectResolved(resolveAs(f, named('dt-ws', 'room'), intent))).toEqual(
          expectResolved(resolveAs(f, `#conv:${f.room}`, intent)),
        );
        expect(
          expectResolved(resolveAs(f, named('dt-ws', 'room', rootId), intent)),
        ).toEqual(expectResolved(resolveAs(f, `#conv:${f.room}/thread:${rootId}`, intent)));
      }
      // The RESOLVED value is the id form for both spellings: a readable address is
      // an input coordinate, and what the header renders and a stored field keeps
      // is the stream. Nothing downstream can tell which spelling was typed, so a
      // rename cannot invalidate anything that was already resolved.
      expect(expectResolved(resolveAs(f, named('dt-ws', 'room'), 'read')).stream).toEqual({
        conversationId: f.room,
        threadRootId: null,
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('folds case in the LOOKUP, and refuses a non-canonical spelling outright', () => {
    const f = setup();
    try {
      // Both segments are compared on the stored folded key, so the case a person
      // typed does not have to match the case a channel was created with — the
      // uniqueness constraint is case-insensitive, so at most one row can answer.
      for (const address of [
        named('DT-WS', 'ROOM'),
        named('dt-Ws', 'Room'),
        named('dt-ws', 'room'),
      ]) {
        expect(expectResolved(resolveAs(f, address, 'read')).stream, address).toEqual({
          conversationId: f.room,
          threadRootId: null,
        });
      }
      // Tolerance stops at the fold. A NORMALIZATION difference is `target_malformed`
      // from the grammar, not a repaired lookup: one title, one spelling.
      for (const address of [named('dt-ws', '%20room'), named('dt-ws', 'ro%6Fm')]) {
        expect(expectRefusal(f, resolveAs(f, address, 'read')), address).toEqual({
          code: 'target_malformed',
          operatorReason: 'grammar',
        });
      }
    } finally {
      f.t.cleanup();
    }
  });

  it('gives the actor one answer for an unknown root, an unknown title and someone else’s channel', () => {
    const f = setup();
    try {
      // The readable form matters MORE here than the id form: an id is 16 random
      // characters and cannot be guessed, while a workspace name and a channel
      // title can be. If any of these three were distinguishable, a non-member
      // could enumerate the installation's channels by name.
      const answers = new Map<string, string[]>();
      const branches: Array<[string, string]> = [
        [named('nope-ws', 'room'), 'workspace_not_found'],
        [named('dt-ws', 'nope-room'), 'title_not_found'],
        [named('dt-ws', 'secret'), 'not_participant'],
      ];
      for (const [address, operatorReason] of branches) {
        const result = resolveAs(f, address, 'read');
        const refusal = expectRefusal(f, result);
        expect(refusal, address).toEqual({ code: 'target_unresolved', operatorReason });
        const seen = answers.get(refusal.code) ?? [];
        seen.push(JSON.stringify(result));
        answers.set(refusal.code, seen);
      }
      expect([...answers.keys()]).toEqual(['target_unresolved']);
      expect(new Set(answers.get('target_unresolved')).size).toBe(1);
      // …and byte-identical to the id form's, so the two spellings do not even
      // disclose WHICH ONE was used to probe.
      const byId = resolveAs(f, `#conv:${MISSING_ID}`, 'read');
      expectRefusal(f, byId);
      expect(JSON.stringify(byId)).toBe(answers.get('target_unresolved')![0]);
    } finally {
      f.t.cleanup();
    }
  });

  it('cannot name a conversation in an agent-home workspace', () => {
    const f = setup();
    try {
      // The root namespace is REGULAR-only, so an agent's private workspace has no
      // address root at all — which is why `agent_home` is a RENDERING fallback and
      // never a resolution outcome. Named by the home workspace's DISPLAY name,
      // which is the agent's handle: the refusal must come from the namespace, not
      // from the name being unspellable.
      const workspaces = new WorkspaceRepo(f.t.ctx.db);
      const home =
        workspaces.getAgentHomeByOwner(f.alice.id) ??
        workspaces.insertAgentHome({ agent: { id: f.alice.id, name: f.alice.handle } });
      const inside = f.conversations.insertChannel({
        workspaceId: home.id,
        title: fixedConversationTitle('notes'),
        visibility: 'private',
      }).id;
      f.conversations.addAgent(inside, f.alice.id);
      // The id form still resolves it — alice participates, so this is not a
      // permission difference: the NAME simply does not address it.
      expect(expectResolved(resolveAs(f, `#conv:${inside}`, 'write')).stream).toEqual({
        conversationId: inside,
        threadRootId: null,
      });
      expect(expectRefusal(f, resolveAs(f, named(f.alice.handle, 'notes'), 'write'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'workspace_not_found',
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('keeps resolving when the workspace is archived', () => {
    const f = setup();
    try {
      // Resolution answers "which stream is this"; whether it accepts a message now
      // is the write gate's question. An address that stopped resolving on archive
      // would mean an agent could no longer even name the conversation it is
      // quoting — and because the answer only reaches a PARTICIPANT (rule 2), it is
      // not an existence oracle either.
      const workspaces = new WorkspaceRepo(f.t.ctx.db);
      const ws = workspaces.getByName(fixedWorkspaceName('dt-ws'));
      if (!ws) throw new Error('fixture workspace is missing');
      expect(workspaces.setArchived(ws.id, true)).not.toBeNull();
      expect(expectResolved(resolveAs(f, named('dt-ws', 'room'), 'read')).stream).toEqual({
        conversationId: f.room,
        threadRootId: null,
      });
      // The collapse still holds for a non-participant, so archiving does not turn
      // the name into a probe with a different answer.
      expect(expectRefusal(f, resolveAs(f, named('dt-ws', 'secret'), 'read'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'not_participant',
      });
    } finally {
      f.t.cleanup();
    }
  });

  it('follows a rename, and stops answering at the old name', () => {
    const f = setup();
    try {
      // A name-shaped address is a COORDINATE, not an allocation (@shiki's accepted
      // cost): the moment a title moves, the new name resolves and the old one is
      // free — indistinguishable from a name nobody ever held. Nothing may be built
      // on the old name continuing to point anywhere.
      f.conversations.updateTitle(f.room, fixedConversationTitle('lounge'));
      expect(expectResolved(resolveAs(f, named('dt-ws', 'lounge'), 'read')).stream).toEqual({
        conversationId: f.room,
        threadRootId: null,
      });
      expect(expectRefusal(f, resolveAs(f, named('dt-ws', 'room'), 'read'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'title_not_found',
      });
      // The id form is unaffected, which is why it is what the header renders and
      // what durable fields keep.
      expect(expectResolved(resolveAs(f, `#conv:${f.room}`, 'read')).stream).toEqual({
        conversationId: f.room,
        threadRootId: null,
      });
    } finally {
      f.t.cleanup();
    }
  });
});

describe('a write may open a direct pair; a read never allocates', () => {
  it('opens the pair once, for either principal kind, and announces it exactly once', () => {
    const f = setup();
    try {
      for (const handle of [f.bob.handle, f.viewer.handle]) {
        const opened = expectResolved(resolveAs(f, `dm:@${handle}`, 'write'));
        // The mint announced itself. `created` is deliberately NOT on the answer
        // any more: an obligation a caller could forget is what let a second door
        // mint a pair in silence (#task:2035 @Cindy B4).
        expect(f.announced, handle).toEqual([opened.stream.conversationId]);
        f.announced.length = 0;
        const again = expectResolved(resolveAs(f, `dm:@${handle}`, 'write'));
        // The get-or-create loser announces NOTHING: the row did not come into
        // existence on this call, so no list changed.
        expect(f.announced, handle).toEqual([]);
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
      expect(expectRefusal(f, resolveAs(f, `dm:@${f.stranger.handle}`, 'read'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'direct_pair_not_found',
      });
      expect(conversationCount(f)).toBe(before);
      // And the refusal is not a one-shot: a resolver that allocated would let the
      // second attempt succeed, which is precisely how "no such stream" would stop
      // being observable.
      expect(expectRefusal(f, resolveAs(f, `dm:@${f.stranger.handle}`, 'read')).operatorReason)
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
        expectRefusal(f, resolveAs(f, `dm:@${f.stranger.handle}/thread:${MISSING_ID}`, 'write')),
      ).toEqual({ code: 'target_unresolved', operatorReason: 'direct_pair_not_found' });
      expect(conversationCount(f)).toBe(before);
    } finally {
      f.t.cleanup();
    }
  });

  it('a write whose caller may not allocate FINDS instead of minting', () => {
    const f = setup();
    try {
      const before = conversationCount(f);
      // `allocation: 'forbidden'` is the confined doors' setting (#task:2021 P4-4):
      // their reach refusal comes one step later, so the pair they would have opened
      // must not exist by then. A pair that does not exist is simply unresolved…
      expect(
        expectRefusal(f, resolveAs(f, `dm:@${f.stranger.handle}`, 'write', undefined, 'forbidden')),
      ).toEqual({ code: 'target_unresolved', operatorReason: 'direct_pair_not_found' });
      expect(conversationCount(f)).toBe(before);
      // …and one that does resolves exactly as it would have, so forbidding
      // allocation changes no outcome that was going to be permitted.
      const opened = expectResolved(resolveAs(f, `dm:@${f.bob.handle}`, 'write'));
      expect(f.announced).toEqual([opened.stream.conversationId]);
      f.announced.length = 0;
      const found = expectResolved(
        resolveAs(f, `dm:@${f.bob.handle}`, 'write', undefined, 'forbidden'),
      );
      expect(found).toEqual(opened);
      // A find allocates nothing, so it announces nothing.
      expect(f.announced).toEqual([]);
      // It is NOT a downgrade to `intent: 'read'` — it says "do not mint", not
      // "this is a read", and a read of a pair that does not exist is refused for
      // the same reason a forbidden write is. Since #task:2072 retired the last
      // placement-specific WRITE rule the resolver has none left that separates
      // them, so what the second axis buys is carried by the caller's reach step
      // (`delivery-reach.ts`), not by an outcome observable here.
    } finally {
      f.t.cleanup();
    }
  });

  it('refuses a DM with yourself, and a handle nobody holds, without writing', () => {
    const f = setup();
    try {
      const before = conversationCount(f);
      expect(expectRefusal(f, resolveAs(f, `dm:@${f.alice.handle}`, 'write'))).toEqual({
        code: 'self_pair_not_addressable',
        operatorReason: 'self_pair',
      });
      expect(expectRefusal(f, resolveAs(f, 'dm:@nobody', 'write'))).toEqual({
        code: 'target_unresolved',
        operatorReason: 'unknown_handle',
      });
      expect(conversationCount(f)).toBe(before);
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
          expectRefusal(f, resolveAs(f, `#conv:${f.room}/thread:${rootId}`, 'write')),
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
      expect(expectRefusal(f, resolveAs(f, `#conv:${f.room}/thread:${reply}`, 'write'))).toEqual({
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
      // throughout: round-tripping is a property of the ADDRESS, not of the intent.
      const cases: Array<[string, string]> = [
        ['workspace', f.room],
        ['direct_pair', pair],
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
