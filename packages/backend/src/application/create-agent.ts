import {
  type AgentDto,
  type AgentRow,
  type CreateAgentInput,
  runtimeDefaultModel,
  systemSubtype,
} from '@silverhand/shared';
import { agentHomeWorkspaceId } from '../repos/workspace-repo.js';
import type { BackendContext } from '../context.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { OutboundFrameAdapter } from '../runtime/outbound-frame-adapter.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import { isParticipantHandleAvailable } from './name-availability.js';
import type { PostCommitEffect } from './post-commit.js';

/**
 * CreateAgent provisioning saga.
 *
 * Owns the whole `POST /api/agents` orchestration that previously lived in
 * the route body + the `d3*`/`d5*` route helpers: idempotency dispatch,
 * fresh-create placement/name/online/reserve, the shared materialize
 * (wire intent → §6.5 ack cross-check → L3a dependent-row transaction →
 * L3b compensation), and the post-commit deliver/auto-start effects.
 *
 * HTTP-agnostic by construction (spec §1.1 / §4): it returns a typed
 * {@link CreateAgentResult} carrying domain codes only; the route maps result
 * kind → HTTP status + body. The use case never imports Hono `Context` and
 * never builds a `Response`. External effects (runtime deliver + start) are
 * collected as fire-and-forget closures on the `created` result and drained by
 * the route AFTER the L3a commit (spec §5/§5.1).
 *
 * Unit-of-work is explicit in three independent better-sqlite3 transactions
 * (spec §5 note / §2.2): the reserve INSERT, the L3a dependent-row tx
 * (`insertProvisioningDependents`), and the L3b compensation UPDATE
 * (`markMaterializationFailed`) — the last MUST stay outside the rolling-back
 * L3a tx, else a rollback would erase the failed stamp and strand the row at
 * `pending_materialization`.
 */

export type CreateAgentDeps = {
  ctx: BackendContext;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  users: UserRepo;
};

export type CreateAgentCommand = {
  input: CreateAgentInput;
  idempotencyKey: string;
  retry: boolean;
  creatorUserId: string;
};

/** The fresh-L4 4-field payload returned on `created` / echoed on `echo`. */
export type CreateAgentSuccess = {
  agent: AgentDto;
  agentHomeWorkspaceId: string;
  dmChannelId: string;
  onboardingMessageId: string;
};

/**
 * Domain failure codes for a failed `agent_materialize` dispatch. Status
 * mapping lives in the route (`mapAgentCreateFailureToStatus`); keeping this a
 * literal union lets that mapper be exhaustively checked (spec §9 constraint ①).
 */
export type AgentMaterializeFailureCode =
  | 'daemon_internal_error'
  | 'host_attach_pending'
  | 'materialize_timeout'
  | 'dependent_row_insert_failed'
  | 'agent_dir_collision'
  | 'fs_quota_exceeded'
  | 'fs_unavailable'
  | 'unsupported_template'
  | 'unsupported_runtime'
  | 'daemon_shutting_down';

export type CreateAgentResult =
  | { kind: 'created'; payload: CreateAgentSuccess; effects: PostCommitEffect[] }
  | { kind: 'echo'; payload: CreateAgentSuccess }
  | { kind: 'inProgress' }
  | { kind: 'previouslyFailed'; failedCode: string | null; failedAt: number | null }
  | { kind: 'metadataMismatch'; field: string }
  | { kind: 'retryTargetNotFound' }
  | { kind: 'retryTargetNotFailed' }
  | { kind: 'corruptGraph'; message: string }
  | { kind: 'nameTaken'; message: string }
  | { kind: 'placementError'; err: unknown }
  | { kind: 'hostAttachPending' }
  | { kind: 'materializeFailed'; failedCode: AgentMaterializeFailureCode; message: string };

// ── Idempotency metadata snapshot (§3.2 / §6.1 mismatch check) ─────────
//
// Design §6.1 step 4 lists six fields:
// `(name, runtime, model, description, template_choice, host_id)`. D2 ships
// only `template_choice='default'`; the route forces it server-side, so that
// axis is trivially equal on every retry. `host_id` mismatch compares the
// STORED host to the REQUEST's literal `host_id` ONLY when the body provided
// one — a same-key retry omitting it means "use whatever the row pinned" and
// never trips the comparator (Cindy D3 round-1 P1: existing-row dispatch must
// NOT call placement).
const METADATA_SNAPSHOT_FIELDS = [
  'name',
  'runtime',
  'model',
  'description',
  'template_choice',
  'host_id',
] as const;
type MetadataSnapshotField = (typeof METADATA_SNAPSHOT_FIELDS)[number];

interface MetadataSnapshot {
  name: string;
  runtime: string;
  model: string | null;
  description: string | null;
  template_choice: string;
  host_id: string;
}

function agentMetadataSnapshot(row: AgentRow): MetadataSnapshot {
  return {
    name: row.name,
    runtime: row.runtime,
    model: row.model ?? null,
    description: row.description ?? null,
    // D2 ships 'default' only; agent row has no column yet.
    template_choice: 'default',
    host_id: row.host_id,
  };
}

function requestMetadataSnapshot(
  input: CreateAgentInput,
  effectiveHostId: string,
): MetadataSnapshot {
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
 * Apply runtime-specific create defaults before any idempotency snapshot,
 * reserve INSERT, or daemon materialize payload is built. Keeping this in
 * the backend write path (not just the desktop form) makes API/CLI creates
 * agree with UI creates. Explicit non-blank `model` still wins; model
 * clearing remains an update-time profile action.
 */
export function normalizeCreateAgentInput(
  input: CreateAgentInput,
): CreateAgentInput {
  if (input.model !== undefined && input.model.trim() !== '') return input;
  const defaultModel = runtimeDefaultModel(input.runtime);
  if (defaultModel === null) return input;
  return { ...input, model: defaultModel };
}

/**
 * First field that differs between stored and requested snapshots, or `null`
 * if every field matches. Order matches {@link METADATA_SNAPSHOT_FIELDS} so the
 * named field is deterministic. Runs unconditionally whenever a same-key row is
 * found, BEFORE the status dispatch (design §6.1 step 4 / Cindy "mismatch
 * BEFORE dispatch" invariant).
 */
function compareIdempotencyMetadata(
  stored: MetadataSnapshot,
  requested: MetadataSnapshot,
): MetadataSnapshotField | null {
  for (const field of METADATA_SNAPSHOT_FIELDS) {
    if (stored[field] !== requested[field]) return field;
  }
  return null;
}

/**
 * Map a typed `agent_materialize` wire error code (carried by
 * {@link HostWsCommandResponseError}) to the domain
 * {@link AgentMaterializeFailureCode} persisted on the row. The HTTP status for
 * each code lives in the route's `mapAgentCreateFailureToStatus` (spec §3.2).
 *
 * Wire codes per `AgentMaterializeErrorCodeSchema` (D2): `agent_dir_collision`,
 * `fs_quota_exceeded`, `fs_unavailable`, `unsupported_template`,
 * `unsupported_runtime`, `internal_error`. Generic codes that can arrive on the
 * materialize arm (`unknown_intent` / `invalid_params` / `internal_error` /
 * `request_too_large`) fold into `daemon_internal_error`; `shutting_down` maps
 * to `daemon_shutting_down`.
 */
function mapDaemonWireErrorToFailureCode(
  err: HostWsCommandResponseError,
): AgentMaterializeFailureCode {
  // Cast: HostWsCommandResponseError narrowly types `code` to the generic
  // 5-enum, but at runtime carries the wider typed codes for
  // `agent_materialize` unchanged from the wire frame.
  const code = err.code as string;
  switch (code) {
    case 'agent_dir_collision':
      return 'agent_dir_collision';
    case 'fs_quota_exceeded':
      return 'fs_quota_exceeded';
    case 'fs_unavailable':
      return 'fs_unavailable';
    case 'unsupported_template':
      return 'unsupported_template';
    case 'unsupported_runtime':
      return 'unsupported_runtime';
    case 'shutting_down':
      return 'daemon_shutting_down';
    default:
      // unknown_intent / invalid_params / internal_error / request_too_large
      // + any future code → catch-all daemon-internal-error.
      return 'daemon_internal_error';
  }
}

const ONBOARDING_DM_CONTENT = (agentName: string): string =>
  [
    `You (@${agentName}) are now in your personal DM with the user.`,
    `Your role contract lives at L1 \`system_prompt.md\`, this computer's authority on who you are; it applies in every workspace on this computer, and edits take effect on the agent's next spawn. This DM also has its own L2 \`MEMORY.md\` / \`notes/\` for memory that stays here.`,
    `Send one short greeting: say hi by name, state your current global role briefly (or say it is not defined yet), and ask what role the user would like you to play. Write by scope: global identity / role / working-style guidance → update L1 \`system_prompt.md\`; DM-local notes → update this DM's \`MEMORY.md\` / \`notes/\`. Do not mention internal file paths to the user unless they ask.`,
  ].join('\n');

/**
 * L3a — flip→active + dependent-row graph in a single transaction. On any
 * failure the whole graph rolls back; the caller's catch runs
 * `markMaterializationFailed` in a SEPARATE tx (spec §2.2). Returns the
 * inserted records so the post-commit effects have the IDs they need.
 */
function insertProvisioningDependents(
  deps: CreateAgentDeps,
  agentRow: AgentRow,
  creatorUserId: string,
): {
  home: ReturnType<WorkspaceRepo['insertAgentHome']>;
  dm: ReturnType<ConversationRepo['insertDmChannel']>;
  onboardingMsg: ReturnType<MessageRepo['insertForConversation']>;
} {
  const { ctx, agents, workspaces, conversations, messages } = deps;
  return ctx.db.transaction(() => {
    agents.flipToActive(agentRow.id);
    // `insertAgentHome` reads the `AgentDto` shape — re-project from the
    // post-flip row.
    const flipped = agents.get(agentRow.id);
    if (!flipped) throw new Error('row vanished post-flip');
    const home = workspaces.insertAgentHome({
      agent: flipped,
    });
    const dm = conversations.insertDmChannel({
      workspaceId: home.id,
      title: 'Onboarding',
      agentId: agentRow.id,
    });
    conversations.addAgent(dm.id, agentRow.id);
    // v40 (graded-permissions): the human who creates an agent owns its home.
    workspaces.addUserMember(home.id, creatorUserId, 'owner');
    workspaces.setOwnerUserId(home.id, creatorUserId);
    conversations.addUser(dm.id, creatorUserId);
    const onboardingMsg = messages.insertForConversation({
      conversationId: dm.id,
      fromKind: 'system',
      content: ONBOARDING_DM_CONTENT(agentRow.name),
      metadata: { subtype: systemSubtype('onboarding') },
    });
    return { home, dm, onboardingMsg };
  })();
}

type MaterializeOutcome =
  | { kind: 'ok'; inserted: ReturnType<typeof insertProvisioningDependents> }
  | { kind: 'failed'; failedCode: AgentMaterializeFailureCode; message: string };

/**
 * Shared L2/L3a/L3b dispatch from a row already in `pending_materialization`,
 * used by both fresh-create (after reserve) and retry (after the failed→pending
 * flip). The reserved row's stored metadata — not the request body — is the
 * wire payload source of truth. On failure runs `markMaterializationFailed`
 * (a single UPDATE, its own implicit tx, outside the L3a tx) and returns the
 * domain failure code + the underlying error message (spec §3.2b body fidelity).
 */
async function materializeReservedAgent(
  deps: CreateAgentDeps,
  args: {
    reservedRow: AgentRow;
    controller: OutboundFrameAdapter;
    connectionId: string;
    creatorUserId: string;
  },
): Promise<MaterializeOutcome> {
  const { ctx, agents } = deps;
  const { reservedRow, controller, connectionId, creatorUserId } = args;

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
    // L3b — markMaterializationFailed in a SEPARATE tx (Cindy D2 invariant
    // #3 / §2.2). For retry this OVERWRITES the previous failure stamp with
    // this attempt's code/at (Cindy D5 guard rail #2). `flipToFailed` is one
    // UPDATE outside any wrapping tx so concurrent rollback cannot remove it.
    const now = Date.now();
    let failedCode: AgentMaterializeFailureCode;
    if (err instanceof HostWsCommandResponseError) {
      failedCode = mapDaemonWireErrorToFailureCode(err);
    } else if (err instanceof HostWsCommandTransportError) {
      if (
        err.code === 'transport_no_connection' ||
        err.code === 'transport_disconnected'
      ) {
        failedCode = 'host_attach_pending';
      } else if (err.code === 'transport_timeout') {
        failedCode = 'materialize_timeout';
      } else {
        failedCode = 'daemon_internal_error';
      }
    } else {
      ctx.logger.error(
        { err, agentId: reservedRow.id },
        'unexpected error during agent_materialize dispatch',
      );
      failedCode = 'daemon_internal_error';
    }
    agents.flipToFailed(reservedRow.id, failedCode, now);
    return {
      kind: 'failed',
      failedCode,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // §6.5 cross-check: daemon ack invariant (agent_dir must equal
  // agent_home_workspace_path; defense-in-depth keeps the route honest).
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
    };
  }

  // ── L3a flip-active + dependent rows tx ───────────────────────
  let inserted: ReturnType<typeof insertProvisioningDependents>;
  try {
    inserted = insertProvisioningDependents(
      deps,
      reservedRow,
      creatorUserId,
    );
  } catch (err) {
    ctx.logger.error(
      { err, agentId: reservedRow.id },
      'L3a dependent-row insert tx failed; flipping to failed',
    );
    agents.flipToFailed(reservedRow.id, 'dependent_row_insert_failed', Date.now());
    return {
      kind: 'failed',
      failedCode: 'dependent_row_insert_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: 'ok', inserted };
}

/**
 * Post-commit best-effort effects (spec §5.1). Each closure is self-catching,
 * so draining them adds no response latency and `start` is NOT serialized
 * behind `deliver`. Order is announce → deliver → start. Only the `created`
 * arms build these effects (echo / failure never do) and the drain runs after
 * the L3a commit, so the identity announce fires exactly once per genuine
 * creation.
 */
function buildPostCommitEffects(
  deps: CreateAgentDeps,
  dmId: string,
  agentId: string,
  onboardingMessageId: string,
): PostCommitEffect[] {
  const { ctx } = deps;
  return [
    () => {
      // Announce the freshly materialized agent so every already-open
      // app-scope viewer converges its directory + identity carriers without
      // a remount — the mirror of `UserService.publishChanged`, since human
      // and agent are isomorphic actors. Id-only payload (client re-reads the
      // authority); contract on `AgentChangedEventSchema` (#task:1707).
      ctx.events.publishToScope('app', 'agent_changed', { agent_id: agentId });
    },
    () => {
      ctx.runtimeHost
        .deliverMessage(dmId, agentId, onboardingMessageId)
        .catch(err =>
          ctx.logger.error(
            { conversationId: dmId, agentId, err },
            'onboarding message deliver failed (post-commit best-effort)',
          ),
        );
    },
    () => {
      ctx.runtimeHost
        .start(dmId, agentId)
        .catch(err =>
          ctx.logger.error(
            { conversationId: dmId, agentId, err },
            'dm onboarding spawn failed (post-commit best-effort)',
          ),
        );
    },
  ];
}

function successFromInserted(
  deps: CreateAgentDeps,
  agentId: string,
  inserted: ReturnType<typeof insertProvisioningDependents>,
): CreateAgentSuccess {
  return {
    agent: deps.agents.get(agentId)!,
    agentHomeWorkspaceId: inserted.home.id,
    dmChannelId: inserted.dm.id,
    onboardingMessageId: inserted.onboardingMsg.id,
  };
}

/**
 * Idempotency dispatch for a same-key existing row (spec §3.3). Runs the
 * metadata mismatch check FIRST (Invariant 1), then dispatches on
 * `materialization_status`. Returns a terminal {@link CreateAgentResult} for
 * every arm EXCEPT the `failed` + `retry` case, which returns
 * `{ proceed: true, rowToRetry, controller, connectionId }` to signal the
 * caller should run the shared materialize.
 */
function resolveIdempotentCreateOutcome(
  deps: CreateAgentDeps,
  args: { existingRow: AgentRow; input: CreateAgentInput; retry: boolean },
):
  | { done: true; result: CreateAgentResult }
  | {
      done: false;
      rowToRetry: AgentRow;
      controller: OutboundFrameAdapter;
      connectionId: string;
    } {
  const { ctx, agents, conversations, messages } = deps;
  const { existingRow, input, retry } = args;

  const mismatchField = compareIdempotencyMetadata(
    agentMetadataSnapshot(existingRow),
    requestMetadataSnapshot(input, input.host_id ?? existingRow.host_id),
  );
  if (mismatchField !== null) {
    return { done: true, result: { kind: 'metadataMismatch', field: mismatchField } };
  }

  switch (existingRow.materialization_status) {
    case 'active': {
      // 200 echo — re-derive the fresh-L4 4-field payload from the graph.
      const dm = conversations.findDmChannelForAgent(existingRow.id);
      if (!dm) {
        ctx.logger.error(
          { agentId: existingRow.id },
          'active agent has no DM channel — invariant violated by external mutation',
        );
        return {
          done: true,
          result: { kind: 'corruptGraph', message: 'agent state inconsistent' },
        };
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
        return {
          done: true,
          result: { kind: 'corruptGraph', message: 'agent state inconsistent' },
        };
      }
      return {
        done: true,
        result: {
          kind: 'echo',
          payload: {
            agent: agents.get(existingRow.id)!,
            agentHomeWorkspaceId: agentHomeWorkspaceId(existingRow.id),
            dmChannelId: dm.id,
            onboardingMessageId: onboarding.id,
          },
        },
      };
    }
    case 'pending_materialization':
      return { done: true, result: { kind: 'inProgress' } };
    case 'failed': {
      if (!retry) {
        return {
          done: true,
          result: {
            kind: 'previouslyFailed',
            failedCode: existingRow.materialization_failed_code,
            failedAt: existingRow.materialization_failed_at,
          },
        };
      }
      // ── L1 (retry) — online check BEFORE flipping the row (Cindy D5
      // guard rail #2: do not bounce failed → pending when offline).
      const controller = ctx.outboundFrameAdapter?.();
      const connectionId = controller?.connectionIdForHost(existingRow.host_id) ?? null;
      if (!controller || !connectionId) {
        return { done: true, result: { kind: 'hostAttachPending' } };
      }
      // Daemon attached — flip failed → pending atomically. The helper's
      // `WHERE status='failed'` guard handles the race where a sibling
      // mutation flipped the row out from under us.
      const flipped = agents.flipFailedToReserveAgain(existingRow.id);
      if (!flipped) {
        return { done: true, result: { kind: 'retryTargetNotFailed' } };
      }
      const rowToRetry = agents.getRow(existingRow.id);
      if (!rowToRetry) {
        ctx.logger.error(
          { agentId: existingRow.id },
          'agent row vanished between flipFailedToReserveAgain and re-read; treating as internal error',
        );
        return {
          done: true,
          result: { kind: 'corruptGraph', message: 'agent row vanished post-flip' },
        };
      }
      return { done: false, rowToRetry, controller, connectionId };
    }
  }
}

export async function createAgent(
  deps: CreateAgentDeps,
  cmd: CreateAgentCommand,
): Promise<CreateAgentResult> {
  const { ctx, agents, users } = deps;
  const { idempotencyKey, retry, creatorUserId } = cmd;
  const input = normalizeCreateAgentInput(cmd.input);

  // L0.3 — idempotency lookup (creator-scoped via the v33 partial unique
  // index; cross-creator collisions are impossible at SQL).
  const existingRow = agents.findByIdempotencyKey(creatorUserId, idempotencyKey);

  // L0.4/L0.5 — existing-row dispatch (mismatch FIRST, then status).
  if (existingRow) {
    const dispatch = resolveIdempotentCreateOutcome(deps, {
      existingRow,
      input,
      retry,
    });
    if (dispatch.done) return dispatch.result;
    // Retry path: materialize the freshly re-reserved row.
    const retryResult = await materializeReservedAgent(deps, {
      reservedRow: dispatch.rowToRetry,
      controller: dispatch.controller,
      connectionId: dispatch.connectionId,
      creatorUserId,
    });
    if (retryResult.kind === 'failed') {
      return {
        kind: 'materializeFailed',
        failedCode: retryResult.failedCode,
        message: retryResult.message,
      };
    }
    return {
      kind: 'created',
      payload: successFromInserted(deps, dispatch.rowToRetry.id, retryResult.inserted),
      effects: buildPostCommitEffects(
        deps,
        retryResult.inserted.dm.id,
        dispatch.rowToRetry.id,
        retryResult.inserted.onboardingMsg.id,
      ),
    };
  }

  // L0.6 — `?retry=true` with no existing row is client misuse.
  if (retry) {
    return { kind: 'retryTargetNotFound' };
  }

  // ── L0.7 — fresh attempt. Placement / name / online / reserve run here.
  let resolvedHostId: string;
  try {
    resolvedHostId = input.host_id
      ? ctx.placement.assertOwnedActiveHost(input.host_id, creatorUserId).id
      : ctx.placement.resolveOwnedReadyForPlacement(creatorUserId).id;
  } catch (err) {
    return { kind: 'placementError', err };
  }

  // Name uniqueness check — SHARED predicate with the name-availability probe
  // endpoint (`isParticipantHandleAvailable`): agent names are the global @-handle
  // namespace shared with human users, so this rejects a name colliding with a
  // user handle too (previously only `agents` was checked and a user-collision
  // tripped the DB trigger instead of returning a clean `nameTaken`).
  if (!isParticipantHandleAvailable({ agents, users }, input.name)) {
    return { kind: 'nameTaken', message: 'agent name already exists' };
  }

  // Controller online check BEFORE reserve (§6.2: no row reserved when daemon
  // offline). The captured `connectionId` locks the check → dispatch window.
  const controller = ctx.outboundFrameAdapter?.();
  const connectionId = controller?.connectionIdForHost(resolvedHostId) ?? null;
  if (!controller || !connectionId) {
    return { kind: 'hostAttachPending' };
  }

  // Evidence-generation custody (P1-4): re-confirm the SAME generation is still
  // attached before any write. The catalog round-trip can take up to 45s; if
  // the daemon reconnected in that window the captured `connectionId` is stale,
  // so we fail BEFORE reserving a row / materializing on a dead generation
  // rather than committing a proof gathered on the old generation to the new
  // one. `connectionId` is generation-unique, so equality is a true
  // same-generation check.
  if (controller.connectionIdForHost(resolvedHostId) !== connectionId) {
    return { kind: 'hostAttachPending' };
  }

  // ── L1 reserve ─────────────────────────────────────────────────
  let reservedRow: AgentRow;
  try {
    reservedRow = agents.reserveForMaterialize(
      input,
      resolvedHostId,
      creatorUserId,
      idempotencyKey,
    );
  } catch (err) {
    ctx.logger.warn(
      { err, agentName: input.name, idempotencyKey },
      'reserveForMaterialize INSERT failed',
    );
    return {
      kind: 'nameTaken',
      message: 'agent reservation conflict; retry with a fresh key',
    };
  }

  const freshResult = await materializeReservedAgent(deps, {
    reservedRow,
    controller,
    connectionId,
    creatorUserId,
  });
  if (freshResult.kind === 'failed') {
    return {
      kind: 'materializeFailed',
      failedCode: freshResult.failedCode,
      message: freshResult.message,
    };
  }
  return {
    kind: 'created',
    payload: successFromInserted(deps, reservedRow.id, freshResult.inserted),
    effects: buildPostCommitEffects(
      deps,
      freshResult.inserted.dm.id,
      reservedRow.id,
      freshResult.inserted.onboardingMsg.id,
    ),
  };
}
