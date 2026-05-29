import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  apiPaths,
  authPaths,
  internalPaths,
  probePaths,
  AddWorkspaceMemberInputSchema,
  AgentCloseThreadInputSchema,
  AgentCreateChannelInputSchema,
  AgentListChannelsQuerySchema,
  AgentReadHistoryInputSchema,
  AgentSearchMessagesInputSchema,
  AgentSendMessageInputSchema,
  AgentSpawnChildInputSchema,
  ClaimTasksInputSchema,
  CreateAgentInputSchema,
  CreateConversationChannelInputSchema,
  CreateWorkspaceInputSchema,
  CreateTasksInputSchema,
  DeleteAgentInputSchema,
  ConversationLogDebugInputSchema,
  HumanClaimTaskInputSchema,
  HumanUpdateTaskStatusInputSchema,
  HostClaimOrCreateInputSchema,
  ListTasksQuerySchema,
  MarkConversationReadInputSchema,
  MarkNotificationsReadInputSchema,
  ScheduleCancelInputSchema,
  ScheduleCreateInputSchema,
  CliTraceInputSchema,
  AuthLoginInputSchema,
  AuthSignupInputSchema,
  ScheduleListInputSchema,
  SearchQueryInputSchema,
  SendMessageInputSchema,
  UnclaimTaskInputSchema,
  UpdateAgentInputSchema,
  UpdateUserProfileInputSchema,
  UpdateWorkspaceInputSchema,
  ArchiveWorkspaceInputSchema,
  ArchiveChannelInputSchema,
  ArchivedChannelsQueryInputSchema,
  UpdateTaskStatusInputSchema,
  type AgentDto,
  type AgentDeleteImpactDto,
  type AgentListedChannel,
  type AgentListedWorkspace,
  type AgentListChannelsDto,
  type AgentListWorkspacesDto,
  type AgentRow,
  type CreateAgentInput,
  type AgentReadHistoryDto,
  type AgentSearchMessageHit,
  type AgentSearchMessagesDto,
  type MessageRef,
  type MessageRow,
  type MessageSenderRef,
  type ReadHistoryMessage,
  type ReadHistoryTarget,
  type ReadHistoryTargetRef,
  type SendMessageTarget,
  systemSubtype,
  TEMP_CONVERSATION_DEBUG_WINDOW_MS,
  type AgentMaterializationStatus,
} from '@silverhand/shared';
import type { BackendContext } from './context.js';
import { createCliInvokeMiddleware } from './observability/cli-invoke-middleware.js';
import { AgentRepo } from './repos/agent-repo.js';
import { AttachmentRepo } from './repos/attachment-repo.js';
import { HostRepo } from './repos/host-repo.js';
import { HostCredentialIssueError, HostTokenService } from './auth/host-token.js';
import { HostWsCommandTransportError, HostWsCommandResponseError, type HostWsServerController } from './ws/host-ws-server.js';
import type { OutboundFrameAdapter } from './runtime/outbound-frame-adapter.js';
import {
  HostTokenRotationCoordinator,
  HostTokenRotationError,
} from './ws/host-token-rotation.js';
import { MessageRepo, messageRowToDto, AnchorMessageNotInConversationError } from './repos/message-repo.js';
import { NotificationRepo } from './repos/notification-repo.js';
import { SavedMessageRepo } from './repos/saved-message-repo.js';
import { SearchRepo } from './repos/search-repo.js';
import { ConversationReadRepo } from './repos/conversation-read-repo.js';
import { ConversationInboxRepo } from './repos/conversation-inbox-repo.js';
import { SettingsRepo, SETTINGS_KEYS } from './repos/settings-repo.js';
import { WorkspaceRepo, agentHomeWorkspaceId } from './repos/workspace-repo.js';
import { ConversationRepo, type RepoError } from './repos/conversation-repo.js';
import { validateWorkspacePath } from './provision.js';
import { ensureAgentL1Dir, initWorkspaceDir, seedAgentL2 } from './workspace-files.js';
import { detectRuntimes } from '@silverhand/host/runtimes';
import { buildAgentWorkspaceDto } from './agent-workspace.js';
import { AttachmentRejection } from './services/attachment-service.js';
import {
  ActorError as ChannelActorError,
  MemberError,
  SeedError,
  WorkspaceUnsuitableError,
} from './services/channel-service.js';
import {
  ActorError as MessageActorError,
  AttachmentError as MessageAttachmentError,
  ConversationError,
  PolicyError,
  TargetError,
} from './services/conversation-message-service.js';
import {
  ActorError as ThreadActorError,
  MembershipError as ThreadMembershipError,
  MessageError as ThreadMessageError,
  ParentError as ThreadParentError,
  SeedAgentError,
  ThreadError,
  ThreadOpenTasksError,
} from './services/thread-service.js';
import {
  ScheduleError,
  type ScheduleErrorCode,
} from './services/schedule-service.js';
import { UserServiceError } from './services/user-service.js';
import { AgentServiceError } from './services/agent-service.js';
import { MembershipService } from './services/membership-service.js';
import { UserRepo } from './repos/user-repo.js';
import { RuntimeHostPlacementError } from './host-placement-errors.js';
import {
  ClearSessionExitTimeoutError,
  ClearSessionInProgressError,
} from './runtime/agent-runtime-host.js';
import {
  type AppEnv,
  getAgentPrincipal,
  getUserPrincipal,
  installInternalPrincipalMiddleware,
  installPublicPrincipalMiddleware,
  installRequireRegisteredViewerMiddleware,
} from './auth/principal.js';
import { installPublicBearerMiddleware } from './auth/bearer.js';
import {
  consumeEmbeddedBootstrapToken,
  isLoopbackAddress,
} from './auth/embedded-bootstrap.js';
import { UserAuthService } from './auth/user-auth-service.js';
import {
  canAgentAccessWorkspace,
  canDeleteAttachment,
  canEditAgent,
  canManageMembers,
  canMutateWorkspace,
  canPostToConversation,
  canViewAgent,
  canViewAttachment,
  canViewConversation,
  canViewOwnedState,
  canViewWorkspace,
} from './permissions.js';

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
};

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
  // D4.c C1 — multi-host placement ambiguity. 409 (Conflict) matches
  // `local_host_unbound`'s semantics: the route's required precondition
  // (a single resolvable local host) does not hold, the caller can
  // recover by picking an explicit `host_id`. Distinct code lets the
  // renderer surface a "you have N hosts — pick one" UX instead of the
  // "no daemon found" UX it shows for `local_host_unbound`.
  local_host_ambiguous: 409,
  workspace_missing: 404,
  // D4.a Commit 6 (3): transient transport-down → 503 Service
  // Unavailable. Differs from `host_runtime_disabled` (409: standalone
  // backend, no daemon at all — config decision) by carrying
  // "try again in a moment" semantics rather than "this server
  // mode never runs agents".
  host_attach_pending: 503,
};

/**
 * D4.a Commit 6 (3) — map a narrow subset of
 * `HostWsCommandTransportError` codes to the typed
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
 * This is the load-bearing gate Cindy 5d/6 review called out: don't
 * collapse all transport errors into one user-facing code.
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

function placementErrorResponse(c: Context, err: unknown): Response | null {
  // RuntimeHostPlacementError thrown by `placement.resolveForAgent`
  // (pre-send) — direct match.
  if (err instanceof RuntimeHostPlacementError) {
    return c.json(
      { error: err.message, code: err.code },
      placementErrorStatusMap[err.code] ?? 400,
    );
  }
  // D4.a Commit 6 (3): HostWsCommandTransportError thrown by the
  // outbound dispatcher AFTER placement resolved — promote the
  // narrow "host unreachable" subset to `host_attach_pending`.
  const promoted = mapTransportErrorToPlacement(err);
  if (promoted) {
    return c.json(
      { error: promoted.message, code: promoted.code },
      placementErrorStatusMap[promoted.code] ?? 400,
    );
  }
  return null;
}

function hostRuntimeDisabledResponse(
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

function standaloneMode(ctx: BackendContext): boolean {
  return ctx.deploymentMode === 'standalone';
}

// ── D4.d D3: POST /api/agents lifecycle helpers ────────────────────
//
// All four helpers below exist to keep the rewritten route body
// linear / readable. None of them call the wire intent themselves;
// they are pure preflight / classification utilities.

/**
 * `Idempotency-Key` header shape per design §14 Q1: 1..64 chars,
 * character set `[A-Za-z0-9_-]`. Server treats the value as
 * opaque (no parsing / interpretation); the regex only enforces the
 * envelope. The header is REQUIRED for `POST /api/agents` — D4.d's
 * "same key, same response" idempotency contract (§3.2) is
 * structurally impossible without it.
 */
const D3_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-]{1,64}$/;

function d3ParseIdempotencyKey(
  c: Context,
): { ok: true; key: string } | { ok: false; response: Response } {
  const raw = c.req.header('Idempotency-Key');
  if (!raw) {
    return {
      ok: false,
      response: c.json(
        {
          error:
            'POST /api/agents requires Idempotency-Key header (1..64 chars, [A-Za-z0-9_-])',
          code: 'idempotency_key_missing',
        },
        400,
      ),
    };
  }
  if (!D3_IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    return {
      ok: false,
      response: c.json(
        {
          error:
            'Idempotency-Key must match /^[A-Za-z0-9_-]{1,64}$/ (per design §14 Q1)',
          code: 'idempotency_key_malformed',
        },
        400,
      ),
    };
  }
  return { ok: true, key: raw };
}

/**
 * Metadata snapshot dimensions for the §3.2 / §6.1 mismatch check.
 *
 * Design §6.1 step 4 lists six fields:
 * `(name, runtime, model, description, template_choice, host_id)`.
 *
 * D2 ships only `template_choice='default'`; the wire enum keeps
 * `'onboarding'` / `'minimal'` reserved but the daemon rejects them
 * (`unsupported_template`). Because the route forces
 * `template_choice='default'` server-side (it is NOT user-supplied
 * input at D3), the `template_choice` axis is trivially equal on
 * every retry and cannot be exercised end-to-end yet. The dimension
 * is listed here for completeness and to future-proof the
 * comparator the moment another template ships — that change will
 * pass `requestedTemplateChoice` through from a future
 * `CreateAgentInputSchema` field and add a stored column to the
 * agent row (the row currently has no `template_choice` column;
 * v33 deliberately left it out so D3 doesn't ship a schema change
 * that would only matter after a future template lands).
 *
 * `host_id` mismatch detection compares the STORED `host_id` to the
 * REQUEST'S literal `host_id` ONLY when the body provided one
 * explicitly. A same-key retry that omits `host_id` is treated as
 * "use whatever the stored row pinned" and never trips the mismatch
 * comparator (Cindy D3 round-1 P1 — existing-row dispatch path must
 * NOT call placement; ownership/online state changes between two
 * retries are not user-visible re-shapes of the request body).
 */
const D3_METADATA_SNAPSHOT_FIELDS = [
  'name',
  'runtime',
  'model',
  'description',
  'template_choice',
  'host_id',
] as const;
type D3MetadataSnapshotField = (typeof D3_METADATA_SNAPSHOT_FIELDS)[number];

interface D3MetadataSnapshot {
  name: string;
  runtime: string;
  model: string | null;
  description: string | null;
  template_choice: string;
  host_id: string;
}

function d3RowSnapshot(row: AgentRow): D3MetadataSnapshot {
  return {
    name: row.name,
    runtime: row.runtime,
    model: row.model ?? null,
    description: row.description ?? null,
    // D2 ships 'default' only; agent row has no column yet, default
    // is the only legal stored value. Comparator stays correct when
    // a later D-stage adds the column + value pair.
    template_choice: 'default',
    host_id: row.host_id,
  };
}

/**
 * Build the per-request snapshot the mismatch comparator reads.
 *
 * `effectiveHostId` is the host id the comparator should use for
 * the request side. Two callers:
 *
 *   - Existing-row path: pass `input.host_id ?? row.host_id`. When
 *     the body omits `host_id`, the snapshot falls back to the
 *     stored row's host so the comparator returns "match" without
 *     calling placement. When the body provides `host_id`, the
 *     literal string is compared to `row.host_id` directly — a
 *     differing value trips the mismatch arm regardless of whether
 *     the caller still owns either host (ownership is enforced on
 *     the no-row reserve path, not on the existing-row dispatch
 *     path; per Cindy D3 round-1 P1).
 *
 *   - No-row reserve path: pass the placement-resolved host id (the
 *     value `reserveForMaterialize` will persist on the new row).
 */
function d3RequestSnapshot(
  input: CreateAgentInput,
  effectiveHostId: string,
): D3MetadataSnapshot {
  return {
    name: input.name,
    runtime: input.runtime,
    model: input.model ?? null,
    description: input.description ?? null,
    template_choice: 'default',
    host_id: effectiveHostId,
  };
}

/**
 * Return the first field that differs between stored and requested
 * snapshots, or `null` if every field matches. Order matches
 * `D3_METADATA_SNAPSHOT_FIELDS` so the response message names the
 * field deterministically.
 *
 * This is the load-bearing comparator for the design §6.1 step 4 +
 * Cindy final-review P1 `ZPJBJ8ANrJRpyQRq` "mismatch BEFORE
 * dispatch" invariant: it runs unconditionally whenever a same-key
 * row is found, regardless of that row's `materialization_status`.
 * The route MUST call it before consulting the dispatch table at
 * step 5 — that's what the D3 invariant tests pin per
 * `{pending, active, failed} × <field>`.
 */
function d3CompareMetadataSnapshot(
  stored: D3MetadataSnapshot,
  requested: D3MetadataSnapshot,
): D3MetadataSnapshotField | null {
  for (const field of D3_METADATA_SNAPSHOT_FIELDS) {
    if (stored[field] !== requested[field]) return field;
  }
  return null;
}

/**
 * Map a typed `agent_materialize` wire error code (returned by the
 * daemon via `HostWsCommandResponseError`) to:
 *   - the L3b `materialization_failed_code` to persist on the row
 *   - the HTTP status + body the client receives
 *
 * Wire codes per `AgentMaterializeErrorCodeSchema` (D2):
 *   - `agent_dir_collision`  → 409 (a foreign / mismatched home exists)
 *   - `fs_quota_exceeded`    → 507 (out of disk on the host)
 *   - `fs_unavailable`       → 502 (host fs temporarily unavailable)
 *   - `unsupported_template` → 400 (request shape ok, host can't honor)
 *   - `unsupported_runtime`  → 400 (same)
 *   - `internal_error`       → 502 (catch-all daemon side error)
 *
 * Generic codes (`ResponseError.code` per protocol.ts) that arrive
 * on the materialize arm — possible because the wire schema unions
 * generic with typed:
 *   - `unknown_intent`     → 502 (daemon doesn't know the intent)
 *   - `invalid_params`     → 502 (server shipped bad params; bug)
 *   - `internal_error`     → 502 (handler threw)
 *   - `shutting_down`      → 503 (daemon is draining)
 *   - `request_too_large`  → 502 (bug; we don't ship oversized frames)
 *
 * 502/503 carry "retry the request with the same Idempotency-Key";
 * 400/507 carry "you need to change the request / free disk first";
 * 409 carries "different daemon-side state, choose a different name".
 */
function d3MapMaterializeWireError(
  err: HostWsCommandResponseError,
): { status: 400 | 409 | 502 | 503 | 507; failedCode: string } {
  // Cast: HostWsCommandResponseError narrowly types `code` to the
  // generic 5-enum, but at runtime carries the wider typed codes
  // for `agent_materialize` unchanged from the wire frame (the
  // typed-error schema admission in `protocol.ts` and the loose
  // transport schema in `socket-transport.ts` together ensure the
  // string survives intact). Narrowing here on the actual string
  // value is correct.
  const code = err.code as string;
  switch (code) {
    case 'agent_dir_collision':
      return { status: 409, failedCode: 'agent_dir_collision' };
    case 'fs_quota_exceeded':
      return { status: 507, failedCode: 'fs_quota_exceeded' };
    case 'fs_unavailable':
      return { status: 502, failedCode: 'fs_unavailable' };
    case 'unsupported_template':
      return { status: 400, failedCode: 'unsupported_template' };
    case 'unsupported_runtime':
      return { status: 400, failedCode: 'unsupported_runtime' };
    case 'shutting_down':
      return { status: 503, failedCode: 'daemon_shutting_down' };
    default:
      // unknown_intent / invalid_params / internal_error /
      // request_too_large + any future code the daemon could emit
      // → catch-all daemon-internal-error.
      return { status: 502, failedCode: 'daemon_internal_error' };
  }
}

function readinessResponse(ctx: BackendContext): {
  body: {
    ok: boolean;
    mode: string;
    deployment_mode: string;
    checks: {
      migrations_applied: boolean;
      listen_ready: boolean;
      db_writable: boolean;
      /**
       * Standalone-only check: present only when
       * `deployment_mode === 'standalone'`. Reports whether the
       * backend's `OutboundRuntimeEventFanout` was constructed and
       * registered as the `HostWsServer.eventSink`. This is a
       * **backend-side wiring readiness** signal — it does NOT mean
       * any daemon host has connected over the outbound websocket.
       * Daemon-side attachment is reported through
       * `HostWsServerController.getAttachment(hostId)` (D3.a Commit 1).
       *
       * Embedded mode never wires this fanout (runtime events flow
       * over Unix-socket IPC) and the field is OMITTED from `checks`
       * to avoid the false impression that embedded readiness depends
       * on it.
       */
      outbound_event_fanout_installed?: boolean;
    };
    error?: string;
    ts: number;
  };
  status: 200 | 503;
} {
  const writable = probeDbWritable(ctx);
  const baseChecks = {
    migrations_applied: ctx.readiness.migrationsApplied,
    listen_ready: ctx.readiness.listenReady,
    db_writable: writable.ok,
  };
  // Standalone backends require the outbound runtime event fanout to be
  // wired before they can correctly route daemon events to clients;
  // missing it is a config bug, not a transient condition, so /readyz
  // must fail-loud at 503 to keep orchestrators from rolling forward.
  // Embedded backends intentionally never construct this fanout
  // (runtime events flow over Unix-socket IPC), so the check is OMITTED
  // for embedded mode rather than included-and-defaulted-true — keeping
  // it out of the response makes the mode boundary explicit to anyone
  // reading the JSON.
  const checks: typeof baseChecks & { outbound_event_fanout_installed?: boolean } =
    ctx.deploymentMode === 'standalone'
      ? {
          ...baseChecks,
          outbound_event_fanout_installed:
            ctx.readiness.outboundEventFanoutInstalled,
        }
      : baseChecks;
  const ok =
    checks.migrations_applied &&
    checks.listen_ready &&
    checks.db_writable &&
    (ctx.deploymentMode !== 'standalone' ||
      checks.outbound_event_fanout_installed === true);
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      mode: ctx.serverConfig.mode,
      deployment_mode: ctx.deploymentMode,
      checks,
      ...(writable.ok ? {} : { error: writable.error }),
      ts: Date.now(),
    },
  };
}

function probeDbWritable(ctx: BackendContext): { ok: true } | { ok: false; error: string } {
  try {
    ctx.db.exec('BEGIN IMMEDIATE');
    ctx.db.exec('ROLLBACK');
    return { ok: true };
  } catch (err) {
    safeRollback(ctx);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function safeRollback(ctx: BackendContext): void {
  try {
    if (ctx.db.inTransaction) ctx.db.exec('ROLLBACK');
  } catch {
    // Best-effort cleanup after a failed readiness write probe.
  }
}

function channelServiceErrorResponse(c: Context, err: unknown): Response | null {
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

function conversationMessageServiceErrorResponse(
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
    const status = err.code === 'thread_not_found' ? 404 : err.code === 'target_closed' || err.code === 'target_archived' ? 409 : 400;
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
  return null;
}

function threadServiceErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof ThreadMessageError) {
    return c.json({ error: err.message, code: err.code }, 404);
  }
  if (err instanceof ThreadParentError) {
    const status = err.code === 'parent_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof ThreadMembershipError) {
    return c.json(
      {
        error: err.message,
        code: err.code,
        ...(err.agentId ? { agent_id: err.agentId } : {}),
      },
      400,
    );
  }
  if (err instanceof ThreadActorError) {
    const status = err.code === 'agent_not_found' ? 404 : 403;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof SeedAgentError) {
    return c.json({ error: err.message, code: err.code }, 404);
  }
  if (err instanceof ThreadError) {
    const status = err.code === 'thread_not_found' ? 404 : 409;
    return c.json({ error: err.message, code: err.code }, status);
  }
  if (err instanceof ThreadOpenTasksError) {
    // Nested error shape on purpose: the CLI's stable ERROR_CODES enum
    // doesn't include silverhand-specific reasons like
    // `has_open_tasks`, so we surface the top-level `code: 'conflict'`
    // (which IS in the enum, drives `exitCodeFor` and `retriable`) and
    // park the silverhand reason in `details.reason`. The structured
    // `details.blocking_tasks` payload is what the CLI uses to render
    // the task list in human mode.
    return c.json(
      {
        error: {
          code: 'conflict',
          message: err.message,
          details: {
            reason: 'has_open_tasks',
            blocking_tasks: err.blockingTasks,
          },
        },
      },
      409,
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

function resolveViewerUserId(c: Context): string {
  return getUserPrincipal(c).userId;
}

function requireSessionBearerUser(c: Context, ctx: BackendContext): Response | string {
  const token = bearerToken(c);
  if (!token) {
    return c.json(
      {
        error: 'host claim requires a user session bearer',
        code: 'session_bearer_required',
      },
      401,
    );
  }
  const session = ctx.authSessions.validateSessionToken(token);
  if (!session.ok) {
    return c.json(
      {
        error: 'host claim requires a user session bearer',
        code: 'session_bearer_required',
      },
      401,
    );
  }
  return session.session.user_id;
}

function authFailed(c: Context): Response {
  return c.json({ error_code: 'auth_failed' }, 401);
}

function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token || null;
}

function authSessionMetadata(c: Context): {
  userAgent: string | null;
  ipFirstSeen: string | null;
} {
  return {
    userAgent: c.req.header('user-agent') ?? null,
    ipFirstSeen:
      firstForwardedFor(c.req.header('x-forwarded-for'))
      ?? c.req.header('x-real-ip')
      ?? null,
  };
}

function notFound(c: Context): Response {
  return c.text('404 Not Found', 404);
}

function isLoopbackRequest(c: Context): boolean {
  try {
    return isLoopbackAddress(getConnInfo(c).remote.address);
  } catch {
    try {
      return isLoopbackAddress(new URL(c.req.url).hostname);
    } catch {
      return false;
    }
  }
}

function firstForwardedFor(value: string | undefined): string | null {
  const first = value?.split(',')[0]?.trim();
  return first || null;
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
};

function scheduleServiceErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof ScheduleError) {
    const status = scheduleErrorStatusMap[err.code] ?? 400;
    return c.json({ error: err.message, code: err.code }, status);
  }
  return null;
}

function requireViewerUserId(c: Context): string {
  return resolveViewerUserId(c);
}

function publicSettingsSnapshot(settings: SettingsRepo): Record<string, string> {
  const out = { ...settings.all() };
  delete out[SETTINGS_KEYS.VIEWER_USER_ID];
  return out;
}

function legacyGlobalNotificationUserId(): null {
  // Stage A.3 bridge: V1 notification writers still mostly create
  // legacy global rows (`user_id IS NULL`). Keep every reader/writer
  // call site grep-able until the per-user notification migration.
  return null;
}

function listLegacyGlobalNotifications(
  notifications: NotificationRepo,
  opts: { unread?: boolean; limit?: number } = {},
) {
  return notifications.list({
    userId: legacyGlobalNotificationUserId(),
    unread: opts.unread,
    limit: opts.limit,
  });
}

const userServiceErrorStatusMap: Partial<
  Record<UserServiceError['code'], 400 | 404 | 409 | 413 | 415>
> = {
  user_not_found: 404,
  name_taken: 409,
  already_registered: 409,
  invalid_input: 400,
  avatar_missing: 400,
  avatar_too_large: 413,
  avatar_unsupported_type: 415,
  avatar_storage_failed: 400,
};

function userServiceErrorStatus(err: unknown): 400 | 404 | 409 | 413 | 415 | null {
  if (err instanceof UserServiceError) {
    return userServiceErrorStatusMap[err.code] ?? 400;
  }
  return null;
}

function userServiceErrorBody(err: unknown): { error: string; code: string } {
  if (err instanceof UserServiceError) {
    return { error: err.message, code: err.code };
  }
  return { error: String(err), code: 'unknown_error' };
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

function agentServiceErrorStatus(err: unknown): 400 | 404 | 413 | 415 | null {
  if (err instanceof AgentServiceError) {
    return agentServiceErrorStatusMap[err.code] ?? 400;
  }
  return null;
}

function agentServiceErrorBody(err: unknown): { error: string; code: string } {
  if (err instanceof AgentServiceError) {
    return { error: err.message, code: err.code };
  }
  return { error: String(err), code: 'unknown_error' };
}

function onboardingBody(
  workspaceName: string,
  recipient: AgentDto,
  others: AgentDto[],
): string {
  return [
    `You (@${recipient.name}) just joined workspace #${workspaceName}.`,
    others.length === 0
      ? `You're the only agent here right now.`
      : `Other agents in this workspace:\n${others.map(m => `- @${m.name} (${m.runtime})`).join('\n')}`,
    ``,
    `Your role contract is auto-loaded above (sourced from L1 system_prompt.md, shared across every workspace), and this workspace's MEMORY.md is auto-loaded as Active Workspace Memory.`,
    `Send one short greeting introducing yourself by your global role. As you work, write by scope: global identity / role / working-style guidance → update L1 system_prompt.md; this workspace's collaboration, tasks, project facts, or work logs → update L2 MEMORY.md / notes/ / CONSENSUS.md. Do not mention internal file paths to the user unless they ask.`,
  ].join('\n');
}

const SLOW_REQUEST_MS = 500;
const DIAGNOSTIC_REQUEST_MS = 100;
const SLOW_ROUTE_SPAN_MS = 100;
let apiRequestSequence = 0;

function installApiTimingMiddleware(app: Hono<AppEnv>, ctx: BackendContext): void {
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const path = url.pathname;
    const isDiagnosticPath = isChannelSwitchDiagnosticPath(path);
    const requestId = nextApiRequestId();
    const startedAt = performance.now();
    ctx.logger.info(
      {
        requestId,
        method: c.req.method,
        path,
        query: url.search || null,
      },
      'api: request start',
    );
    try {
      await next();
    } finally {
      const elapsedMs = elapsedSince(startedAt);
      ctx.logger.info(
        {
          requestId,
          method: c.req.method,
          path,
          query: url.search || null,
          status: c.res.status,
          elapsedMs,
        },
        'api: request complete',
      );
      if (
        elapsedMs >= SLOW_REQUEST_MS ||
        (isDiagnosticPath && elapsedMs >= DIAGNOSTIC_REQUEST_MS)
      ) {
        ctx.logger.warn(
          {
            requestId,
            method: c.req.method,
            path,
            status: c.res.status,
            elapsedMs,
            thresholdMs: isDiagnosticPath ? DIAGNOSTIC_REQUEST_MS : SLOW_REQUEST_MS,
          },
          'api: slow request',
        );
      }
    }
  });
}

function nextApiRequestId(): string {
  apiRequestSequence = (apiRequestSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `api-${apiRequestSequence}`;
}

function isChannelSwitchDiagnosticPath(path: string): boolean {
  if (path === apiPaths.messageUnreadSummary) {
    return true;
  }
  if (/^\/api\/workspaces\/[^/]+\/channels(\/archived)?$/.test(path)) return true;
  if (
    /^\/api\/channels\/[^/]+\/(messages|agents|agent-run-states|threads|mark-read|message-unread)$/.test(
      path,
    )
  ) {
    return true;
  }
  return /^\/api\/threads\/[^/]+\/(messages|agents|agent-run-states|mark-read)$/.test(
    path,
  );
}

function timedRouteSpan<T>(
  ctx: BackendContext,
  span: string,
  fields: Record<string, unknown>,
  fn: () => T,
  resultFields?: (result: T) => Record<string, unknown>,
): T {
  const startedAt = performance.now();
  try {
    const result = fn();
    const elapsedMs = elapsedSince(startedAt);
    if (elapsedMs >= SLOW_ROUTE_SPAN_MS) {
      ctx.logger.warn(
        {
          span,
          elapsedMs,
          thresholdMs: SLOW_ROUTE_SPAN_MS,
          ...fields,
          ...(resultFields?.(result) ?? {}),
        },
        'api: slow route span',
      );
    }
    return result;
  } catch (err) {
    ctx.logger.warn(
      {
        span,
        elapsedMs: elapsedSince(startedAt),
        ...fields,
        err,
      },
      'api: route span failed',
    );
    throw err;
  }
}

function elapsedSince(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

export function createApiRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  installApiTimingMiddleware(app, ctx);
  installPublicBearerMiddleware(app, ctx, {
    // Liveness probe stays open so a process supervisor can health-check
    // without holding a user session token. `/readyz` is outside `/api/*`.
    allowlist: [apiPaths.health, apiPaths.serverInfo],
  });
  installPublicPrincipalMiddleware(app);
  // Registration gate: after the public bearer middleware authenticates
  // a session, this verifies the user row still exists before public
  // data routes run. Probe paths, `/api/server/info`, `/auth/*`, and
  // `/internal/*` are anonymous / route-owned / agent-principal and skip the
  // relevant public layers. Under DB corruption (principal set but row missing)
  // it 500s.
  installRequireRegisteredViewerMiddleware(app, ctx, {
    whitelistPaths: [apiPaths.serverInfo, apiPaths.me],
  });
  const hosts = new HostRepo(ctx.db);
  const agents = new AgentRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const attachments = new AttachmentRepo(ctx.db);
  const saved = new SavedMessageRepo(ctx.db);
  const search = new SearchRepo(ctx.db);
  const settings = new SettingsRepo(ctx.db);
  const conversationInboxes = new ConversationInboxRepo(ctx.db);
  const notifications = new NotificationRepo(ctx.db);
  const conversationReads = new ConversationReadRepo(ctx.db);
  const users = new UserRepo(ctx.db);
  const hostTokens = new HostTokenService(ctx.db);
  const membership = new MembershipService({ agents, users, conversations });
  const userAuth = new UserAuthService({
    db: ctx.db,
    users,
    passwordCredentials: ctx.passwordCredentials,
    authSessions: ctx.authSessions,
  });

  // ── Auth / health / runtimes / hosts ─────────────────────────────
  app.get(apiPaths.serverInfo, c =>
    c.json({
      signup_enabled: ctx.authConfig.signupEnabled,
      bind_address_scope: ctx.bindAddressScope,
    }),
  );

  if (ctx.deploymentMode === 'embedded') {
    app.post(authPaths.embeddedBootstrap, async c => {
      if (ctx.serverConfig.mode !== 'embedded') return notFound(c);
      if (!isLoopbackRequest(c)) return notFound(c);
      const body = await c.req.json().catch(() => null);
      const token =
        body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string'
          ? (body as { token: string }).token.trim()
          : '';
      if (!token) return notFound(c);

      const ok = await consumeEmbeddedBootstrapToken(
        ctx.embeddedBootstrap,
        token,
        ctx.logger,
      );
      if (!ok) return notFound(c);

      const allUsers = users.list();
      let userId: string;
      if (allUsers.length === 0) {
        const user = ctx.userService.register({
          name: 'local',
          display_name: 'Local User',
        });
        userId = user.id;
      } else if (allUsers.length === 1) {
        userId = allUsers[0]!.id;
      } else {
        return c.json(
          {
            error: 'embedded bootstrap cannot choose among multiple users',
            code: 'bootstrap_ambiguous_user',
          },
          409,
        );
      }

      const user = ctx.userService.getDto(userId);
      if (!user) return c.json({ error: 'bootstrap user is missing' }, 500);
      const issued = ctx.authSessions.issueSession({
        userId,
        ...authSessionMetadata(c),
      });
      return c.json({ user_token: issued.userToken, user });
    });
  }

  // D4.a Commit 4 (per `docs/remote-backend-d4-design.md` §6.2):
  // `/auth/signup` is **always mounted**. The handler branches on
  // `signupEnabled` and returns a typed `403 { code:
  // 'signup_disabled' }` body when disabled — a change from the
  // A.2 hide-as-missing behaviour. Desktop and ops tooling read the
  // structured body (plus `/api/server/info.signup_enabled`) instead
  // of a generic 404.
  app.post(authPaths.signup, async c => {
    if (!ctx.authConfig.signupEnabled) {
      return c.json(
        {
          error: 'signup is disabled on this backend',
          code: 'signup_disabled',
        },
        403,
      );
    }
    const body = await c.req.json().catch(() => null);
    const parsed = AuthSignupInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const signup = await userAuth.signup(parsed.data);
    if (!signup.ok) return authFailed(c);
    const user = ctx.userService.getDto(signup.userId);
    if (!user) {
      return c.json({ error: 'created user is missing post-signup' }, 500);
    }
    const issued = ctx.authSessions.issueSession({
      userId: signup.userId,
      ...authSessionMetadata(c),
    });
    return c.json({ user_token: issued.userToken, user });
  });

  app.post(authPaths.login, async c => {
    const body = await c.req.json().catch(() => null);
    const parsed = AuthLoginInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const verified = await ctx.passwordCredentials.verifyLoginPassword(parsed.data);
    if (!verified.ok) return authFailed(c);
    const user = ctx.userService.getDto(verified.userId);
    if (!user) {
      return c.json({ error: 'authenticated user is missing' }, 500);
    }
    const issued = ctx.authSessions.issueSession({
      userId: verified.userId,
      ...authSessionMetadata(c),
    });
    return c.json({ user_token: issued.userToken, user });
  });

  app.post(authPaths.logout, c => {
    const token = bearerToken(c);
    if (!token || !ctx.authSessions.revokeSessionToken(token)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return c.json({ ok: true });
  });

  app.get(apiPaths.health, c =>
    c.json({ ok: true, mode: ctx.serverConfig.mode, ts: Date.now() }),
  );

  const handleReady = (c: Context): Response => {
    const ready = readinessResponse(ctx);
    return c.json(ready.body, ready.status);
  };
  app.get(probePaths.readyz, handleReady);

  app.get(apiPaths.eventWebSocket, c =>
    c.json({ error: 'event websocket requires a websocket upgrade' }, 401),
  );

  app.get(apiPaths.hostConnect, c =>
    c.json({ error: 'host websocket requires a websocket upgrade' }, 401),
  );

  app.get(apiPaths.runtimes, async c => {
    if (standaloneMode(ctx)) {
      return hostRuntimeDisabledResponse(c, 'runtime detection', 503);
    }
    const runtimes = await detectRuntimes();
    return c.json({ runtimes });
  });

  // GET /api/hosts — owner-scoped list (Stage B.4 viewer filter).
  // Session bearer required; pre-session callers cannot enumerate
  // other users' hosts. Returns
  // every host (active + revoked) belonging to the caller, sorted
  // active-first then by created_at.
  app.get(apiPaths.hosts, c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    return c.json({ hosts: hosts.listForUser(userId) });
  });

  app.post(apiPaths.hostClaimOrCreate, async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    // D4.c C2 — lifted the standalone guard. claim-or-create is the
    // entry point for the desktop main process to register itself
    // with the backend and obtain a host_token to write into
    // daemon-config.json. In standalone deployment the same
    // sequence runs: the desktop's renderer logs in (session
    // bearer), main calls claim-or-create with `installation_id`,
    // backend mints a host row + host_token, main writes
    // daemon-config so the local daemon can attach via outbound
    // WSS. There is no architectural reason to forbid this in
    // standalone — the pre-D4.c guard was a placeholder while
    // multi-host ACL was sorted out (Stage A.3 / B.4). Now that
    // those are landed and host_token rotation works in both
    // modes, claim-or-create runs identically. R4: this is a
    // backend-internal HTTP route, not a server↔daemon protocol
    // change.

    const body = await c.req.json().catch(() => null);
    const parsed = HostClaimOrCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    // Stage B.4: `claimOrCreateLocal` filters revoked rows out of the
    // `(user, installation)` lookup, so this call always returns an
    // active host (either freshly minted, legacy reused, or an active
    // existing claim). The caller no longer needs a `host_revoked`
    // 409 branch here — re-claim after revoke transparently mints a
    // new active row, matching the active-only partial-unique index.
    const claimed = hosts.claimOrCreateLocal({
      userId,
      installationId: parsed.data.installation_id,
      preferredName: parsed.data.label,
    });

    let hostToken: string | undefined;
    if (
      parsed.data.current_host_id !== claimed.host.id ||
      !hostTokens.hasActiveLongLivedCredential(claimed.host.id)
    ) {
      try {
        hostToken = hostTokens.issueHostToken({ hostId: claimed.host.id }).hostToken;
      } catch (err) {
        if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
          // Defensive: the active-only filter above should make this
          // unreachable, but leave the typed mapping in place so a
          // future regression in the lookup surfaces as 409 rather
          // than as a 500.
          return c.json(
            {
              error: 'host has been revoked',
              error_code: 'host_revoked',
            },
            409,
          );
        }
        throw err;
      }
    }

    const response = {
      host_id: claimed.host.id,
      host: hosts.toDto(claimed.host),
      server_url: ctx.serverConfig.url,
      ...(hostToken ? { host_token: hostToken } : {}),
    };
    return c.json(response);
  });

  // POST /api/hosts/:id/revoke — Stage B.4 soft-delete. Owner-only,
  // 404 on cross-user/missing (no enumeration), idempotent. Always
  // sweeps `host_credentials.revoked_at IS NULL` for the host even if
  // `hosts.revoked_at` is already set, so a half-failed prior revoke
  // is reconciled. Does NOT cascade-delete agents / workspaces /
  // conversations — those rows stay; runtime placement is the
  // boundary that fails closed afterwards.
  app.post('/api/hosts/:id/revoke', async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;
    // D4.c C2 — lifted the standalone guard. Revoke is owner-only
    // soft-delete + credential sweep; the in-DB action is identical
    // in embedded and standalone. Standalone adds one extra step:
    // if the revoked host currently has a live outbound websocket,
    // close it with code 1008 / reason `host_revoked` to flip the
    // renderer's BackendInfo immediately instead of waiting for
    // the daemon to lose its current socket on its own. The
    // current daemon outbound client reconnects on every close
    // code (`packages/host/src/daemon/outbound-client.ts:349`);
    // the reconnect attempt is rejected at upgrade-auth because
    // `verifyHostToken` no longer accepts the credential. Branching
    // on `host_revoked` to suppress reconnect is a follow-up (D3.e
    // / D4.d). The revoke and credential sweep run inside a single
    // transaction; the disconnect happens AFTER commit so the
    // credential is already revoked when the daemon's reconnect
    // arrives. R4: HTTP route + outbound WS close-frame, no
    // protocol change.

    const hostId = c.req.param('id');
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      // Cross-user / missing collapse to 404 to avoid host_id
      // enumeration (matches the route ACL spec from A.3).
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }

    const now = Date.now();
    ctx.db.transaction(() => {
      if (host.revoked_at === null) {
        hosts.revoke(hostId, now);
      }
      // Always sweep — covers idempotent re-revoke and reconciles
      // half-failed prior runs (host row revoked, credentials still
      // active).
      hostTokens.revokeAllCredentialsForHost(hostId, now);
    })();

    const updated = hosts.get(hostId);
    if (!updated) {
      // Unreachable: SELECT immediately after a transaction we just
      // committed. Surface as 500 if it ever happens so the contract
      // stays loud.
      throw new Error(`HostRepo.get returned null for revoked host ${hostId}`);
    }

    // D4.c C2 — best-effort connection drop. Runs AFTER the
    // commit so the credential is already revoked when the
    // daemon's reconnect arrives at upgrade-auth. Always safe
    // to call: idempotent for hosts with no live attachment
    // (returns false) and replacement-safe for the connection
    // map (cleanup is driven by the socket's `close` listener,
    // not by this call). This kick is a WS-only concern (it is
    // deliberately NOT part of `OutboundFrameAdapter`): it only
    // bites the standalone path, where the daemon attaches over
    // WSS. In embedded mode the daemon does not dial in over WS
    // (the backend dials the daemon's local Unix socket instead),
    // so there is no outbound WS attachment to drop here — the
    // revoke's authoritative effect is the DB credential flip
    // above, and `disconnectHost` is a harmless no-op.
    const wsController = ctx.hostWsController?.();
    if (wsController) {
      try {
        wsController.disconnectHost(hostId);
      } catch (err) {
        // Connection close is optimistic UX, never the
        // authoritative revoke effect; log and swallow.
        ctx.logger.warn(
          { err, hostId, action: 'host_revoke_disconnect' },
          'host_revoke disconnect failed (non-blocking)',
        );
      }
    }

    return c.json({ host: hosts.toDto(updated) });
  });

  // POST /api/hosts/:id/rotate-token — Stage B.4 long-lived token
  // rotation. Owner-only, 404 on cross-user/missing, 409 if the host
  // is already revoked or is not a `local` kind (V1 surface only
  // rotates the user's local host). Embedded mode returns a fresh
  // long_lived token for Electron main to write to daemon-config
  // before IPC returns to the renderer. Standalone mode sends the
  // cleartext replacement only over the host WebSocket `rotate_token`
  // command and returns no token bytes in the HTTP response.
  app.post('/api/hosts/:id/rotate-token', async c => {
    const userId = requireSessionBearerUser(c, ctx);
    if (userId instanceof Response) return userId;

    const hostId = c.req.param('id');
    const host = hosts.get(hostId);
    if (!host || host.user_id !== userId) {
      return c.json({ error: 'host not found', error_code: 'host_not_found' }, 404);
    }
    if (host.revoked_at !== null) {
      return c.json(
        {
          error: 'host has been revoked',
          error_code: 'host_revoked',
        },
        409,
      );
    }
    if (host.kind !== 'local') {
      return c.json(
        {
          error: 'rotate is only supported for local hosts',
          error_code: 'kind_not_supported',
        },
        409,
      );
    }

    if (standaloneMode(ctx)) {
      const transport = ctx.hostWsController?.();
      if (!transport) {
        return hostRuntimeDisabledResponse(c, 'host token rotation', 503);
      }
      try {
        await new HostTokenRotationCoordinator({
          hostTokens,
          transport,
          logger: ctx.logger,
        }).rotateHostToken(hostId);
      } catch (err) {
        if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
          return c.json(
            {
              error: 'host has been revoked',
              error_code: 'host_revoked',
            },
            409,
          );
        }
        if (err instanceof HostWsCommandTransportError) {
          return c.json(
            {
              error: 'host token rotation transport failed',
              error_code: err.code,
            },
            err.code === 'transport_no_connection' ? 503 : 502,
          );
        }
        if (err instanceof HostTokenRotationError) {
          return c.json(
            {
              error: 'host token rotation rejected by daemon',
              error_code: 'host_token_rotation_failed',
              reason: err.details.daemonReason,
            },
            502,
          );
        }
        throw err;
      }

      const refreshed = hosts.get(hostId);
      if (!refreshed) {
        throw new Error(`HostRepo.get returned null for rotated host ${hostId}`);
      }
      return c.json({
        host_id: hostId,
        host: hosts.toDto(refreshed),
        status: 'rotated',
      });
    }

    let issued: ReturnType<HostTokenService['rotateHostToken']>;
    try {
      issued = hostTokens.rotateHostToken({ hostId });
    } catch (err) {
      if (err instanceof HostCredentialIssueError && err.code === 'host_revoked') {
        return c.json(
          {
            error: 'host has been revoked',
            error_code: 'host_revoked',
          },
          409,
        );
      }
      throw err;
    }

    const refreshed = hosts.get(hostId);
    if (!refreshed) {
      throw new Error(`HostRepo.get returned null for rotated host ${hostId}`);
    }
    return c.json({
      host_id: hostId,
      host: hosts.toDto(refreshed),
      host_token: issued.hostToken,
    });
  });

  function resolveCreateHostId(
    explicitHostId: string | undefined,
    userId: string,
  ): string {
    if (explicitHostId) {
      return ctx.placement.assertOwnedActiveHost(explicitHostId, userId).id;
    }
    return ctx.placement.resolveOwnedLocalForUser(userId).id;
  }

  /**
   * D4.c C3 — preflight that rejects any workspace-level mutation
   * (PATCH metadata, DELETE) when one of the workspace's existing
   * agent-backed conversations carries an agent that no longer
   * matches `expectedHostId`. Throws the placement layer's
   * `host_mismatch` error (typed 409 via `placementErrorResponse`)
   * BEFORE the route runs any side effect — metadata write,
   * rename system message insert, runtime stop, attachment sweep,
   * or workspaces.delete.
   *
   * Coverage MUST match the downstream side-effect loop. DELETE
   * iterates `conversations.list().filter(workspace_id === id)`
   * which scans EVERY conversation kind (channel, dm_channel,
   * thread). The preflight does the same — using
   * `conversations.listAllChannelsForWorkspace` (channels only)
   * would silently miss a cross-host agent attached to a thread
   * or dm_channel and let DELETE walk the runtime stop / sweep /
   * delete path on a workspace that should fail-closed (Cindy
   * round-1 P1).
   *
   * NOTE: This is a control-plane placement check. fs side-effect
   * boundaries (`initWorkspaceDir` / `ensureAgentL1Dir` /
   * `seedAgentL2`) are NOT moved by C3 — they remain server-side
   * placeholders in standalone mode pending the D4.e workspace
   * materialize intent. The fail-closed contract here is
   * "rejected path leaks no fs / DB / message side effect", which
   * is true because the call sits before every write.
   */
  function assertWorkspaceAgentsMatchHost(
    workspaceId: string,
    expectedHostId: string,
  ): void {
    const workspaceConversations = conversations
      .list()
      .filter(conversation => conversation.workspace_id === workspaceId);
    for (const conversation of workspaceConversations) {
      for (const ca of conversations.listAgents(conversation.id)) {
        ctx.placement.assertAgentMatchesHost(ca.agent_id, expectedHostId);
      }
    }
  }

  // ── Workspaces / conversations ──────────────────────────────────
  //
  // Canonical workspace/channel/thread API backed by workspaces and
  // conversations. Route kind guards prevent a thread id from silently
  // passing as a channel id.

  app.get(apiPaths.workspaces, c =>
    c.json({
      workspaces: workspaces
        .list()
        .filter(workspace => canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)),
    }),
  );

  app.post(apiPaths.workspaces, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (workspaces.getByName(parsed.data.name)) {
      return c.json({ error: 'workspace name already exists' }, 409);
    }
    // D4.c C3 — `workspace_path` is fs concept that lives on the
    // **daemon-host**'s filesystem. In embedded mode the daemon
    // and the backend share that fs (the user's machine) so a
    // caller-supplied `workspace_path` is meaningful. In
    // standalone mode the backend's fs is the server box, which
    // the user does NOT control; per D2.0 ("server doesn't
    // pretend to own user filesystem") accepting an arbitrary
    // path here would be a contract violation. Reject with a
    // route-local typed code rather than overloading the runtime
    // host placement taxonomy. The fs materialization redesign
    // (workspace_path → daemon-host) lives in D4.e.
    if (standaloneMode(ctx) && parsed.data.workspace_path) {
      return c.json(
        {
          error: 'workspace_path is not supported in standalone mode',
          error_code: 'workspace_path_not_supported',
        },
        409,
      );
    }

    const workspacePath =
      parsed.data.workspace_path?.trim() || workspaces.workspacePathFor(parsed.data.name);
    const validation = validateWorkspacePath(
      workspacePath,
      ctx.silverhandDir,
      ctx.workspacesRoot,
    );
    if (!validation.ok) {
      return c.json(
        { error: `invalid workspace_path: ${validation.reason}` },
        400,
      );
    }

    const viewerUserId = requireViewerUserId(c);
    let workspaceHostId: string;
    let memberAgents: AgentDto[];
    try {
      // D4.c C3 — unified placement decision: both embedded and
      // standalone go through `resolveCreateHostId`. Caller-supplied
      // `workspace_host_id` → `assertOwnedActiveHost(host, user)`;
      // caller omitted → `resolveOwnedLocalForUser(user)` which is
      // the C1-installed 0/1/N policy (`local_host_unbound` /
      // `local_host_ambiguous` typed 409). The pre-D4.c branch that
      // synthesized a `STANDALONE_SERVER` placeholder host is no
      // longer reached.
      workspaceHostId = resolveCreateHostId(
        parsed.data.workspace_host_id,
        viewerUserId,
      );
      memberAgents = parsed.data.member_agent_ids
        .map(id => agents.get(id))
        .filter((agent): agent is AgentDto => agent !== null);
      for (const agent of memberAgents) {
        ctx.placement.assertAgentMatchesHost(agent.id, workspaceHostId);
      }
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }

    await initWorkspaceDir(validation.resolved);

    const workspace = workspaces.insert({
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      workspacePath: validation.resolved,
      workspaceHostId,
    });

    // v25: human membership. The actor (registered viewer) becomes a
    // member of every workspace they create. In v1 single-human this is
    // always the same one viewer; in v2 multi-human it's still
    // correct — the creator is a member by default.
    workspaces.addUserMember(workspace.id, viewerUserId);

    for (const agent of memberAgents) {
      workspaces.addMember(workspace.id, agent.id);
      const agentL1Dir = join(ctx.silverhandDir, 'agents', agent.id);
      await ensureAgentL1Dir(agentL1Dir);
      await seedAgentL2({
        workspacePath: workspace.workspace_path,
        agentId: agent.id,
      });
    }

    const onboarding = conversations.insertChannel({
      workspaceId: workspace.id,
      workspacePath: workspace.workspace_path,
      title: 'Onboarding',
    });
    // Snapshot workspace_users into the onboarding channel.
    // v1: single viewer; v2 will fan out across all workspace humans.
    for (const userId of workspaces.listUserMemberIds(workspace.id)) {
      conversations.addUser(onboarding.id, userId);
    }
    for (const agent of memberAgents) {
      conversations.addAgent(onboarding.id, agent.id);
    }
    for (const agent of memberAgents) {
      const others = memberAgents.filter(m => m.id !== agent.id);
      const onboardingMsg = messages.insertForConversation({
        conversationId: onboarding.id,
        fromKind: 'system',
        content: onboardingBody(workspace.name, agent, others),
        metadata: { subtype: systemSubtype('onboarding') },
      });
      await ctx.runtimeHost.deliverMessage(
        onboarding.id,
        agent.id,
        onboardingMsg.id,
      );
      ctx.runtimeHost
        .start(onboarding.id, agent.id)
        .catch(err =>
          ctx.logger.error(
            { conversationId: onboarding.id, agentId: agent.id, err },
            'onboarding spawn failed',
          ),
        );
    }

    return c.json(
      { workspace, onboarding_channel_id: onboarding.id, channel: onboarding },
      201,
    );
  });

  app.get(apiPaths.workspace(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ workspace });
  });

  app.patch(apiPaths.workspace(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // D4.c C3 — replaced the standalone-mode `host_runtime_disabled`
    // short-circuit with an actual placement preflight that runs in
    // both deployment modes. Iterate every existing agent-backed
    // conversation in this workspace; if any agent's host placement
    // no longer matches the workspace's `workspace_host_id`,
    // fail-closed with 409 `host_mismatch`. This MUST run before
    // any side effect: metadata write
    // (`updateMutableMetadata`), the rename system message
    // insert, or `runtimeHost.deliverMessage`. The pre-D4.c
    // standalone short-circuit was a deferral placeholder; now
    // the same DB-level placement contract applies in both modes,
    // so the route can run identically. (NOTE: agent-host
    // assignments don't change today, but the preflight makes the
    // invariant explicit so future agent-rebind paths can't
    // silently break workspace metadata writes.)
    try {
      assertWorkspaceAgentsMatchHost(workspace.id, workspace.workspace_host_id);
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
    if (parsed.data.name && parsed.data.name !== workspace.name) {
      const collision = workspaces.getByName(parsed.data.name);
      if (collision && collision.id !== workspace.id) {
        return c.json({ error: 'workspace name already exists' }, 409);
      }
    }
    const updated = workspaces.updateMutableMetadata(workspace.id, parsed.data);
    if (!updated) return c.json({ error: 'workspace update failed' }, 500);

    if (parsed.data.name && parsed.data.name !== workspace.name) {
      for (const channel of conversations.listAllChannelsForWorkspace(workspace.id)) {
        if (channel.closed_at !== null) continue;
        const announce = messages.insertForConversation({
          conversationId: channel.id,
          fromKind: 'system',
          content:
            `This workspace was renamed from #${workspace.name} to #${parsed.data.name}. ` +
            `Update any references in your MEMORY.md when you next edit it.`,
          metadata: {
            subtype: systemSubtype('rename'),
            old_name: workspace.name,
            new_name: parsed.data.name,
          },
        });
        for (const ca of conversations.listAgents(channel.id)) {
          await ctx.runtimeHost.deliverMessage(
            channel.id,
            ca.agent_id,
            announce.id,
          );
        }
        ctx.events.publish(channel.id, {
          kind: 'message',
          payload: { message: announce },
        });
      }
    }

    return c.json({ workspace: updated });
  });

  app.patch('/api/workspaces/:id/archive', async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveWorkspaceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const updated = workspaces.setArchived(workspace.id, parsed.data.archived);
    if (!updated) return c.json({ error: 'archive update failed' }, 500);
    return c.json({ workspace: updated });
  });

  app.post(apiPaths.workspacePin(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (
      !workspace ||
      workspace.workspace_kind !== 'regular' ||
      workspace.archived_at !== null
    ) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const updated = workspaces.setPinned(workspace.id, true);
    if (!updated) return c.json({ error: 'workspace pin failed' }, 500);
    return c.json({ workspace: updated });
  });

  app.delete(apiPaths.workspacePin(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (
      !workspace ||
      workspace.workspace_kind !== 'regular' ||
      workspace.archived_at !== null
    ) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const updated = workspaces.setPinned(workspace.id, false);
    if (!updated) return c.json({ error: 'workspace unpin failed' }, 500);
    return c.json({ workspace: updated });
  });

  app.delete(apiPaths.workspace(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.body(null, 204);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceConversations = conversations
      .list()
      .filter(conversation => conversation.workspace_id === workspace.id);
    // D4.c C3 — replaced the standalone-mode `host_runtime_disabled`
    // short-circuit with an explicit placement preflight that runs
    // in both deployment modes. This MUST run before any side
    // effect: `runtimeHost.resolveConversationRuns`, runtime stop,
    // `attachmentService.sweepForChannel`, `workspaces.delete`. If
    // any agent's host placement no longer matches the workspace,
    // fail-closed with 409 `host_mismatch` and leave every
    // conversation / blob / row untouched.
    try {
      assertWorkspaceAgentsMatchHost(workspace.id, workspace.workspace_host_id);
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
    for (const conversation of workspaceConversations) {
      ctx.runtimeHost.resolveConversationRuns(conversation.id, 'conversation_closed');
      for (const ca of conversations.listAgents(conversation.id)) {
        void ctx.runtimeHost.stop(conversation.id, ca.agent_id, 'hard');
      }
    }
    // Sweep physical attachment blobs for every top-level channel before
    // dropping the workspace. attachments.channel_id only points at
    // channel/dm_channel rows (threads upload via parent), so iterate
    // those — DB rows go via CASCADE, blobs need an explicit delete.
    for (const conversation of workspaceConversations) {
      if (conversation.kind === 'channel' || conversation.kind === 'dm_channel') {
        await ctx.attachmentService
          .sweepForChannel(conversation.id)
          .catch(err =>
            ctx.logger.warn(
              { workspaceId: workspace.id, conversationId: conversation.id, err },
              'delete workspace: attachment sweep failed (continuing)',
            ),
          );
      }
    }
    workspaces.delete(workspace.id);
    return c.body(null, 204);
  });

  app.get(apiPaths.workspaceChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const principal = getUserPrincipal(c);
    if (!canViewWorkspace(ctx, principal, workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Membership filter: human principals only see channels/threads
    // they are explicit members of (`conversation_users`). Agent /
    // system principals never call these public list endpoints in
    // practice; if they ever do, the unfiltered behavior is the
    // historical contract.
    const forUserId =
      principal.kind === 'user' ? principal.userId : undefined;
    const channels =
      workspace.workspace_kind === 'regular'
        ? timedRouteSpan(
            ctx,
            'workspace.channels.list_active',
            { workspaceId: workspace.id },
            () =>
              conversations.listActiveChannelsForWorkspace(workspace.id, {
                forUserId,
              }),
            result => ({ channelCount: result.length }),
          )
        : timedRouteSpan(
            ctx,
            'workspace.dm_channel.list',
            { workspaceId: workspace.id },
            () =>
              conversations.listDmChannelsForWorkspace(workspace.id, {
                forUserId,
              }),
            result => ({ channelCount: result.length }),
          );
    // Active endpoint only returns threads whose parent is also active —
    // the response is a self-contained tree, no orphan threads.
    const threads =
      workspace.workspace_kind === 'regular'
        ? timedRouteSpan(
            ctx,
            'workspace.threads.list_active',
            { workspaceId: workspace.id },
            () =>
              conversations.listThreadsForWorkspace(workspace.id, {
                parentArchived: false,
                forUserId,
              }),
            result => ({ threadCount: result.length }),
          )
        : timedRouteSpan(
            ctx,
            'workspace.threads.list',
            { workspaceId: workspace.id },
            () =>
              conversations.listThreadsForWorkspace(workspace.id, {
                forUserId,
              }),
            result => ({ threadCount: result.length }),
          );
    return c.json({
      channels,
      threads,
    });
  });

  app.get(apiPaths.workspaceArchivedChannels(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    const principal = getUserPrincipal(c);
    if (!canViewWorkspace(ctx, principal, workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // agent_home workspaces don't support channel archive (their only
    // conversation is the dm_channel). Return an empty tree so the
    // frontend can call this hook unconditionally.
    if (workspace.workspace_kind !== 'regular') {
      return c.json({ channels: [], threads: [] });
    }
    const forUserId =
      principal.kind === 'user' ? principal.userId : undefined;
    const channels = timedRouteSpan(
      ctx,
      'workspace.channels.list_archived',
      { workspaceId: workspace.id },
      () =>
        conversations.listArchivedChannelsForWorkspace(workspace.id, {
          forUserId,
        }),
      result => ({ channelCount: result.length }),
    );
    const threads = timedRouteSpan(
      ctx,
      'workspace.threads.list_archived',
      { workspaceId: workspace.id },
      () =>
        conversations.listThreadsForWorkspace(workspace.id, {
          parentArchived: true,
          forUserId,
        }),
      result => ({ threadCount: result.length }),
    );
    return c.json({ channels, threads });
  });

  app.get(apiPaths.archivedChannels, c => {
    const principal = getUserPrincipal(c);
    const parsed = ArchivedChannelsQueryInputSchema.safeParse({
      workspace_id: c.req.query('workspace_id'),
      since: c.req.query('since'),
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (
      parsed.data.workspace_id !== undefined &&
      !canViewWorkspace(ctx, principal, parsed.data.workspace_id)
    ) {
      // Mirror the workspace-scoped endpoint: 404 when the workspace
      // doesn't exist, 403 when the caller can't see it. v1 user can
      // see every workspace, so this is mostly future-proofing.
      const exists = workspaces.get(parsed.data.workspace_id);
      return c.json(
        { error: exists ? 'forbidden' : 'workspace not found' },
        exists ? 403 : 404,
      );
    }
    const rows = timedRouteSpan(
      ctx,
      'archived_channels.list',
      {
        workspaceFilter: parsed.data.workspace_id ?? null,
        since: parsed.data.since ?? null,
      },
      () =>
        conversations.listArchivedChannelsAggregate({
          workspaceId: parsed.data.workspace_id,
          since: parsed.data.since,
          forUserId:
            principal.kind === 'user' ? principal.userId : undefined,
        }),
      result => ({ rowCount: result.length }),
    );
    // Membership filter is applied at the repo level (forUserId), so
    // the result already only includes channels the principal is a
    // `conversation_users` member of. v1 single-human is auto-added
    // to every conversation; v2 multi-human relies on this filter.
    return c.json({ channels: rows });
  });

  app.post(apiPaths.workspaceChannels(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateConversationChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (workspace.workspace_kind === 'agent_home') {
      if (parsed.data.member_agent_ids.length > 0) {
        return c.json(
          { error: 'agent_home channels always use the home owner as member' },
          400,
        );
      }
      if (!workspace.owner_agent_id) {
        return c.json({ error: 'agent_home workspace missing owner' }, 500);
      }
      const owner = agents.get(workspace.owner_agent_id);
      if (!owner) return c.json({ error: 'agent_home owner not found' }, 404);
      const principal = getUserPrincipal(c);
      const channel = ctx.db.transaction(() => {
        const dm = conversations.insertDmChannel({
          workspaceId: workspace.id,
          workspacePath: workspace.workspace_path,
          title: parsed.data.title,
          agentId: owner.id,
        });
        conversations.addAgent(dm.id, owner.id);
        // v25: human membership for the freshly-created DM. The user
        // who triggered the route is a workspace member (canMutate
        // already passed), so they are a legitimate human member of
        // their newly-created DM. Without this row the post-create
        // GET /messages would 403 for the same principal that just
        // created it.
        if (principal.kind === 'user') {
          conversations.addUser(dm.id, principal.userId);
        }
        return dm;
      })();
      ctx.events.publishToScope(`workspace:${workspace.id}`, 'workspace_channels_changed', {
        workspace_id: workspace.id,
        channel_id: channel.id,
      });
      return c.json({ channel }, 201);
    }
    if (standaloneMode(ctx) && parsed.data.member_agent_ids.length > 0) {
      // D4.b P1-1 (B-class deferral): agent-backed channel
      // creation needs the agent CRUD placement model (D4.c /
      // G3). Typed `host_runtime_disabled` here means CRUD
      // deferral, NOT runtime transport unavailable.
      return hostRuntimeDisabledResponse(c, 'agent-backed channel creation');
    }
    try {
      const result = await ctx.channelService.createChannel({
        workspaceId: id,
        title: parsed.data.title,
        memberAgentIds: parsed.data.member_agent_ids,
        actor: getUserPrincipal(c),
      });
      return c.json({ channel: result.channel }, 201);
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(apiPaths.workspaceMembers(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (workspace.workspace_kind === 'agent_home') {
      return c.json({ members: [] });
    }
    return c.json({ members: workspaces.listMembers(workspace.id) });
  });

  app.post(apiPaths.workspaceMembers(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canManageMembers(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AddWorkspaceMemberInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // D4.c C3 — lifted the standalone `host_runtime_disabled`
    // short-circuit. The DB-level placement check still runs
    // inside `WorkspaceRepo.addMember` →
    // `assertAgentMatchesHost`, which throws BEFORE any fs side
    // effect (`ensureAgentL1Dir` / `seedAgentL2`). The catch
    // block below maps the placement error to 409
    // `host_mismatch`. So the fail-closed contract holds without
    // the deployment-mode short-circuit.
    const agent = agents.get(parsed.data.agent_id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    let member: ReturnType<WorkspaceRepo['addMember']>;
    try {
      member = workspaces.addMember(workspace.id, agent.id);
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
    const agentL1Dir = join(ctx.silverhandDir, 'agents', agent.id);
    await ensureAgentL1Dir(agentL1Dir);
    await seedAgentL2({
      workspacePath: workspace.workspace_path,
      agentId: agent.id,
    });
    return c.json({ member }, 201);
  });

  app.delete(apiPaths.workspaceMember(':id', ':agentId'), async c => {
    const id = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (!id || !agentId) {
      return c.json({ error: 'workspace id and agent id required' }, 400);
    }
    const workspace = workspaces.get(id);
    if (!workspace || workspace.workspace_kind !== 'regular') return c.body(null, 204);
    if (!canManageMembers(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    for (const conversation of conversations.list()) {
      if (conversation.workspace_id !== workspace.id) continue;
      await ctx.runtimeHost
        .stop(conversation.id, agentId, 'hard')
        .catch(err =>
          ctx.logger.warn(
            { conversationId: conversation.id, agentId, err },
            'workspace member remove: stop failed',
          ),
        );
      conversations.removeAgent(conversation.id, agentId);
    }
    workspaces.removeMember(workspace.id, agentId);
    return c.body(null, 204);
  });

  app.get('/api/workspaces/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'workspace id required' }, 400);
    const workspace = workspaces.get(id);
    if (!workspace) {
      return c.json({ error: 'workspace not found' }, 404);
    }
    if (!canViewWorkspace(ctx, getUserPrincipal(c), workspace.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    const unread = timedRouteSpan(
      ctx,
      'workspace.message_unread.counts',
      { workspaceId: workspace.id, viewerUserId },
      () =>
        conversationReads.unreadCountsByConversationForWorkspace(
          workspace.id,
          viewerUserId,
        ),
      result => ({
        conversationCount: Object.keys(result.by_conversation).length,
        total: result.total,
      }),
    );
    return c.json(unread);
  });

  app.get(apiPaths.messageUnreadSummary, c => {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const byWorkspace = timedRouteSpan(
      ctx,
      'workspace.message_unread.summary',
      { viewerUserId },
      () => conversationReads.unreadCountsByWorkspaceSidebar(viewerUserId),
      result => ({ scopeCount: Object.keys(result).length }),
    );
    return c.json({
      by_workspace: byWorkspace,
    });
  });

  app.get('/api/channels/:id/message-unread', c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const count = timedRouteSpan(
      ctx,
      'conversation.message_unread.count',
      { conversationId: channel.id, viewerUserId },
      () =>
        conversationReads.unreadCountForConversation(
          channel.id,
          viewerUserId,
        ),
    );
    return c.json({ by_conversation: { [channel.id]: count }, total: count });
  });

  /**
   * Parse the cursor query for the user-facing messages window
   * endpoints (channel + thread). Returns either a parsed selector
   * (≤ 1 anchor) or a Hono `Response` carrying a 400 with a stable
   * `code` + `message`. Anchors are mutually exclusive on the wire:
   * if a client sends 2+ at once we refuse before touching the DB so
   * the resulting window is unambiguous and React Query never has to
   * second-guess which cursor a page came from.
   */
  function parseMessagesWindowQuery(c: Context):
    | {
        ok: true;
        limit: number;
        beforeSeq: number | null;
        afterSeq: number | null;
        aroundMessageId: string | null;
      }
    | { ok: false; response: Response } {
    const parsedLimit = Number(c.req.query('limit') ?? 200);
    const limit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 500)
      : 200;
    const before = c.req.query('before_seq');
    const after = c.req.query('after_seq');
    const around = c.req.query('around_message_id');

    // Reject any anchor that came in but failed numeric parsing
    // before we count anchors — otherwise a junk `before_seq=foo`
    // would silently degrade to "latest" and surprise the caller.
    // `seq` is monotonically positive in the DB (1-indexed). `0` is
    // intentionally allowed: `after_seq=0` means "page forward from
    // before-the-first row", which is a legitimate way to ask for
    // the earliest window. Negative cursors are rejected.
    let beforeSeq: number | null = null;
    if (before !== undefined) {
      const n = Number(before);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          response: c.json(
            {
              error: 'before_seq must be a non-negative integer',
              code: 'invalid_cursor',
            },
            400,
          ),
        };
      }
      beforeSeq = n;
    }
    let afterSeq: number | null = null;
    if (after !== undefined) {
      const n = Number(after);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        return {
          ok: false,
          response: c.json(
            {
              error: 'after_seq must be a non-negative integer',
              code: 'invalid_cursor',
            },
            400,
          ),
        };
      }
      afterSeq = n;
    }
    // Empty `around_message_id=` is a client bug, not "give me
    // latest" — refusing it forces callers to either pass a real
    // anchor or omit the param entirely, so the resulting window
    // is unambiguous.
    if (around !== undefined && around.length === 0) {
      return {
        ok: false,
        response: c.json(
          {
            error: 'around_message_id must be a non-empty message id',
            code: 'invalid_cursor',
          },
          400,
        ),
      };
    }
    const aroundMessageId =
      around !== undefined && around.length > 0 ? around : null;

    const anchorCount =
      (beforeSeq !== null ? 1 : 0) +
      (afterSeq !== null ? 1 : 0) +
      (aroundMessageId !== null ? 1 : 0);
    if (anchorCount > 1) {
      return {
        ok: false,
        response: c.json(
          {
            error:
              'before_seq, after_seq and around_message_id are mutually exclusive',
            code: 'mutually_exclusive_cursors',
          },
          400,
        ),
      };
    }

    return { ok: true, limit, beforeSeq, afterSeq, aroundMessageId };
  }

  app.get(apiPaths.conversationChannelMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = parseMessagesWindowQuery(c);
    if (!parsed.ok) return parsed.response;
    const { limit, beforeSeq, afterSeq, aroundMessageId } = parsed;
    try {
      const window = timedRouteSpan(
        ctx,
        'conversation.messages.window',
        {
          conversationId: channel.id,
          kind: channel.kind,
          limit,
          beforeSeq,
          afterSeq,
          aroundMessageId,
        },
        () =>
          messages.listWindowForConversation(channel.id, {
            limit,
            beforeSeq,
            afterSeq,
            aroundMessageId,
          }),
        result => ({
          messageCount: result.messages.length,
          hasMoreBefore: result.has_more_before,
          hasMoreAfter: result.has_more_after,
        }),
      );
      return c.json(window);
    } catch (err) {
      if (err instanceof AnchorMessageNotInConversationError) {
        return c.json(
          {
            error: 'around_message_id not found in this conversation',
            code: 'message_not_found',
          },
          404,
        );
      }
      throw err;
    }
  });

  app.get(apiPaths.conversationChannel(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ channel });
  });

  app.get(apiPaths.thread(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ thread });
  });

  /**
   * GET /api/conversations/:id/ref
   *
   * Identity + routing metadata for any conversation (channel /
   * dm_channel / thread) by id. Designed to back cross-workspace
   * secondary-pane resolution and the `#conv:<id>` sigil renderer (PR-3).
   *
   * Permission: `canViewConversation` — strict conversation membership.
   * The route is user-facing only (no `/internal` twin), so agent
   * principals never reach it. Do NOT generalise to agents without a
   * dedicated ACL helper.
   *
   * Response intentionally excludes messages and per-user unread
   * state — those go through the existing window/cursor endpoints.
   * `workspace_kind` is projected `agent_home → 'dm'` so the
   * renderer never sees a third kind.
   */
  app.get(apiPaths.conversationRef(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspace = workspaces.get(conversation.workspace_id);
    if (!workspace) return c.json({ error: 'conversation not found' }, 404);

    const parentChannelId =
      conversation.kind === 'thread' ? conversation.parent_conversation_id : null;
    let parentTitle: string | null = null;
    if (parentChannelId) {
      const parent = conversations.get(parentChannelId);
      // Parent missing implies a stale row; we still return ref but
      // leave parent_title null so the renderer falls back to "thread"
      // instead of crashing.
      parentTitle = parent ? parent.title : null;
    }

    const ref = {
      id: conversation.id,
      kind: conversation.kind,
      title: conversation.title,
      workspace_id: conversation.workspace_id,
      // External projection: agents see `agent_home` internally; users
      // see `dm`. The renderer/UI uses regular|dm exclusively.
      workspace_kind:
        workspace.workspace_kind === 'agent_home'
          ? ('dm' as const)
          : ('regular' as const),
      workspace_path: conversation.workspace_path,
      parent_channel_id: parentChannelId,
      parent_title: parentTitle,
      closed_at: conversation.closed_at,
      archived_at: conversation.archived_at,
    };
    return c.json({ ref });
  });

  app.get(apiPaths.conversationLogDebug(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const status = ctx.logControl.getConversationDebugStatus(conversation.id);
    return c.json({
      conversationId: conversation.id,
      enabled: status.enabled,
      expiresAt: status.expiresAt,
    });
  });

  app.post(apiPaths.conversationLogDebug(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewConversation(ctx, principal, conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ConversationLogDebugInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    let expiresAt: number | null = null;
    if (parsed.data.enabled) {
      expiresAt = Date.now() + TEMP_CONVERSATION_DEBUG_WINDOW_MS;
      ctx.logControl.enableConversationDebug(conversation.id, expiresAt);
    } else {
      ctx.logControl.disableConversationDebug(conversation.id);
    }

    let daemonSynced = true;
    try {
      await ctx.runtimeHost.setConversationLogDebug(
        conversation.id,
        parsed.data.enabled,
        expiresAt,
      );
    } catch (err) {
      daemonSynced = false;
      ctx.logger.warn(
        { conversationId: conversation.id, err },
        'conversation log debug: daemon sync failed',
      );
    }

    ctx.logger.info(
      {
        conversationId: conversation.id,
        enabled: parsed.data.enabled,
        expiresAt,
        daemonSynced,
        actorUserId: principal.userId,
      },
      'conversation log debug window updated',
    );
    return c.json({
      conversationId: conversation.id,
      enabled: parsed.data.enabled,
      expiresAt,
      daemonSynced,
    });
  });

  /**
   * GET /api/conversations/:id/members
   *
   * Resolved member list (agents + humans) for any conversation by id.
   * Backs the chat-header member-chip strip (PR-C). Same `MemberDto`
   * shape that the platform prompt's "Members in this conversation:"
   * block (PR-B) consumes — single source of truth so the agent's
   * stated participants and the chips the human sees can never drift.
   *
   * Permission: `canViewConversation` — strict membership / system
   * gate (workspace member or conversation member). Threads inherit
   * their parent's membership at creation time (v25 PR-A invariant),
   * so this route is correct for channel / dm_channel / thread alike
   * without special-casing.
   *
   * Self filtering is the renderer's job. Agent self has no UI
   * meaning here; the renderer drops the current human viewer
   * (UI-self) by `kind === 'human' && user_id === viewer.id` —
   * unrelated to the prompt's per-spawn `self: true` agent marker.
   */
  app.get(apiPaths.conversationMembers(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'conversation id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), conversation.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const members = membership.listMembers(conversation.id);
    return c.json({ members });
  });

  app.get(apiPaths.threadMessages(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = parseMessagesWindowQuery(c);
    if (!parsed.ok) return parsed.response;
    const { limit, beforeSeq, afterSeq, aroundMessageId } = parsed;
    try {
      const window = timedRouteSpan(
        ctx,
        'conversation.messages.window',
        {
          conversationId: thread.id,
          kind: thread.kind,
          limit,
          beforeSeq,
          afterSeq,
          aroundMessageId,
        },
        () =>
          messages.listWindowForConversation(thread.id, {
            limit,
            beforeSeq,
            afterSeq,
            aroundMessageId,
          }),
        result => ({
          messageCount: result.messages.length,
          hasMoreBefore: result.has_more_before,
          hasMoreAfter: result.has_more_after,
        }),
      );
      return c.json(window);
    } catch (err) {
      if (err instanceof AnchorMessageNotInConversationError) {
        return c.json(
          {
            error: 'around_message_id not found in this conversation',
            code: 'message_not_found',
          },
          404,
        );
      }
      throw err;
    }
  });

  app.get(apiPaths.conversationChannelAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const channelAgents = timedRouteSpan(
      ctx,
      'conversation.agents.list',
      { conversationId: channel.id, kind: channel.kind },
      () => conversations.listAgents(channel.id),
      result => ({ agentCount: result.length }),
    );
    return c.json({ agents: channelAgents });
  });

  app.get(apiPaths.threadAgents(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const threadAgents = timedRouteSpan(
      ctx,
      'conversation.agents.list',
      { conversationId: thread.id, kind: thread.kind },
      () => conversations.listAgents(thread.id),
      result => ({ agentCount: result.length }),
    );
    return c.json({ agents: threadAgents });
  });

  app.post('/api/channels/:id/pin', async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), channel.workspace_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.channelService.setPinned({ channelId: id, pinned: true });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.delete('/api/channels/:id/pin', async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), channel.workspace_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.channelService.setPinned({ channelId: id, pinned: false });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.patch(apiPaths.channelArchive(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const conversation = conversations.get(id);
    if (!conversation) return c.json({ error: 'channel not found' }, 404);
    if (!canMutateWorkspace(ctx, getUserPrincipal(c), conversation.workspace_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ArchiveChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = await ctx.channelService.setArchived({
        channelId: id,
        archived: parsed.data.archived,
      });
      return c.json({ channel: result.channel });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get(apiPaths.channelAgentRunStates(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const states = timedRouteSpan(
      ctx,
      'conversation.agent_run_states.snapshot',
      { conversationId: channel.id, kind: channel.kind },
      () => ctx.runtimeHost.getAgentRunStates(channel.id),
      result => ({ stateCount: result.length }),
    );
    return c.json({ states });
  });

  app.get(apiPaths.threadAgentRunStates(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const states = timedRouteSpan(
      ctx,
      'conversation.agent_run_states.snapshot',
      { conversationId: thread.id, kind: thread.kind },
      () => ctx.runtimeHost.getAgentRunStates(thread.id),
      result => ({ stateCount: result.length }),
    );
    return c.json({ states });
  });

  app.post(apiPaths.channelMessages(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canPostToConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // D4.b P1-1 (Cindy round-3 cleanup): lift `standaloneMode(ctx)`
    // fail-closed guard. The send-message route is **best-effort
    // delivery** — `ConversationMessageService.sendMessage` always
    // persists the message and returns 201 to the user, and the
    // per-agent `runtimeHost.deliverMessage(...)` fan-out is
    // wrapped in a top-level catch so a transient daemon-down
    // state does NOT bubble up as an HTTP error. The message stays
    // in `conversation_inboxes` as pending; the daemon's next
    // reattach drives the post-hydrate auto-drain (see
    // `OutboundRuntimeEventFanout.onHydrateComplete`) and the
    // inbox row's `delivered_at` flips then. So:
    //
    //   - No daemon attached → 201 success; message pending;
    //     auto-drain handles delivery on next reattach. The typed
    //     `HostWsCommandTransportError('transport_no_connection')`
    //     fires inside `deliverMessage` but is logged + swallowed
    //     by `sendMessage`'s `try/catch`. The HTTP response does
    //     NOT surface `host_attach_pending` here.
    //   - Daemon attached, runtime errors → same: 201 + logged.
    //
    // The typed `host_attach_pending` (503) surface lives on the
    // explicit lifecycle routes (`/start` / `/stop` /
    // `/clear-session` deferred), where the user is explicitly
    // asking the runtime to do something synchronously. That's
    // where the renderer needs the typed branch; for "send a
    // message" the persistent inbox IS the recovery mechanism.
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: channel.id,
        actor: getUserPrincipal(c),
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
      });
      return c.json({ message: result.message }, 201);
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(apiPaths.threadMessages(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canPostToConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    // D4.b P1-1: standalone send-to-agent-backed lifted (same
    // rationale as channelMessages above).
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: thread.id,
        actor: getUserPrincipal(c),
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
      });
      return c.json({ message: result.message }, 201);
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(apiPaths.channelMarkRead(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return markConversationRead(channel.id, c);
  });

  app.post(apiPaths.threadMarkRead(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return markConversationRead(thread.id, c);
  });

  app.get(apiPaths.channelThreads(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    if (!canViewConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const threads = timedRouteSpan(
      ctx,
      'conversation.threads.summary',
      { conversationId: channel.id, kind: channel.kind },
      () => conversations.listThreadSummariesForParent(channel.id),
      result => ({ threadCount: result.length }),
    );
    return c.json({ threads });
  });

  app.get(apiPaths.saved, c => {
    const principal = getUserPrincipal(c);
    return c.json({ saved: saved.listForUser(principal.userId) });
  });

  // ── Attachments ──────────────────────────────────────────────────
  // Upload via channel/thread context so the server resolves the access
  // boundary; clients never specify channel_id directly. Download is
  // by id — auth is bearer (renderer) or v1-permissive (TODO when DM
  // membership is enforceable per blob).

  app.post(apiPaths.channelAttachments(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'channel id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    const viewerUserId = requireViewerUserId(c);
    if (!canPostToConversation(ctx, getUserPrincipal(c), channel.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return uploadAttachment(ctx, c, channel.id, 'user', viewerUserId);
  });

  app.post(apiPaths.threadAttachments(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'thread id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    const viewerUserId = requireViewerUserId(c);
    if (!canPostToConversation(ctx, getUserPrincipal(c), thread.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return uploadAttachment(ctx, c, thread.id, 'user', viewerUserId);
  });

  app.get(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    const viewerUserId = requireViewerUserId(c);
    const principal = getUserPrincipal(c);
    const response = await ctx.attachmentService.serveForViewer(id, row =>
      canViewAttachment(ctx, principal, row),
    );
    if (!response) return c.json({ error: 'attachment not found' }, 404);
    return response;
  });

  app.delete(apiPaths.attachment(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'attachment id required' }, 400);
    const viewerUserId = requireViewerUserId(c);
    const attachment = attachments.getById(id);
    if (!attachment) return c.json({ error: 'attachment not found' }, 404);
    if (!canDeleteAttachment(ctx, getUserPrincipal(c), attachment)) {
      return c.json({ error: 'cannot delete attachment owned by another uploader' }, 403);
    }
    const result = await ctx.attachmentService.deleteOrphan(id, {
      kind: 'user',
      userId: viewerUserId,
    });
    if (result.ok) return c.body(null, 204);
    if (result.error === 'not_found') {
      return c.json({ error: 'attachment not found' }, 404);
    }
    if (result.error === 'forbidden') {
      return c.json({ error: 'cannot delete attachment owned by another uploader' }, 403);
    }
    // 'in_use' — at least one persisted message still references this id.
    return c.json(
      { error: 'attachment is referenced by a message and cannot be deleted' },
      409,
    );
  });

  app.post(apiPaths.messageSave(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const message = messages.getById(id);
    if (!message || !canViewConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'message not found' }, 404);
    }
    const row = saved.save(id);
    if (!row) return c.json({ error: 'message not found' }, 404);
    // Notify the resolved viewer's private scope so the saved list
    // invalidates without polling. Pre-PR1 this was 'viewer:local';
    // routes now resolve the current viewer principal.
    const viewerUserId = requireViewerUserId(c);
    ctx.events.publishToScope(
      `viewer:${viewerUserId}`,
      'saved_changed',
      { message_id: id, action: 'save' },
    );
    return c.json({ saved: row }, 201);
  });

  app.delete(apiPaths.messageSave(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'message id required' }, 400);
    const message = messages.getById(id);
    if (!message || !canViewConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'message not found' }, 404);
    }
    saved.remove(id);
    const viewerUserId = requireViewerUserId(c);
    ctx.events.publishToScope(
      `viewer:${viewerUserId}`,
      'saved_changed',
      { message_id: id, action: 'unsave' },
    );
    return c.body(null, 204);
  });

  app.get(apiPaths.search, c => {
    const parsed = SearchQueryInputSchema.safeParse(
      Object.fromEntries(new URL(c.req.url).searchParams.entries()),
    );
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    // Legacy `messages.from_user_id IS NULL` rows predate the principal
    // middleware. The renderer treats them as authored by the current
    // viewer, so when the search filter targets the viewer we widen the
    // SQL to include NULLs. Done here (not in the repo) so SearchRepo
    // stays a pure SQL adapter without an implicit settings lookup.
    const viewerUserId = requireViewerUserId(c);
    const includeNullAuthor =
      parsed.data.user_id !== undefined && parsed.data.user_id === viewerUserId;
    const results = search.search(parsed.data, {
      includeNullAuthor,
      visibleUserId: viewerUserId,
    });
    return c.json({ query: parsed.data, results });
  });

  app.post(apiPaths.messageThread(':id'), async c => {
    const messageId = c.req.param('id');
    if (!messageId) return c.json({ error: 'message id required' }, 400);
    const message = messages.getById(messageId);
    if (!message) return c.json({ error: 'message not found' }, 404);
    if (!canPostToConversation(ctx, getUserPrincipal(c), message.conversation_id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // D4.b P1-1: thread creation in an agent-backed conversation
    // doesn't itself dispatch any runtime command; it only creates
    // the child conversation row. The original D4.a guard was
    // over-broad — once the agent IS attached we want the thread
    // to be creatable in standalone too. Lifted; the downstream
    // "first message to the thread agent" path is what surfaces
    // typed `host_attach_pending` if no daemon.
    try {
      const result = await ctx.threadService.createThreadFromMessage({
        messageId,
        actor: getUserPrincipal(c),
      });
      return c.json(
        { thread_id: result.thread.id, thread: result.thread, reused: result.reused },
        result.reused ? 200 : 201,
      );
    } catch (err) {
      const mapped = threadServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post('/api/channels/:id/agents/:aid/start', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return startConversationAgent(channel.id, aid, c);
  });

  app.post('/api/threads/:id/agents/:aid/start', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'thread id and agent id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return startConversationAgent(thread.id, aid, c);
  });

  app.post('/api/channels/:id/agents/:aid/stop', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return stopConversationAgent(channel.id, aid, c);
  });

  app.post('/api/threads/:id/agents/:aid/stop', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'thread id and agent id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return stopConversationAgent(thread.id, aid, c);
  });

  app.post('/api/channels/:id/agents/:aid/clear-session', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'channel id and agent id required' }, 400);
    const channel = conversations.getChannelLike(id);
    if (!channel) return c.json({ error: 'channel not found' }, 404);
    return clearConversationAgentSession(channel.id, aid, c);
  });

  app.post('/api/threads/:id/agents/:aid/clear-session', async c => {
    const id = c.req.param('id');
    const aid = c.req.param('aid');
    if (!id || !aid) return c.json({ error: 'thread id and agent id required' }, 400);
    const thread = conversations.getThread(id);
    if (!thread) return c.json({ error: 'thread not found' }, 404);
    return clearConversationAgentSession(thread.id, aid, c);
  });

  async function markConversationRead(
    conversationId: string,
    c: Context,
  ): Promise<Response> {
    const viewerUserId = requireViewerUserId(c);
    if (!canViewOwnedState(ctx, getUserPrincipal(c), viewerUserId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkConversationReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const unreadBefore = conversationReads.unreadCountForConversation(
      conversationId,
      viewerUserId,
    );
    const row = conversationReads.markRead({
      viewerUserId,
      conversationId,
      seq: parsed.data.seq,
    });
    const unreadAfter =
      unreadBefore > 0
        ? conversationReads.unreadCountForConversation(conversationId, viewerUserId)
        : unreadBefore;
    // Notify viewer scope only when unread counters changed. Repeated
    // mark-read calls happen during focus/channel effects and should be no-ops.
    if (unreadAfter !== unreadBefore) {
      publishUnreadUpdated(ctx, conversationId, viewerUserId);
    }
    return c.json({ last_read_seq: row.last_read_seq });
  }

  async function startConversationAgent(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    if (!canPostToConversation(ctx, getUserPrincipal(c), conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    ctx.logger.info(
      { conversationId, agentId },
      'api: start agent requested',
    );
    // D4.b P1-1: blanket `standaloneMode(ctx)` guard lifted. When
    // the workspace's daemon-host is attached, `ctx.runtimeHost.start`
    // dispatches `runtime_start` over the outbound WS like the
    // embedded path. When no daemon is attached, the outbound
    // transport throws a typed
    // `HostWsCommandTransportError('transport_no_connection')` →
    // `placementErrorResponse` → 503 `host_attach_pending`. The
    // pre-D4.b 409 `host_runtime_disabled` collapsed both arms
    // into "this mode never runs agents" — wrong for D4.b.
    try {
      await ctx.runtimeHost.start(conversationId, agentId);
      return c.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { conversationId, agentId, err },
        'api: start agent failed',
      );
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      return c.json({ error: msg }, 400);
    }
  }

  async function stopConversationAgent(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    if (!canPostToConversation(ctx, getUserPrincipal(c), conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const mode: 'soft' | 'hard' = body?.mode === 'soft' ? 'soft' : 'hard';
    const directive =
      typeof body?.directive === 'string' ? body.directive : undefined;
    ctx.logger.info(
      { conversationId, agentId, mode, hasDirective: !!directive },
      'api: stop agent requested',
    );
    // D4.b P1-1: same lift as start (see startConversationAgent).
    try {
      await ctx.runtimeHost.stop(conversationId, agentId, mode, directive);
      return c.json({ ok: true });
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  }

  async function clearConversationAgentSession(
    conversationId: string,
    agentId: string,
    c: Context,
  ): Promise<Response> {
    if (!agents.get(agentId)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(conversationId, agentId)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 400);
    }
    const principal = getUserPrincipal(c);
    if (!canPostToConversation(ctx, principal, conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    ctx.logger.info(
      { conversationId, agentId },
      'api: clear agent session requested',
    );
    // D4.c C7 — standalone guard lifted. The standalone fanout's
    // `clearSession` (Cindy `szDHSdeKwtEUlxZb` P1 + `nPqEVJjCLjuNDH-6`)
    // dispatches `runtime_clear_session` over the outbound WS,
    // bounded-waits for the resulting `runtime_exit` projection
    // landed, then atomically clears `cli_session_id` + writes the
    // audit row in one DB tx — same wire shape as embedded
    // `DaemonAgentRuntimeHost.clearSession` (R4 envelope invariant).
    //
    // Two route-local typed errors that are NOT in the placement
    // taxonomy (Cindy `nPqEVJjCLjuNDH-6` constraint #1):
    //   - `ClearSessionExitTimeoutError` → 503
    //     `clear_session_timeout`. Daemon ACK'd
    //     `runtime_clear_session` but the resulting `runtime_exit`
    //     never landed within the bound (e.g. SIGKILL grace window
    //     stuck child). DB UNCHANGED — retry is safe.
    //   - `ClearSessionInProgressError` → 409
    //     `clear_session_in_progress`. A previous clear-session for
    //     the same (cid, aid) is still waiting on `runtime_exit`.
    //     Clear-session is a user-explicit one-shot — fail-fast
    //     beats share-waiter complexity.
    //
    // Transport-down at dispatch time still surfaces as 503
    // `host_attach_pending` via `placementErrorResponse`.
    //
    // **This IPC is local supervisor/control, not server↔daemon
    // formal semantics.**
    try {
      const result = await ctx.runtimeHost.clearSession(
        conversationId,
        agentId,
        principal.userId,
      );
      return c.json({
        ok: true,
        prev_cli_session_id: result.prevCliSessionId,
        was_running: result.wasRunning,
      });
    } catch (err) {
      if (err instanceof ClearSessionExitTimeoutError) {
        ctx.logger.warn(
          { conversationId, agentId, code: err.code },
          'api: clear agent session timed out waiting for runtime_exit projection',
        );
        return c.json({ error: err.message, code: err.code }, 503);
      }
      if (err instanceof ClearSessionInProgressError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.logger.error(
        { conversationId, agentId, err },
        'api: clear agent session failed',
      );
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      return c.json({ error: msg }, 400);
    }
  }

  /**
   * D4.d D3: insert the dependent-row graph for a freshly-materialized
   * agent in a SINGLE transaction. Called from L3a after the daemon
   * ack returns ok with the materialized `agent_dir` (which IS the
   * agent_home workspace path per §6.5).
   *
   * The tx writes (in order):
   *   1. flip `agents.materialization_status = 'active'`
   *   2. INSERT `agent_home` workspace row with `workspace_path =
   *      agent_dir`
   *   3. INSERT DM `conversations` row (`kind='dm_channel'`)
   *   4. INSERT `conversation_agents` binding
   *   5. INSERT `workspace_users` (creator) + `conversation_users`
   *      (creator) — v25 human membership
   *   6. INSERT onboarding `messages` row
   *
   * If ANY step fails (e.g. name-collision trigger fires at step 2),
   * `better-sqlite3` rolls the whole tx back. The caller wraps this
   * call in a try/catch and on failure runs the L3b path (flip the
   * row to `failed` with `failed_code='dependent_row_insert_failed'`)
   * in a SEPARATE tx — the L3b flip MUST be its own tx because the
   * L3a tx's rollback removes any UPDATE this function performed,
   * so without an explicit L3b tx the row would stay
   * `pending_materialization` (Cindy D2 design invariant #3:
   * "L3a catch must explicitly open L3b tx flip failed; not assume
   * tx rollback automatically leaves the row in failed").
   *
   * Throws on failure. Returns the inserted records on success so
   * L4 (deliver + auto-start) has the IDs it needs.
   */
  function d3InsertDependentRowsAtomic(
    agentRow: AgentRow,
    agentDir: string,
    creatorUserId: string,
  ): {
    home: ReturnType<typeof workspaces.insertAgentHome>;
    dm: ReturnType<typeof conversations.insertDmChannel>;
    onboardingMsg: ReturnType<typeof messages.insertForConversation>;
  } {
    return ctx.db.transaction(() => {
      agents.flipToActive(agentRow.id);
      // `insertAgentHome` reads the `AgentDto` shape — re-project
      // from the post-flip row.
      const flipped = agents.get(agentRow.id);
      if (!flipped) throw new Error('row vanished post-flip');
      const home = workspaces.insertAgentHome({
        agent: flipped,
        workspacePath: agentDir,
      });
      const dm = conversations.insertDmChannel({
        workspaceId: home.id,
        workspacePath: agentDir,
        title: 'Onboarding',
        agentId: agentRow.id,
      });
      conversations.addAgent(dm.id, agentRow.id);
      workspaces.addUserMember(home.id, creatorUserId);
      conversations.addUser(dm.id, creatorUserId);
      const onboardingMsg = messages.insertForConversation({
        conversationId: dm.id,
        fromKind: 'system',
        content: [
          `You (@${agentRow.name}) are now in your personal DM with the user.`,
          `Your role contract lives at L1 \`system_prompt.md\` and is shared across every workspace; updates to it propagate everywhere on the agent's next spawn. This DM also has its own L2 \`MEMORY.md\` / \`notes/\` for memory that stays here.`,
          `Send one short greeting: say hi by name, state your current global role briefly (or say it is not defined yet), and ask what role the user would like you to play. Write by scope: global identity / role / working-style guidance → update L1 \`system_prompt.md\`; DM-local notes → update this DM's \`MEMORY.md\` / \`notes/\`. Do not mention internal file paths to the user unless they ask.`,
        ].join('\n'),
        metadata: { subtype: systemSubtype('onboarding') },
      });
      return { home, dm, onboardingMsg };
    })();
  }

  // ── Agents ───────────────────────────────────────────────────────

  /**
   * D4.d D5 — shared L2/L3a/L3b/L4 dispatch from a row already in
   * `pending_materialization`. Used by both the fresh-create path
   * (after L0/L1 reserve) and the same-row retry path (after
   * `?retry=true` flips a failed row back to pending). Keeping the
   * post-reserve sequence in one place is the load-bearing way to
   * guarantee Cindy D5 guard rail #2 (retry uses the SAME L2 / L3a /
   * L3b helpers as fresh create — failed dispatch on retry must land
   * the row back at `failed` with refreshed code/at, never leave
   * pending) and guard rail #3 (no new protocol surface — retry
   * reuses the exact `agent_materialize` send the fresh path uses,
   * including `expectedConnectionId` lock and the §6.5 cross-check).
   *
   * The reservedRow's stored metadata is the source of truth for the
   * wire payload — NOT the HTTP request body. For fresh create this
   * is trivially true (body just got written into the row at
   * reserve). For retry the §3.2 immutable-metadata invariant
   * matters: the body equals the row's snapshot (mismatch already
   * rejected at L0.4) but reading from the row makes the contract
   * explicit and survives any later refactor.
   *
   * Returns the post-L3a inserted dependent rows (caller fires L4
   * best-effort deliver + auto-start outside this helper). On
   * failure returns a typed code + HTTP status + the caller-visible
   * message; the caller renders the 4xx/5xx body.
   */
  async function d5RunMaterializeFromReserved(deps: {
    reservedRow: AgentRow;
    controller: OutboundFrameAdapter;
    connectionId: string;
    creatorUserId: string;
  }): Promise<
    | {
        kind: 'ok';
        inserted: ReturnType<typeof d3InsertDependentRowsAtomic>;
      }
    | {
        kind: 'failed';
        failedCode: string;
        message: string;
        status: 400 | 409 | 500 | 502 | 503 | 504 | 507;
      }
  > {
    const { reservedRow, controller, connectionId, creatorUserId } = deps;
    // ── L2 wire intent ──────────────────────────────────────────────
    let ackResult: { agent_dir: string; agent_home_workspace_path: string };
    try {
      const result = await controller.sendCommand(
        reservedRow.host_id,
        'agent_materialize',
        {
          agent_id: reservedRow.id,
          agent_home_workspace_id: agentHomeWorkspaceId(reservedRow.id),
          name: reservedRow.name,
          runtime: reservedRow.runtime,
          model: reservedRow.model ?? null,
          description: reservedRow.description ?? null,
          template_choice: 'default',
        },
        { timeoutMs: 60_000, expectedConnectionId: connectionId },
      );
      ackResult = {
        agent_dir: result.agent_dir,
        agent_home_workspace_path: result.agent_home_workspace_path,
      };
    } catch (err) {
      // L3b — SEPARATE tx (Cindy D2 invariant #3). For the retry
      // path this OVERWRITES the previous failure stamp with this
      // attempt's code/at, which is the Cindy D5 guard rail #2
      // contract: a retry that fails must update failure metadata,
      // not preserve the old one. `flipToFailed` is one UPDATE
      // outside any wrapping tx so concurrent rollback elsewhere
      // cannot remove it.
      const now = Date.now();
      let failedCode: string;
      let status: 400 | 409 | 502 | 503 | 504 | 507;
      if (err instanceof HostWsCommandResponseError) {
        const mapped = d3MapMaterializeWireError(err);
        failedCode = mapped.failedCode;
        status = mapped.status;
      } else if (err instanceof HostWsCommandTransportError) {
        if (
          err.code === 'transport_no_connection' ||
          err.code === 'transport_disconnected'
        ) {
          failedCode = 'host_attach_pending';
          status = 503;
        } else if (err.code === 'transport_timeout') {
          failedCode = 'materialize_timeout';
          status = 504;
        } else {
          failedCode = 'daemon_internal_error';
          status = 502;
        }
      } else {
        ctx.logger.error(
          { err, agentId: reservedRow.id },
          'unexpected error during agent_materialize dispatch',
        );
        failedCode = 'daemon_internal_error';
        status = 502;
      }
      agents.flipToFailed(reservedRow.id, failedCode, now);
      return {
        kind: 'failed',
        failedCode,
        message: err instanceof Error ? err.message : String(err),
        status,
      };
    }

    // §6.5 cross-check: daemon ack invariant (agent_dir must equal
    // agent_home_workspace_path; both schemas already enforce, but
    // server-side defense-in-depth keeps the route honest).
    if (ackResult.agent_dir !== ackResult.agent_home_workspace_path) {
      agents.flipToFailed(reservedRow.id, 'daemon_internal_error', Date.now());
      ctx.logger.error(
        {
          agentId: reservedRow.id,
          agent_dir: ackResult.agent_dir,
          agent_home_workspace_path: ackResult.agent_home_workspace_path,
        },
        'daemon ack carried mismatched agent_dir vs agent_home_workspace_path',
      );
      return {
        kind: 'failed',
        failedCode: 'daemon_internal_error',
        message:
          'daemon ack invariant violation (agent_dir != agent_home_workspace_path)',
        status: 502,
      };
    }

    // ── L3a flip-active + dependent rows tx ───────────────────────
    let inserted: ReturnType<typeof d3InsertDependentRowsAtomic>;
    try {
      inserted = d3InsertDependentRowsAtomic(
        reservedRow,
        ackResult.agent_dir,
        creatorUserId,
      );
    } catch (err) {
      ctx.logger.error(
        { err, agentId: reservedRow.id },
        'L3a dependent-row insert tx failed; flipping to failed',
      );
      agents.flipToFailed(
        reservedRow.id,
        'dependent_row_insert_failed',
        Date.now(),
      );
      return {
        kind: 'failed',
        failedCode: 'dependent_row_insert_failed',
        message: err instanceof Error ? err.message : String(err),
        status: 500,
      };
    }
    return { kind: 'ok', inserted };
  }

  app.get(apiPaths.agents, c => {
    const principal = getUserPrincipal(c);
    // D4.d D5 — Q6.a list filter, lifted into `canViewAgent` per
    // Cindy `vB9vzUo4y_vgSZf8` P1 + design §I3 / §4.1: default
    // hides BOTH `pending_materialization` AND `failed`. Pending
    // rows are management-view material; default-hiding them keeps
    // §5 boot reconciler residue out of the everyday product
    // surface.
    //
    // D4.d D6 — `?include_pending=1` widener parity (Cindy
    // `hguBjY1O1GMy2JSS` D6 standards: same shape as D5
    // `?include_failed=1` — ACL-first / creator-scoped / not a
    // cross-user enumeration surface). Adds pending rows to the
    // already-ACL-scoped candidate set; can combine with
    // `?include_failed=1` so the management view's
    // `?include_failed=1&include_pending=1` shows all three
    // statuses the caller owns. `canViewAgent`'s ACL-first
    // ordering means neither flag widens visibility across
    // users — pending rows have no dependent workspaces (L3a
    // never ran), so the workspace-membership branch of
    // `canViewAgent` can never match cross-user, mirroring the
    // failed-row property D5 relied on.
    const includeFailed = c.req.query('include_failed') === '1';
    const includePending = c.req.query('include_pending') === '1';
    const includeStatuses: AgentMaterializationStatus[] = ['active'];
    if (includeFailed) includeStatuses.push('failed');
    if (includePending) includeStatuses.push('pending_materialization');
    return c.json({
      agents: agents
        .list()
        .filter(agent =>
          canViewAgent(ctx, principal, agent.id, { includeStatuses }),
        ),
    });
  });

  /**
   * `POST /api/agents` — D4.d D3 lifecycle.
   *
   * **NOTE on R4 / formal semantics carveout** (Cindy D1/D2 review
   * line, retained here): the dispatcher / IPC plumbing this route
   * relies on is local supervisor/control. The `agent_materialize`
   * intent the route dispatches via that plumbing, however, IS
   * formal server↔daemon semantics by R4 design — it carries
   * business state (template + identity + L1 fs ownership), not
   * transport bytes.
   *
   * Lifecycle (§6.3):
   *   L0 preflight → L1 reserve → L2 wire intent → L3a/L3b flip +
   *   dependents → L4 deliver + auto-start.
   *
   * Standalone vs embedded: this route does NOT branch on deployment
   * mode. Both modes dispatch the same wire intent via the
   * deployment-neutral `ctx.outboundFrameAdapter()` port (D5.a-3):
   * standalone reaches the real daemon over the WSS-backed adapter;
   * embedded dials the daemon's local `daemon-outbound.sock` via the
   * `EmbeddedUnixOutboundFrameAdapter`. Both carry the identical
   * outbound frame envelope — there is no loopback-over-WS adapter and
   * no `hostWsController.sendCommand` on this path anymore. The only
   * mode-visible behavior is "daemon offline → 503 host_attach_pending",
   * which mirrors D4.b runtime intent routes.
   */
  app.post(apiPaths.agents, async c => {
    // ── L0 preflight ───────────────────────────────────────────────
    //
    // Order is load-bearing (Cindy D3 round-1 P1): existing-row
    // lookup + mismatch + dispatch ALL run BEFORE placement /
    // online check / reserve. Placement may flap as host inventory
    // changes (0 → 1 → N owned-active locals); the §6.1 preflight
    // contract requires that a same-key retry returns the same
    // outcome it returned the first time, NOT a fresh placement
    // error. Online check + reserve only fire on the no-row path.
    //
    // D5 adds: `?retry=true` — same-row retry on a stored `failed`
    // row (§3.2 (a)). Cindy D5 guard rails locked:
    //   1. `?retry=true` only succeeds against (this creator,
    //      this key, status='failed') with body matching the row's
    //      stored metadata snapshot. Metadata mismatch still
    //      rejects FIRST (no body field becomes implicitly
    //      mutable via the retry verb).
    //   2. retry uses the SAME L2/L3a/L3b helpers as fresh create
    //      via `d5RunMaterializeFromReserved`. Dispatch failure
    //      flips the row back to `failed` with this attempt's
    //      code/at — never preserved-old, never stuck-pending.
    //   3. No new wire / daemon / protocol surface. Retry reuses
    //      the same `agent_materialize` send the fresh path uses.

    // L0.1 — parse body shape.
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getUserPrincipal(c);
    const creatorUserId = principal.userId;

    // L0.2 — Idempotency-Key header MUST be present + shape-valid
    // (design §14 Q1).
    const keyParse = d3ParseIdempotencyKey(c);
    if (!keyParse.ok) return keyParse.response;
    const idempotencyKey = keyParse.key;

    // L0.2b (D5) — `?retry=true` is parsed here so the existing-row
    // dispatch branches can route on it; semantically it's a
    // modifier on the existing-row + failed arm only.
    const retryFlag = c.req.query('retry') === 'true';

    // L0.3 — Idempotency lookup (creator-scoped via the v33 partial
    // unique index; cross-creator collisions are impossible at SQL).
    const existingRow = agents.findByIdempotencyKey(
      creatorUserId,
      idempotencyKey,
    );

    // L0.4 — if a row exists, metadata-mismatch check fires BEFORE
    // status dispatch (Cindy final-review P1 + D5 guard rail #1).
    if (existingRow) {
      const mismatchField = d3CompareMetadataSnapshot(
        d3RowSnapshot(existingRow),
        d3RequestSnapshot(
          parsed.data,
          parsed.data.host_id ?? existingRow.host_id,
        ),
      );
      if (mismatchField !== null) {
        return c.json(
          {
            error: `Idempotency-Key reuse: request body differs from the original at field '${mismatchField}'. Use a fresh Idempotency-Key for a different agent.`,
            code: 'idempotency_metadata_mismatch',
            mismatched_field: mismatchField,
          },
          400,
        );
      }

      // L0.5 — metadata matches; dispatch on materialization_status
      // per §3.2 (D5 routes the `failed` arm via `?retry=true`).
      switch (existingRow.materialization_status) {
        case 'active': {
          // 200 echo — caller is retrying a successful create (or
          // passed `?retry=true` against an already-active row,
          // which is also a no-op same-key outcome). Either way the
          // response is the same fresh-L4 4-field payload.
          const dm = conversations.findDmChannelForAgent(existingRow.id);
          if (!dm) {
            ctx.logger.error(
              { agentId: existingRow.id },
              'active agent has no DM channel — invariant violated by external mutation',
            );
            return c.json(
              { error: 'agent state inconsistent', code: 'internal_error' },
              500,
            );
          }
          const onboarding = messages.findFirstSystemSubtypeInConversation(
            dm.id,
            systemSubtype('onboarding'),
          );
          if (!onboarding) {
            ctx.logger.error(
              { agentId: existingRow.id, dmChannelId: dm.id },
              'active agent has no onboarding system message — invariant violated by external mutation',
            );
            return c.json(
              { error: 'agent state inconsistent', code: 'internal_error' },
              500,
            );
          }
          return c.json(
            {
              agent: agents.get(existingRow.id)!,
              agent_home_workspace_id: agentHomeWorkspaceId(existingRow.id),
              dm_channel_id: dm.id,
              onboarding_message_id: onboarding.id,
            },
            200,
          );
        }
        case 'pending_materialization':
          // Another in-flight request with the same key is still
          // dispatching. Same response regardless of `?retry=true`:
          // the caller's intent is "make this attempt succeed",
          // which it might still be doing on a sibling request.
          // 409 `materialization_in_progress` — renderer silently
          // retries with backoff.
          return c.json(
            {
              error: 'an in-flight materialize for this key is still pending',
              code: 'materialization_in_progress',
            },
            409,
          );
        case 'failed': {
          // D5: `?retry=true` enters same-row retry; otherwise
          // 409 (unchanged from D3, minus the "(D5)" suffix).
          if (!retryFlag) {
            return c.json(
              {
                error: `previous materialize attempt failed (${existingRow.materialization_failed_code}); resend with ?retry=true to retry this row, or use a fresh Idempotency-Key for a new attempt`,
                code: 'materialization_previously_failed',
                failed_code: existingRow.materialization_failed_code,
                failed_at: existingRow.materialization_failed_at,
              },
              409,
            );
          }

          // ── L1 (retry) — online check BEFORE flipping the row.
          // Cindy D5 guard rail #2: do NOT flip failed → pending
          // when the daemon is offline (the row would otherwise
          // bounce failed → pending → failed in vain, and any
          // observer between the two flips would see a misleading
          // `pending_materialization` status).
          // D5.a-3 P1-3 — formal dispatch via the deployment-neutral
          // `outboundFrameAdapter` (not WS-only `hostWsController`).
          const controller = ctx.outboundFrameAdapter?.();
          const connectionId =
            controller?.connectionIdForHost(existingRow.host_id) ?? null;
          if (!controller || !connectionId) {
            return c.json(
              {
                error: 'host runtime is not currently attached',
                code: 'host_attach_pending',
              },
              503,
            );
          }

          // Daemon attached — flip failed → pending atomically.
          // The helper's `WHERE status = 'failed'` guard handles
          // the race window where a sibling mutation (e.g.,
          // another tab clicking Delete) flips the row out from
          // under us: 409 retry_target_not_failed surfaces in
          // that case, never silently re-flipping a non-failed
          // row.
          const flipped = agents.flipFailedToReserveAgain(existingRow.id);
          if (!flipped) {
            return c.json(
              {
                error: 'agent row is no longer in failed state; refresh and try again',
                code: 'retry_target_not_failed',
              },
              409,
            );
          }
          // Re-read post-flip so the L2 helper sees the
          // authoritative `pending_materialization` shape (the row
          // has the same metadata; the failed_* fields are NULL
          // again).
          const rowToRetry = agents.getRow(existingRow.id);
          if (!rowToRetry) {
            ctx.logger.error(
              { agentId: existingRow.id },
              'agent row vanished between flipFailedToReserveAgain and re-read; treating as internal error',
            );
            return c.json(
              { error: 'agent row vanished post-flip', code: 'internal_error' },
              500,
            );
          }

          // L2 / L3a / L3b via the shared helper. On any failure
          // the helper has already flipped the row back to
          // `failed` with this attempt's code/at (Cindy D5
          // guard rail #2).
          const retryResult = await d5RunMaterializeFromReserved({
            reservedRow: rowToRetry,
            controller,
            connectionId,
            creatorUserId,
          });
          if (retryResult.kind === 'failed') {
            return c.json(
              { error: retryResult.message, code: retryResult.failedCode },
              retryResult.status,
            );
          }
          // L4 deliver + auto-start (post-commit best-effort) —
          // identical to fresh create. Use 201 because this is
          // the first time this row reaches `active`.
          ctx.runtimeHost
            .deliverMessage(
              retryResult.inserted.dm.id,
              rowToRetry.id,
              retryResult.inserted.onboardingMsg.id,
            )
            .catch(err =>
              ctx.logger.error(
                {
                  conversationId: retryResult.inserted.dm.id,
                  agentId: rowToRetry.id,
                  err,
                },
                'onboarding message deliver failed (post-commit best-effort)',
              ),
            );
          ctx.runtimeHost
            .start(retryResult.inserted.dm.id, rowToRetry.id)
            .catch(err =>
              ctx.logger.error(
                {
                  conversationId: retryResult.inserted.dm.id,
                  agentId: rowToRetry.id,
                  err,
                },
                'dm onboarding spawn failed (post-commit best-effort)',
              ),
            );
          return c.json(
            {
              agent: agents.get(rowToRetry.id)!,
              agent_home_workspace_id: retryResult.inserted.home.id,
              dm_channel_id: retryResult.inserted.dm.id,
              onboarding_message_id: retryResult.inserted.onboardingMsg.id,
            },
            201,
          );
        }
      }
    }

    // L0.6 (D5) — `?retry=true` without an existing row is a
    // client misuse: caller asked to retry something we never
    // recorded. 404 explicit instead of silent fresh-create
    // fallthrough (which would be surprising and would mask UI
    // bugs that send retry=true with the wrong key).
    if (retryFlag) {
      return c.json(
        {
          error: 'no prior agent found for this Idempotency-Key; use a fresh-key POST to create a new agent',
          code: 'retry_target_not_found',
        },
        404,
      );
    }

    // ── L0.7 — no idempotency row → fresh attempt. Placement /
    //          name uniqueness / online check ALL run here, NOT in
    //          the existing-row path above (Cindy D3 round-1 P1).
    let resolvedHostId: string;
    try {
      resolvedHostId = resolveCreateHostId(parsed.data.host_id, creatorUserId);
    } catch (err) {
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }

    // Name uniqueness check (preserved from pre-D4.d). A legitimate
    // "fresh attempt with a name that's already taken" still 409s.
    if (agents.getByName(parsed.data.name)) {
      return c.json({ error: 'agent name already exists', code: 'agent_name_taken' }, 409);
    }

    // Controller online check BEFORE reserve (Cindy D3 round-1 P1
    // §6.2 invariant: "online check before reserve / no row reserved
    // when daemon offline"). The captured `connectionId` is then
    // passed to `sendCommand` as `expectedConnectionId` to lock the
    // check → dispatch window against a reattach race.
    //
    // D5.a-3 P1-3 — formal `agent_materialize` dispatch goes through the
    // deployment-neutral `outboundFrameAdapter`, not `hostWsController`
    // (which is WS-only and null in embedded). Embedded resolves to the
    // local-Unix adapter; standalone to the WSS-backed adapter.
    const controller = ctx.outboundFrameAdapter?.();
    const connectionId = controller?.connectionIdForHost(resolvedHostId) ?? null;
    if (!controller || !connectionId) {
      // Daemon not currently attached for this host. Fail-fast with
      // 503; do NOT reserve a row (the previous behavior — reserve
      // then flip to failed — leaked failed orphans on transient
      // offline windows and was the wrong observable per §6.2).
      return c.json(
        {
          error: 'host runtime is not currently attached',
          code: 'host_attach_pending',
        },
        503,
      );
    }

    // ── L1 reserve ─────────────────────────────────────────────────
    let reservedRow: AgentRow;
    try {
      reservedRow = agents.reserveForMaterialize(
        parsed.data,
        resolvedHostId,
        creatorUserId,
        idempotencyKey,
      );
    } catch (err) {
      ctx.logger.warn(
        { err, agentName: parsed.data.name, idempotencyKey },
        'reserveForMaterialize INSERT failed',
      );
      return c.json(
        { error: 'agent reservation conflict; retry with a fresh key', code: 'agent_name_taken' },
        409,
      );
    }

    // L2 / L3a / L3b via the shared helper. Same as the retry path —
    // both fresh and retry hit `d5RunMaterializeFromReserved`, which
    // guarantees Cindy D5 guard rail #3 (no new protocol surface).
    const freshResult = await d5RunMaterializeFromReserved({
      reservedRow,
      controller,
      connectionId,
      creatorUserId,
    });
    if (freshResult.kind === 'failed') {
      return c.json(
        { error: freshResult.message, code: freshResult.failedCode },
        freshResult.status,
      );
    }

    // ── L4 deliver + auto-start (post-commit best-effort) ─────────
    //
    // Cindy D3 round-1 P1.4: L3a commit IS the "create succeeded"
    // boundary. L4 runtime delivery / spawn are post-commit
    // best-effort surfaces — failure ONLY logs.
    ctx.runtimeHost
      .deliverMessage(
        freshResult.inserted.dm.id,
        reservedRow.id,
        freshResult.inserted.onboardingMsg.id,
      )
      .catch(err =>
        ctx.logger.error(
          {
            conversationId: freshResult.inserted.dm.id,
            agentId: reservedRow.id,
            err,
          },
          'onboarding message deliver failed (post-commit best-effort)',
        ),
      );
    ctx.runtimeHost
      .start(freshResult.inserted.dm.id, reservedRow.id)
      .catch(err =>
        ctx.logger.error(
          {
            conversationId: freshResult.inserted.dm.id,
            agentId: reservedRow.id,
            err,
          },
          'dm onboarding spawn failed (post-commit best-effort)',
        ),
      );

    return c.json(
      {
        agent: agents.get(reservedRow.id)!,
        agent_home_workspace_id: freshResult.inserted.home.id,
        dm_channel_id: freshResult.inserted.dm.id,
        onboarding_message_id: freshResult.inserted.onboardingMsg.id,
      },
      201,
    );
  });

  app.get('/api/agents/:id', c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    // D4.d D5 — Q6.a single-get filter, lifted into `canViewAgent`
    // per Cindy `vB9vzUo4y_vgSZf8` P1. Default view hides BOTH
    // `failed` AND `pending_materialization` behind 404.
    //
    // D4.d D6 — `?include_pending=1` widener parity (mirrors the
    // list widener); both flags compose, ACL-first ordering keeps
    // them creator-scoped — cross-user pending / failed lookups
    // still 404 even with both flags set.
    const includeFailed = c.req.query('include_failed') === '1';
    const includePending = c.req.query('include_pending') === '1';
    const includeStatuses: AgentMaterializationStatus[] = ['active'];
    if (includeFailed) includeStatuses.push('failed');
    if (includePending) includeStatuses.push('pending_materialization');
    if (
      !canViewAgent(ctx, getUserPrincipal(c), agent.id, { includeStatuses })
    ) {
      return c.json({ error: 'agent not found' }, 404);
    }
    return c.json({ agent });
  });

  // PATCH — partial update. `name` and `host_id` are intentionally not
  // patchable here: `name` is the immutable handle (renaming would
  // ripple through the agent_home workspace, every @mention in history,
  // every L2 file path), and host swap is out of v1 scope. Runtime change is
  // refused while any conversation_agent for this agent is starting/active
  // — otherwise the next event from the in-flight CLI would be parsed
  // by the wrong driver.
  //
  // Permission: `canEditAgent` (v26). The creator user — recorded on
  // `agents.created_by_user_id` at create time — and the agent acting
  // as itself are the only allowed editors. v1 single-human installs
  // see this as viewer-only (the viewer created every agent); v2
  // multi-human deployments will deny non-creator humans even if they
  // share the workspace.
  app.patch('/api/agents/:id', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    if (parsed.data.runtime && parsed.data.runtime !== agent.runtime) {
      const live = agents
        .listRuntimeConversations(id)
        .some(s => s.status === 'starting' || s.status === 'active');
      if (live) {
        return c.json(
          { error: 'agent_busy_change_runtime', detail: 'stop the agent before changing runtime' },
          409,
        );
      }
    }
    const updated = agents.update(id, parsed.data);
    return c.json({ agent: updated });
  });

  // Public avatar lifecycle. Mirrors `/api/me/avatar` but keyed by
  // agent id and gated by the v26 `canEditAgent` predicate (creator
  // user ∨ system on the public surface; agent-self is reachable only
  // via the internal route below). v1 single-human installs see this
  // as viewer-only; v2 multi-human deployments deny non-creator humans
  // even when they share the workspace.
  //
  // Read gate: any logged-in viewer who reaches the existing
  // `GET /api/agents/:id` can also fetch the avatar — there is no
  // hidden-profile concept in v1 (matches `GET /api/users/:id/avatar`).
  app.post(apiPaths.agentAvatar(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    if (!agents.get(id)) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const dto = await ctx.agentService.uploadAvatar(id, {
        buffer,
        contentType: file.type || 'application/octet-stream',
        filename: file.name || 'avatar',
      });
      return c.json({ avatar_url: dto.avatar_url, agent: dto });
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
  });

  app.delete(apiPaths.agentAvatar(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    if (!agents.get(id)) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const dto = await ctx.agentService.clearAvatar(id);
      return c.json({ agent: dto });
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
  });

  // Public-by-id avatar fetch. Read gate matches GET /api/agents/:id
  // (authed + agent exists). Returns 404 when the agent has no avatar
  // — the renderer's `useAgentAvatarObjectUrls` hook treats 404 as
  // "fall back to the runtime icon".
  app.get(apiPaths.agentAvatar(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    if (!agents.get(id)) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    const ref = ctx.agentService.getAvatarStorageRef(id);
    if (!ref) return c.json({ error: 'avatar not found' }, 404);
    return ctx.blobStorage.serve(
      { storage: ctx.blobStorage.kind, storageKey: ref.storageKey },
      { contentType: ref.contentType, filename: ref.filename },
    );
  });

  app.get('/api/agents/:id/workspace', async c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (standaloneMode(ctx)) {
      // D4.b P1-1 (local filesystem op): agent workspace
      // resolution reads `ctx.silverhandDir/agents/<id>` — the
      // agent's L1 dir lives on the desktop, not the server. This
      // route is fundamentally local-only; the guard is correct
      // (NOT a runtime transport unavailable scenario, NOT a
      // CRUD deferral). D2.0 daemon-host data-plane will likely
      // proxy the L1 dir read; until then 503 is honest.
      return hostRuntimeDisabledResponse(c, 'agent workspace resolution', 503);
    }
    const l1Dir = join(ctx.silverhandDir, 'agents', agent.id);
    const workspace = await buildAgentWorkspaceDto(l1Dir);
    return c.json({ workspace });
  });

  app.get('/api/agents/:id/runtime-state', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    return c.json({ conversation_agents: agents.listRuntimeConversations(agent.id) });
  });

  // Schedules — user-facing read & cancel for the per-agent panel.
  // Reuses ScheduleService (same code path the agent's MCP tools use)
  // so the data is identical to what the agent sees via list_schedules.
  // Permission posture matches the rest of /api/agents/:id/* — host
  // viewer can see/manage any agent on this host. When multi-user
  // permissioning lands these routes inherit it from the same gate.
  app.get(apiPaths.agentSchedules(':id'), c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const parsed = ScheduleListInputSchema.safeParse({
      status: c.req.query('status') || undefined,
      // limit comes through the URL as a string; coerce upfront so the
      // schema's `.int()` doesn't bounce a numeric string.
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    });
    if (!parsed.success) {
      return c.json(
        { error: 'invalid query', issues: parsed.error.issues },
        400,
      );
    }
    const schedules = ctx.scheduleService.list(
      agent.id,
      parsed.data.status,
      parsed.data.limit,
    );
    return c.json({ schedules });
  });

  app.post(apiPaths.agentScheduleCancel(':id', ':scheduleId'), c => {
    const agentId = c.req.param('id');
    const scheduleId = c.req.param('scheduleId');
    if (!agentId || !scheduleId) {
      return c.json({ error: 'agent id and schedule id required' }, 400);
    }
    const agent = agents.get(agentId);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const schedule = ctx.scheduleService.cancel(scheduleId, agent.id);
      // Audit hook (no separate audit infra in v1 — single-host model
      // means logger is the audit trail). The viewer id comes from the
      // request principal resolved by session bearer.
      ctx.logger.info(
        {
          user_id: resolveViewerUserId(c),
          agent_id: agent.id,
          schedule_id: scheduleId,
        },
        'agent schedule cancelled by user',
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  // POST /stop — hard-stop every running conversation_agent for this
  // agent. Returns the count we actually attempted to stop. No-op
  // (200 with stopped: 0) when nothing is running.
  app.post('/api/agents/:id/stop', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // D4.b P1-1 (Cindy round-2 `0Hd5ComnzYxHJ6Rk` P1): bulk stop
    // variant. Lifted in parallel with `stopConversationAgent`, BUT
    // per-conversation errors must surface as a typed response — the
    // pre-round-2 implementation swallowed every `.catch(warn)` and
    // returned `{ stopped: live.length }` even when every underlying
    // `runtime_stop` actually failed (e.g. standalone + no daemon →
    // every call throws `HostWsCommandTransportError('transport_no_connection')`
    // → silent 200 success). That hit the D4 contract's "no silent
    // no-op" gate.
    //
    // Semantics (post-fix):
    //   - `live.length === 0` → 200 `{ stopped: 0 }` (true no-op).
    //   - All calls succeeded → 200 `{ stopped: <count> }` (unchanged
    //     happy path).
    //   - All calls failed with a typed
    //     placement/transport-no-connection error → surface that error
    //     via `placementErrorResponse` (503 `host_attach_pending` /
    //     409 `local_host_unbound` / etc.). This is the typed-fail
    //     contract Cindy required.
    //   - All calls failed with non-typed errors → 500 with
    //     `{ stopped: 0, error: <first message> }`.
    //   - Mixed (some succeeded, some failed) → log each failure +
    //     return 200 `{ stopped: <success count> }`. Partial success
    //     stays a 200 because the bulk endpoint historically reports
    //     a count, not all-or-nothing; the unsuccessful conversations
    //     stay in `status='active'` and the user can retry.
    const live = agents
      .listRuntimeConversations(id)
      .filter(s => s.status === 'starting' || s.status === 'active');
    if (live.length === 0) {
      return c.json({ stopped: 0 });
    }
    const settled = await Promise.allSettled(
      live.map(s => ctx.runtimeHost.stop(s.conversation_id, id, 'hard')),
    );
    const failures: { conversationId: string; err: unknown }[] = [];
    let successCount = 0;
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        successCount += 1;
      } else {
        failures.push({
          conversationId: live[idx]!.conversation_id,
          err: r.reason,
        });
        ctx.logger.warn(
          { conversationId: live[idx]!.conversation_id, agentId: id, err: r.reason },
          'agent bulk stop: conversation stop failed',
        );
      }
    });
    if (successCount === 0 && failures.length > 0) {
      // Every stop failed. Try to surface a typed placement / transport
      // error from the first failure so the renderer can branch on
      // `host_attach_pending` exactly like the per-conversation stop
      // route does.
      const mapped = placementErrorResponse(c, failures[0]!.err);
      if (mapped) return mapped;
      const msg =
        failures[0]!.err instanceof Error
          ? failures[0]!.err.message
          : String(failures[0]!.err);
      return c.json({ stopped: 0, error: msg }, 500);
    }
    return c.json({ stopped: successCount });
  });

  // GET /delete-impact — drives the destructive-confirm dialog.
  // Default-active only (Cindy `f0JxEM9nMhsVfLIo` refinement): the
  // management view's affordances on failed / pending rows are
  // `Delete` + `Retry`, NOT a destructive impact preview. Returning
  // 404 here for failed/pending avoids the misleading "this delete
  // will sweep N conversations" panel on a row that has zero
  // dependents to begin with.
  app.get('/api/agents/:id/delete-impact', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return c.json({ impact: computeDeleteImpact(agent.id) });
  });

  // DELETE — full destructive flow. See docs/progress.md (this PR's
  // entry). Caller must pass `{ confirm: true }` so wallet-fingers
  // can't drop a heavy DM channel by accident from devtools.
  //
  // Status widener (D5 fixup, Cindy `vB9vzUo4y_vgSZf8` P1): DELETE
  // opts in to ALL three statuses so the §3.2 status dispatch below
  // can reach `pending_materialization → 409` and `failed → 204`.
  // Without the opt-in, `canViewAgent`'s default-active filter
  // would 204 (idempotent unknown id) every DELETE on a
  // non-active row, hiding the management surface.
  const DELETE_INCLUDE_STATUSES: AgentMaterializationStatus[] = [
    'active',
    'pending_materialization',
    'failed',
  ];
  app.delete('/api/agents/:id', async c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.body(null, 204); // idempotent on unknown id
    if (
      !canViewAgent(ctx, getUserPrincipal(c), agent.id, {
        includeStatuses: DELETE_INCLUDE_STATUSES,
      })
    ) {
      return c.body(null, 204);
    }
    if (!canEditAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    // D4.d D5 — materialization-aware DELETE dispatch:
    //
    //   pending_materialization → 409 (another request is mid-
    //     flight; DELETE during reserve→flip would race the L3a/L3b
    //     tx and leave half-state). Operator must wait for the
    //     pending → active|failed transition; if it's stuck past
    //     the §5 reconciler threshold (60s default), the boot
    //     reconciler will flip it to failed and the operator can
    //     DELETE then. Same error code the POST `pending` arm
    //     uses, so the renderer can render one banner for both.
    //
    //   failed → 204 row-only delete. Failed rows have NO
    //     dependent rows (L3a never ran; the §6.3 invariant says
    //     dependent rows are inserted in the same tx as the
    //     flip-active, so a failed row by definition has the
    //     pre-L3a shape — agent row only). Skip the entire
    //     stop/sweep/L1/L2 flow that the active-row path runs,
    //     just drop the agents row. The §3.2 contract permits
    //     this: failed rows are exactly the management-view's
    //     "delete or retry" surface.
    //
    //   active → unchanged from D3 (full destructive flow below).
    //     This branch must remain backward-compatible — Cindy
    //     round-1 P1 #2 invariant + every existing
    //     active-delete test pins this.
    if (agent.materialization_status === 'pending_materialization') {
      return c.json(
        {
          error: 'an in-flight materialize for this agent is still pending; wait for it to complete (or for the §5 boot reconciler to mark it failed) before deleting',
          code: 'materialization_in_progress',
        },
        409,
      );
    }
    if (agent.materialization_status === 'failed') {
      // No dependent rows to sweep — the row was inserted in L1
      // reserve and never reached L3a flip-active + dependents.
      // No L1 dir either, in general: the daemon may have written
      // a partial dir for some failure codes (§4.5 Group B/C), but
      // we deliberately do NOT issue a remote `agent_demolish` —
      // §4.5 explicitly keeps DELETE DB-only so D4.d does not
      // expand the wire protocol surface. Operators with a real
      // disk-cleanup need use host shell access (runbook §12.8).
      agents.delete(id);
      ctx.logger.info(
        {
          agentId: id,
          agentName: agent.name,
          failedCode: agent.materialization_failed_code,
        },
        'failed agent row deleted (D5: row-only, no dependents)',
      );
      return c.body(null, 204);
    }
    // ── active branch: existing destructive flow (preserved
    //                   verbatim, including the `confirm: true`
    //                   body guard which is the click-through
    //                   safety on the heavy DM-channel + L1/L2
    //                   sweep path).

    const body = await c.req.json().catch(() => ({}));
    const parsed = DeleteAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'confirm flag required', detail: 'pass {"confirm": true}' },
        400,
      );
    }

    const impact = computeDeleteImpact(id);

    // 1. Hard-stop every running conversation_agent. Must precede any DB
    //    delete — once conversation_agents rows are gone, the runtime host
    //    can't look up handles by (conversation id, agent id).
    for (const live of impact.running_conversation_agents) {
      await ctx.runtimeHost
        .stop(live.conversation_id, id, 'hard')
        .catch(err =>
          ctx.logger.warn(
            { conversationId: live.conversation_id, agentId: id, err },
            'delete: stop failed (continuing)',
          ),
        );
    }

    // 2. Remove from every regular workspace and its conversations.
    for (const ws of impact.regular_memberships) {
      const workspace = workspaces.get(ws.id);
      if (!workspace) continue;
      for (const conversation of conversations.list()) {
        if (conversation.workspace_id === workspace.id) {
          conversations.removeAgent(conversation.id, id);
        }
      }
      workspaces.removeMember(workspace.id, id);
    }

    // 3. Sweep DM blobs before deleting the agent. DB rows cascade through
    //    agent -> agent_home -> conversations, but physical files need an
    //    explicit pass. Thread uploads are channel-scoped to the dm channel.
    const dmChannels = impact.owned_home
      ? conversations.listDmChannelsForWorkspace(impact.owned_home.id)
      : [];
    for (const dm of dmChannels) {
      await ctx.attachmentService.sweepForChannel(dm.id).catch(err =>
        ctx.logger.warn(
          { agentId: id, conversationId: dm.id, err },
          'delete agent: DM attachment sweep failed (continuing)',
        ),
      );
    }

    // 4. Drop the agent. owner_agent_id ON DELETE CASCADE removes its
    //    agent_home subtree; regular conversation history keeps deleted
    //    sender rows via SET NULL on messages.from_agent_id.
    agents.delete(id);

    // 5. Wipe L1 — the agent's global memory/notes/system_prompt.
    await fs
      .rm(impact.l1_path, { recursive: true, force: true })
      .catch(err =>
        ctx.logger.warn({ agentId: id, l1: impact.l1_path, err }, 'delete: L1 rm failed'),
      );
    await Promise.all(
      impact.l2_paths.map(p =>
        fs.rm(p, { recursive: true, force: true }).catch(err =>
          ctx.logger.warn({ agentId: id, path: p, err }, 'delete: L2 rm failed'),
        ),
      ),
    );

    ctx.logger.info(
      {
        agentId: id,
        agentName: agent.name,
        dmChannelId: impact.dm_channel?.id ?? null,
        regularWorkspaces: impact.regular_memberships.length,
        stoppedConversations: impact.running_conversation_agents.length,
      },
      'agent deleted',
    );
    return c.body(null, 204);
  });

  /**
   * Build the AgentDeleteImpactDto from current DB + filesystem
   * state. Pure read — used both by the GET preview endpoint and by
   * the DELETE handler so the two stay in lock-step.
   */
  function computeDeleteImpact(agentId: string): AgentDeleteImpactDto {
    const agent = agents.get(agentId);
    if (!agent) throw new Error('agent not found'); // guarded by callers
    const ownedHome = workspaces.getAgentHomeByOwner(agentId);
    const regulars = workspaces
      .listForAgent(agentId)
      .filter(w => w.workspace_kind === 'regular');
    const dmChannels = ownedHome
      ? conversations.listDmChannelsForWorkspace(ownedHome.id)
      : conversations.listDmChannelsForAgent(agentId);
    const dm = dmChannels[0] ?? null;

    let dmChannel: AgentDeleteImpactDto['dm_channel'] = null;
    let attachmentsCount = 0;
    if (dm) {
      const rootIds = dmChannels.map(c => c.id);
      const threadIds = rootIds.flatMap(channelId =>
        conversations.listThreadsForChannel(channelId).map(t => t.id),
      );
      const ids = [...rootIds, ...threadIds];
      const placeholders = ids.map(() => '?').join(',');
      const messageCount =
        ids.length === 0
          ? 0
          : ctx.db
              .prepare<string[], { c: number }>(
	                `SELECT COUNT(*) AS c
	                   FROM messages
	                  WHERE conversation_id IN (${placeholders})`,
	              )
              .get(...ids)?.c ?? 0;
      attachmentsCount =
        ctx.db
          .prepare<string[], { c: number }>(
            `SELECT COUNT(*) AS c
               FROM attachments
              WHERE channel_id IN (${rootIds.map(() => '?').join(',')})`,
          )
          .get(...rootIds)?.c ?? 0;
      dmChannel = {
        id: dm.id,
        name: dm.title,
        conversation_count: ids.length,
        message_count: messageCount,
      };
    }

    const runtimeConversations = agents.listRuntimeConversations(agentId);
    const running = runtimeConversations
      .filter(s => s.status === 'starting' || s.status === 'active')

    const l1Path = join(ctx.silverhandDir, 'agents', agentId);
    const l2Paths = regulars.map(c =>
      join(c.workspace_path, '.silverhand', 'agents', agentId),
    );

    return {
      agent_id: agent.id,
      agent_name: agent.name,
      agent_display_name: agent.display_name,
      dm_channel: dmChannel,
      regular_workspaces: regulars.map(c => ({ id: c.id, name: c.name })),
      regular_memberships: regulars.map(c => ({ id: c.id, name: c.name })),
      owned_home: ownedHome,
      attachments_count: attachmentsCount,
      running_conversation_agents: running,
      pending_inbox_count: conversationInboxes.countPendingForAgent(agentId),
      l1_path: l1Path,
      l2_paths: l2Paths,
    };
  }

  // Old HTTP route aliases were removed in the hard cutover.

  // ── Host-wide settings ───────────────────────────────────────────
  // Flat KV. Currently exposes `proxy_url`. Empty string deletes the row.
  app.get(apiPaths.settings, c =>
    c.json({ settings: publicSettingsSnapshot(settings) }),
  );

  app.put(apiPaths.settings, async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid input' }, 400);
    }
    const allowed = new Set<string>(Object.values(SETTINGS_KEYS));
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (k === SETTINGS_KEYS.VIEWER_USER_ID) {
        return c.json({ error: `unknown settings key: ${k}` }, 400);
      }
      if (!allowed.has(k)) {
        return c.json({ error: `unknown settings key: ${k}` }, 400);
      }
      if (typeof v !== 'string') {
        return c.json({ error: `value for ${k} must be a string` }, 400);
      }
      settings.set(k, v);
    }
    return c.json({ settings: publicSettingsSnapshot(settings) });
  });

  // ── Current viewer (user profile) ────────────────────────────────
  // GET /api/me returns the resolved UserDto for the authenticated
  // session subject. The unauthenticated setup path lives under
  // `/auth/*` / desktop `auth:getState`; public `/api/*` no longer
  // accepts the retired server-config bearer.
  //
  // Boundary contract:
  //   - `/auth/signup` is the public credentialed creator of users.
  //   - `/auth/embedded-bootstrap` may create a profile-only local user
  //     in embedded mode before issuing a normal session bearer.
  //   - PATCH /api/me only accepts `display_name`. Renaming is not
  //     exposed at any service / route surface.
  //   - Avatar lives on its own routes (POST/DELETE /api/me/avatar)
  app.get(apiPaths.me, c => {
    // Kept defensive for tests or future setup allowlists. Normal C.6+
    // public API traffic reaches this route with a session principal.
    const principal = c.get('principal');
    if (!principal || principal.kind !== 'user') {
      return c.json({
        registration_required: true,
        suggested_name: ctx.userService.suggestRegistrationName(),
      });
    }
    const dto = ctx.userService.getDto(principal.userId);
    if (!dto) {
      // Principal middleware just validated this; corruption only.
      return c.json({ error: 'viewer user is missing post-validation' }, 500);
    }
    return c.json(dto);
  });

  app.patch(apiPaths.me, async c => {
    const viewerUserId = requireViewerUserId(c);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateUserProfileInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: parsed.error.errors[0]?.message ?? 'invalid input' },
        400,
      );
    }
    try {
      const dto = ctx.userService.updateProfile(viewerUserId, parsed.data);
      return c.json(dto);
    } catch (err) {
      const status = userServiceErrorStatus(err);
      if (status) return c.json(userServiceErrorBody(err), status);
      throw err;
    }
  });

  app.post(apiPaths.meAvatar, async c => {
    const viewerUserId = requireViewerUserId(c);
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const dto = await ctx.userService.uploadAvatar(viewerUserId, {
        buffer,
        contentType: file.type || 'application/octet-stream',
        filename: file.name || 'avatar',
      });
      return c.json({ avatar_url: dto.avatar_url, user: dto });
    } catch (err) {
      const status = userServiceErrorStatus(err);
      if (status) return c.json(userServiceErrorBody(err), status);
      throw err;
    }
  });

  app.delete(apiPaths.meAvatar, async c => {
    const viewerUserId = requireViewerUserId(c);
    try {
      const dto = await ctx.userService.clearAvatar(viewerUserId);
      return c.json(dto);
    } catch (err) {
      const status = userServiceErrorStatus(err);
      if (status) return c.json(userServiceErrorBody(err), status);
      throw err;
    }
  });

  // Public-by-id avatar fetch. The renderer never assembles storage
  // keys; it just GETs this URL with the standard auth headers and
  // turns the bytes into an object URL (mirrors the attachment
  // download pattern). Any logged-in viewer can fetch any user's
  // avatar — there is no hidden-profile concept in V1.
  app.get(apiPaths.userAvatar(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'user id required' }, 400);
    const ref = ctx.userService.getAvatarStorageRef(id);
    if (!ref) return c.json({ error: 'avatar not found' }, 404);
    return ctx.blobStorage.serve(
      { storage: ctx.blobStorage.kind, storageKey: ref.storageKey },
      { contentType: ref.contentType, filename: ref.filename },
    );
  });

  // ── Notifications ────────────────────────────────────────────────
  // v1 single-user. user_id is always NULL on writes; reads filter on
  // `user_id IS NULL` (see NotificationRepo.list). Multi-user migration
  // will pass through a user id resolved from auth.
  app.get(apiPaths.notifications, c => {
    const unread = c.req.query('unread') === '1';
    const limit = parseLimit(c.req.query('limit'), 100);
    return c.json({
      notifications: listLegacyGlobalNotifications(notifications, { unread, limit }),
    });
  });

  // Lightweight endpoint: total unread + per-sidebar-scope counts + the
  // most recent unread pointer so the renderer can jump straight there.
  app.get(apiPaths.notificationsUnread, c => {
    const total = timedRouteSpan(
      ctx,
      'notifications.unreadCount',
      {},
      () => notifications.unreadCount(legacyGlobalNotificationUserId()),
      result => ({ total: result }),
    );
    const byWorkspace = Object.fromEntries(
      timedRouteSpan(
        ctx,
        'notifications.unreadCountsByWorkspace',
        {},
        () =>
          notifications.unreadCountsByWorkspace(legacyGlobalNotificationUserId()),
        result => ({ workspaceCount: result.size }),
      ).entries(),
    );
    const latestByWorkspace = Object.fromEntries(
      timedRouteSpan(
        ctx,
        'notifications.latestUnreadByWorkspace',
        {},
        () =>
          notifications.latestUnreadByWorkspace(legacyGlobalNotificationUserId()),
        result => ({ workspaceCount: result.size }),
      ).entries(),
    );
    return c.json({
      total,
      by_workspace: byWorkspace,
      latest_by_workspace: latestByWorkspace,
    });
  });

  // Mark-read with three modes: by id, by conversation/workspace, or all. Validation
  // mirrors `MarkNotificationsReadInputSchema` in shared/dto.ts.
  app.post(apiPaths.notificationsRead, async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = MarkNotificationsReadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const { id, workspace_id, conversation_id, all } = parsed.data;
    let marked = 0;
    if (id) {
      const ok = notifications.markRead(id, legacyGlobalNotificationUserId());
      marked = ok ? 1 : 0;
    } else if (workspace_id) {
      marked = notifications.markWorkspaceRead(
        workspace_id,
        legacyGlobalNotificationUserId(),
      );
    } else if (conversation_id) {
      marked = notifications.markConversationRead(
        conversation_id,
        legacyGlobalNotificationUserId(),
      );
    } else if (all) {
      marked = notifications.markAllRead(legacyGlobalNotificationUserId());
    } else {
      // Unreachable thanks to the schema refine, but TS doesn't narrow.
      return c.json({ error: 'invalid input' }, 400);
    }
    // Push to the resolved viewer's private scope only when unread
    // notification counters changed.
    if (marked > 0) {
      const viewerUserId = requireViewerUserId(c);
      ctx.events.publishToScope(
        `viewer:${viewerUserId}`,
        'unread_updated',
        { marked },
      );
    }
    return c.json({ marked });
  });

  // ── Tasks (human-facing list + overrides) ────────────────────────
  app.get(apiPaths.tasks, c => {
    const statusValues = (c.req.queries('status') ?? []).filter(s => s !== 'all');
    const taskNumberValues = c.req.queries('task_number') ?? [];
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: statusValues.length > 0 ? statusValues : undefined,
      task_number: taskNumberValues.length > 0 ? taskNumberValues : undefined,
      assignee_id: c.req.query('assignee_id') || undefined,
      limit: c.req.query('limit') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    return c.json({
      tasks: ctx.taskService.list({
        actor: getUserPrincipal(c),
        workspaceId: parsed.data.workspace_id,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
        taskNumbers: parsed.data.task_number,
        assigneeAgentId: parsed.data.assignee_id,
        limit: parsed.data.limit,
      }),
    });
  });

  app.post('/api/tasks/:messageId/claim', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanClaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.claimTask({
      actor: getUserPrincipal(c),
      by: { messageId: c.req.param('messageId') },
      assignee: parsed.data.agent_id ? { agentId: parsed.data.agent_id } : undefined,
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:messageId/unclaim', async c => {
    const result = await ctx.taskService.unclaimTask({
      actor: getUserPrincipal(c),
      by: { messageId: c.req.param('messageId') },
    });
    return c.json(result, result.success ? 200 : 409);
  });

  app.post('/api/tasks/:messageId/status', async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = HumanUpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const result = await ctx.taskService.updateStatus({
      actor: getUserPrincipal(c),
      by: { messageId: c.req.param('messageId') },
      status: parsed.data.status,
    });
    return c.json(result, result.success ? 200 : 409);
  });

  return app;
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 500);
}

function parseBeforeSeq(raw: string | undefined): number | null | 'invalid' {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) return 'invalid';
  return n;
}

const READ_HISTORY_SNIPPET_MAX_CHARS = 160;
const SEARCH_EXCERPT_CONTEXT_CHARS = 80;

type ConversationDto = NonNullable<ReturnType<ConversationRepo['get']>>;

type HistoryMessageRow = MessageRow & {
  task_assignee_name: string | null;
  sender_agent_name: string | null;
};

type AgentSearchMessageRow = HistoryMessageRow & {
  workspace_id: string;
  conversation_kind: ConversationDto['kind'];
  channel_id: string;
  thread_id: string | null;
};

type ReadHistoryTargetResult =
  | { ok: true; conversation: ConversationDto }
  | {
      ok: false;
      status: 400 | 403 | 404;
      code: string;
      message: string;
    };

function resolveAgentReadHistoryTarget(
  conversations: ConversationRepo,
  sourceConversation: ConversationDto,
  agentId: string,
  target: ReadHistoryTarget | undefined,
): ReadHistoryTargetResult {
  const requested = target ?? 'self';
  let resolved: ConversationDto | null;
  if (requested === 'self') {
    resolved = sourceConversation;
  } else if (requested === 'parent') {
    if (!sourceConversation.parent_conversation_id) {
      return {
        ok: false,
        status: 400,
        code: 'no_parent',
        message: 'no parent channel',
      };
    }
    resolved = conversations.get(sourceConversation.parent_conversation_id);
    if (!resolved) {
      return {
        ok: false,
        status: 404,
        code: 'parent_not_found',
        message: 'parent channel not found',
      };
    }
  } else if ('thread_id' in requested) {
    const thread = conversations.getThread(requested.thread_id);
    if (!thread) {
      return {
        ok: false,
        status: 404,
        code: 'thread_not_found',
        message: 'thread not found',
      };
    }
    if (thread.parent_conversation_id !== sourceConversation.id) {
      return {
        ok: false,
        status: 400,
        code: 'thread_not_child',
        message: 'target is not a direct thread of current channel',
      };
    }
    resolved = thread;
  } else {
    // Cross-conversation read by id. The agent must be in
    // `conversation_agents` for the target — workspace-level
    // membership alone is not enough; channel/thread membership is
    // the bottom guard. The check below covers it uniformly.
    const conversation = conversations.get(requested.conversation_id);
    if (!conversation) {
      return {
        ok: false,
        status: 404,
        code: 'conversation_not_found',
        message: 'conversation not found',
      };
    }
    if (
      conversation.kind !== 'channel' &&
      conversation.kind !== 'dm_channel' &&
      conversation.kind !== 'thread'
    ) {
      return {
        ok: false,
        status: 400,
        code: 'unsupported_conversation_kind',
        message: 'target conversation kind is not readable',
      };
    }
    resolved = conversation;
  }

  if (!conversations.getAgent(resolved.id, agentId)) {
    return {
      ok: false,
      status: 403,
      code: 'not_target_conversation_member',
      message: 'agent is not a member of target conversation',
    };
  }
  return { ok: true, conversation: resolved };
}

function targetRef(conversation: ConversationDto): ReadHistoryTargetRef {
  return {
    conversation_id: conversation.id,
    conversation_kind: conversation.kind,
    channel_id:
      conversation.kind === 'thread'
        ? conversation.parent_conversation_id ?? conversation.id
        : conversation.id,
    thread_id: conversation.kind === 'thread' ? conversation.id : null,
    workspace_id: conversation.workspace_id,
    title: conversation.title,
  };
}

function messageRef(row: MessageRow, target: ReadHistoryTargetRef): MessageRef {
  return {
    id: row.id,
    workspace_id: target.workspace_id,
    conversation_id: target.conversation_id,
    conversation_kind: target.conversation_kind,
    channel_id: target.channel_id,
    thread_id: target.thread_id,
    seq: row.seq,
    created_at: row.created_at,
  };
}

function senderRef(row: HistoryMessageRow): MessageSenderRef {
  return {
    kind: row.from_kind,
    agent_id: row.from_agent_id,
    user_id: row.from_user_id,
    display_name:
      row.from_kind === 'agent'
        ? row.sender_agent_name ?? row.from_agent_id
        : row.from_kind === 'user'
          ? row.from_user_id
          : null,
  };
}

function snippetFor(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  if (compact.length <= READ_HISTORY_SNIPPET_MAX_CHARS) return compact;
  return `${compact.slice(0, READ_HISTORY_SNIPPET_MAX_CHARS - 1)}…`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`);
}

function likeNeedle(query: string): string {
  return `%${escapeLike(query)}%`;
}

function historyRowToMessage(
  row: HistoryMessageRow,
  target: ReadHistoryTargetRef,
  includeContent: boolean,
): ReadHistoryMessage {
  const dto = messageRowToDto(row, { assigneeName: row.task_assignee_name });
  return {
    message_ref: messageRef(row, target),
    sender: senderRef(row),
    snippet: snippetFor(dto.content),
    metadata: dto.metadata,
    attachments: dto.attachments,
    ...(includeContent ? { content: dto.content } : {}),
  };
}

function historySystemFilter(includeSystem: boolean): string {
  return includeSystem ? '' : `AND m.from_kind != 'system'`;
}

function historySelectSql(whereSql: string, orderSql: string, limitSql = 'LIMIT ?'): string {
  return `SELECT
            m.*,
            assignee.display_name AS task_assignee_name,
            sender.display_name AS sender_agent_name
          FROM messages m
          LEFT JOIN agents assignee ON assignee.id = m.task_assignee_agent_id
          LEFT JOIN agents sender ON sender.id = m.from_agent_id
         WHERE ${whereSql}
         ${orderSql}
         ${limitSql}`;
}

function listHistoryBefore(
  ctx: BackendContext,
  conversationId: string,
  beforeSeq: number,
  includeSystem: boolean,
  limit: number,
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  const rows = ctx.db
    .prepare<[string, number, number], HistoryMessageRow>(
      `SELECT *
         FROM (
           ${historySelectSql(
             `m.conversation_id = ?
              AND m.seq < ?
              ${historySystemFilter(includeSystem)}`,
             'ORDER BY m.seq DESC',
           )}
         )
        ORDER BY seq ASC`,
    )
    .all(conversationId, beforeSeq, limit);
  return rows;
}

function listHistoryAfter(
  ctx: BackendContext,
  conversationId: string,
  afterSeq: number,
  includeSystem: boolean,
  limit: number,
): HistoryMessageRow[] {
  if (limit <= 0) return [];
  return ctx.db
    .prepare<[string, number, number], HistoryMessageRow>(
      historySelectSql(
        `m.conversation_id = ?
         AND m.seq > ?
         ${historySystemFilter(includeSystem)}`,
        'ORDER BY m.seq ASC',
      ),
    )
    .all(conversationId, afterSeq, limit);
}

function getHistoryAnchorSeq(
  ctx: BackendContext,
  conversationId: string,
  messageId: string,
): number | null {
  const row = ctx.db
    .prepare<[string, string], { seq: number }>(
      `SELECT seq
         FROM messages
        WHERE id = ?
          AND conversation_id = ?`,
    )
    .get(messageId, conversationId);
  return row?.seq ?? null;
}

function getHistoryRowById(
  ctx: BackendContext,
  conversationId: string,
  messageId: string,
  includeSystem: boolean,
): HistoryMessageRow | null {
  const row = ctx.db
    .prepare<[string, string], HistoryMessageRow>(
      historySelectSql(
        `m.id = ?
         AND m.conversation_id = ?
         ${historySystemFilter(includeSystem)}`,
        '',
        '',
      ),
    )
    .get(messageId, conversationId);
  return row ?? null;
}

function hasHistoryBefore(
  ctx: BackendContext,
  conversationId: string,
  seq: number,
  includeSystem: boolean,
): boolean {
  return (
    ctx.db
      .prepare<[string, number], { found: 1 }>(
        `SELECT 1 AS found
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq < ?
            ${historySystemFilter(includeSystem)}
          LIMIT 1`,
      )
      .get(conversationId, seq) !== undefined
  );
}

function hasHistoryAfter(
  ctx: BackendContext,
  conversationId: string,
  seq: number,
  includeSystem: boolean,
): boolean {
  return (
    ctx.db
      .prepare<[string, number], { found: 1 }>(
        `SELECT 1 AS found
           FROM messages m
          WHERE m.conversation_id = ?
            AND m.seq > ?
            ${historySystemFilter(includeSystem)}
          LIMIT 1`,
      )
      .get(conversationId, seq) !== undefined
  );
}

function buildReadHistoryDto(
  ctx: BackendContext,
  targetConversation: ConversationDto,
  input: {
    before_seq?: number;
    after_seq?: number;
    around_message_id?: string;
    include_content: boolean;
    include_system: boolean;
    limit: number;
  },
): AgentReadHistoryDto | { error: string; code: string; status: 404 } {
  const target = targetRef(targetConversation);
  let rows: HistoryMessageRow[];
  let anchor: AgentReadHistoryDto['anchor'];

  if (input.before_seq !== undefined) {
    anchor = { type: 'before_seq', seq: input.before_seq };
    rows = listHistoryBefore(
      ctx,
      targetConversation.id,
      input.before_seq,
      input.include_system,
      input.limit,
    );
  } else if (input.after_seq !== undefined) {
    anchor = { type: 'after_seq', seq: input.after_seq };
    rows = listHistoryAfter(
      ctx,
      targetConversation.id,
      input.after_seq,
      input.include_system,
      input.limit,
    );
  } else {
    const messageId = input.around_message_id!;
    const anchorSeq = getHistoryAnchorSeq(ctx, targetConversation.id, messageId);
    if (anchorSeq === null) {
      return {
        error: 'message not found',
        code: 'message_not_found',
        status: 404,
      };
    }
    anchor = { type: 'around_message_id', message_id: messageId };
    const beforeCount = Math.floor((input.limit - 1) / 2);
    const before = listHistoryBefore(
      ctx,
      targetConversation.id,
      anchorSeq,
      input.include_system,
      beforeCount,
    );
    const anchorRow = getHistoryRowById(
      ctx,
      targetConversation.id,
      messageId,
      input.include_system,
    );
    const afterLimit = Math.max(
      0,
      input.limit - before.length - (anchorRow ? 1 : 0),
    );
    const after = listHistoryAfter(
      ctx,
      targetConversation.id,
      anchorSeq,
      input.include_system,
      afterLimit,
    );
    rows = [...before, ...(anchorRow ? [anchorRow] : []), ...after];
  }

  const minSeq = rows[0]?.seq ?? null;
  const maxSeq = rows.at(-1)?.seq ?? null;
  return {
    target,
    anchor,
    limit: input.limit,
    include_content: input.include_content,
    include_system: input.include_system,
    messages: rows.map(row =>
      historyRowToMessage(row, target, input.include_content),
    ),
    has_more_before:
      minSeq === null
        ? false
        : hasHistoryBefore(
            ctx,
            targetConversation.id,
            minSeq,
            input.include_system,
          ),
    has_more_after:
      maxSeq === null
        ? false
        : hasHistoryAfter(
            ctx,
            targetConversation.id,
            maxSeq,
            input.include_system,
          ),
  };
}

function listAgentVisibleChannels(
  ctx: BackendContext,
  workspaceId: string,
  agentId: string,
): AgentListChannelsDto {
  const rows = ctx.db
    .prepare<[string, string], ConversationDto>(
      `SELECT c.*
         FROM conversations c
         JOIN conversation_agents ca
           ON ca.conversation_id = c.id
          AND ca.agent_id = ?
        WHERE c.workspace_id = ?
          AND c.kind IN ('channel', 'dm_channel')
        ORDER BY (c.archived_at IS NOT NULL) ASC,
                 (c.pinned_at IS NOT NULL) DESC,
                 c.pinned_at DESC,
                 c.updated_at DESC`,
    )
    .all(agentId, workspaceId);
  return {
    workspace_id: workspaceId,
    channels: rows.map(
      (row): AgentListedChannel => ({
        id: row.id,
        title: row.title,
        kind: row.kind === 'dm_channel' ? 'dm_channel' : 'channel',
        archived: row.archived_at !== null,
        updated_at: row.updated_at,
      }),
    ),
  };
}

/**
 * Build the cross-workspace `list_workspaces` payload for the calling
 * agent. The workspace list is the canonical
 * `WorkspaceRepo.listForAgent` (regular ∪ owned agent_home); per-row
 * `agent_dir` mirrors `activeAgentProfileDir` — for `agent_home` the
 * workspace root is itself the agent's home, for `regular` we point
 * at the nested L2 profile dir.
 */
function buildAgentListWorkspacesDto(
  ctx: BackendContext,
  agentId: string,
): AgentListWorkspacesDto {
  const workspaces = new WorkspaceRepo(ctx.db, {
    workspacesRoot: ctx.workspacesRoot,
  }).listForAgent(agentId);
  return {
    workspaces: workspaces.map((w): AgentListedWorkspace => {
      const agentDir =
        w.workspace_kind === 'agent_home'
          ? w.workspace_path
          : join(w.workspace_path, '.silverhand', 'agents', agentId);
      return {
        id: w.id,
        name: w.name,
        kind: w.workspace_kind,
        archived: w.archived_at !== null,
        updated_at: w.updated_at,
        agent_dir: agentDir,
      };
    }),
  };
}

function searchMessageRef(row: AgentSearchMessageRow): MessageRef {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    conversation_id: row.conversation_id,
    conversation_kind: row.conversation_kind,
    channel_id: row.channel_id,
    thread_id: row.thread_id,
    seq: row.seq,
    created_at: row.created_at,
  };
}

function searchExcerptFor(
  content: string,
  query: string,
): { excerpt: string; match_offset: number } {
  const compact = content.replace(/\s+/g, ' ').trim();
  const lower = compact.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const matchStart = lower.indexOf(lowerQuery);
  if (matchStart < 0) {
    const excerpt = compact.slice(0, SEARCH_EXCERPT_CONTEXT_CHARS * 2);
    return { excerpt, match_offset: 0 };
  }
  const start = Math.max(0, matchStart - SEARCH_EXCERPT_CONTEXT_CHARS);
  const end = Math.min(
    compact.length,
    matchStart + query.length + SEARCH_EXCERPT_CONTEXT_CHARS,
  );
  const prefix = start > 0 ? '...' : '';
  const suffix = end < compact.length ? '...' : '';
  return {
    excerpt: `${prefix}${compact.slice(start, end)}${suffix}`,
    match_offset: matchStart - start + prefix.length,
  };
}

type SearchMessagesResult =
  | { ok: true; dto: AgentSearchMessagesDto }
  | {
      ok: false;
      status: 400 | 403 | 404;
      code: string;
      message: string;
    };

function buildAgentSearchMessagesDto(
  ctx: BackendContext,
  conversations: ConversationRepo,
  sourceConversation: ConversationDto,
  agentId: string,
  input: {
    q: string;
    scope: 'current' | 'workspace' | 'channel';
    workspace_id?: string;
    channel_id?: string;
    include_system: boolean;
    limit: number;
  },
): SearchMessagesResult {
  const where: string[] = [`m.content LIKE ? ESCAPE '\\'`];
  const params: Array<string | number> = [likeNeedle(input.q)];
  let channelId: string | null = null;
  let workspaceId: string | null = null;

  if (!input.include_system) {
    where.push(`m.from_kind != 'system'`);
  }

  if (input.scope === 'current') {
    where.push(`conv.id = ?`);
    params.push(sourceConversation.id);
  } else if (input.scope === 'workspace') {
    // Cross-workspace handled by the route before we get here:
    // `canAgentAccessWorkspace` already gated `input.workspace_id`
    // when it differs from `sourceConversation.workspace_id`. Here we
    // just pick the SQL filter; the conversation_agents JOIN below
    // remains the bottom guard so unjoined channels in the target
    // workspace stay invisible.
    workspaceId = input.workspace_id ?? sourceConversation.workspace_id;
    where.push(`conv.workspace_id = ?`);
    params.push(workspaceId);
  } else {
    channelId = input.channel_id ?? null;
    if (!channelId) {
      return {
        ok: false,
        status: 400,
        code: 'channel_id_required',
        message: 'channel_id is required for channel scope',
      };
    }
    const channel = conversations.getChannelLike(channelId);
    if (!channel) {
      return {
        ok: false,
        status: 404,
        code: 'channel_not_found',
        message: 'channel not found',
      };
    }
    // channel_id is globally unique. PR-B made list_channels return
    // channels from any workspace the agent has access to, so the
    // bottom guard is conversation-membership, not source-workspace
    // identity. The SQL `JOIN conversation_agents` below still
    // filters child threads by per-conversation membership.
    if (!conversations.getAgent(channel.id, agentId)) {
      return {
        ok: false,
        status: 403,
        code: 'not_channel_member',
        message: 'agent is not a member of this channel',
      };
    }
    where.push(`(conv.id = ? OR conv.parent_conversation_id = ?)`);
    params.push(channel.id, channel.id);
  }

  const sqlParams: Array<string | number> = [agentId, ...params, input.limit];
  const rows = ctx.db
    .prepare<Array<string | number>, AgentSearchMessageRow>(
      `SELECT
          m.*,
          assignee.display_name AS task_assignee_name,
          sender.display_name AS sender_agent_name,
          conv.workspace_id AS workspace_id,
          conv.kind AS conversation_kind,
          CASE WHEN conv.kind = 'thread' THEN conv.parent_conversation_id ELSE conv.id END
            AS channel_id,
          CASE WHEN conv.kind = 'thread' THEN conv.id ELSE NULL END AS thread_id
         FROM messages m
         JOIN conversations conv ON conv.id = m.conversation_id
         JOIN conversation_agents ca
           ON ca.conversation_id = conv.id
          AND ca.agent_id = ?
         LEFT JOIN agents assignee ON assignee.id = m.task_assignee_agent_id
         LEFT JOIN agents sender ON sender.id = m.from_agent_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.created_at DESC, m.seq DESC
        LIMIT ?`,
    )
    .all(...sqlParams);

  return {
    ok: true,
    dto: {
      query: input.q,
      scope: input.scope,
      workspace_id: workspaceId,
      channel_id: channelId,
      include_system: input.include_system,
      limit: input.limit,
      hits: rows.map((row): AgentSearchMessageHit => {
        const excerpt = searchExcerptFor(row.content, input.q);
        return {
          message_ref: searchMessageRef(row),
          sender: senderRef(row),
          excerpt: excerpt.excerpt,
          match_offset: excerpt.match_offset,
        };
      }),
    },
  };
}

function publishUnreadUpdated(
  ctx: BackendContext,
  conversationId: string,
  viewerUserId: string,
): void {
  ctx.events.publishToScope(`viewer:${viewerUserId}`, 'unread_updated', {
    conversation_id: conversationId,
  });
}

export function createInternalRouter(ctx: BackendContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const agents = new AgentRepo(ctx.db);
  const conversations = new ConversationRepo(ctx.db);
  const messages = new MessageRepo(ctx.db);
  const workspaces = new WorkspaceRepo(ctx.db, { workspacesRoot: ctx.workspacesRoot });
  const taskDeps = { ctx, agents, conversations, messages };

  app.use('/internal/conversations/:cid/agents/:aid/*', async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.replace(/^Bearer\s+/i, '').trim();
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    const verified = ctx.agentTokens.verify(token, cid, aid);
    if (!verified.ok) {
      ctx.logger.warn(
        {
          path: c.req.path,
          hasHeader: !!header,
          tokenLen: token.length,
          reason: verified.reason,
          conversationId: cid,
          agentId: aid,
          caller: c.req.header('x-agent-hub-caller') ?? 'unknown',
        },
        'internal: unauthorized request',
      );
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });
  installInternalPrincipalMiddleware(app, { agents, conversations });

  // CLI invocation logging — must run after auth so we only emit lines
  // for verified principals, but before route handlers so handler
  // throws/short-circuits still produce one line per call.
  app.use(
    '/internal/conversations/:cid/agents/:aid/*',
    createCliInvokeMiddleware(ctx),
  );

  // Observability-only: CLI fire-and-forget pre-flight failure trace.
  // Excluded from the cli.invoke middleware (the middleware checks the
  // suffix and skips it); logged here as `cli.preflight_failure`.
  app.post(internalPaths.agentCliTrace(':cid', ':aid'), async c => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = CliTraceInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    ctx.loggers.cli.info(
      {
        category: 'cli.preflight_failure',
        conversationId: principal.conversationId,
        agentId: principal.agentId,
        noun: parsed.data.noun ?? null,
        verb: parsed.data.verb ?? null,
        flags_seen: parsed.data.flags_seen ?? [],
        error_code: parsed.data.error_code ?? null,
        error_subkind: parsed.data.error_subkind ?? null,
        error_message: parsed.data.error_message ?? null,
        duration_ms: parsed.data.duration_ms ?? null,
        status: 'failure',
      },
      'cli.preflight_failure',
    );
    return c.json({ ok: true });
  });

  // ── canonical conversation-scoped MCP routes ───────────────────
  app.post(internalPaths.agentSendConversationMessage(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSendMessageInputSchema.safeParse(body);
    if (!parsed.success) {
      ctx.logger.warn(
        { conversationId: cid, agentId: aid, issues: parsed.error.issues },
        'internal: agent send-message rejected (invalid input)',
      );
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.conversationMessageService.sendMessage({
        conversationId: principal.conversationId,
        actor: principal,
        content: parsed.data.content,
        attachmentIds: parsed.data.attachment_ids ?? [],
        target: parsed.data.target,
      });
      return c.json({ message_id: result.message.id });
    } catch (err) {
      const mapped = conversationMessageServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentCreateThread(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSpawnChildInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.threadService.createThreadFromAgent({
        parentConversationId: principal.conversationId,
        actor: principal,
        title: parsed.data.title,
        contextSummary: parsed.data.context_summary,
        initialPrompt: parsed.data.initial_prompt,
        requestedMembers: parsed.data.members,
      });
      return c.json({ thread_id: result.thread.id });
    } catch (err) {
      const mapped = threadServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentCreateChannel(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCreateChannelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }

    const principal = getAgentPrincipal(c);
    const current = conversations.get(principal.conversationId);
    if (!current) return c.json({ error: 'conversation not found' }, 404);
    if (!canPostToConversation(ctx, principal, current.id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const memberAgentIds = conversations
      .listAgents(current.id)
      .map(member => member.agent_id);

    try {
      const result = await ctx.channelService.createChannel({
        workspaceId: current.workspace_id,
        title: parsed.data.title,
        memberAgentIds,
        actor: principal,
        seed: {
          systemMessageBody:
            `Channel created from '${current.title}'. Reason: ${parsed.data.context_summary}`,
          initialPrompt: parsed.data.initial_prompt,
          autoStartMembers: 'all',
        },
      });
      return c.json({ channel_id: result.channel.id });
    } catch (err) {
      const mapped = channelServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentCloseThread(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentCloseThreadInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const result = await ctx.threadService.closeThread({
        threadId: principal.conversationId,
        actor: principal,
        summary: parsed.data.summary,
        postedToParent: parsed.data.posted_to_parent ?? false,
        allowOpenTasks: parsed.data.allow_open_tasks ?? false,
      });
      return c.json({ thread: result.thread });
    } catch (err) {
      const mapped = threadServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentReadHistory(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentReadHistoryInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    const target = resolveAgentReadHistoryTarget(
      conversations,
      sourceConversation,
      principal.agentId,
      parsed.data.target,
    );
    if (!target.ok) {
      return c.json({ error: target.message, code: target.code }, target.status);
    }
    const result = timedRouteSpan(
      ctx,
      'agent.read_history',
      {
        sourceConversationId: principal.conversationId,
        targetConversationId: target.conversation.id,
        agentId: principal.agentId,
        limit: parsed.data.limit,
      },
      () => buildReadHistoryDto(ctx, target.conversation, parsed.data),
      out => ({
        messageCount: 'messages' in out ? out.messages.length : 0,
      }),
    );
    if ('error' in result) {
      return c.json({ error: result.error, code: result.code }, result.status);
    }
    return c.json(result);
  });

  app.get(internalPaths.agentListWorkspaces(':cid', ':aid'), c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const result = timedRouteSpan(
      ctx,
      'agent.list_workspaces',
      {
        sourceConversationId: principal.conversationId,
        agentId: principal.agentId,
      },
      () => buildAgentListWorkspacesDto(ctx, principal.agentId),
      out => ({ workspaceCount: out.workspaces.length }),
    );
    return c.json(result);
  });

  app.get(internalPaths.agentListChannels(':cid', ':aid'), c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const parsedQuery = AgentListChannelsQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
    });
    if (!parsedQuery.success) {
      return c.json({ error: 'invalid query', issues: parsedQuery.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    // Default to source workspace; cross-workspace access is gated by
    // `canAgentAccessWorkspace` (workspace_members ∪ owned agent_home).
    const targetWorkspaceId =
      parsedQuery.data.workspace_id ?? sourceConversation.workspace_id;
    if (targetWorkspaceId !== sourceConversation.workspace_id) {
      if (!canAgentAccessWorkspace(ctx, principal.agentId, targetWorkspaceId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    const result = timedRouteSpan(
      ctx,
      'agent.list_channels',
      {
        sourceConversationId: principal.conversationId,
        sourceWorkspaceId: sourceConversation.workspace_id,
        targetWorkspaceId,
        agentId: principal.agentId,
      },
      () =>
        listAgentVisibleChannels(ctx, targetWorkspaceId, principal.agentId),
      out => ({ channelCount: out.channels.length }),
    );
    return c.json(result);
  });

  app.post(internalPaths.agentSearchMessages(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentSearchMessagesInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const sourceConversation = conversations.get(principal.conversationId);
    if (!sourceConversation) return c.json({ error: 'conversation not found' }, 404);
    // Cross-workspace search is gated up-front by
    // `canAgentAccessWorkspace`. The dto builder still runs the
    // conversation_agents JOIN as the bottom guard, so unjoined
    // channels in the target workspace stay invisible.
    if (
      parsed.data.workspace_id &&
      parsed.data.workspace_id !== sourceConversation.workspace_id
    ) {
      if (
        !canAgentAccessWorkspace(
          ctx,
          principal.agentId,
          parsed.data.workspace_id,
        )
      ) {
        return c.json({ error: 'forbidden' }, 403);
      }
    }
    const result = timedRouteSpan(
      ctx,
      'agent.search_messages',
      {
        sourceConversationId: principal.conversationId,
        agentId: principal.agentId,
        scope: parsed.data.scope,
        workspaceId: parsed.data.workspace_id ?? null,
        channelId: parsed.data.channel_id ?? null,
        limit: parsed.data.limit,
      },
      () =>
        buildAgentSearchMessagesDto(
          ctx,
          conversations,
          sourceConversation,
          principal.agentId,
          parsed.data,
        ),
      out => ({
        hitCount: out.ok ? out.dto.hits.length : 0,
      }),
    );
    if (!result.ok) {
      return c.json({ error: result.message, code: result.code }, result.status);
    }
    return c.json(result.dto);
  });

  app.get(internalPaths.agentListConversationTasks(':cid', ':aid'), c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    // status / task_number are repeatable; `?status=in_progress&status=in_review`
    // and `?task_number=190&task_number=191` are the canonical multi-value form.
    // 'all' is a legacy alias for no-filter — drop it before validation.
    const statusValues = (c.req.queries('status') ?? []).filter(s => s !== 'all');
    const taskNumberValues = c.req.queries('task_number') ?? [];
    const parsed = ListTasksQuerySchema.safeParse({
      workspace_id: c.req.query('workspace_id') || undefined,
      conversation_id: c.req.query('conversation_id') || undefined,
      status: statusValues.length > 0 ? statusValues : undefined,
      task_number: taskNumberValues.length > 0 ? taskNumberValues : undefined,
      assignee_id: c.req.query('assignee_id') || undefined,
      limit: c.req.query('limit') || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: 'invalid query', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canViewConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Agent-side --workspace-id (#task:530): default is the actor's
    // current conversation's workspace; if the agent passes a different
    // workspace_id we must validate existence + membership at the route
    // layer so the service doesn't silently widen reads across
    // workspaces. We don't accept --workspace <name> for list — only
    // claim/unclaim/status need the disambiguation.
    let effectiveWorkspaceId = parsed.data.workspace_id;
    if (effectiveWorkspaceId && effectiveWorkspaceId !== conversation.workspace_id) {
      const targetWs = workspaces.get(effectiveWorkspaceId);
      if (!targetWs) {
        return c.json(
          { error: `workspace ${effectiveWorkspaceId} not found`, code: 'unknown_workspace' },
          404,
        );
      }
      const isMember =
        targetWs.workspace_kind === 'agent_home'
          ? targetWs.owner_agent_id === aid
          : workspaces.isMember(targetWs.id, aid);
      if (!isMember) {
        return c.json(
          {
            error: `agent is not a member of workspace ${targetWs.id}`,
            code: 'workspace_membership_required',
          },
          403,
        );
      }
    } else if (!effectiveWorkspaceId) {
      effectiveWorkspaceId = conversation.workspace_id;
    }
    return c.json({
      tasks: ctx.taskService.list({
        actor: principal,
        workspaceId: effectiveWorkspaceId,
        conversationId: parsed.data.conversation_id,
        status: parsed.data.status,
        taskNumbers: parsed.data.task_number,
        assigneeAgentId: parsed.data.assignee_id,
        limit: parsed.data.limit,
      }),
    });
  });

  app.post(internalPaths.agentCreateConversationTasks(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const result = await ctx.taskService.createTasks({
      conversationId: principal.conversationId,
      actor: principal,
      tasks: parsed.data.tasks,
    });
    if ('error' in result) {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  app.post(internalPaths.agentClaimConversationTasks(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ClaimTasksInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const actor = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, actor, actor.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    // Wire optional --workspace-id / --workspace selector (#task:530).
    // Schema XOR enforces exclusivity; the service does membership +
    // existence checks per result entry.
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const results = [];
    for (const taskNumber of parsed.data.task_numbers ?? []) {
      results.push(
        await ctx.taskService.claimTask({ actor, by: { taskNumber }, workspaceSelector }),
      );
    }
    for (const messageId of parsed.data.message_ids ?? []) {
      results.push(
        await ctx.taskService.claimTask({ actor, by: { messageId }, workspaceSelector }),
      );
    }
    return c.json({ results });
  });

  app.post(internalPaths.agentUnclaimConversationTask(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UnclaimTaskInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.unclaimTask({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      workspaceSelector,
    });
    return c.json(result);
  });

  app.post(internalPaths.agentUpdateConversationTaskStatus(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = UpdateTaskStatusInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const workspaceSelector = {
      ...(parsed.data.workspace_id ? { workspaceId: parsed.data.workspace_id } : {}),
      ...(parsed.data.workspace_name ? { workspaceName: parsed.data.workspace_name } : {}),
    };
    const result = await ctx.taskService.updateStatus({
      actor: principal,
      by: { taskNumber: parsed.data.task_number },
      status: parsed.data.status,
      workspaceSelector,
    });
    return c.json(result);
  });

  // ── Agent-initiated attachments (silverhand CLI → backend) ────────
  // Agents never specify channel_id; the backend derives it from the
  // calling conversation (cid) so the access boundary is fixed by the
  // agent's runtime context. locateForAgent additionally enforces that
  // the requested attachment belongs to the same channel.

  app.post(internalPaths.agentUploadAttachment(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const conversation = conversations.get(cid);
    if (!conversation) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    if (!conversations.getAgent(cid, aid)) {
      return c.json({ error: 'agent is not a member of this conversation' }, 403);
    }
    const principal = getAgentPrincipal(c);
    if (!canPostToConversation(ctx, principal, principal.conversationId)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    return uploadAttachment(
      ctx,
      c,
      principal.conversationId,
      'agent',
      principal.agentId,
    );
  });

  app.get(
    internalPaths.agentLocateAttachment(':cid', ':aid', ':attachmentId'),
    async c => {
      const cid = c.req.param('cid');
      const aid = c.req.param('aid');
      const attachmentId = c.req.param('attachmentId');
      if (!cid || !aid || !attachmentId) {
        return c.json(
          { error: 'conversation id, agent id, and attachment id required' },
          400,
        );
      }
      if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
      if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
      if (!conversations.getAgent(cid, aid)) {
        return c.json({ error: 'agent is not a member of this conversation' }, 403);
      }
      const principal = getAgentPrincipal(c);
      if (!canViewConversation(ctx, principal, principal.conversationId)) {
        return c.json({ error: 'forbidden' }, 403);
      }
      const located = await ctx.attachmentService.locateForAgent(
        attachmentId,
        principal.conversationId,
      );
      if (!located) {
        // Either does not exist or belongs to a different channel — same
        // shape on purpose so we don't leak existence across channels.
        return c.json({ error: 'attachment not found' }, 404);
      }
      return c.json(located.locate);
    },
  );

  // ── Agent self-edit avatar (silverhand CLI → backend) ────────────
  // The agent token middleware already enforces `principal.agentId ===
  // :aid`, so the URL pin alone makes this self-only. `canEditAgent`
  // is called as a defensive double-check (mirrors the public route)
  // and to keep the agent-self branch of the predicate exercised by
  // tests instead of dead code.
  //
  // Only the avatar is exposed here — display_name / description /
  // runtime / reasoning_effort / fast_mode self-edit is **not**
  // covered by PR-2. Cross-creator profile edits go through the
  // public `PATCH /api/agents/:id` (creator-only); agent self-edit
  // for those fields is a future internal route, not implied by this
  // PR.

  app.post(internalPaths.agentUploadAvatar(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return c.json({ error: 'multipart/form-data required' }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    try {
      const dto = await ctx.agentService.uploadAvatar(aid, {
        buffer,
        contentType: file.type || 'application/octet-stream',
        filename: file.name || 'avatar',
      });
      return c.json({ avatar_url: dto.avatar_url, agent: dto });
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
  });

  app.delete(internalPaths.agentDeleteAvatar(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    if (!conversations.get(cid)) return c.json({ error: 'conversation not found' }, 404);
    if (!agents.get(aid)) return c.json({ error: 'agent not found' }, 404);
    const principal = getAgentPrincipal(c);
    if (!canEditAgent(ctx, principal, aid)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const dto = await ctx.agentService.clearAvatar(aid);
      return c.json({ agent: dto });
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
  });

  // ── Agent-owned schedules (silverhand CLI → backend) ──────────────
  // Per-agent surface. The route hangs off the calling conversation so
  // the existing internal principal middleware (cid+aid → AgentPrincipal)
  // authenticates the request without a second auth path; the calling
  // `cid` is also passed into the service as the default
  // `target_conversation_id` so creating a schedule in DM defaults to
  // firing in DM, in a channel defaults to firing in that channel, etc.
  // (the agent can always override with `target_conversation_id` in the
  // body to fire elsewhere it's a member of).
  // Errors map ScheduleError.code → structured `{ error, code }` JSON
  // via scheduleServiceErrorResponse so the agent sees stable codes.

  app.post(internalPaths.agentScheduleCreate(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCreateInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    try {
      const schedule = ctx.scheduleService.create(
        parsed.data,
        principal.agentId,
        cid,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post(internalPaths.agentScheduleList(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleListInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    const schedules = ctx.scheduleService.list(
      principal.agentId,
      parsed.data.status,
      parsed.data.limit,
    );
    return c.json({ schedules });
  });

  app.post(internalPaths.agentScheduleCancel(':cid', ':aid'), async c => {
    const cid = c.req.param('cid');
    const aid = c.req.param('aid');
    if (!cid || !aid) {
      return c.json({ error: 'conversation id and agent id required' }, 400);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = ScheduleCancelInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const principal = getAgentPrincipal(c);
    try {
      const schedule = ctx.scheduleService.cancel(
        parsed.data.schedule_id,
        principal.agentId,
      );
      return c.json({ schedule });
    } catch (err) {
      const mapped = scheduleServiceErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  });

  return app;
}

/** Parse multipart/form-data and hand the file to AttachmentService.
 *  Shared between public (channel/thread) and internal (agent) upload
 *  routes so the response shape and error mapping stay identical. */
async function uploadAttachment(
  ctx: BackendContext,
  c: Context,
  sourceConversationId: string,
  createdByKind: 'user' | 'agent',
  createdById: string,
): Promise<Response> {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch (err) {
    ctx.logger.warn(
      { sourceConversationId, err },
      'api: attachment upload — multipart parse failed',
    );
    return c.json({ error: 'multipart/form-data required' }, 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return c.json({ error: 'file field required' }, 400);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const dto = await ctx.attachmentService.upload({
      sourceConversationId,
      filename: file.name,
      contentType: file.type || null,
      buffer,
      createdByKind,
      createdById,
    });
    return c.json(dto, 201);
  } catch (err) {
    if (err instanceof AttachmentRejection) {
      const status = err.failure.kind === 'too_large' ? 413 : 400;
      return c.json({ error: err.message, code: err.failure.kind }, status);
    }
    throw err;
  }
}
