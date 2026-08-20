import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import {
  channelServiceErrorResponse,
  conversationMessageServiceErrorResponse,
} from '../../src/routes/responses.js';
import { TargetError } from '../../src/services/conversation-message-service.js';
import {
  ActorError as SendActorError,
  ConversationError as SendConversationError,
  type ActorErrorCode as SendActorErrorCode,
  type ConversationErrorCode as SendConversationErrorCode,
} from '../../src/services/conversation-message-service.js';
import {
  ActorError,
  type ActorErrorCode,
  MemberError,
  SeedError,
  WorkspaceUnsuitableError,
} from '../../src/services/channel-service.js';
import { ChannelError } from '../../src/services/channel/errors.js';

/** Drive the mapper through a real Hono context and return the HTTP status
 *  it produces (500 when the mapper declines to map the error). */
async function statusFor(err: unknown): Promise<number> {
  const app = new Hono();
  app.get('/', c =>
    conversationMessageServiceErrorResponse(c, err) ?? c.text('unmapped', 500),
  );
  const res = await app.request('/');
  return res.status;
}

describe('conversationMessageServiceErrorResponse — TargetError mapping', () => {
  it('maps reply_target_not_found to 404 (not a 400 bad request)', async () => {
    expect(
      await statusFor(
        new TargetError('reply_target_not_found', 'reply target not found'),
      ),
    ).toBe(404);
  });
});

/**
 * Golden code→status table for the channel domain's error surface (#task:1981
 * §9.9). The channel service used to raise a structurally-typed `RepoError`
 * and now raises its own driver-free `ChannelError`; this table is the wire
 * contract stated independently of `repoErrorStatusMap`, so a change to that
 * table (or to the branch ORDER in the mapper, which is what keeps
 * `ChannelError` from falling through to the generic 400) reddens here.
 *
 * `body.code` is asserted too: the renderer branches on the code, so a status
 * that survives while the code changes is still a break.
 */
async function channelMapping(err: unknown): Promise<{ status: number; code: unknown }> {
  const app = new Hono();
  app.get('/', c => channelServiceErrorResponse(c, err) ?? c.text('unmapped', 500));
  const res = await app.request('/');
  if (res.status === 500) return { status: 500, code: null };
  return { status: res.status, code: ((await res.json()) as { code?: unknown }).code };
}

/** Same driver, WHOLE body — used where the absence of a field is the contract
 *  and a `code`-only assertion would pass on a body that grew one. */
async function channelBody(err: unknown): Promise<{ status: number; body: unknown }> {
  const app = new Hono();
  app.get('/', c => channelServiceErrorResponse(c, err) ?? c.text('unmapped', 500));
  const res = await app.request('/');
  return { status: res.status, body: await res.json() };
}

describe('channelServiceErrorResponse — channel-domain status parity', () => {
  const GOLDEN: Array<{ err: unknown; code: string; status: number }> = [
    // ChannelError is exhaustive over ChannelErrorCode ('not_found').
    { err: new ChannelError('not_found', 'channel not found'), code: 'not_found', status: 404 },
    {
      err: new WorkspaceUnsuitableError('workspace_not_found', 'gone'),
      code: 'workspace_not_found',
      status: 404,
    },
    {
      err: new WorkspaceUnsuitableError('workspace_not_regular', 'dm home'),
      code: 'workspace_not_regular',
      status: 400,
    },
    {
      err: new WorkspaceUnsuitableError('workspace_not_agent_home', 'regular'),
      code: 'workspace_not_agent_home',
      status: 400,
    },
    { err: new MemberError('agent_not_found', 'a1', 'no agent'), code: 'agent_not_found', status: 400 },
    {
      err: new MemberError('agent_not_workspace_member', 'a1', 'outsider'),
      code: 'agent_not_workspace_member',
      status: 400,
    },
    {
      err: new MemberError('user_not_workspace_member', 'u1', 'outsider'),
      code: 'user_not_workspace_member',
      status: 400,
    },
    {
      err: new SeedError('seed_requires_agent_actor', 'need agent actor'),
      code: 'seed_requires_agent_actor',
      status: 400,
    },
    // The actor gate's own rendering is exhaustive over `ActorErrorCode` in
    // `ACTOR_WIRE` below, not enumerated here.
  ];

  for (const row of GOLDEN) {
    it(`maps ${(row.err as Error).name} ${row.code} to ${row.status}`, async () => {
      expect(await channelMapping(row.err)).toEqual({ status: row.status, code: row.code });
    });
  }

  it('still maps the generic repo-error shape other services share (not_found stays 404)', async () => {
    const err = Object.assign(new Error('gone'), { code: 'not_found' });
    expect(await channelMapping(err)).toEqual({ status: 404, code: 'not_found' });
  });

  it('declines to map an untyped error rather than inventing a 400', async () => {
    expect(await channelMapping(new Error('boom'))).toEqual({ status: 500, code: null });
  });
});

/**
 * The actor gate's wire rendering, EXHAUSTIVE OVER `ActorErrorCode` BY TYPE: a
 * new member of that union fails to compile until its rendering is declared
 * here. That missing obligation is exactly how `user_cannot_govern_workspace`
 * (#task:1987) reached the wire as a brand-new code + message with no arm to
 * redden. Bodies are stated WHOLE — for the governance refusal the ABSENCE of
 * `code` is the contract, and a `code`-only assertion would pass on a body that
 * grew one.
 */
const ACTOR_WIRE: Record<
  ActorErrorCode,
  { status: number; body: Record<string, unknown> }
> = {
  // "the thing you named does not exist" (404) vs "it exists and you may not
  // use it" (403).
  agent_not_found: { status: 404, body: { error: 'forged', code: 'agent_not_found' } },
  source_conversation_not_found: {
    status: 404,
    body: { error: 'forged', code: 'source_conversation_not_found' },
  },
  agent_not_member_of_source_conv: {
    status: 403,
    body: { error: 'forged', code: 'agent_not_member_of_source_conv' },
  },
  agent_workspace_mismatch: {
    status: 403,
    body: { error: 'forged', code: 'agent_workspace_mismatch' },
  },
  agent_cannot_create_public: {
    status: 403,
    body: { error: 'forged', code: 'agent_cannot_create_public' },
  },
  // The in-lock governance refusal renders as the route's OWN pre-lock body:
  // no `code`, and the internal message dropped. Route parity is pinned in
  // `channels.test.ts`.
  user_cannot_govern_workspace: { status: 403, body: { error: 'forbidden' } },
};

describe('channelServiceErrorResponse — ActorError wire rendering', () => {
  for (const [code, expected] of Object.entries(ACTOR_WIRE)) {
    it(`renders ${code} as ${expected.status} ${JSON.stringify(expected.body)}`, async () => {
      expect(
        await channelBody(new ActorError(code as ActorErrorCode, 'forged')),
      ).toEqual({ status: expected.status, body: expected.body });
    });
  }
});

/** Drive the send mapper and return status + wire code together: the renderer
 *  and the CLI both branch on the code, so a status that survives while the code
 *  drifts is still a break. */
async function sendMapping(err: unknown): Promise<{ status: number; code: unknown }> {
  const app = new Hono();
  app.get('/', c =>
    conversationMessageServiceErrorResponse(c, err) ?? c.text('unmapped', 500),
  );
  const res = await app.request('/');
  if (res.status === 500) return { status: 500, code: null };
  return { status: res.status, code: ((await res.json()) as { code?: unknown }).code };
}

/**
 * The send path's conversation-level refusals, EXHAUSTIVE OVER
 * `ConversationErrorCode` BY TYPE: a new member of that union fails to compile
 * until its status is declared here. Written as a type-keyed table for the same
 * reason as `ACTOR_WIRE` above — `conversation_endpoint_gone` (#task:2021 P4-4)
 * is exactly the kind of code that reaches the wire with no arm to redden.
 *
 * The 403/409 split is the contract, not a detail: a lifecycle 409 invites a
 * retry, and the `direct_pair` narrowing is a state that NEVER becomes postable
 * again. 403 is also what `canPostToConversation` already answers to the same
 * fact at the request layer, so the in-transaction re-check reporting a
 * different status would make one refusal look like two.
 */
const SEND_CONVERSATION_WIRE: Record<SendConversationErrorCode, number> = {
  conversation_not_found: 404,
  conversation_closed: 409,
  conversation_archived: 409,
  conversation_endpoint_gone: 403,
};

describe('conversationMessageServiceErrorResponse — ConversationError mapping', () => {
  for (const [code, status] of Object.entries(SEND_CONVERSATION_WIRE)) {
    it(`maps ${code} to ${status}`, async () => {
      expect(
        await sendMapping(
          new SendConversationError(code as SendConversationErrorCode, 'refused'),
        ),
      ).toEqual({ status, code });
    });
  }
});

/**
 * Same discipline for the send path's actor refusals: "the thing you named does
 * not exist" (404) vs "it exists and you may not post here" (403).
 */
const SEND_ACTOR_WIRE: Record<SendActorErrorCode, number> = {
  agent_not_found: 404,
  agent_not_participant_of_conversation: 403,
  // The human arm of the SAME gate (#task:2021 P4-4, @Cindy B7). Same 403 as its
  // agent counterpart and as the route's own pre-transaction refusal, and a
  // separate code only so an operator reading a person's refused send is not
  // handed an `agent_…` one. No 404 twin: an id naming nobody simply holds no
  // seat, endpoint or membership, so it is refused as a non-participant.
  user_not_participant_of_conversation: 403,
};

describe('conversationMessageServiceErrorResponse — ActorError mapping', () => {
  for (const [code, status] of Object.entries(SEND_ACTOR_WIRE)) {
    it(`maps ${code} to ${status}`, async () => {
      expect(
        await sendMapping(new SendActorError(code as SendActorErrorCode, 'refused')),
      ).toEqual({ status, code });
    });
  }
});
