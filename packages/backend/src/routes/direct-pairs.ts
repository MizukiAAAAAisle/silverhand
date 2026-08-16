// Direct-pairs route (#task:2035, extended by #task:2036): the viewer's Direct
// Messages list, and the door that OPENS a line.
//
// Viewer-scoped and WORKSPACE-FREE by construction. Every other conversation
// list hangs off a workspace (`GET /api/workspaces/:id/channels`), and a
// `direct_pair` cannot: it has no workspace coordinate, so there is no `:id` that
// could carry it. That absence is the placement's definition, which is why this
// is a face of its own rather than a filter on an existing one.
//
// TWO SURFACES. The GET reports the lines that already exist. The POST opens a
// NEW line from the agent's own page (#task:2036): a person pressing "Message"
// resolves no address — a human client posts where the person is looking, so
// there is nothing for `resolveDeliveryTarget` to parse — and so reaches the
// mint through `openDirectPair` directly rather than through the addressed
// resolver. It is keyed by AGENT id because a brand-new line has no conversation
// id yet; subsequent messages go through the ordinary channel-messages door on
// the resolved pair.
//
// LAZY ALLOCATE (@shiki #task:2036). Opening the page / composing / cancelling is
// a client-side draft and touches nothing here: no pair is minted until a person
// actually SENDS. The mint is get-or-create, so a person who opens and backs out
// leaves no row. The door below is therefore also the allocation point, and its
// ORDERING is load-bearing (@Cindy #task:2036): the initiation gate and every
// side-effect-free door-local preflight (schema, content cap, reply target) run
// BEFORE `openDirectPair`, so an unauthorized or malformed request cannot leave an
// empty line behind. The mint happens the moment that preflight passes and the
// send intent is committed — NOT "only on success": a downstream domain/persistence
// failure AFTER the mint may leave an announced empty line, which is the same
// acceptable resolve-then-send window the agent side already has, and is proven
// intentional by a counter-example test rather than smoothed over here. What is
// idempotent under a double-submit is the pair ALLOCATION (get-or-create resolves
// to one row, one announcement), not the POST — two sends post two messages.
//
// Auth/principal is inherited from the parent api app middleware.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  apiPaths,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_MESSAGE_CONTENT_LABEL,
  MESSAGE_SEND_MAX_BODY_BYTES,
  messageContentByteLength,
  messageContentExceedsLimit,
  normalizeAttachmentRefs,
  SendMessageInputSchema,
  type ConversationEndpointIdentity,
  type DirectPairListResponse,
  type MessageSendAck,
} from '@silverhand/shared';
import type { AppEnv } from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import {
  getPrincipal,
  getUserPrincipal,
  requireViewerUserId,
} from '../auth/principal.js';
import { canInitiateDirectMessageToAgent, canViewAgent, canViewOwnedState } from '../permissions.js';
import { openDirectPair } from '../application/open-direct-pair.js';
import { openDirectPairPorts } from '../repos/delivery-target-persistence.js';
import { conversationMessageServiceErrorResponse } from './responses.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { DirectPairsReadModel } from '../read-model/direct-pairs.js';

export interface DirectPairsRouteDeps {
  ctx: BackendContext;
  /** The projection, handle bound at composition time (#task:1983 W2). */
  directPairs: DirectPairsReadModel;
  /** For the first-send mint (#task:2036). The door hands only the two ports
   *  `openDirectPair` needs, assembled by `openDirectPairPorts`; it never
   *  reaches the resolver's lookup surface, which it has no address to use. */
  conversations: ConversationRepo;
}

export function createDirectPairsApp(deps: DirectPairsRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { ctx, directPairs, conversations } = deps;

  // GET the viewer's existing DM lines. The gate is owned-state, exactly like
  // Activity and Favorites: the question "which lines do I have" is a fact about
  // the viewer, and the read model already scopes every row to pairs the viewer
  // is an ENDPOINT of, through the single placement authority. There is no
  // per-entity membership check to add on top — for a `direct_pair` the endpoint
  // coordinates ARE the membership.
  app.get(apiPaths.directPairs, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const dto: DirectPairListResponse = directPairs.list({ viewerUserId });
    return c.json(dto);
  });

  // Pre-parse bound: reject oversized bodies (declared or chunked) before
  // buffering/JSON.parse, mirroring the channel-messages door. The precise UTF-8
  // content cap is enforced after parse — and, like every other refusal on this
  // door, before any pair is minted.
  const sendBodyLimit = bodyLimit({
    maxSize: MESSAGE_SEND_MAX_BODY_BYTES,
    onError: c =>
      c.json(
        {
          error: 'request body exceeds message-send bound',
          code: 'content_too_large',
          max_body_bytes: MESSAGE_SEND_MAX_BODY_BYTES,
        },
        413,
      ),
  });

  // POST the FIRST message to an agent, opening the line if it does not exist
  // (#task:2036). Keyed by agent id: a brand-new line has no conversation id.
  //
  // ORDER IS THE CONTRACT (@Cindy #task:2036). Everything that can refuse without
  // a side effect runs first — initiation authority, body bound, schema, the
  // reply-target rejection, the content cap — so that an unauthorized or
  // malformed request produces zero pair and zero `direct_pairs_changed`. Only
  // after all of them does `openDirectPair` mint (and announce) the row, and only
  // then is the message sent. A failure in that last step may leave an empty
  // line, which is intentional and identical to the agent side's resolve-then-send
  // window; the list, not this response, is the authority for what exists.
  app.post(apiPaths.agentDirectMessages(':id'), sendBodyLimit, async c => {
    const agentId = c.req.param('id');
    if (!agentId) return c.json({ error: 'agent id required' }, 400);

    // Gate 1 — a two-step ladder, exactly like `GET /api/agents/:id`.
    //
    // First, ANTI-ENUMERATION: a principal who cannot even see the agent's page
    // gets 404, so a stranger probing agent ids cannot tell an id that exists
    // from one that does not (an unviewable and a nonexistent agent are one
    // answer). Only then, INITIATION AUTHORITY — the ONE named home of "who may
    // open a DM" (`canInitiateDirectMessageToAgent`), deliberately distinct from
    // page visibility and from the owner audit ACL. Its verdict includes the
    // target's session scope, so a viewable-but-conversation-scoped agent (whose
    // human entry stays its workspace/Agent Space) and an agent principal both
    // fall here, as 403 — honest to a caller who can already see the page.
    const principal = getPrincipal(c);
    if (!canViewAgent(ctx, principal, agentId)) {
      return c.json({ error: 'not found' }, 404);
    }
    if (!canInitiateDirectMessageToAgent(ctx, principal, agentId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // The gates above admitted only a user principal, so this cannot throw.
    const viewerUserId = requireViewerUserId(c);

    // `bodyLimit` signals a chunked-body overflow by erroring the wrapped stream
    // mid-read; rethrow so the middleware converts it to 413 rather than letting
    // the parse failure collapse to `{}` → 400.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      if (err instanceof Error && err.name === 'BodyLimitError') throw err;
      body = {};
    }
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // A first send cannot target a reply cluster: a brand-new line has none. This
    // is an ill-formed request for THIS door, not a delivery failure — so it is
    // refused here, before allocation, rather than surfacing after the pair
    // exists. Replies happen on the resolved pair through the channel-messages door.
    if (parsed.data.reply_to_message_id) {
      return c.json(
        {
          error: 'cannot open a direct-message line into a reply cluster',
          code: 'reply_to_unsupported',
        },
        400,
      );
    }
    if (messageContentExceedsLimit(parsed.data.content)) {
      return c.json(
        {
          error: `message content exceeds ${MAX_MESSAGE_CONTENT_LABEL} limit`,
          code: 'content_too_large',
          max_bytes: MAX_MESSAGE_CONTENT_BYTES,
          actual_bytes: messageContentByteLength(parsed.data.content),
        },
        413,
      );
    }

    // Every refusal above was side-effect-free. Only now mint the line. The mint
    // is get-or-create, so a retried or raced first send resolves to the one row
    // (and only the winner announces it — see `open-direct-pair.ts`).
    const me: ConversationEndpointIdentity = { kind: 'human', id: viewerUserId };
    const them: ConversationEndpointIdentity = { kind: 'agent', id: agentId };
    const conversation = openDirectPair(
      openDirectPairPorts({ conversations, events: ctx.events }),
      me,
      them,
      Date.now(),
    );

    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: conversation.id,
        actor: getUserPrincipal(c),
        content: parsed.data.content,
        attachmentRefs: normalizeAttachmentRefs(parsed.data.attachment_ids),
        // The first message opens the line's main stream; there is no other
        // placement a first send could name (the reply-cluster case was refused
        // above). Same shape as the channel-messages door's main-line send.
        destination: { kind: 'own_main_line' },
      });
      // Echo the committed payload VERBATIM plus the sender-only unresolved-
      // references sibling, identically to the channel-messages door: one
      // idempotent apply seam over ACK and WS echo, and the omit-when-empty rule
      // proven by the destructure rather than a length check.
      const [firstUnresolved, ...restUnresolved] = result.unresolvedReferences;
      const ack: MessageSendAck = {
        ...result.committed,
        ...(firstUnresolved
          ? { unresolved_references: [firstUnresolved, ...restUnresolved] }
          : {}),
      };
      return c.json(ack, 201);
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return app;
}
