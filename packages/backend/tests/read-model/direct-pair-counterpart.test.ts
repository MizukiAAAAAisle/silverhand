/**
 * `resolveCounterpart` — the ONE resolver of a `direct_pair`'s "other side",
 * shared by the viewer DM list (#task:2035) and the owner-audit chats list
 * (#task:2036 part ②). A pure unit test: the function takes a row, a reference
 * endpoint, and a principal resolver, and returns the wire value object for the
 * endpoint that is NOT the reference. No DB — the resolver is a stub.
 *
 * The load-bearing case is the fail-loud contract the module states for itself:
 * exactly one of the two endpoints must equal the reference. A `find(e => e !==
 * reference)` spelling would name the FIRST endpoint whenever the reference
 * matches NEITHER — silently drawing a stranger's line, the one failure a
 * counterpart face must never produce. These A/B positive controls plus the
 * neither-match counterexample pin that the resolver takes the genuine other
 * side and throws otherwise, rather than trusting the caller's enumeration to
 * always contain the reference.
 */
import { describe, expect, it } from 'vitest';
import type {
  ConversationEndpointIdentity,
  ConversationEndpointRef,
} from '@silverhand/shared';
import {
  resolveCounterpart,
  type LivePrincipal,
  type PrincipalResolver,
} from '../../src/read-model/direct-pair-counterpart.js';

const AGENT: ConversationEndpointIdentity = { kind: 'agent', id: 'agent_1' };
const HUMAN: ConversationEndpointIdentity = { kind: 'human', id: 'user_1' };
const STRANGER: ConversationEndpointIdentity = { kind: 'human', id: 'user_stranger' };

/** A live-principal stub keyed by `kind:id`; any endpoint absent from the map
 *  resolves to a MISS (the `deleted` state), so a test can pin either arm. */
function resolverOf(
  live: Record<string, LivePrincipal>,
): PrincipalResolver {
  return endpoint => live[`${endpoint.kind}:${endpoint.id}`] ?? null;
}

const AGENT_PRINCIPAL: LivePrincipal = {
  name: 'assistant',
  display_name: 'Assistant',
  avatar_url: null,
  runtime: 'claude',
};
const HUMAN_PRINCIPAL: LivePrincipal = {
  name: 'teammate',
  display_name: 'Teammate',
  avatar_url: null,
  runtime: null,
};

/** A `direct_pair` row with the agent in slot A and the human in slot B — the
 *  canonical stored order this test builds both references against. */
function pairRow(): ConversationEndpointRef & { id: string } {
  return {
    id: 'conv_pair',
    placement_kind: 'direct_pair',
    endpoint_a_kind: 'agent',
    endpoint_a_id: 'agent_1',
    endpoint_b_kind: 'human',
    endpoint_b_id: 'user_1',
    endpoint_a_deleted_at: null,
    endpoint_b_deleted_at: null,
  };
}

describe('resolveCounterpart', () => {
  const resolve = resolverOf({
    'agent:agent_1': AGENT_PRINCIPAL,
    'human:user_1': HUMAN_PRINCIPAL,
  });

  it('reference in slot A → counterpart is slot B (the human)', () => {
    const counterpart = resolveCounterpart(pairRow(), AGENT, resolve);
    expect(counterpart).toMatchObject({
      status: 'active',
      kind: 'human',
      id: 'user_1',
      name: 'teammate',
    });
  });

  it('reference in slot B → counterpart is slot A (the agent)', () => {
    const counterpart = resolveCounterpart(pairRow(), HUMAN, resolve);
    expect(counterpart).toMatchObject({
      status: 'active',
      kind: 'agent',
      id: 'agent_1',
      name: 'assistant',
      runtime: 'claude',
    });
  });

  it('reference matching NEITHER endpoint throws — never silently names slot A', () => {
    // The counterexample the `find(e => e !== reference)` spelling gets wrong: a
    // reference this row does not contain must fail loud, not hand back the human
    // (slot A of the "not me" scan) as though it were the stranger's counterpart.
    expect(() => resolveCounterpart(pairRow(), STRANGER, resolve)).toThrow(
      /does not name human:user_stranger as exactly one endpoint/,
    );
  });

  it('a non-direct_pair row throws', () => {
    const channel: ConversationEndpointRef & { id: string } = {
      id: 'conv_channel',
      placement_kind: 'workspace',
      endpoint_a_kind: null,
      endpoint_a_id: null,
      endpoint_b_kind: null,
      endpoint_b_id: null,
      endpoint_a_deleted_at: null,
      endpoint_b_deleted_at: null,
    };
    expect(() => resolveCounterpart(channel, AGENT, resolve)).toThrow(
      /is not a direct_pair/,
    );
  });
});
