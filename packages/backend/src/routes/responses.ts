// Shared HTTP result-mapping helpers for per-context route modules. These
// adapters own status-code mapping after use cases or services return typed
// results. They live in a neutral leaf so route modules can share them without
// import cycles.
import { type Context } from 'hono';
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
import {
  ActorError as MessageActorError,
  AttachmentError as MessageAttachmentError,
  ConversationError,
  MessageFreshnessError,
  PolicyError,
  TargetError,
} from '../services/conversation-message-service.js';
import {
  ScheduleError,
  type ScheduleErrorCode,
} from '../services/schedule-service.js';
import { LegacyThreadRuntimeDisabledError } from '../runtime/agent-runtime-host.js';
import { AgentServiceError } from '../services/agent-service.js';

const placementErrorStatusMap: Record<
  string,
  400 | 403 | 404 | 409 | 503
> = {
  agent_missing: 404,
  host_mismatch: 409,
  host_missing: 404,
  host_not_owned: 403,
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
  workspace_missing: 404,
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
    case 'workspace_agent_placement': {
      const mapped = placementErrorResponse(c, error.cause);
      if (mapped) return mapped;
      throw error.cause;
    }
    case 'workspace_agent_seed_failed':
      return c.json(
        { error: error.failure.message, code: error.failure.code },
        error.failure.status,
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
 */
export function reactionResultResponse(
  c: Context,
  result: ReactionResult,
): Response {
  if (result.ok) {
    return c.json({
      changed: result.changed,
      emoji: result.emoji,
      count: result.count,
    });
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
  parent_not_found: 404,
  parent_closed: 409,
  cross_channel_parent: 400,
  max_depth_exceeded: 400,
  concurrent_limit: 429,
  spawn_cooldown: 429,
  not_found: 404,
  thread: 400,
  not_archivable: 400,
  not_renamable: 400,
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
    const status =
      err.code === 'source_conversation_not_found' || err.code === 'agent_not_found'
        ? 404
        : 403;
    return c.json({ error: err.message, code: err.code }, status);
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
  if (err instanceof ConversationError) {
    const status = err.code === 'conversation_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof MessageActorError) {
    const status = err.code === 'agent_not_found' ? 404 : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof TargetError) {
    const status =
      err.code === 'thread_not_found' || err.code === 'reply_target_not_found'
        ? 404
        : err.code === 'target_closed'
          || err.code === 'target_archived'
          || err.code === 'stream_key_mismatch'
          || err.code === 'legacy_thread_read_only'
          ? 409
          : 400;
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
  if (err instanceof MessageFreshnessError) {
    return c.json(
      {
        error: {
          code: 'conflict',
          message: err.message,
          details: {
            subkind: err.code,
            conversation_id: err.conversationId,
            stale_event_id: err.staleEventId,
            seen_up_to_seq: err.seenUpToSeq,
            current_seq: err.currentSeq,
            newer_messages: err.newerMessages,
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
  if (err instanceof LegacyThreadRuntimeDisabledError) {
    return c.json({ error: err.message, code: err.code }, 409);
  }
  if (!(err instanceof HostWsCommandResponseError)) return null;
  if (err.details.commandKind !== 'runtime_start') return null;
  const code = err.code as string;
  if (
    code !== 'workspace_not_provisioned' &&
    code !== 'workspace_path_missing' &&
    code !== 'registry_unavailable' &&
    code !== 'shutting_down'
  ) {
    return null;
  }
  const status =
    code === 'workspace_path_missing'
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
