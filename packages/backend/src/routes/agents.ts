// Public `/api/agents` surface: list / create / get / patch / runtime transition / avatar
// workspace-fs (tree·file) / runtime-state / schedules (list·cancel) / stop /
// delete. The destructive DELETE cascade already delegates to
// the `deleteAgent` use case; `stop` is a runtime-adapter aggregation with no
// DB/UoW, so it stays in the route layer.
import {
  createAgent,
  type AgentMaterializeFailureCode,
} from '../application/create-agent.js';
import type {
  AgentProvisioningPersistence,
} from '../application/agent-provisioning-ports.js';
import type {
  AgentTeardownPersistence,
} from '../application/agent-teardown-ports.js';
import type { AgentDeletionRunner } from '../application/agent-deletion-resumer.js';
import { isParticipantHandleAvailable } from '../application/name-availability.js';
import {
  deleteAgent,
} from '../application/delete-agent.js';
import {
  switchAgentRuntime,
  SwitchAgentRuntimeError,
} from '../application/switch-agent-runtime.js';
import {
  runPostCommitEffects,
} from '../application/post-commit.js';
import {
  getUserPrincipal,
  resolveViewerUserId,
  type AppEnv,
  type Principal,
} from '../auth/principal.js';
import type { BackendContext } from '../context.js';
import {
  canEditAgent,
  canViewAgent,
  canViewAgentFiles,
  canViewWorkspace,
} from '../permissions.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationInboxRepo } from '../repos/conversation-inbox-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { RuntimeSlotRepo } from '../repos/runtime-slot-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import {
  type WorkspaceRepo,
} from '../repos/workspace-repo.js';
import {
  agentServiceErrorBody,
  agentServiceErrorStatus,
  placementErrorResponse,
  scheduleServiceErrorResponse,
} from './responses.js';
import {
  dispatchAgentWorkspaceFileRead,
  dispatchAgentWorkspaceTree,
  dispatchAgentProfileMcpRead,
  dispatchMcpProbe,
  resolveOutboundForHost,
} from '../runtime/workspace-data-plane.js';
import {
  CreateAgentInputSchema,
  ParticipantNameSchema,
  McpProbeRequestSchema,
  ScheduleListInputSchema,
  SwitchAgentRuntimeInputSchema,
  UpdateAgentInputSchema,
  apiPaths,
  type AgentDto,
  type AgentMaterializationStatus,
  type NameAvailabilityDto,
} from '@silverhand/shared';
import {
  Hono,
} from 'hono';

export interface AgentsRouteDeps {
  ctx: BackendContext;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  conversationInboxes: ConversationInboxRepo;
  runtimeSlots: RuntimeSlotRepo;
  users: UserRepo;
  /** #task:1990 — the L3a dependent-row transaction scope (wired at
   *  composition root; the use case never receives `BackendContext`). */
  agentProvisioning: AgentProvisioningPersistence;
  /** #task:1987 D — the teardown read + UnitOfWork shared with
   *  `DELETE /api/hosts/:id`; the delete use case names no repo. */
  agentTeardown: AgentTeardownPersistence;
  agentDeletionRunner: AgentDeletionRunner;
}

// ── POST /api/agents — Idempotency-Key parsing (route-side, pure) ──
//
// `Idempotency-Key` header shape: 1..64 chars, character set
// `[A-Za-z0-9_-]`. Server treats the value as opaque
// (no parsing / interpretation); the regex only enforces the envelope.
// The header is REQUIRED for `POST /api/agents` — the "same key, same
// response" idempotency contract (§3.2) is structurally impossible
// without it. Pure (no `Context`); the route reads the header and maps
// `!ok` → 400.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_\-]{1,64}$/;

function parseIdempotencyKeyHeader(
  raw: string | undefined,
): { ok: true; key: string } | { ok: false; code: string; message: string } {
  if (!raw) {
    return {
      ok: false,
      code: 'idempotency_key_missing',
      message:
        'POST /api/agents requires Idempotency-Key header (1..64 chars, [A-Za-z0-9_-])',
    };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    return {
      ok: false,
      code: 'idempotency_key_malformed',
      message:
        'Idempotency-Key must match /^[A-Za-z0-9_-]{1,64}$/ (per design §14 Q1)',
    };
  }
  return { ok: true, key: raw };
}

/**
 * Map a domain `agent_materialize` failure code to its HTTP status
 * to its HTTP status. Verbatim reproduction of the original status mapping that
 * was embedded in `d3MapMaterializeWireError` + the transport/ack/dependent-row
 * arms of `d5RunMaterializeFromReserved`; that orchestration now lives in
 * `application/create-agent.ts` and returns the domain `failedCode` only. The
 * switch is exhaustive over {@link AgentMaterializeFailureCode}; a new code
 * that forgets a case fails to compile.
 */
function mapAgentCreateFailureToStatus(
  code: AgentMaterializeFailureCode,
): 400 | 409 | 500 | 502 | 503 | 504 | 507 {
  switch (code) {
    case 'daemon_internal_error':
      return 502;
    case 'host_attach_pending':
      return 503;
    case 'materialize_timeout':
      return 504;
    case 'dependent_row_insert_failed':
      return 500;
    case 'agent_dir_collision':
      return 409;
    case 'fs_quota_exceeded':
      return 507;
    case 'fs_unavailable':
      return 502;
    case 'unsupported_template':
      return 400;
    case 'unsupported_runtime':
      return 400;
    case 'daemon_shutting_down':
      return 503;
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

type AgentWorkspaceScope =
  | { ok: true; workspaceId: string | null }
  | {
      ok: false;
      status: 400 | 403 | 404;
      code: string;
      message: string;
    };

function resolveAgentWorkspaceScope(params: {
  ctx: BackendContext;
  principal: Principal;
  workspaces: WorkspaceRepo;
  agentId: string;
  workspaceId: string | undefined;
}): AgentWorkspaceScope {
  const rawWorkspaceId = params.workspaceId;
  if (rawWorkspaceId === undefined) return { ok: true, workspaceId: null };
  if (rawWorkspaceId.length === 0) {
    return {
      ok: false,
      status: 400,
      code: 'invalid_workspace_id',
      message: 'workspace_id query param must not be empty',
    };
  }

  const workspace = params.workspaces.get(rawWorkspaceId);
  if (!workspace) {
    return {
      ok: false,
      status: 404,
      code: 'workspace_not_found',
      message: 'workspace not found',
    };
  }
  if (!canViewWorkspace(params.ctx, params.principal, workspace.id)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden',
      message: 'forbidden',
    };
  }

  // Scoped reads always gate membership against the requested workspace, even
  // when that workspace is an agent_home/DM id that resolves to the same L1
  // home dir. The no-param path is the existing broad "can view this agent"
  // home view; `workspace_id` is the narrower per-workspace/L2 view.
  const isMember =
    workspace.workspace_kind === 'agent_home'
      ? workspace.owner_agent_id === params.agentId
      : params.workspaces.isMember(workspace.id, params.agentId);
  if (!isMember) {
    return {
      ok: false,
      status: 404,
      code: 'workspace_agent_not_member',
      message: 'agent is not a member of this workspace',
    };
  }

  return { ok: true, workspaceId: workspace.id };
}

export function createAgentsApp(deps: AgentsRouteDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const {
    ctx,
    agents,
    workspaces,
    conversations,
    messages,
    conversationInboxes,
    runtimeSlots,
    users,
    agentProvisioning,
    agentTeardown,
  } = deps;

  app.get(apiPaths.agents, c => {
    const principal = getUserPrincipal(c);
    // Default view hides BOTH `pending_materialization` AND `failed`. Pending
    // rows are management-view material; default-hiding them keeps
    // §5 boot reconciler residue out of the everyday product
    // surface.
    //
    // `?include_pending=1` mirrors `?include_failed=1`: ACL-first,
    // creator-scoped, and not a cross-user enumeration surface. Adds pending rows to the
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
    // `?scope=owned` NARROWS the ACL-visible set to agents THIS user created
    // (`created_by_user_id == viewer`), dropping agents visible only via shared
    // workspace membership (#task:1256). It never WIDENS — it composes on top of
    // `canViewAgent`, so it cannot expose an agent the ACL already hides. Default
    // (absent / any other value) keeps the full ACL-visible set. "Whose agent is
    // mine" is defined here in the contract, so every consumer (desktop, CLI)
    // agrees — the renderer passes the flag and never re-filters client-side.
    const ownedOnly = c.req.query('scope') === 'owned';
    return c.json({
      agents: agents
        .list()
        .filter(
          agent =>
            canViewAgent(ctx, principal, agent.id, { includeStatuses })
            && (!ownedOnly || agent.created_by_user_id === principal.userId),
        ),
    });
  });

  // GET /api/agents/name-availability?name= — create-form onBlur uniqueness
  // probe. Registered BEFORE `/api/agents/:id` so the static segment is not
  // shadowed by the param route. Shares ONE predicate with the create path
  // (`isParticipantHandleAvailable`) so the form can never report "available"
  // for a name create would reject. Agent names are the GLOBAL @-handle
  // namespace shared with human users → the predicate checks agents ∪ users.
  app.get(apiPaths.agentNameAvailability, c => {
    getUserPrincipal(c); // authed-user gate (parity with sibling routes)
    const parsed = ParticipantNameSchema.safeParse(c.req.query('name') ?? '');
    if (!parsed.success) {
      return c.json({
        available: false,
        reason: 'invalid',
      } satisfies NameAvailabilityDto);
    }
    const available = isParticipantHandleAvailable({ agents, users }, parsed.data);
    return c.json({
      available,
      reason: available ? 'available' : 'taken',
    } satisfies NameAvailabilityDto);
  });

  /**
   * `POST /api/agents` — create-agent provisioning saga (thin route).
   *
   * The whole orchestration — idempotency dispatch, fresh-create
   * placement/name/online/reserve, the shared materialize (wire intent →
   * §6.5 ack cross-check → L3a dependent-row tx → L3b compensation), and the
   * post-commit deliver/auto-start effects — lives in the `createAgent` use
   * case (`application/create-agent.ts`). This route is now just
   * parse + principal + map the typed `CreateAgentResult` to HTTP status/body.
   *
   * **NOTE on formal semantics carveout**: the dispatcher / IPC plumbing the
   * use case relies on is
   * local supervisor/control. The `agent_materialize` intent it dispatches via
   * that plumbing, however, IS formal server↔daemon semantics by R4 design —
   * it carries business state (template + identity + L1 fs ownership), not
   * transport bytes.
   *
   * Standalone vs embedded: the use case does NOT branch on deployment mode.
   * Both modes dispatch the same wire intent via the deployment-neutral
   * `ctx.outboundFrameAdapter()` port: standalone reaches the real daemon over
   * the WSS-backed adapter; embedded dials the daemon's local
   * `daemon-outbound.sock` via the `EmbeddedUnixOutboundFrameAdapter`. Both
   * carry the identical outbound frame envelope. The only mode-visible
   * behavior is "daemon offline → 503 host_attach_pending".
   */
  app.post(apiPaths.agents, async c => {
    // Parse body shape.
    const body = await c.req.json().catch(() => ({}));
    const parsed = CreateAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    const principal = getUserPrincipal(c);

    // Idempotency-Key header MUST be present + shape-valid (design §14 Q1).
    const keyParse = parseIdempotencyKeyHeader(c.req.header('Idempotency-Key'));
    if (!keyParse.ok) {
      return c.json({ error: keyParse.message, code: keyParse.code }, 400);
    }

    const result = await createAgent(
      {
        logger: ctx.logger,
        events: ctx.events,
        runtimeHost: ctx.runtimeHost,
        outboundFrameAdapter: ctx.outboundFrameAdapter,
        placement: ctx.placement,
        agents,
        workspaces,
        conversations,
        messages,
        users,
        agentProvisioning,
      },
      {
        input: parsed.data,
        idempotencyKey: keyParse.key,
        retry: c.req.query('retry') === 'true',
        creatorUserId: principal.userId,
      },
    );

    switch (result.kind) {
      case 'created':
        // L4 deliver + auto-start are fire-and-forget closures:
        // each returns immediately, so draining adds no response latency and
        // does not serialize start behind deliver. 201 — the first time this
        // row reaches `active`.
        await runPostCommitEffects(result.effects, ctx.logger);
        return c.json(
          {
            agent: result.payload.agent,
            agent_home_workspace_id: result.payload.agentHomeWorkspaceId,
            dm_channel_id: result.payload.dmChannelId,
            onboarding_message_id: result.payload.onboardingMessageId,
          },
          201,
        );
      case 'echo':
        return c.json(
          {
            agent: result.payload.agent,
            agent_home_workspace_id: result.payload.agentHomeWorkspaceId,
            dm_channel_id: result.payload.dmChannelId,
            onboarding_message_id: result.payload.onboardingMessageId,
          },
          200,
        );
      case 'inProgress':
        return c.json(
          {
            error: 'an in-flight materialize for this key is still pending',
            code: 'materialization_in_progress',
          },
          409,
        );
      case 'previouslyFailed':
        return c.json(
          {
            error: `previous materialize attempt failed (${result.failedCode}); resend with ?retry=true to retry this row, or use a fresh Idempotency-Key for a new attempt`,
            code: 'materialization_previously_failed',
            failed_code: result.failedCode,
            failed_at: result.failedAt,
          },
          409,
        );
      case 'metadataMismatch':
        return c.json(
          {
            error: `Idempotency-Key reuse: request body differs from the original at field '${result.field}'. Use a fresh Idempotency-Key for a different agent.`,
            code: 'idempotency_metadata_mismatch',
            mismatched_field: result.field,
          },
          400,
        );
      case 'retryTargetNotFound':
        return c.json(
          {
            error:
              'no prior agent found for this Idempotency-Key; use a fresh-key POST to create a new agent',
            code: 'retry_target_not_found',
          },
          404,
        );
      case 'retryTargetNotFailed':
        return c.json(
          {
            error: 'agent row is no longer in failed state; refresh and try again',
            code: 'retry_target_not_failed',
          },
          409,
        );
      case 'corruptGraph':
        return c.json({ error: result.message, code: 'internal_error' }, 500);
      case 'nameTaken':
        return c.json({ error: result.message, code: 'agent_name_taken' }, 409);
      case 'hostAttachPending':
        return c.json(
          {
            error: 'host runtime is not currently attached',
            code: 'host_attach_pending',
          },
          503,
        );
      case 'placementError': {
        const mapped = placementErrorResponse(c, result.err);
        if (mapped) return mapped;
        throw result.err;
      }
      case 'materializeFailed':
        return c.json(
          { error: result.message, code: result.failedCode },
          mapAgentCreateFailureToStatus(result.failedCode),
        );
      default: {
        const _exhaustive: never = result;
        throw new Error(
          `unhandled CreateAgentResult: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  });

  app.get('/api/agents/:id', c => {
    const id = c.req.param('id');
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    // Default view hides BOTH `failed` AND `pending_materialization` behind 404.
    //
    // `?include_pending=1` mirrors the list widener; both flags compose, ACL-first ordering keeps
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

  // PATCH — partial update. `name`, `host_id`, and `runtime` are intentionally not
  // patchable here: `name` is the immutable handle (renaming would
  // ripple through the agent_home workspace, every @mention in history,
  // every L2 file path), host swap is out of v1 scope, and runtime swap is
  // not a simple profile edit: the dedicated PUT transition below owns CLI
  // session clearing, spawn exclusion, and atomic target-runtime tuning.
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
    // Route the write through the service so the `agent_changed` refresh
    // event is published in ONE seam (shared with the avatar routes and the
    // agent-self `profile update` route) — no per-route publish to drift.
    // The service also validates runtime tuning (reasoning valid for the
    // current runtime); an explicit out-of-runtime value throws → 400.
    let updated: AgentDto | null;
    try {
      updated = ctx.agentService.updateAgent(id, parsed.data);
    } catch (err) {
      const status = agentServiceErrorStatus(err);
      if (status) return c.json(agentServiceErrorBody(err), status);
      throw err;
    }
    if (!updated) return c.json({ error: 'agent not found' }, 404);
    return c.json({ agent: updated });
  });

  // Runtime is intentionally not part of generic PATCH. Switching drivers is
  // a lifecycle transition: lock delivery, clear every old-runtime session,
  // atomically install the target runtime + explicit tuning, then re-drive
  // active/pending conversations.
  app.put(apiPaths.agentRuntime(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewAgent(ctx, principal, id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    if (!canEditAgent(ctx, principal, id)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const parsed = SwitchAgentRuntimeInputSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid input', issues: parsed.error.issues }, 400);
    }
    try {
      const result = await switchAgentRuntime(
        { ctx, agents, runtimeSlots, conversationInboxes },
        {
          agentId: id,
          actorUserId: resolveViewerUserId(c),
          config: parsed.data,
        },
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof SwitchAgentRuntimeError) {
        if (err.cause) {
          const mapped = placementErrorResponse(c, err.cause);
          if (mapped) return mapped;
        }
        return c.json({ error: err.message, code: err.code }, err.status);
      }
      const mapped = placementErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
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

  // Two-protocol read pair backing the two-column AgentWorkspacePane:
  // `/workspace/tree` returns the flat tree (every
  // visible file/dir under the agent home dir by default, or under the
  // agent's L2 dir for `?workspace_id=…`); `/workspace/file?path=…`
  // reads one file by virtual path. Both go through the same data-plane
  // dispatch so embedded + remote daemons share one code path. The backend
  // gates the semantic source (`workspace_id`); the daemon owns path
  // resolution + virtual-path security.
  app.get(apiPaths.agentWorkspaceTree(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewAgent(ctx, principal, agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    // #task:1219 — agent files (L1/home + L2) are owner-private. The
    // `canViewAgent` gate above is the anti-enumeration outer door (a
    // total stranger gets 404 and can't tell the agent exists); a
    // co-workspace member who is NOT the owner clears it but must still
    // be refused here. Mirrors the sibling owner-gated surfaces (raw
    // MCP config, schedules). 403 is the honest "you're not the owner"
    // surface the renderer renders as a neutral private empty state.
    if (!canViewAgentFiles(ctx, principal, agent.id)) {
      return c.json({ error: 'forbidden', code: 'forbidden' }, 403);
    }
    const scope = resolveAgentWorkspaceScope({
      ctx,
      principal,
      workspaces,
      agentId: agent.id,
      workspaceId: c.req.query('workspace_id'),
    });
    if (!scope.ok) {
      return c.json({ error: scope.message, code: scope.code }, scope.status);
    }
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const tree = await dispatchAgentWorkspaceTree(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      {
        agent_id: agent.id,
        ...(scope.workspaceId ? { workspace_id: scope.workspaceId } : {}),
      },
    );
    if (tree.kind === 'failed') {
      return c.json({ error: tree.message, code: tree.code }, tree.status);
    }
    return c.json({ tree: tree.result.tree });
  });

  app.get(apiPaths.agentWorkspaceFile(':id'), async c => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'agent id required' }, 400);
    const agent = agents.get(id);
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    const principal = getUserPrincipal(c);
    if (!canViewAgent(ctx, principal, agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    // #task:1219 — agent files (L1/home + L2) are owner-private. The
    // `canViewAgent` gate above is the anti-enumeration outer door (a
    // total stranger gets 404 and can't tell the agent exists); a
    // co-workspace member who is NOT the owner clears it but must still
    // be refused here. Mirrors the sibling owner-gated surfaces (raw
    // MCP config, schedules). 403 is the honest "you're not the owner"
    // surface the renderer renders as a neutral private empty state.
    if (!canViewAgentFiles(ctx, principal, agent.id)) {
      return c.json({ error: 'forbidden', code: 'forbidden' }, 403);
    }
    const scope = resolveAgentWorkspaceScope({
      ctx,
      principal,
      workspaces,
      agentId: agent.id,
      workspaceId: c.req.query('workspace_id'),
    });
    if (!scope.ok) {
      return c.json({ error: scope.message, code: scope.code }, scope.status);
    }
    // The query param is the only piece of caller-supplied input that
    // crosses the wire. The backend does NO shape work on it — the
    // daemon's `parseAndResolveVirtualPath` is the single security
    // boundary, and double-validation here would just add a second
    // place for a bug to live. Empty string is rejected by the
    // intent's wire schema (path: z.string().min(1)); we surface that
    // pre-flight as a clean 400 so the renderer doesn't pay a daemon
    // round-trip for an obvious typo.
    const path = c.req.query('path');
    if (!path) {
      return c.json({ error: 'path query param is required', code: 'forbidden_path' }, 400);
    }
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const file = await dispatchAgentWorkspaceFileRead(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      {
        agent_id: agent.id,
        path,
        ...(scope.workspaceId ? { workspace_id: scope.workspaceId } : {}),
      },
    );
    if (file.kind === 'failed') {
      return c.json({ error: file.message, code: file.code }, file.status);
    }
    return c.json({ file: file.result.file });
  });

  // #task:1135 — agent-pane "Profile MCP" section: read the agent's L1
  // `mcp.json` through the same data-plane dispatch the CLI `profile mcp get`
  // uses, so embedded + remote daemons share one path. Returns
  // `{ raw: string | null }` — null is the normal "no MCP configured" case
  // (NOT a 404), so the pane renders an empty state instead of an error.
  //
  // Gate (Cindy #task:1135 review, Blocker 1): raw `mcp.json` can carry
  // secrets (env tokens, HTTP auth headers). `canViewAgent` gates a
  // same-workspace teammate IN (anti-enumeration / existence), but reading
  // raw secrets requires `canEditAgent` — the creator/self branch, same
  // bar as editing the agent. A viewer who is not the editor gets 403, not
  // the raw bytes. "We don't censor secrets" means we don't inspect the
  // owner's own file, NOT that any viewer may read it.
  app.get(apiPaths.agentProfileMcp(':id'), async c => {
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
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const mcp = await dispatchAgentProfileMcpRead(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      { agent_id: agent.id },
    );
    if (mcp.kind === 'failed') {
      return c.json({ error: mcp.message, code: mcp.code }, mcp.status);
    }
    return c.json({ raw: mcp.result.raw });
  });

  // #task:1137 — public probe mirror for the agent pane (Test connection /
  // List tools). Same gate as the raw read: canViewAgent (404 anti-enum) THEN
  // canEditAgent (403) — a probe connects to the user's endpoint with their
  // secrets, so a non-editor viewer must not trigger it. The daemon opens a
  // one-shot connection and closes it; the connection's own success/failure is
  // the `McpProbeResult` body (200), only host-transport faults are HTTP errors.
  app.post(apiPaths.agentProfileMcpProbe(':id'), async c => {
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
    const body = await c.req.json().catch(() => ({}));
    const parsed = McpProbeRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'invalid input', code: 'invalid_input', issues: parsed.error.issues },
        400,
      );
    }
    const outbound = resolveOutboundForHost(
      ctx.outboundFrameAdapter?.() ?? null,
      agent.host_id,
    );
    if (outbound.kind === 'failed') {
      return c.json({ error: outbound.message, code: outbound.code }, outbound.status);
    }
    const probe = await dispatchMcpProbe(
      outbound.adapter,
      agent.host_id,
      outbound.connectionId,
      {
        source: { kind: 'profile', agent_id: agent.id },
        server_name: parsed.data.server_name,
        include_tools: parsed.data.include_tools,
      },
    );
    if (probe.kind === 'failed') {
      return c.json({ error: probe.message, code: probe.code }, probe.status);
    }
    return c.json(probe.result);
  });

  app.get('/api/agents/:id/runtime-state', c => {
    const agent = agents.get(c.req.param('id'));
    if (!agent) return c.json({ error: 'agent not found' }, 404);
    if (!canViewAgent(ctx, getUserPrincipal(c), agent.id)) {
      return c.json({ error: 'agent not found' }, 404);
    }
    // Two scopes of the same runtime data (#task:1398):
    //  - `conversation_agents` = COMPLETE control view (includes archived).
    //    The Header Stop button + AgentView membership gate read this, so a
    //    best-effort-stop straggler in an archived channel stays reachable.
    //  - `visible_conversation_agents` = DISPLAY roster (excludes archived),
    //    read only by the Activity pane. Filtering the *whole* response would
    //    gate the Stop control on display scope — a fail-closed leak.
    // Both arrays are SEATS with display coordinates attached, so a seat whose
    // conversation carries no workspace (a DM, an inbox) is present here with
    // null workspace fields rather than dropped. Stop-all (below) and the
    // delete-agent purge take the coordinate-free `runtimeSlots.listSeats`
    // instead — they act on the session, not on where it is displayed.
    return c.json({
      conversation_agents: agents.listRuntimeConversations(agent.id),
      visible_conversation_agents: agents.listRuntimeConversations(agent.id, {
        excludeArchived: true,
      }),
    });
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

  // POST /stop — hard-stop every running semantic slot for this agent:
  // one aggregate-owned AgentSlot, or each live ConversationSlot. Returns the
  // count actually stopped. No-op (200 with stopped: 0) when none is live.
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
    // Bulk stop variant. Per-conversation errors must surface as a typed response — the
    // pre-round-2 implementation swallowed every `.catch(warn)` and
    // returned `{ stopped: live.length }` even when every underlying
    // `runtime_stop` actually failed (e.g. standalone + no daemon →
    // every call throws `HostWsCommandTransportError('transport_no_connection')`
    // → silent 200 success). That violates the "no silent no-op" contract.
    //
    // Semantics (post-fix):
    //   - `live.length === 0` → 200 `{ stopped: 0 }` (true no-op).
    //   - All calls succeeded → 200 `{ stopped: <count> }` (unchanged
    //     happy path).
    //   - All calls failed with a typed
    //     placement/transport-no-connection error → surface that error
    //     via `placementErrorResponse` (503 `host_attach_pending` /
    //     409 `local_host_unbound` / etc.).
    //   - All calls failed with non-typed errors → 500 with
    //     `{ stopped: 0, error: <first message> }`.
    //   - Mixed (some succeeded, some failed) → log each failure +
    //     return 200 `{ stopped: <success count> }`. Partial success
    //     stays a 200 because the bulk endpoint historically reports
    //     a count, not all-or-nothing; the unsuccessful conversations
    //     stay in `status='active'` and the user can retry.
    // ONE read for both scopes: the slot table already discriminates them
    // (`conversation_id IS NULL` is the AgentSlot), so the seat face answers
    // "what is running for this agent" without the caller re-deriving the scope
    // from `agents.session_scope` — and without a roster or a workspace join,
    // which is what let a DM session keep running with nothing able to stop it.
    const stops = runtimeSlots
      .listSeats(id)
      .filter(seat => seat.status === 'starting' || seat.status === 'active')
      .map(seat => ({
        // The coordinate comes OUT of the seat's identity; an AgentSlot has
        // none, and `stop` takes `null` for exactly that case.
        conversationId:
          seat.scope.kind === 'conversation' ? seat.scope.conversationId : null,
        scope: seat.scope,
      }));
    if (stops.length === 0) {
      return c.json({ stopped: 0 });
    }
    const settled = await Promise.allSettled(
      // The scope comes from the SLOT being stopped, not from the agent's
      // configured `session_scope`: the row is what is actually running, and
      // asking the agent again would re-derive a fact the read already carried.
      stops.map(stop =>
        ctx.runtimeHost.stop(
          stop.conversationId,
          id,
          stop.scope.kind === 'agent' ? { runtimeScope: stop.scope } : undefined,
        ),
      ),
    );
    const failures: { conversationId: string | null; err: unknown }[] = [];
    let successCount = 0;
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        successCount += 1;
      } else {
        failures.push({
          conversationId: stops[idx]!.conversationId,
          err: r.reason,
        });
        ctx.logger.warn(
          { conversationId: stops[idx]!.conversationId, agentId: id, err: r.reason },
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

  // DELETE /api/agents/:id — destructive cascade. The full saga
  // (materialization dispatch, hard-stop, fail-closed daemon purge,
  // membership/conversation teardown, DM sweep, row delete) lives in the
  // `deleteAgent` use case (application/delete-agent.ts). This route is
  // parse-body + principal + map the typed DeleteAgentResult to HTTP. The
  // `confirm:true` guard is enforced inside the use case's active branch so a
  // failed row + malformed body stays 204 (not 400).
  app.delete('/api/agents/:id', async c => {
    const body = await c.req.json().catch(() => ({}));
    const result = await deleteAgent(
      {
        ctx,
        teardown: agentTeardown,
        deletionRunner: deps.agentDeletionRunner,
      },
      {
        agentId: c.req.param('id'),
        requesterUserId: getUserPrincipal(c).userId,
        body,
        retry: c.req.query('retry') === 'true',
      },
    );
    switch (result.kind) {
      case 'deleted':
      case 'notFound':
        return c.body(null, 204);
      case 'forbidden':
        return c.json({ error: 'forbidden' }, 403);
      case 'pendingInFlight':
        return c.json(
          {
            error: 'an in-flight materialize for this agent is still pending; wait for it to complete (or for the §5 boot reconciler to mark it failed) before deleting',
            code: 'materialization_in_progress',
          },
          409,
        );
      case 'deletionInProgress':
        return c.json(
          {
            error: 'agent deletion is already in progress',
            code: 'agent_deletion_in_progress',
          },
          409,
        );
      case 'deletionPendingRetry':
        return c.json(
          { error: result.error, code: 'agent_deletion_pending_retry' },
          202,
        );
      case 'confirmRequired':
        return c.json(
          { error: 'confirm flag required', detail: 'pass {"confirm": true}' },
          400,
        );
      default: {
        const _exhaustive: never = result;
        throw new Error(
          `unhandled DeleteAgentResult: ${JSON.stringify(_exhaustive)}`,
        );
      }
    }
  });

  return app;
}
