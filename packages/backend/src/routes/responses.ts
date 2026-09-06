// Shared HTTP result-mapping helpers for per-context route modules. These
// adapters own status-code mapping after use cases or services return typed
// results. They live in a neutral leaf so route modules can share them without
// import cycles.
import { type Context } from 'hono';
import type { ReactionMutationAck } from '@silverhand/shared';
import { RuntimeHostPlacementError } from '../host-placement-errors.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import type { AddConversationMemberResult } from '../application/conversation-member.js';
import type { ReactionResult } from '../application/react-message.js';
import type { RepoError } from '../repos/conversation-repo.js';
import {
  ActorError as ChannelActorError,
  MemberError,
  SeedError,
  WorkspaceUnsuitableError,
} from '../services/channel-service.js';
import { ChannelError } from '../services/channel/errors.js';
import {
  ActorError as MessageActorError,
  AttachmentError as MessageAttachmentError,
  ConversationError,
  ClientMessageConflict,
  MessageStaleError,
  PolicyError,
  TargetError,
} from '../services/conversation-message-service.js';
import {
  ScheduleError,
  type ScheduleErrorCode,
} from '../services/schedule-service.js';
import { AgentServiceError } from '../services/agent-service.js';

const placementErrorStatusMap: Record<
  string,
  400 | 403 | 404 | 409 | 503
> = {
  agent_missing: 404,
  host_missing: 404,
  host_not_owned: 403,
  host_pending_attach: 409,
  host_runtime_disabled: 409,
  host_revoked: 409,
  local_host_unbound: 409,
  // Multi-host placement ambiguity. 409 (Conflict) matches
  // `local_host_unbound` semantics: the route's required precondition
  // (a single resolvable local host) does not hold, the caller can
  // recover by picking an explicit `host_id`. Distinct code lets the
  // renderer surface a "you have N hosts — pick one" UX instead of the
  // "no daemon found" UX it shows for `local_host_unbound`.
  local_host_ambiguous: 409,
  // Transient transport-down → 503 Service Unavailable. Differs from
  // `host_runtime_disabled` (409: standalone
  // backend, no daemon at all — config decision) by carrying
  // "try again in a moment" semantics rather than "this server
  // mode never runs agents".
  host_attach_pending: 503,
};

/**
 * Map a narrow subset of `HostWsCommandTransportError` codes to the typed
 * `host_attach_pending` placement-error code.
 *
 * **Why narrow**: only the two transport codes that mean "host is
 * temporarily unreachable" are collapsed into `host_attach_pending`:
 *   - `transport_no_connection` — host record resolved by placement,
 *     but no live WS connection at send time.
 *   - `transport_disconnected` — WS connection dropped between
 *     dispatch and send.
 *
 * Other `HostWsCommandTransportError` codes have different recovery
 * semantics and intentionally fall through to the generic 400
 * fallback in `startConversationAgent` / `stopConversationAgent`:
 *   - `transport_timeout` — daemon ACK'd receipt but never
 *     responded; could be a daemon bug, not "attach pending".
 *   - `transport_send_failed` — local WS write failure; could be a
 *     backend bug, not the daemon's problem.
 *   - `transport_invalid_command` — payload schema mismatch;
 *     protocol bug, callers must not retry blindly.
 *   - `transport_response_mismatch` — protocol bug, same.
 *
 * This is load-bearing: don't collapse all transport errors into one
 * user-facing code.
 */
function mapTransportErrorToPlacement(
  err: unknown,
): RuntimeHostPlacementError | null {
  if (!(err instanceof HostWsCommandTransportError)) return null;
  if (
    err.code !== 'transport_no_connection'
    && err.code !== 'transport_disconnected'
  ) {
    return null;
  }
  return new RuntimeHostPlacementError(
    'host_attach_pending',
    `daemon host ${err.details.hostId} is not currently attached; retry in a moment`,
  );
}

/**
 * Standalone-mode "this action needs a daemon-host runtime" rejection. Shared
 * by the host router and `GET /api/runtimes` without a `routes/hosts.ts →
 * routes.ts` import cycle. Status defaults to 409 (config decision: this server
 * mode is control-plane only); callers pass 503 when the runtime is expected
 * but transiently absent.
 */
export function hostRuntimeDisabledResponse(
  c: Context,
  action: string,
  status: 409 | 503 = 409,
): Response {
  return c.json(
    {
      error: `${action} requires a daemon-host runtime; standalone server mode is control-plane only until D2`,
      code: 'host_runtime_disabled',
    },
    status,
  );
}

export function placementErrorResponse(c: Context, err: unknown): Response | null {
  // RuntimeHostPlacementError thrown by `placement.resolveForAgent`
  // (pre-send) — direct match.
  if (err instanceof RuntimeHostPlacementError) {
    return c.json(
      { error: err.message, code: err.code },
      placementErrorStatusMap[err.code] ?? 400,
    );
  }
  // HostWsCommandTransportError thrown by the outbound dispatcher AFTER
  // placement resolved — promote the narrow "host unreachable" subset to
  // `host_attach_pending`.
  const promoted = mapTransportErrorToPlacement(err);
  if (promoted) {
    return c.json(
      { error: promoted.message, code: promoted.code },
      placementErrorStatusMap[promoted.code] ?? 400,
    );
  }
  return null;
}

/**
 * Map an {@link AddConversationMemberResult} to an HTTP response. The use case
 * is HTTP-agnostic; this adapter owns the status-code mapping for
 * both the public and internal member-add routes. Error shapes are preserved.
 */
export function conversationMemberResultResponse(
  c: Context,
  result: AddConversationMemberResult,
): Response {
  if (result.ok) return c.json({ members: result.members });
  const error = result.error;
  switch (error.code) {
    case 'conversation_not_found':
      return c.json({ error: 'conversation not found' }, 404);
    case 'conversation_member_add_unsupported':
      return c.json(
        {
          error: 'conversation members can only be added to channels or threads',
          code: 'conversation_member_add_unsupported',
        },
        422,
      );
    case 'conversation_closed':
      return c.json({ error: 'conversation is closed', code: 'conversation_closed' }, 409);
    case 'forbidden':
      return c.json({ error: 'forbidden' }, 403);
    case 'candidate_not_found':
      return c.json({ error: error.message, code: 'candidate_not_found' }, 404);
    case 'workspace_membership_required':
      return c.json({ error: error.message, code: 'workspace_membership_required' }, 422);
    case 'agent_not_owned':
      // #task:1681 — joining this conversation would enroll the agent into the
      // workspace, which is its creator's call. 403 (not 404) so the surface can
      // state the rule.
      // #task:1683 — the same code now also answers a plain channel member who
      // reached for someone else's agent that is ALREADY in the workspace.
      //
      // TWO causes, so the message must be their INTERSECTION (Cindy, #task:1683
      // review): "only its creator can bring it in" is true of the enrollment
      // cause but FALSE of the second one — a workspace admin may add an
      // already-enrolled foreign agent to a channel. What both causes share is
      // only that this caller did not create this agent, so that is all this
      // message asserts; which OTHER actor could succeed is a matrix cell and
      // belongs to the surface, which knows the viewer's role. The narrower
      // creator-only sentence stays on the two pure-enrollment producers
      // (workspace add, create-workspace initial members).
      return c.json(
        {
          error: 'you are not authorized to add this agent — you did not create it',
          code: 'agent_not_owned',
        },
        403,
      );
    case 'handle_ambiguous':
      return c.json(
        { error: 'handle is ambiguous', code: 'handle_ambiguous', candidates: error.candidates },
        422,
      );
  }
}

/**
 * Map a {@link ReactionResult} (add/remove) to an HTTP response. Shared by
 * the human `/api/messages/:id/reactions` and internal agent `react-message`
 * routes so both surfaces emit the same status/code set
 * (docs/reactions-design.md §5).
 *
 * The success body is typed as the shared {@link ReactionMutationAck}, the one
 * shape both surfaces promise their callers (§5.3), so a field drifting here must
 * break the build, not a live surface.
 */
export function reactionResultResponse(
  c: Context,
  result: ReactionResult,
): Response {
  if (result.ok) {
    const ack: ReactionMutationAck = {
      changed: result.changed,
      emoji: result.emoji,
      count: result.count,
    };
    return c.json(ack);
  }
  const error = result.error;
  switch (error.code) {
    case 'invalid_reaction':
      return c.json({ error: error.message, code: 'invalid_reaction' }, 422);
    case 'message_not_found':
      return c.json({ error: error.message, code: 'message_not_found' }, 404);
    case 'system_message_not_reactable':
      return c.json(
        { error: error.message, code: 'system_message_not_reactable' },
        422,
      );
    case 'conversation_not_found':
      return c.json({ error: error.message, code: 'conversation_not_found' }, 404);
    case 'forbidden':
      return c.json({ error: error.message, code: 'forbidden' }, 403);
    case 'conversation_closed':
      return c.json({ error: error.message, code: 'conversation_closed' }, 409);
    case 'conversation_archived':
      return c.json({ error: error.message, code: 'conversation_archived' }, 409);
  }
}

// --- Service-error -> HTTP response mappers ---
// Shared by public API routers and the internal-agent router without reverse
// imports. Private helpers stay module-private here; only the mappers are
// exported.

function isRepoError(err: unknown): err is RepoError {
  return err instanceof Error && typeof (err as RepoError).code === 'string';
}

const repoErrorStatusMap: Record<string, 400 | 404 | 409 | 429> = {
  concurrent_limit: 429,
  spawn_cooldown: 429,
  not_found: 404,
  thread: 400,
  not_archivable: 400,
  not_renamable: 400,
  // #task:2016 — the addressing refusals. `conversation_title_taken` is a
  // CONFLICT (well-formed request; another channel in this workspace already
  // shows that title, and the title is the address); `not_addressable` is a bad
  // request (this conversation holds no address at all — see `ChannelErrorCode`).
  //
  // `not_addressable` is SHADOWED at today's only wire entrance: the sole caller
  // of `renameChannel` is the human PATCH door, which gates on
  // `canGovernConversationWorkspace(..., 'admin')`, and a conversation with no
  // workspace admits only a `system` principal — a principal that door cannot
  // carry (`getUserPrincipal` throws on it). So the addressless case is refused
  // 403 before addressability is asked, and the mapping below exists for the
  // SERVICE contract (proved in `tests/services/channel-service.test.ts`), not
  // for a reachable HTTP shape. Kept rather than dropped because the alternative
  // for a future non-human caller is a 500, and the cost is this one row.
  conversation_title_taken: 409,
  not_addressable: 400,
};

export function channelServiceErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof WorkspaceUnsuitableError) {
    return c.json(
      { error: err.message, code: err.code },
      err.code === 'workspace_not_found' ? 404 : 400,
    );
  }
  if (err instanceof MemberError || err instanceof SeedError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof ChannelActorError) {
    // The commit-time governance refusal (#task:1987) is the SAME refusal as the
    // route's own pre-lock gate — `workspaces.ts` answers `{ error: 'forbidden' }`
    // / 403 when the actor cannot govern the workspace — only observed one lock
    // later, where the role is re-derived. Rendering it identically is the
    // decision, not an omission: a client can do nothing different about "you
    // still lacked the capability at commit time", and giving the seam its own
    // code + message would publish an internal concurrency reason as public
    // protocol. So this code never reaches the wire; `responses.test.ts`'s
    // exhaustive actor table and the parity case in `channels.test.ts` pin both
    // halves of that claim.
    if (err.code === 'user_cannot_govern_workspace') {
      return c.json({ error: 'forbidden' }, 403);
    }
    const status =
      err.code === 'source_conversation_not_found' || err.code === 'agent_not_found'
        ? 404
        : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  // The channel domain's own driver-free error (#task:1981). It used to be a
  // `RepoError` raised by the service, and it maps through the SAME status
  // table so the HTTP contract is unchanged — this branch pins that, rather
  // than relying on `isRepoError`'s structural `code` check to keep catching it.
  if (err instanceof ChannelError) {
    return c.json(
      { error: err.message, code: err.code },
      repoErrorStatusMap[err.code] ?? 400,
    );
  }
  if (isRepoError(err)) {
    return c.json(
      { error: err.message, code: err.code },
      repoErrorStatusMap[err.code] ?? 400,
    );
  }
  return null;
}

export function conversationMessageServiceErrorResponse(
  c: Context,
  err: unknown,
): Response | null {
  if (err instanceof ClientMessageConflict) return c.json({error: err.message, code: 'client_message_conflict'}, 409);
  if (err instanceof ConversationError) {
    // 404 for "no such conversation"; 403 for the `direct_pair` narrowing, whose
    // fact is an AUTHORIZATION one and is what `canPostToConversation` already
    // answers 403 to at the request layer (#task:2021 P4-4) — the in-transaction
    // re-check must not report the same refusal as a lifecycle 409, or a client
    // would retry a state that never changes; 409 for the lifecycle codes.
    const status =
      err.code === 'conversation_not_found'
        ? 404
        : err.code === 'conversation_endpoint_gone'
          ? 403
          : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof MessageActorError) {
    const status = err.code === 'agent_not_found' ? 404 : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof TargetError) {
    // 404 for a reply target that is not in the conversation — the same answer
    // the resolver gives an address that names nothing. 409 for the freshness
    // assertion mismatch: the sender's view of where it is has to be re-earned,
    // which is exactly the retry the stale conflict asks for (#task:2021 P4-4).
    const status = err.code === 'reply_target_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof PolicyError) {
    return c.json({ error: err.message, code: err.code }, 400);
  }
  if (err instanceof MessageAttachmentError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.attachmentId ? { attachment_id: err.attachmentId } : {}),
      },
      400,
    );
  }
  if (err instanceof MessageStaleError) {
    // Signal-only stale contract (thread MzSv_f1u0e0xbKmH, shiki seq 1205),
    // re-based on the #task:2095 freshness model: staleness is a property of
    // THIS RUNTIME's field of view — it has an undelivered inbox row it must
    // consume — not a per-stream sequence position. So the 409 carries only
    // pointer metadata: the arming id and a hint. It NEVER carries message
    // bodies, and — deliberately — NO count of what is undelivered. Under the
    // old model a count meant re-deriving the freshness universe (a second,
    // drift-prone definition); under this one an `EXISTS` probe would make a
    // COUNT trivially cheap, which is exactly why the temptation must be
    // refused: "how far behind" is not part of this contract. Bodies are
    // released exactly once, through the normal inbox/admission face, and the
    // runtime's undelivered set drains via admission evidence, not via this
    // response. The hint keeps the current turn actionable while that pending
    // content continues through the existing normal-delivery path.
    //
    // #task:1614: this hint is deliberately the ONLY prompt surface that
    // mentions `message stale-receive` — the command's sole legal calling
    // context is an unresolved message_stale, so the one-shot hint here
    // is its entire discovery path (shiki + Cindy, 2026-07-25). Do not
    // add it to the persistent platform prompt.
    return c.json(
      {
        error: {
          code: 'conflict',
          message: err.message,
          details: {
            // `subkind` is the WIRE DISCRIMINANT: the daemon's
            // `extractStaleConflict` hard-compares it to `message_stale`
            // before arming (see `MessageStaleError`). `stale_event_id` is the
            // arming id the runtime replays into `stale-receive`.
            //
            // The old `seen_up_to_seq`/`current_seq`/`stream_key` fields
            // addressed the retired per-stream seq CAS axis and all their
            // consumers went with it. `target_conversation_id` is NOT one of
            // them (#task:2095 F17): it is the conversation the rejected send
            // TARGETED — a property every send has, surfaced here for the SAME
            // reason the SUCCESS response returns `conversation_id`. The daemon
            // holds it on the armed event so a later `stale-resolve` of a
            // name-shaped draft can name the target it aimed at (the resolve
            // route's authorization subject), instead of a daemon-side memo
            // that was cold on a name's first use each session — the very hole
            // this ticket closes. It is not a count and not a seq target, so it
            // does not reopen F13.
            subkind: err.code,
            stale_event_id: err.staleEventId,
            target_conversation_id: err.targetConversationId,
            hint:
              'send rejected; run ' +
              `\`silverhand message stale-receive --stale-event-id ${err.staleEventId}\` ` +
              'to pull this draft\'s pending messages now, or stop this send attempt ' +
              'until they arrive through normal delivery',
          },
        },
      },
      409,
    );
  }
  return null;
}

// Maps a daemon-side typed failure of the `runtime_start` command to an HTTP
// response. Shared by per-conversation runtime-control routes without a
// back-edge to routes.ts; status/code/body unchanged. Returns null for anything that isn't a
// `runtime_start` HostWsCommandResponseError with a recognised code, so callers
// fall through to placement / generic handling.
export function runtimeStartErrorResponse(c: Context, err: unknown): Response | null {
  if (!(err instanceof HostWsCommandResponseError)) return null;
  if (err.details.commandKind !== 'runtime_start') return null;
  const code = err.code as string;
  if (
    code !== 'workspace_not_provisioned' &&
    code !== 'workspace_bundle_missing' &&
    code !== 'registry_unavailable' &&
    code !== 'shutting_down'
  ) {
    return null;
  }
  const status =
    code === 'workspace_bundle_missing'
      ? 409
      : code === 'shutting_down'
        ? 503
        : 502;
  return c.json({ error: err.message, code }, status);
}

const scheduleErrorStatusMap: Record<ScheduleErrorCode, 400 | 403 | 404 | 409 | 429> = {
  invalid_input: 400,
  invalid_cron_expression: 400,
  invalid_timezone: 400,
  fire_at_too_soon: 400,
  fire_at_too_far: 400,
  unbounded_repeat_requires_explicit_limit: 400,
  too_many_active_schedules: 429,
  agent_not_found: 404,
  agent_home_not_found: 404,
  target_conversation_not_found: 404,
  target_conversation_closed: 409,
  agent_not_in_target_conversation: 403,
  schedule_not_found: 404,
  not_owner: 403,
  not_cancellable: 409,
  capability_denied: 403,
};

export function scheduleServiceErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof ScheduleError) {
    const status = scheduleErrorStatusMap[err.code] ?? 400;
    // Typed capability denial: surface the missing bucket as
    // its own field rather than string-stuffing it into `code`. The CLI
    // preserves the explicit `capability_denied` stable code as-is;
    // `message` (from the ScheduleError) + `details.capability` carry the
    // human-readable line and the missing bucket through that path.
    if (err.code === 'capability_denied') {
      return c.json(
        {
          error: err.message,
          code: err.code,
          capability: err.capability,
          message: err.message,
          details: { capability: err.capability },
        },
        status,
      );
    }
    return c.json({ error: err.message, code: err.code }, status);
  }
  return null;
}

const agentServiceErrorStatusMap: Partial<
  Record<AgentServiceError['code'], 400 | 404 | 413 | 415>
> = {
  agent_not_found: 404,
  reasoning_effort_invalid_for_runtime: 400,
  fast_mode_invalid_for_runtime: 400,
  avatar_missing: 400,
  avatar_too_large: 413,
  avatar_unsupported_type: 415,
  avatar_storage_failed: 400,
};

export function agentServiceErrorStatus(err: unknown): 400 | 404 | 413 | 415 | null {
  if (err instanceof AgentServiceError) {
    return agentServiceErrorStatusMap[err.code] ?? 400;
  }
  return null;
}

export function agentServiceErrorBody(err: unknown): { error: string; code: string } {
  if (err instanceof AgentServiceError) {
    return { error: err.message, code: err.code };
  }
  return { error: String(err), code: 'unknown_error' };
}
