import {
  type CanonicalConversationTitle,
  type ChannelConversationDto,
  type ConversationVisibility,
  type DmChannelDto,
  type MessageDto,
  requireWorkspacePlacement,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import {
  logTitleAddressMoved,
  logTitleAddressRefused,
  logTitleAddressTaken,
} from '../observability/title-address-log.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { ChannelError } from './channel/errors.js';
import type {
  ChannelAgentReadPort,
  ChannelDirectWritePort,
  ChannelReadPort,
  ChannelUnitOfWork,
  ChannelWorkspaceReadPort,
} from './channel/ports.js';
import type { ConversationUnreadPublishPort } from './conversation/unread-publish-port.js';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal.js';
import { roleGovernsWorkspace } from '../auth/workspace-role.js';

/**
 * ChannelService is the single owner of channel create / pin / unpin
 * business side effects. Routes translate auth and input shapes, then call
 * this service; they must not replicate inserts, member fan-out, agent
 * delivery/start, or `workspace_channels_changed` publishing.
 *
 * Contract:
 * - `createChannel` targets regular workspaces.
 * - `createAgentHomeDmChannel` targets agent_home workspaces (an agent's
 *   private DM surface). It owns the single-transaction insertDmChannel +
 *   addAgent + (user) addUser and the post-commit `workspace_channels_changed`
 *   publish for that branch. Its signature deliberately takes NO member
 *   parameters, so the agent_home rule "members are always the owner + the
 *   current user" is structural.
 * - Every requested member must exist and already be a workspace member.
 * - User actors scope humans to the creator (implicit) plus any explicit
 *   subset they pass. Omitted or empty both mean creator-only — there is NO
 *   full-workspace snapshot; others reach a `public` channel via browse +
 *   self-join and never see a `private` one they weren't added to.
 *   Agent actors inherit humans from the fork source instead.
 * - Agent actors must be members of the fork source they NAMED, and that source
 *   must belong to the target workspace. The source is
 *   {@link ChannelForkActor.forkSourceConversationId} — never the credential's
 *   conversation (#task:2021 P4-4).
 * - Agent routes explicitly snapshot `memberAgentIds` from the addressed source
 *   before calling the service.
 * - Seed messages are agent-only.
 * - Channel create / archive publish `workspace_channels_changed` after the
 *   DB mutation commits.
 */

export type ChannelActor =
  | UserPrincipal
  | AgentPrincipal;

/**
 * The agent arm of {@link CreateChannelInput.actor}: who forks, and WHAT.
 *
 * Deliberately NOT `AgentPrincipal`, and that is the whole point of the type. A
 * A ConversationSlot principal carries `conversationId`, and this service used
 * to read that field as the fork source: the workspace
 * the channel is born into, the agent roster it inherits, the human members it
 * inherits, and the `source_conversation_id` stamped into the seed message all came
 * from runtime custody. Under an AgentSlot there is no such coordinate, so the
 * source arrives as an ADDRESS the route resolves.
 *
 * Handing the service a principal would leave the old field in reach, one
 * `input.actor.forkSourceConversationId` away from silently restoring the ambient default.
 * An actor with no frame to fall back to makes that a type error instead.
 */
export interface ChannelForkActor {
  readonly kind: 'agent';
  readonly agentId: string;
  /** The RESOLVED fork source. The caller has already established that this agent
   *  participates in it (so this is not a discovery oracle) and that it is
   *  workspace-placed; the service re-derives both under its own write lock. */
  readonly forkSourceConversationId: string;
}

export interface CreateChannelInput {
  workspaceId: string;
  /**
   * The channel's title, WHICH IS ITS ADDRESS (#task:2016) — the canonical pair,
   * parsed once at the request boundary. A collision with a sibling channel's
   * folded title is a REFUSAL (`conversation_title_taken`, 409), never a silent
   * suffix: the requester is told to choose, rather than handed an address nobody
   * asked for.
   */
  title: CanonicalConversationTitle;
  memberAgentIds: string[];
  memberUserIds?: string[];
  /** Channel visibility. Omitted → 'private'. `public` requires a user actor
   *  (agents have no public-creation path); the service rejects otherwise. */
  visibility?: ConversationVisibility;
  /** A human creator, or an agent forking a conversation it NAMED — see
   *  {@link ChannelForkActor} for why the agent arm is not a principal. */
  actor: UserPrincipal | ChannelForkActor;
  seed?: {
    systemMessageBody: string;
    initialPrompt: string;
    autoStartMembers: 'all' | 'none';
  };
}

export interface CreateChannelResult {
  channel: ChannelConversationDto;
}

export interface SetArchivedInput {
  channelId: string;
  archived: boolean;
}

export interface RenameChannelInput {
  channelId: string;
  /** The new title, which is also the new ADDRESS (#task:2016). */
  title: CanonicalConversationTitle;
}

export type WorkspaceUnsuitableCode =
  | 'workspace_not_found'
  | 'workspace_not_regular'
  | 'workspace_not_agent_home';

export class WorkspaceUnsuitableError extends Error {
  constructor(
    public readonly code: WorkspaceUnsuitableCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceUnsuitableError';
  }
}

/**
 * Defensive failures for {@link ChannelService.createAgentHomeDmChannel}. Both
 * codes guard a state the schema already forbids — `workspaces` carries a CHECK
 * (`agent_home ⇒ owner_agent_id IS NOT NULL`) and a FK
 * (`owner_agent_id → agents(id)`), so neither is reachable through the public
 * API. They exist purely so the service does not blindly trust its caller. The
 * route maps these two codes to their exact `{ error }`-only bodies (no `code`
 * field); it must NOT route them through `channelServiceErrorResponse`, which
 * would add a `code`. This error type covers ONLY these two branches — every
 * other failure (workspace missing / not agent_home / a persistence failure
 * inside the transaction) is left to surface as a generic 500.
 */
export type AgentHomeChannelErrorCode =
  | 'agent_home_missing_owner'
  | 'agent_home_owner_not_found';

export class AgentHomeChannelError extends Error {
  constructor(
    public readonly code: AgentHomeChannelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentHomeChannelError';
  }
}

export type MemberErrorCode =
  | 'agent_not_found'
  | 'agent_not_workspace_member'
  | 'user_not_workspace_member';

export class MemberError extends Error {
  constructor(
    public readonly code: MemberErrorCode,
    public readonly memberId: string,
    message: string,
  ) {
    super(message);
    this.name = 'MemberError';
  }
}

export type ActorErrorCode =
  | 'agent_not_found'
  | 'source_conversation_not_found'
  | 'agent_not_member_of_source_conv'
  | 'agent_workspace_mismatch'
  | 'agent_cannot_create_public'
  /** The user actor no longer governs the workspace as of the write lock (an
   *  `admin` demotion or a removal committed after the route's gate). It is an
   *  INTERNAL name: `channelServiceErrorResponse` renders it as the route's own
   *  `{ error: 'forbidden' }` / 403 — no `code`, message dropped — so the seam
   *  adds no public protocol. */
  | 'user_cannot_govern_workspace';

export class ActorError extends Error {
  constructor(
    public readonly code: ActorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ActorError';
  }
}

export type SeedErrorCode = 'seed_requires_agent_actor';

export class SeedError extends Error {
  constructor(
    public readonly code: SeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SeedError';
  }
}

export interface ChannelServiceOptions {
  channels: ChannelReadPort;
  channelWrites: ChannelDirectWritePort;
  workspaces: ChannelWorkspaceReadPort;
  agents: ChannelAgentReadPort;
  uow: ChannelUnitOfWork;
  unreadPublish: ConversationUnreadPublishPort;
  events: ScopeEventBus;
  runtimeHost: AgentRuntimeHost;
  logger: BackendLogger;
}

interface CreateChannelTxResult {
  channel: ChannelConversationDto;
  contextMsg: MessageDto | null;
  promptMsg: MessageDto | null;
  humanMemberCount: number;
}

export class ChannelService {
  private readonly channels: ChannelReadPort;
  private readonly channelWrites: ChannelDirectWritePort;
  private readonly workspaces: ChannelWorkspaceReadPort;
  private readonly agents: ChannelAgentReadPort;
  private readonly uow: ChannelUnitOfWork;
  private readonly unreadPublish: ConversationUnreadPublishPort;
  private readonly events: ScopeEventBus;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly logger: BackendLogger;

  constructor(opts: ChannelServiceOptions) {
    this.channels = opts.channels;
    this.channelWrites = opts.channelWrites;
    this.workspaces = opts.workspaces;
    this.agents = opts.agents;
    this.uow = opts.uow;
    this.unreadPublish = opts.unreadPublish;
    this.events = opts.events;
    this.runtimeHost = opts.runtimeHost;
    this.logger = opts.logger;
  }

  async createChannel(input: CreateChannelInput): Promise<CreateChannelResult> {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace) {
      throw new WorkspaceUnsuitableError(
        'workspace_not_found',
        'workspace not found',
      );
    }
    if (workspace.workspace_kind !== 'regular') {
      throw new WorkspaceUnsuitableError(
        'workspace_not_regular',
        'workspace is not a regular workspace',
      );
    }

    const memberAgentIds = Array.from(new Set(input.memberAgentIds));
    const explicitUserMemberIds =
      input.memberUserIds === undefined
        ? null
        : Array.from(new Set(input.memberUserIds));
    for (const agentId of memberAgentIds) {
      if (!this.agents.get(agentId)) {
        throw new MemberError('agent_not_found', agentId, `agent ${agentId} not found`);
      }
      if (!this.workspaces.isMember(workspace.id, agentId)) {
        throw new MemberError(
          'agent_not_workspace_member',
          agentId,
          `agent ${agentId} is not a member of this workspace`,
        );
      }
    }
    if (input.actor.kind === 'user' && explicitUserMemberIds) {
      for (const userId of explicitUserMemberIds) {
        if (!this.workspaces.isUserMember(workspace.id, userId)) {
          throw new MemberError(
            'user_not_workspace_member',
            userId,
            `user ${userId} is not a human member of this workspace`,
          );
        }
      }
    }

    if (input.actor.kind === 'agent') {
      if (!this.agents.get(input.actor.agentId)) {
        throw new ActorError('agent_not_found', 'agent not found');
      }
      const sourceConversation = this.channels.get(input.actor.forkSourceConversationId);
      if (!sourceConversation) {
        throw new ActorError(
          'source_conversation_not_found',
          'source conversation not found',
        );
      }
      if (!this.channels.getAgent(input.actor.forkSourceConversationId, input.actor.agentId)) {
        throw new ActorError(
          'agent_not_member_of_source_conv',
          'agent is not a member of the source conversation',
        );
      }
      if (sourceConversation.workspace_id !== workspace.id) {
        throw new ActorError(
          'agent_workspace_mismatch',
          'source conversation belongs to another workspace',
        );
      }
    }

    if (input.seed && input.actor.kind !== 'agent') {
      throw new SeedError(
        'seed_requires_agent_actor',
        'seeded channel creation requires an agent actor',
      );
    }

    // `public` is a human product concept — agents have no public read/create
    // path (see canReadConversation). Guard the invariant at the write boundary
    // rather than trusting callers: the human create route always passes a user
    // actor, but a future agent caller must never mint a public channel.
    if (input.visibility === 'public' && input.actor.kind !== 'user') {
      throw new ActorError(
        'agent_cannot_create_public',
        'public channel creation requires a human actor',
      );
    }

    // Workspace-keyed: the channel row and every founding-member row belong to
    // this one workspace, and the scope's faces are bound to it (#task:1987).
    const created = this.uow.atomicallyInWorkspace(
      workspace.id,
      (tx): CreateChannelTxResult => {
        // Re-derive, INSIDE the lock, every fact that authorizes a write below.
        // The gates above are early refusals only: a roster change can commit in
        // the seam between them and BEGIN, and the interleaving would leave a
        // membership edge for a principal who is not a workspace member — a state
        // no serial order produces (create-then-remove cascades the edge away;
        // remove-then-create refuses). Any refusal here throws, which rolls the
        // whole transaction back, and reuses the SAME typed error as its pre-lock
        // twin so the HTTP mapping is unchanged.
        const current = tx.workspace.get();
        if (!current) {
          throw new WorkspaceUnsuitableError(
            'workspace_not_found',
            'workspace not found',
          );
        }
        if (current.workspace_kind !== 'regular') {
          throw new WorkspaceUnsuitableError(
            'workspace_not_regular',
            'workspace is not a regular workspace',
          );
        }
        for (const agentId of memberAgentIds) {
          if (!tx.agents.get(agentId)) {
            throw new MemberError('agent_not_found', agentId, `agent ${agentId} not found`);
          }
          if (!tx.workspace.hasAgentMember(agentId)) {
            throw new MemberError(
              'agent_not_workspace_member',
              agentId,
              `agent ${agentId} is not a member of this workspace`,
            );
          }
        }
        if (input.actor.kind === 'agent') {
          if (!tx.agents.get(input.actor.agentId)) {
            throw new ActorError('agent_not_found', 'agent not found');
          }
          // The source conversation's `workspace_id` is immutable, so the
          // pre-lock mismatch gate cannot go stale and this read cannot trip the
          // scope's workspace binding; the edge, however, can be revoked in the
          // seam.
          if (!tx.channels.getAgent(input.actor.forkSourceConversationId, input.actor.agentId)) {
            throw new ActorError(
              'agent_not_member_of_source_conv',
              'agent is not a member of the source conversation',
            );
          }
        } else {
          // The user actor's AUTHORITY, re-derived from the role row as of the
          // lock. The route's `canGovernWorkspace(…, 'admin')` gate stays where it
          // is — a refusal should not take a write lock — but it cannot be the
          // authority for the write: an `admin` demotion committing in the seam
          // would otherwise still mint a channel. This is the same rule
          // `addWorkspaceHumanMember` applies in this slice, and both writers of
          // workspace-governed rows must sample authority at the same moment.
          if (!roleGovernsWorkspace(tx.workspace.humanRole(input.actor.userId))) {
            throw new ActorError(
              'user_cannot_govern_workspace',
              'user does not govern this workspace',
            );
          }
        }

        // The title IS the address, so the collision check happens here, under
        // this transaction's write lock — two concurrent creations of the same
        // title cannot both pass it. The partial UNIQUE index inside
        // `insertChannel` is the backstop if this check is ever wrong.
        if (tx.channels.isTitleTaken(input.title.key)) {
          logTitleAddressRefused(this.logger, {
            workspaceId: workspace.id,
            conversationId: null,
            key: input.title.key,
          });
          throw new ChannelError(
            'conversation_title_taken',
            `a channel titled ${input.title.title} already exists in this workspace`,
          );
        }
        const channel = tx.channels.insertChannel({
          title: input.title,
          spawnedByAgentId:
            input.actor.kind === 'agent' ? input.actor.agentId : null,
          visibility: input.visibility,
        });
        for (const memberId of memberAgentIds) {
          tx.channels.addAgent(channel.id, memberId);
        }

        // Human membership snapshot at creation:
        //   - agent-created channel: inherit narrowly from the SOURCE
        //     conversation's `conversation_users` (an agent in a private subset
        //     of humans must not fan out to the whole workspace).
        //   - user-created channel: the creator (implicit, so they can always
        //     view what they made) plus any explicitly-selected humans. There is
        //     NO full-workspace snapshot — a new channel starts scoped to the
        //     creator + chosen members; others reach a `public` channel by
        //     browsing (canReadConversation) and self-join, and never see a
        //     `private` one they weren't added to.
        const userMemberIds = input.actor.kind === 'agent'
          ? tx.channels
              .listUsers(input.actor.forkSourceConversationId)
              .map(u => u.user_id)
          : Array.from(
              new Set([input.actor.userId, ...(explicitUserMemberIds ?? [])]),
            );
        for (const userId of userMemberIds) {
          // Same in-lock eligibility rule as the agent members above, and it
          // covers the IMPLICIT creator too: `canGovernWorkspace` is satisfied by
          // a `workspace_users` role row, so a creator removed in the seam would
          // otherwise get a `conversation_users` row with no membership behind it.
          // A role row IS that membership, so the role projection answers it.
          // The agent-actor branch needs no check — its list is READ in this
          // lock, so the removal cascade has already taken those rows out.
          if (
            input.actor.kind === 'user'
            && tx.workspace.humanRole(userId) === null
          ) {
            throw new MemberError(
              'user_not_workspace_member',
              userId,
              `user ${userId} is not a human member of this workspace`,
            );
          }
          tx.channels.addUser(channel.id, userId);
        }

        let contextMsg: MessageDto | null = null;
        let promptMsg: MessageDto | null = null;
        if (input.seed && input.actor.kind === 'agent') {
          // Snapshot source identity at insert time so the renderer can
          // draw the Spawned-from chip without a follow-up join, even if
          // the source conversation or agent is later renamed/archived.
          const sourceConv = tx.channels.get(input.actor.forkSourceConversationId);
          const sourceAgent = tx.agents.get(input.actor.agentId);
          contextMsg = tx.messages.insert({
            conversationId: channel.id,
            fromKind: 'system',
            content: input.seed.systemMessageBody,
            metadata: {
              subtype: systemSubtype('channel_context'),
              source_conversation_id: input.actor.forkSourceConversationId,
              source_conversation_title: sourceConv?.title ?? undefined,
              created_by_agent_id: input.actor.agentId,
              created_by_agent_name: sourceAgent?.name ?? undefined,
            },
          });
          promptMsg = tx.messages.insert({
            conversationId: channel.id,
            fromKind: 'agent',
            fromAgentId: input.actor.agentId,
            content: input.seed.initialPrompt,
          });
        }

        return { channel, contextMsg, promptMsg, humanMemberCount: userMemberIds.length };
      },
    );

    this.publishWorkspaceChannelsChanged(workspace.id, created.channel.id);
    logTitleAddressTaken(this.logger, {
      workspaceId: workspace.id,
      conversationId: created.channel.id,
      key: input.title.key,
    });
    this.logger.info(
      {
        conversationId: created.channel.id,
        workspaceId: workspace.id,
        actorKind: input.actor.kind,
        actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
        memberCount: memberAgentIds.length,
        humanMemberCount: created.humanMemberCount,
        seeded: !!input.seed,
      },
      'channel-service: channel created',
    );

    if (input.seed && input.actor.kind === 'agent') {
      if (created.contextMsg) {
        await this.deliverBestEffort(
          created.channel.id,
          input.actor.agentId,
          created.contextMsg.id,
          'channel-service: seed context delivery failed',
        );
      }
      if (created.promptMsg) {
        await this.distributeBestEffort(
          created.channel.id,
          input.actor.agentId,
          created.promptMsg.id,
        );
      }
      if (input.seed.autoStartMembers === 'all') {
        await this.startAgentsBestEffort(created.channel.id);
      }
    }

    return { channel: created.channel };
  }

  /**
   * Create a secondary DM channel inside an agent_home workspace (the agent's
   * private surface). The members are always the home owner agent + the current
   * user, so this takes NO member list. Re-validates the workspace kind and
   * owner defensively (see {@link AgentHomeChannelError}) rather than trusting
   * the caller, then performs the three writes as a SINGLE transaction so a
   * partial failure leaves no half DM, and publishes
   * `workspace_channels_changed` only after the commit.
   */
  async createAgentHomeDmChannel(input: {
    workspaceId: string;
    /** The DM's title, which is its address in the home workspace (#task:2016). */
    title: CanonicalConversationTitle;
    actor: ChannelActor;
  }): Promise<{ channel: DmChannelDto }> {
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace) {
      throw new WorkspaceUnsuitableError('workspace_not_found', 'workspace not found');
    }
    if (workspace.workspace_kind !== 'agent_home') {
      throw new WorkspaceUnsuitableError(
        'workspace_not_agent_home',
        'workspace is not an agent_home workspace',
      );
    }
    if (!workspace.owner_agent_id) {
      throw new AgentHomeChannelError(
        'agent_home_missing_owner',
        'agent_home workspace missing owner',
      );
    }
    const owner = this.agents.get(workspace.owner_agent_id);
    if (!owner) {
      throw new AgentHomeChannelError(
        'agent_home_owner_not_found',
        'agent_home owner not found',
      );
    }

    const channel = this.uow.atomicallyInWorkspace(
      workspace.id,
      (tx): DmChannelDto => {
        // In-lock re-derivation, same rule as `createChannel`: the kind/owner
        // facts this transaction writes by must be read under the mechanism that
        // protects them, not carried in from before BEGIN.
        const current = tx.workspace.get();
        if (!current) {
          throw new WorkspaceUnsuitableError('workspace_not_found', 'workspace not found');
        }
        if (current.workspace_kind !== 'agent_home') {
          throw new WorkspaceUnsuitableError(
            'workspace_not_agent_home',
            'workspace is not an agent_home workspace',
          );
        }
        if (!current.owner_agent_id) {
          throw new AgentHomeChannelError(
            'agent_home_missing_owner',
            'agent_home workspace missing owner',
          );
        }
        const currentOwner = tx.agents.get(current.owner_agent_id);
        if (!currentOwner) {
          throw new AgentHomeChannelError(
            'agent_home_owner_not_found',
            'agent_home owner not found',
          );
        }
        // Same address rule as `createChannel` — a DM channel is a workspace
        // placement today, so its title occupies the home's address space. When
        // P3 moves direct conversations onto their own placement they stop holding
        // an address and this check goes with them.
        if (tx.channels.isTitleTaken(input.title.key)) {
          logTitleAddressRefused(this.logger, {
            workspaceId: workspace.id,
            conversationId: null,
            key: input.title.key,
          });
          throw new ChannelError(
            'conversation_title_taken',
            `a channel titled ${input.title.title} already exists in this workspace`,
          );
        }
        const dm = tx.channels.insertDmChannel({
          title: input.title,
          agentId: currentOwner.id,
        });
        tx.channels.addAgent(dm.id, currentOwner.id);
        // Human membership for the freshly-created DM: the creating user is a
        // workspace member (the admin gate already passed), so they are a
        // legitimate member of their own new DM. Without this row a follow-up
        // GET /messages would 403 for the same principal that just created it.
        // No in-lock membership OR authority re-check here, unlike
        // `createChannel`: every human-roster route (add, role change, removal,
        // self-leave) refuses a non-`regular` workspace, so on an `agent_home` one
        // the seam that would strip or demote this user's role row does not exist.
        // The re-derivation would be unreachable code, not a missing gate.
        if (input.actor.kind === 'user') {
          tx.channels.addUser(dm.id, input.actor.userId);
        }
        return dm;
      },
    );

    this.publishWorkspaceChannelsChanged(workspace.id, channel.id);
    logTitleAddressTaken(this.logger, {
      workspaceId: workspace.id,
      conversationId: channel.id,
      key: input.title.key,
    });
    return { channel };
  }

  async setArchived(
    input: SetArchivedInput,
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    const existing = this.channels.get(input.channelId);
    if (!existing) {
      throw new ChannelError('not_found', 'channel not found');
    }

    const updated = this.channelWrites.setArchived(
      input.channelId,
      input.archived,
    );
    if (!updated) {
      throw new ChannelError('not_found', 'channel not found');
    }

    // Archiving a channel terminates its agent runtime: an agent still working
    // in an archived channel is doing meaningless work. Stop is best-effort and
    // async (the host may be offline), so "archived ⇒ no runtime" is an eventual
    // state, not an instant invariant — which is exactly why the control-plane
    // callers (Stop-all, delete-agent purge) read the unfiltered SEAT face
    // (`RuntimeSlotRepo.listSeats`, no archive scope and no placement scope):
    // a straggler runtime left here must still be reachable to stop/purge. Only
    // the display roster excludes archived (see agent-repo). (#task:1398)
    if (input.archived) {
      this.runtimeHost.resolveConversationRuns(updated.id, 'conversation_closed');
      for (const ca of this.channels.listAgents(updated.id)) {
        // A ConversationSlot is owned by this conversation edge; closing the
        // conversation terminates that process. An AgentSlot is owned by the
        // Agent aggregate and may still be serving other target conversations,
        // so archiving one target must not kill the shared process.
        if (this.agents.get(ca.agent_id)?.session_scope !== 'conversation') {
          continue;
        }
        void this.runtimeHost.stop(updated.id, ca.agent_id).catch(err =>
          this.logger.warn(
            { channelId: updated.id, agentId: ca.agent_id, err },
            'archive channel: runtime stop failed (continuing)',
          ),
        );
      }
    }

    this.publishWorkspaceChannelsChanged(
      requireWorkspacePlacement(updated),
      updated.id,
    );
    // Archiving/unarchiving flips whether this channel's unread counts toward the
    // viewer badges (ROLLUP_UNREAD excludes archived — #task:1403). The rollup is
    // authoritative the instant `archived_at` commits, but the already-cached
    // sidebar/global badges are patched in place from `unread_updated`, not
    // refetched (#task:1284) — so without this emit an archived channel's unread
    // would linger until the next snapshot. Post-commit + symmetric: archive
    // decrements every affected viewer's badge, unarchive restores it (the
    // predicate re-includes the channel). Per-viewer absolutes ride the
    // `viewer:<id>` scope, so no broadcast-invariant risk.
    this.unreadPublish.publishUnreadUpdatedToConversationViewers(updated.id);
    return { channel: updated };
  }

  /**
   * Rename a top-level channel — which MOVES ITS ADDRESS, because they are the
   * same string (#task:2016).
   *
   * ONE method, not two. The retired-slug design had a display `renameChannel`
   * and an addressing `setChannelName` as siblings, because a title could be
   * rewritten freely while an address was permanent. @shiki settled the opposite
   * model: there is no independent semantic name, a rename releases the old title
   * IMMEDIATELY, and nothing remembers it — so "change the display text" and
   * "change the address" are not two operations that could disagree. A second
   * method here would have to write the same column.
   *
   * Mirrors the workspace-rename contract (routes/workspaces.ts) at the channel
   * scope: update title + key, then — only when the title actually changed — emit
   * a `rename` system message into the channel (`scope: 'conversation'`), deliver
   * it to every member agent so the new address reaches their context, and publish
   * `workspace_channels_changed` so the sidebar/header refetch. Titles are
   * freeform (spaces / CJK), so the prose quotes them rather than using a sigil.
   *
   * A no-op rename (byte-identical title) short-circuits: no system message, no
   * delivery, no event. A change of SPELLING that folds to the same key
   * (`general` → `General`) is NOT a no-op — it is a real display change that
   * keeps the address, so it writes, announces, and does not conflict with itself.
   *
   * Refusals:
   *  - unknown / non-channel-like id → `not_found`;
   *  - a target with no workspace to hold an address (an agent inbox, reachable
   *    because `kind` is GENERATED) → `not_addressable`;
   *  - another channel in this workspace already showing that title → 409
   *    `conversation_title_taken`, never auto-suffixed.
   *
   * The authoritative old title, the no-op decision, the collision check, the
   * write and the `rename` system-message insert ALL run in ONE
   * `atomicallyForChannel` callback — keyed on this very channel, so every face
   * addresses it and none can be pointed elsewhere. A failed insert can never
   * leave a renamed channel with no audit row; two concurrent renames can never
   * both read the same old title and write a from-title that never existed, nor
   * both pass the collision check (see `getChannelLikeForUpdate`'s isolation
   * obligation). Delivery and the `workspace_channels_changed` publish are
   * post-commit side effects.
   */
  async renameChannel(
    input: RenameChannelInput,
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    // Pre-lock refusal for a placement that holds no address at all.
    // `workspace_id` is immutable, so reading the placement before BEGIN cannot go
    // stale — the same assumption the UnitOfWork's own key→workspace resolution
    // rests on.
    const target = this.channels.getChannelLike(input.channelId);
    if (!target) {
      throw new ChannelError('not_found', 'channel not found');
    }
    if (target.workspace_id === null) {
      throw new ChannelError(
        'not_addressable',
        'this conversation has no workspace to hold a title address',
      );
    }
    // Bound once, so the address-space this rename happens in is a value rather
    // than a property re-read (and re-narrowed) at every observation site.
    const workspaceId = target.workspace_id;

    const renamed = this.uow.atomicallyForChannel(
      input.channelId,
      (
        tx,
      ): {
        channel: ChannelConversationDto | DmChannelDto;
        releasedKey: string | null;
        announce: MessageDto | null;
      } => {
        const existing = tx.channels.getChannelLikeForUpdate();
        if (!existing) {
          throw new ChannelError('not_found', 'channel not found');
        }
        // No-op: the stored title is already canonical, so a byte comparison
        // against the canonical form is the whole question.
        const oldTitle = existing.title;
        if (input.title.title === oldTitle) {
          return { channel: existing, releasedKey: null, announce: null };
        }
        // Excludes this channel: re-spelling your own title keeps the address you
        // already hold, and must not be refused as a conflict with yourself.
        if (tx.channels.isTitleTakenByAnother(input.title.key)) {
          logTitleAddressRefused(this.logger, {
            workspaceId,
            conversationId: input.channelId,
            key: input.title.key,
          });
          throw new ChannelError(
            'conversation_title_taken',
            `a channel titled ${input.title.title} already exists in this workspace`,
          );
        }
        const updated = tx.channels.updateTitle(input.title);
        if (!updated) {
          throw new ChannelError('not_found', 'channel not found');
        }
        const announce = tx.messages.insert({
          fromKind: 'system',
          content:
            `This channel was renamed from “${oldTitle}” to “${input.title.title}”. `
            + 'A channel is addressed by its title, so the old one no longer '
            + 'reaches this channel — update any references in your MEMORY.md when '
            + 'you next edit it.',
          metadata: {
            subtype: systemSubtype('rename'),
            old_name: oldTitle,
            new_name: input.title.title,
            scope: 'conversation',
          },
        });
        return { channel: updated.channel, releasedKey: updated.releasedKey, announce };
      },
    );

    const { channel: updated, announce } = renamed;
    if (!announce) return { channel: updated };

    // Post-commit, and only on the branch that actually wrote: this line is the
    // only surviving record that `from_key` was ever this channel's address.
    logTitleAddressMoved(this.logger, {
      workspaceId,
      conversationId: updated.id,
      fromKey: renamed.releasedKey,
      toKey: input.title.key,
    });

    for (const ca of this.channels.listAgents(updated.id)) {
      await this.deliverBestEffort(
        updated.id,
        ca.agent_id,
        announce.id,
        'channel rename delivery failed',
      );
    }
    this.events.publish(updated.id, {
      kind: 'message',
      payload: { message: announce },
    });
    this.publishWorkspaceChannelsChanged(requireWorkspacePlacement(updated), updated.id);
    return { channel: updated };
  }

  /**
   * Toggle a channel's visibility (`private ↔ public`). Mirrors
   * {@link setArchived}'s shape: a single-column repo write plus the
   * post-commit `workspace_channels_changed` publish that drives every
   * viewer's discovery-union list to refetch.
   *
   * `public → private` is a viewer-scoped visibility LOSS for non-members: the
   * `workspace_channels_changed` fan-out drops the channel from their
   * discovery-union list, and `canReadConversation` denies them immediately so
   * an open non-member view is ejected by read-path validation
   * (docs/architecture-principles.md §12). Members are unaffected (the
   * membership branch of the read gate ignores visibility). `private → public`
   * is additive (the channel enters others' discovery union). A same-value
   * request is a no-op 200 (no write, no event).
   *
   * `public` is a human product concept — this re-asserts the create-time
   * actor-kind guard (defense in depth beyond the route's `canGovernWorkspace`
   * admin gate, which already rejects agents): a non-user actor requesting
   * `public` throws `agent_cannot_create_public`. Visibility applies to regular
   * channels only; a `dm_channel` / thread id is a typed `not_found`.
   */
  async setChannelVisibility(input: {
    channelId: string;
    visibility: ConversationVisibility;
    actor: ChannelActor;
  }): Promise<{ channel: ChannelConversationDto }> {
    const existing = this.channels.get(input.channelId);
    if (!existing || existing.kind !== 'channel') {
      throw new ChannelError('not_found', 'channel not found');
    }
    if (input.visibility === 'public' && input.actor.kind !== 'user') {
      throw new ActorError(
        'agent_cannot_create_public',
        'public channel requires a human actor',
      );
    }
    // Same-value no-op: nothing changed, so emit nothing.
    if (existing.visibility === input.visibility) {
      const channel = this.channels.getChannelLike(input.channelId);
      if (!channel || channel.kind !== 'channel') {
        throw new ChannelError('not_found', 'channel not found');
      }
      return { channel };
    }
    const updated = this.channelWrites.setVisibility(
      input.channelId,
      input.visibility,
    );
    if (!updated) {
      throw new ChannelError('not_found', 'channel not found');
    }
    this.publishWorkspaceChannelsChanged(requireWorkspacePlacement(updated), updated.id);
    this.logger.info(
      {
        conversationId: updated.id,
        workspaceId: updated.workspace_id,
        visibility: input.visibility,
        actorKind: input.actor.kind,
      },
      'channel-service: visibility updated',
    );
    return { channel: updated };
  }

  /** The discovery-union invalidation frame. Keyed on a WORKSPACE — both the
   *  `workspace:<id>` scope it rides and the list it invalidates (the viewer's
   *  per-workspace channel list) are workspace artifacts, so there is no frame
   *  to emit for a placement without one.
   *
   *  The two CREATE callers pass the workspace they were asked to create in; the
   *  three MUTATION callers derive it from the mutated row with
   *  `requireWorkspacePlacement`. That assertion cannot fire today — each of
   *  them refuses anything but `kind === 'channel'`, i.e. an open roster, which
   *  only the workspace arm has — and it is written anyway because the
   *  alternative (`?? ''` / `!`) would turn a future placement with an open
   *  roster into a frame addressed to a scope nobody subscribes to. */
  private publishWorkspaceChannelsChanged(workspaceId: string, channelId: string): void {
    this.events.publishToScope(`workspace:${workspaceId}`, 'workspace_channels_changed', {
      workspace_id: workspaceId,
      channel_id: channelId,
    });
  }

  private async deliverBestEffort(
    conversationId: string,
    agentId: string,
    messageId: string,
    reason: string,
  ): Promise<void> {
    try {
      await this.runtimeHost.deliverMessage(conversationId, agentId, messageId);
    } catch (err) {
      this.logger.warn({ conversationId, agentId, messageId, err }, reason);
    }
  }

  private async distributeBestEffort(
    conversationId: string,
    excludeAgentId: string,
    messageId: string,
  ): Promise<void> {
    const recipients = this.channels
      .listAgents(conversationId)
      .filter(ca => ca.agent_id !== excludeAgentId);
    try {
      await Promise.all(
        recipients.map(ca =>
          this.runtimeHost.deliverMessage(
            conversationId,
            ca.agent_id,
            messageId,
          ),
        ),
      );
    } catch (err) {
      this.logger.warn(
        { conversationId, excludeAgentId, messageId, err },
        'channel-service: prompt distribution failed',
      );
    }
  }

  private async startAgentsBestEffort(conversationId: string): Promise<void> {
    // Runtime start is idempotent at the semantic slot. Membership must not
    // import a slot projection merely to optimize away this call: doing so
    // makes a missing/stale runtime observation change who is a member.
    const recipients = this.channels.listAgents(conversationId);
    try {
      await Promise.all(
        recipients.map(ca =>
          this.runtimeHost.start(conversationId, ca.agent_id).catch(err => {
            this.logger.warn(
              { conversationId, agentId: ca.agent_id, err },
              'channel-service: auto-start on agent-created channel failed',
            );
          }),
        ),
      );
    } catch (err) {
      this.logger.warn({ conversationId, err }, 'channel-service: auto-start failed');
    }
  }
}
