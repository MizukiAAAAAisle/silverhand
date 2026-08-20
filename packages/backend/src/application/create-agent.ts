import {
  type AgentDto,
  type AgentRow,
  type CreateAgentInput,
  formatReferenceToken,
  inlineCode,
  runtimeDefaultModel,
  fixedConversationTitle,
  systemSubtype,
} from '@silverhand/shared';
import { agentHomeWorkspaceId } from '../repos/workspace-repo.js';
import type { BackendLogger } from '../context.js';
import type { RuntimeHostPlacementControl } from '../runtime/host-placement.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ConversationRepo } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { OutboundFrameAdapter } from '../runtime/outbound-frame-adapter.js';
import type {
  AgentMessageDeliveryPort,
  AgentRuntimeStartPort,
} from '../runtime/agent-runtime-host.js';
import type { ScopeEventPublisher } from '../ws/scope-event-bus.js';
import type {
  AgentProvisioningPersistence,
} from './agent-provisioning-ports.js';
import {
  HostWsCommandResponseError,
  HostWsCommandTransportError,
} from '../ws/host-ws-server.js';
import { isParticipantHandleAvailable } from './name-availability.js';
import {
  publishDirectPairsChangedToViewer,
  recordDirectPairOpens,
} from './direct-pairs-changed.js';
import { openDirectPair } from './open-direct-pair.js';
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
 * Unit-of-work is explicit in three independent transactions (spec §5 note /
 * §2.2): the reserve INSERT, the L3a dependent-row tx
 * (`insertProvisioningDependents`, via the injected
 * {@link AgentProvisioningPersistence} scope — no raw `Db` here), and the L3b
 * compensation UPDATE (`markMaterializationFailed`) — the last MUST stay
 * outside the rolling-back L3a tx, else a rollback would erase the failed
 * stamp and strand the row at `pending_materialization`.
 */

/**
 * Narrow ambient deps for the create-agent use case (#task:1990). No ambient
 * `BackendContext`: it structurally carries `db`, and this use case must not
 * hold raw DB capability. Each field is an independent NAMED port (one
 * capability per port) so sibling use cases (#1987 D) can reuse the exact
 * subset they need without a second decomposition; the composition root
 * (routes.ts) satisfies them from the context.
 */
export type CreateAgentDeps = {
  logger: BackendLogger;
  /** Narrow event face: the app-scope `agent_changed` announce only. */
  events: ScopeEventPublisher;
  /** Narrow runtime face: the two post-commit best-effort effects only. */
  runtimeHost: AgentMessageDeliveryPort & AgentRuntimeStartPort;
  outboundFrameAdapter?: () => OutboundFrameAdapter | null;
  placement: RuntimeHostPlacementControl;
  agents: AgentRepo;
  workspaces: WorkspaceRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  users: UserRepo;
  /** Transaction-scoped provisioning persistence (the L3a dependent graph). */
  agentProvisioning: AgentProvisioningPersistence;
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
  agentHomeWorkspaceId: string | null;
  dmChannelId: string | null;
  onboardingMessageId: string | null;
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
  'session_scope',
] as const;
type MetadataSnapshotField = (typeof METADATA_SNAPSHOT_FIELDS)[number];

interface MetadataSnapshot {
  name: string;
  runtime: string;
  model: string | null;
  description: string | null;
  template_choice: string;
  host_id: string;
  session_scope: 'agent' | 'conversation';
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
    session_scope: row.session_scope,
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
    session_scope: input.session_scope ?? 'conversation',
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

/**
 * AgentSlot onboarding (#task:2034, destination changed by #task:2072). Lands in
 * the agent's DIRECT LINE WITH ITS CREATOR — a `direct_pair` whose two endpoints
 * are that human and this agent — so the greeting it asks for is a REPLY IN
 * PLACE, not an outbound send to an address: the runtime is woken on this very
 * conversation, so the shortest correct instruction is "answer here". That is
 * why this no longer teaches the `dm:@<handle>` target grammar; teaching a
 * target for the stream the agent is already standing in would be the same
 * mistake as the inbox it replaced, where the text had to route AROUND a
 * destination no person reads.
 *
 * It still cannot borrow the ConversationSlot text below: an agent-scoped agent
 * has no home workspace and no personal DM CHANNEL, and this line is shared with
 * exactly one person rather than being the agent's own space.
 *
 * Memory layout is deliberately NOT re-taught here: the AgentSlot prompt already
 * carries the authoritative L1 path and states that workspace L2 does not exist
 * in this context, so a second statement of the same rule is only a place for
 * the two to drift. Both interpolations are handles — a constrained shape, not
 * free text — so the reference tokens cannot fabricate structure.
 */
const ONBOARDING_DIRECT_LINE_CONTENT = (
  agentName: string,
  creatorHandle: string,
): string =>
  [
    `You (${formatReferenceToken({ kind: 'agent', handle: agentName })}) have just been created as an agent-scoped agent: one session of you serves every conversation you are in, and this stream is your direct line with the person who created you (${formatReferenceToken({ kind: 'human', handle: creatorHandle })}) — they are the only other participant here.`,
    `Send one short greeting in THIS conversation: say hi by name, state your current global role briefly (or say it is not defined yet), and ask what role they would like you to play.`,
    `Write global identity / role / working-style guidance to your L1 ${inlineCode('system_prompt.md')} once they answer; it applies in every conversation and takes effect on your next spawn. Do not mention internal file paths to the user unless they ask.`,
  ].join('\n');

const ONBOARDING_DM_CONTENT = (agentName: string): string =>
  [
    // Canonical reference, not the plain `@name` alias (#task:2000): a
    // server-authored body models the one form that both renders and delivers.
    `You (${formatReferenceToken({ kind: 'agent', handle: agentName })}) are now in your personal DM with the user.`,
    `Your role contract lives at L1 \`system_prompt.md\`, this computer's authority on who you are; it applies in every workspace on this computer, and edits take effect on the agent's next spawn. This DM also has its own L2 \`MEMORY.md\` / \`notes/\` for memory that stays here.`,
    `Send one short greeting: say hi by name, state your current global role briefly (or say it is not defined yet), and ask what role the user would like you to play. Write global identity / role / working-style guidance to L1 \`system_prompt.md\`. Use this DM's L2 only for durable, DM-specific knowledge absent from the codebase, task board, and channel/thread history. Do not mention internal file paths to the user unless they ask.`,
  ].join('\n');

/**
 * Thrown when the provisioning conditional transition loses to a concurrent
 * writer: the row is no longer `pending_materialization` (another request
 * failed it under its own stamp, activated it, or removed it). This is
 * DISTINCT from a genuine dependent-row failure: the row's terminal state is
 * authoritative, so the L3b compensation must NOT overwrite it with our
 * `dependent_row_insert_failed`. The caller re-reads and reports the winner's
 * state instead.
 */
class ProvisioningEligibilityLostError extends Error {
  constructor() {
    super('agent provisioning eligibility lost to a concurrent transition');
  }
}

/**
 * L3a — flip→active + dependent-row graph in a single transaction. On any
 * failure the whole graph rolls back; the caller's catch runs
 * `markMaterializationFailed` in a SEPARATE tx (spec §2.2) — EXCEPT when the
 * transition itself lost eligibility, which is a different control flow (the
 * winner's state is preserved, never compensated). Returns the inserted records
 * (minimal id projections, R4) so the post-commit effects have the IDs they
 * need.
 *
 * ALL persistence inside the callback comes from the transaction scope — never
 * a captured factory repo (a future pooled adapter would read/write on the
 * wrong connection).
 */
function insertProvisioningDependents(
  deps: Pick<CreateAgentDeps, 'agentProvisioning'>,
  agentRow: AgentRow,
  creatorUserId: string,
  creatorHandle: string,
):
  | {
      kind: 'agent';
      directLine: { id: string };
      openedPairConversationIds: readonly string[];
      onboardingMsg: { id: string };
    }
  | {
      kind: 'conversation';
      home: { id: string };
      dm: { id: string };
      onboardingMsg: { id: string };
    } {
  // The mint's announcement, held as data until this transaction has committed
  // (#task:2072). Assembled here for the same reason the mention CC assembles it
  // at its own boundary: the pair must roll back with the graph, so the frame
  // cannot go out in the same breath — see `recordDirectPairOpens`.
  const opens = recordDirectPairOpens();
  return deps.agentProvisioning.uow.atomically(tx => {
    // Conditional transition FIRST (pending-only): the UPDATE only matches a
    // row that still has eligibility. `lost` means another transition already
    // won (row now failed / active / vanished) — fail closed BEFORE any
    // dependent write, and signal the caller NOT to compensate.
    const outcome = tx.agents.flipToActiveAndGet(agentRow.id);
    if (outcome.status === 'lost') throw new ProvisioningEligibilityLostError();
    const flipped = outcome.row;
    if (flipped.sessionScope === 'agent') {
      // The AGENT arm's whole dependent graph: the creator's direct line with
      // this agent, and the onboarding message in it (#task:2034 destination,
      // #task:2072 carrier). No home, no DM channel, no roster row — a
      // `direct_pair`'s participants ARE its endpoint columns, and `agent_home`
      // is the OTHER scope's model, not a legacy layer to keep building here.
      //
      // MINTED INSIDE this transaction, not beside the reserved row: the line
      // exists only for the message about to be written into it, so a line that
      // outlived a rolled-back graph would be an empty conversation in the
      // creator's DM list. Get-or-create rather than insert because the creator
      // may already have a line with this agent — `?retry=true` re-enters here on
      // the same row, and a mention of the handle while it was still
      // `pending_materialization` already opens exactly this pair.
      //
      // NOT GATED BY `canInitiateDirectMessageToAgent`, and not by an oversight:
      // that gate answers "may this human START contact with an agent", which is
      // a question about reach, and this mint grants none. Its human endpoint IS
      // the row's `created_by_user_id`, already an independent arm of
      // `canViewAgent` — so the pair adds no visibility its creator lacks, unlike
      // the mention CC, where the author is an arbitrary participant and the
      // endpoint would have BEEN the new reach. Nor could the gate be asked
      // honestly at the only point it may run (before the mint): until the flip
      // above commits, the row is `pending_materialization`, which the gate reads
      // as invisible-to-everyone, and asking it AFTER the flip inside this
      // transaction would be a gate reading a status only this uncommitted
      // transaction can see. The one clause with content here — the agent is
      // agent-scoped — is this arm's own condition.
      const directLine = openDirectPair(
        { conversations: tx.conversations, allocations: opens.port },
        { kind: 'human', id: creatorUserId },
        { kind: 'agent', id: agentRow.id },
        agentRow.created_at,
      );
      const onboardingMsg = tx.messages.insertForConversation({
        conversationId: directLine.id,
        fromKind: 'system',
        content: ONBOARDING_DIRECT_LINE_CONTENT(flipped.name, creatorHandle),
        metadata: { subtype: systemSubtype('onboarding') },
      });
      return {
        kind: 'agent',
        directLine,
        // The ids THIS mint created, so the post-commit half can prove it covered
        // them rather than the coverage being a property of whoever wrote this.
        // Empty when the line already existed — the frame says "this row exists",
        // and a caller that did not create it is not the one it came into
        // existence on.
        openedPairConversationIds: [...opens.opened()],
        onboardingMsg,
      };
    }
    const home = tx.workspaces.insertAgentHome({
      agent: flipped,
    });
    const dm = tx.conversations.insertDmChannel({
      workspaceId: home.id,
      // The title IS the address (#task:2016); the home's address space was
      // created empty two statements ago, so this cannot conflict.
      title: fixedConversationTitle('Onboarding'),
      agentId: agentRow.id,
    });
    tx.conversations.addAgent(dm.id, agentRow.id);
    // v40 (graded-permissions): the human who creates an agent owns its home.
    tx.workspaces.addOwnerMember(home.id, creatorUserId);
    tx.workspaces.setOwnerUserId(home.id, creatorUserId);
    tx.conversations.addUser(dm.id, creatorUserId);
    const onboardingMsg = tx.messages.insertForConversation({
      conversationId: dm.id,
      fromKind: 'system',
      content: ONBOARDING_DM_CONTENT(agentRow.name),
      metadata: { subtype: systemSubtype('onboarding') },
    });
    return { kind: 'conversation', home, dm, onboardingMsg };
  });
}

type MaterializeOutcome =
  | { kind: 'ok'; inserted: ReturnType<typeof insertProvisioningDependents> }
  | { kind: 'failed'; failedCode: AgentMaterializeFailureCode; message: string }
  /** Another transition won (row failed/active/vanished under a different
   *  stamp). Do NOT compensate; the caller re-reads the row's actual state. */
  | { kind: 'lost' };

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
  const { logger, agents } = deps;
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
      logger.error(
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
    logger.error(
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
    // The creator's handle, resolved BEFORE the transaction: the agent-scoped
    // onboarding text names the person to greet, and `users.name` IS the
    // mention handle (one identifier, not a display alias). Read here rather
    // than from inside the callback because no tx face exposes users and a
    // captured factory repo must never be read inside an `atomically` block.
    // Absent = a broken actor for an authenticated request; it throws into the
    // catch below and lands as `dependent_row_insert_failed`, which is honest:
    // the graph was not written.
    const creator = deps.users.get(creatorUserId);
    if (!creator) {
      throw new Error(
        `creator user ${creatorUserId} not found while building the onboarding graph`,
      );
    }
    inserted = insertProvisioningDependents(
      deps,
      reservedRow,
      creatorUserId,
      creator.name,
    );
  } catch (err) {
    // Eligibility lost ≠ dependent-row failure. Another transition already won
    // (row failed under ITS code, or active with a graph): compensating here
    // would OVERWRITE the winner's terminal stamp with our
    // dependent_row_insert_failed. Report `lost` — the caller re-reads the row
    // and returns its authoritative state, never compensating the winner.
    if (err instanceof ProvisioningEligibilityLostError) {
      return { kind: 'lost' };
    }
    logger.error(
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
  conversationId: string,
  agentId: string,
  onboardingMessageId: string,
): PostCommitEffect[] {
  const { events, runtimeHost, logger } = deps;
  return [
    () => {
      // Announce the freshly materialized agent so every already-open
      // app-scope viewer converges its directory + identity carriers without
      // a remount — the mirror of `UserService.publishChanged`, since human
      // and agent are isomorphic actors. Id-only payload (client re-reads the
      // authority); contract on `AgentChangedEventSchema` (#task:1707).
      events.publishToScope('app', 'agent_changed', { agent_id: agentId });
    },
    () => {
      runtimeHost
        .deliverMessage(conversationId, agentId, onboardingMessageId)
        .catch(err =>
          logger.error(
            { conversationId, agentId, err },
            'onboarding message deliver failed (post-commit best-effort)',
          ),
        );
    },
    () => {
      runtimeHost
        .start(conversationId, agentId)
        .catch(err =>
          logger.error(
            { conversationId, agentId, err },
            'onboarding spawn failed (post-commit best-effort)',
          ),
        );
    },
  ];
}

/**
 * Both scopes get the SAME three effects, because the onboarding contract is
 * "the agent is woken with a message it must act on" and that is scope-blind
 * (#task:2034). Only the destination differs: the ConversationSlot is woken on
 * its DM channel, the AgentSlot on its direct line with the creator — which is
 * exactly the placement its RuntimeScope resolves a cwd for (#task:2019), so
 * there is no refusal arm to mirror here.
 *
 * The agent arm owes ONE more effect, and it is not a fourth member of the
 * scope-blind contract: a pair this transaction MINTED is a row the creator's DM
 * list is the read surface for, so the frame it was promised at the mint
 * (`recordDirectPairOpens`) is published here — after the commit that made the
 * row durable. Audience is the pair's human endpoint, which IS `creatorUserId`
 * by construction of the mint, not by a roster read. Nothing is published when
 * the line already existed: the frame says "this row exists", and the message
 * that just landed in it publishes its own conversation frame either way.
 */
function postCommitEffectsForInserted(
  deps: CreateAgentDeps,
  agentId: string,
  creatorUserId: string,
  inserted: ReturnType<typeof insertProvisioningDependents>,
): PostCommitEffect[] {
  if (inserted.kind === 'agent') {
    return [
      ...inserted.openedPairConversationIds.map(
        (conversationId): PostCommitEffect =>
          () => {
            publishDirectPairsChangedToViewer(deps.events, creatorUserId, {
              conversation_id: conversationId,
            });
          },
      ),
      ...buildPostCommitEffects(
        deps,
        inserted.directLine.id,
        agentId,
        inserted.onboardingMsg.id,
      ),
    ];
  }
  return buildPostCommitEffects(
    deps,
    inserted.dm.id,
    agentId,
    inserted.onboardingMsg.id,
  );
}

/**
 * The three optional coordinates are the HUMAN's navigation target for a fresh
 * create, so the agent-scoped arm reports none of them: it has no home and no DM
 * CHANNEL, and no field here can honestly carry a `direct_pair` — `dmChannelId`
 * is a channel inside the agent's home, which the desktop navigates to as one,
 * and a message id without a conversation coordinate is dangling. The creator
 * still learns about the line, from the read surface that owns it: the
 * `direct_pairs_changed` invalidation above plus `GET /api/direct-pairs`. The
 * wire shape is unchanged (`dm_channel_id === null` ⇔ agent-scoped).
 */
function successFromInserted(
  deps: CreateAgentDeps,
  agentId: string,
  inserted: ReturnType<typeof insertProvisioningDependents>,
): CreateAgentSuccess {
  if (inserted.kind === 'agent') {
    return {
      agent: deps.agents.get(agentId)!,
      agentHomeWorkspaceId: null,
      dmChannelId: null,
      onboardingMessageId: null,
    };
  }
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
  const { logger, agents, conversations, messages } = deps;
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
      if (existingRow.session_scope === 'agent') {
        return {
          done: true,
          result: {
            kind: 'echo',
            payload: {
              agent: agents.get(existingRow.id)!,
              agentHomeWorkspaceId: null,
              dmChannelId: null,
              onboardingMessageId: null,
            },
          },
        };
      }
      // 200 echo — re-derive the fresh-L4 4-field payload from the graph.
      const dm = conversations.findDmChannelForAgent(existingRow.id);
      if (!dm) {
        logger.error(
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
        logger.error(
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
      const controller = deps.outboundFrameAdapter?.();
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
        logger.error(
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

/**
 * Eligibility was lost to a concurrent transition (the row is now failed under
 * ANOTHER writer's stamp, or active with a complete graph). The winner's
 * terminal state is authoritative: we re-read the row and dispatch on its
 * CURRENT status (retry:false — never re-arm a retry loop here, never
 * compensate). active → echo, failed → previouslyFailed with the winner's code,
 * pending → inProgress (a third writer flipped it again).
 */
function resolveLostProvisioning(
  deps: CreateAgentDeps,
  agentId: string,
  input: CreateAgentInput,
): CreateAgentResult {
  const fresh = deps.agents.getRow(agentId);
  if (!fresh) {
    return {
      kind: 'corruptGraph',
      message: 'agent row vanished during provisioning',
    };
  }
  const outcome = resolveIdempotentCreateOutcome(deps, {
    existingRow: fresh,
    input,
    retry: false,
  });
  return outcome.done
    ? outcome.result
    : {
        kind: 'corruptGraph',
        message: 'agent row in non-terminal state after lost provisioning',
      };
}

export async function createAgent(
  deps: CreateAgentDeps,
  cmd: CreateAgentCommand,
): Promise<CreateAgentResult> {
  const { logger, agents, users } = deps;
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
    // Lost the race: another transition already won (failed under ITS code, or
    // active). Do NOT compensate — report the winner's authoritative state.
    if (retryResult.kind === 'lost') {
      return resolveLostProvisioning(deps, dispatch.rowToRetry.id, input);
    }
    return {
      kind: 'created',
      payload: successFromInserted(deps, dispatch.rowToRetry.id, retryResult.inserted),
      effects: postCommitEffectsForInserted(
        deps,
        dispatch.rowToRetry.id,
        creatorUserId,
        retryResult.inserted,
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
      ? deps.placement.assertOwnedActiveHost(input.host_id, creatorUserId).id
      : deps.placement.resolveOwnedReadyForPlacement(creatorUserId).id;
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
  const controller = deps.outboundFrameAdapter?.();
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
  // ONE INSERT, its own commit: the L2 materialize dispatch below depends on the
  // row being durable before it runs. It used to be the AGGREGATE factory, which
  // paired the row with an `agent_inbox` so a mention of the handle had a
  // destination even if materialization never succeeded; #task:2072 moved that
  // destination to the AUTHOR's direct line with the agent, minted at the send
  // boundary — so a bare row is already a complete, addressable Agent.
  let reservedRow: AgentRow;
  try {
    reservedRow = deps.agentProvisioning.reserveAgentRow({
      input,
      defaultHostId: resolvedHostId,
      createdByUserId: creatorUserId,
      idempotencyKey,
    });
  } catch (err) {
    logger.warn(
      { err, agentName: input.name, idempotencyKey },
      'agent row reserve INSERT failed',
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
  // Lost the race: another transition already won. Report the winner's state,
  // do NOT compensate.
  if (freshResult.kind === 'lost') {
    return resolveLostProvisioning(deps, reservedRow.id, input);
  }
  return {
    kind: 'created',
    payload: successFromInserted(deps, reservedRow.id, freshResult.inserted),
    effects: postCommitEffectsForInserted(
      deps,
      reservedRow.id,
      creatorUserId,
      freshResult.inserted,
    ),
  };
}
