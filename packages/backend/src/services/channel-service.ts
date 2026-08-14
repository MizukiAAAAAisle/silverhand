import {
  type ChannelConversationDto,
  type ConversationVisibility,
  type DmChannelDto,
  type MessageDto,
  requireWorkspacePlacement,
  slugifyConversationTitle,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
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
 *   Agent actors inherit humans from the source conversation instead.
 * - Agent actors must be members of their source conversation, and that
 *   source conversation must belong to the target workspace.
 * - Agent routes explicitly snapshot `memberAgentIds` from the current
 *   conversation before calling the service. From a thread, that means thread
 *   members, not parent-channel members.
 * - Seed messages are agent-only.
 * - Channel create / archive publish `workspace_channels_changed` after the
 *   DB mutation commits.
 */

export type ChannelActor =
  | UserPrincipal
  | AgentPrincipal;

export interface CreateChannelInput {
  workspaceId: string;
  title: string;
  /**
   * The channel's ADDRESS in its workspace namespace (#task:2016). Omitted →
   * derived from `title` by `slugifyConversationTitle`, the same deriver the v72
   * backfill used, so an upgraded channel and a fresh one agree about the obvious
   * name for a title.
   *
   * A conflict is a REFUSAL (`conversation_name_taken`, 409), never a silent
   * suffix — including for the derived case, where two CJK-only titles both
   * derive `channel`: the second request is told to choose an address rather than
   * being handed one nobody asked for. Only the backfill may suffix; it had to
   * cover every existing row and had no requester to refuse.
   */
  name?: string;
  memberAgentIds: string[];
  memberUserIds?: string[];
  /** Channel visibility. Omitted → 'private'. `public` requires a user actor
   *  (agents have no public-creation path); the service rejects otherwise. */
  visibility?: ConversationVisibility;
  actor: ChannelActor;
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
  title: string;
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
      const sourceConversation = this.channels.get(input.actor.conversationId);
      if (!sourceConversation) {
        throw new ActorError(
          'source_conversation_not_found',
          'source conversation not found',
        );
      }
      if (!this.channels.getAgent(input.actor.conversationId, input.actor.agentId)) {
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
          if (!tx.channels.getAgent(input.actor.conversationId, input.actor.agentId)) {
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

        // The ADDRESS, decided before the row is written and checked against the
        // namespace under this transaction's write lock — so two concurrent
        // creations of the same name cannot both pass. The namespace key inside
        // `insertChannel` is the backstop if this check is ever wrong.
        const name = input.name ?? slugifyConversationTitle(input.title);
        if (tx.channels.isNameAllocated(name)) {
          throw new ChannelError(
            'conversation_name_taken',
            `the name ${name} is already allocated in this workspace`,
          );
        }
        const channel = tx.channels.insertChannel({
          title: input.title,
          name,
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
              .listUsers(input.actor.conversationId)
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
          const sourceConv = tx.channels.get(input.actor.conversationId);
          const sourceAgent = tx.agents.get(input.actor.agentId);
          contextMsg = tx.messages.insert({
            conversationId: channel.id,
            fromKind: 'system',
            content: input.seed.systemMessageBody,
            metadata: {
              subtype: systemSubtype('channel_context'),
              source_conversation_id: input.actor.conversationId,
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
    title: string;
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
        // Same address rule as `createChannel`, derived only: this door takes no
        // explicit name (an agent-home DM is reached through its owner, not by
        // typing its address), so a conflict is answered by asking for a
        // different TITLE. When P3 moves direct conversations onto their own
        // placement they leave the namespace and this check goes with them.
        const name = slugifyConversationTitle(input.title);
        if (tx.channels.isNameAllocated(name)) {
          throw new ChannelError(
            'conversation_name_taken',
            `the name ${name} is already allocated in this workspace`,
          );
        }
        const dm = tx.channels.insertDmChannel({
          title: input.title,
          name,
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
   * Rename a top-level channel and broadcast the change so neither
   * agents nor live UIs keep a stale title.
   *
   * Mirrors the workspace-rename contract (routes/workspaces.ts) at the
   * channel scope: update the title, then — only when it actually
   * changed — emit a `rename` system message into the channel
   * (`scope: 'conversation'`), deliver it to every member agent so the
   * new name reaches their context, and publish
   * `workspace_channels_changed` so the sidebar/header refetch the new
   * title. Unlike workspace names (plain handles, `#old → #new`),
   * channel titles are freeform (spaces / CJK), so the prose quotes
   * them rather than using a `#` sigil.
   *
   * A no-op rename (same title) short-circuits: no system message, no
   * delivery, no event — returning the unchanged channel.
   *
   * The authoritative old title, the no-op decision, the title write and the
   * `rename` system-message insert ALL run in ONE `atomicallyForChannel`
   * callback — keyed on this very channel, so every face addresses it and none
   * can be pointed elsewhere — so a failed insert can never leave a renamed
   * channel with no audit row — and two
   * concurrent renames can never both read the same old title and write a
   * from-title that never existed (see `getChannelLikeForUpdate`'s isolation
   * obligation). Whether a nested write of the adapter's own needs a savepoint
   * is the adapter's problem; the UnitOfWork's contract is that everything
   * written through the scope commits together or not at all.
   * Delivery and the `workspace_channels_changed` publish are post-commit side
   * effects.
   */
  async renameChannel(
    input: RenameChannelInput,
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    const renamed = this.uow.atomicallyForChannel(
      input.channelId,
      (
        tx,
      ): {
        channel: ChannelConversationDto | DmChannelDto;
        announce: MessageDto | null;
      } => {
        const existing = tx.channels.getChannelLikeForUpdate();
        if (!existing) {
          throw new ChannelError('not_found', 'channel not found');
        }
        // No-op: nothing changed, so emit nothing.
        const oldTitle = existing.title;
        if (input.title === oldTitle) {
          return { channel: existing, announce: null };
        }
        const updated = tx.channels.updateTitle(input.title);
        if (!updated) {
          throw new ChannelError('not_found', 'channel not found');
        }
        const announce = tx.messages.insert({
          fromKind: 'system',
          content:
            `This channel was renamed from “${oldTitle}” to “${input.title}”. ` +
            `Update any references in your MEMORY.md when you next edit it.`,
          metadata: {
            subtype: systemSubtype('rename'),
            old_name: oldTitle,
            new_name: input.title,
            scope: 'conversation',
          },
        });
        return { channel: updated, announce };
      },
    );

    const { channel: updated, announce } = renamed;
    if (!announce) return { channel: updated };

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
   * RE-ADDRESS a channel: retire its current name and allocate a new one
   * (#task:2016).
   *
   * A sibling of {@link renameChannel}, not a variant of it. A title is display
   * text and may be rewritten as often as anyone likes; a name is the coordinate
   * a `#<name>` reference resolves through, so changing it RETIRES an address
   * permanently — the old name never resolves to this channel again and can never
   * be given to another one. That asymmetry is why the two live in separate
   * methods reached by separate request shapes (`PATCH` accepts exactly one of
   * `title` / `visibility` / `name`), and why this one emits its own
   * `conversation_name_changed` audit subtype instead of the display `rename`
   * row. Changing the title does not touch the name and changing the name does
   * not touch the title — the doc §8 falsifier for P0-c is exactly that.
   *
   * One transaction, keyed on this channel, containing: the authoritative read,
   * the namespace conflict check, the retirement, the allocation, and the audit
   * message. Retire-then-allocate rather than an UPDATE, because the namespace
   * keeps retired rows forever (that is what lets a stale reference report its
   * successor). Two concurrent re-addresses cannot both pass the conflict check:
   * it is taken under the same write lock that performs the writes.
   *
   * Refusals:
   *  - unknown / non-channel-like id → `not_found`;
   *  - a target with no workspace namespace (an agent inbox, reachable because
   *    `kind` is GENERATED) → `not_addressable`;
   *  - a name allocated in this namespace, currently or in the past → 409
   *    `conversation_name_taken`. Never auto-suffixed: a requester who typed
   *    `#design` must not silently end up at `#design-2`.
   *
   * Requesting the name the channel already holds is a NO-OP (no retirement, no
   * audit row, no events) — not a conflict and not a burn of the address.
   */
  async setChannelName(
    input: { channelId: string; name: string },
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    // Pre-lock refusals. `workspace_id` is immutable, so reading the placement
    // before BEGIN cannot go stale — the same assumption the UnitOfWork's own
    // key→workspace resolution rests on.
    const target = this.channels.getChannelLike(input.channelId);
    if (!target) {
      throw new ChannelError('not_found', 'channel not found');
    }
    if (target.workspace_id === null) {
      throw new ChannelError(
        'not_addressable',
        'this conversation has no workspace namespace to be addressed in',
      );
    }

    const readdressed = this.uow.atomicallyForChannel(
      input.channelId,
      (
        tx,
      ): {
        channel: ChannelConversationDto | DmChannelDto;
        announce: MessageDto | null;
      } => {
        const existing = tx.channels.getChannelLikeForUpdate();
        if (!existing) {
          throw new ChannelError('not_found', 'channel not found');
        }
        const oldName = existing.name;
        if (oldName === input.name) {
          return { channel: existing, announce: null };
        }
        if (tx.channels.isNameAllocated(input.name)) {
          throw new ChannelError(
            'conversation_name_taken',
            `the name ${input.name} is already allocated in this workspace`,
          );
        }
        const now = Date.now();
        tx.channels.retireCurrentName(now);
        tx.channels.allocateName(input.name, now);
        const updated = tx.channels.getChannelLikeForUpdate();
        if (!updated) {
          throw new ChannelError('not_found', 'channel not found');
        }
        // The audit row names BOTH addresses, and `old_name` is null only for a
        // channel that held none — a half-state a fault left behind, which this
        // write repairs rather than refuses.
        //
        // Both addresses are written as INLINE CODE, and that is load-bearing
        // (@Cindy, #task:2016 review): the `#name` sigil is, today, still owned
        // by the TITLE namespace on the read side — the renderer's `remarkRefs`
        // turns a bare `#roadmap` in prose into `silverhand-channel:roadmap` and
        // resolves it through a map keyed by channel TITLE. A semantic name is a
        // different namespace, so a bare sigil here would silently navigate to
        // whichever channel happens to be TITLED `roadmap` — this message is the
        // first producer to write a semantic name into prose, so it would be the
        // first to mis-target. `inlineCode` is the one position `remarkRefs`
        // returns from without splitting, so the token stays literally visible to
        // agents (plain-text read faces round-trip it byte for byte) while never
        // entering the renderer's link branch. When the sigil is re-pointed at
        // the name namespace, this can become a canonical reference; until then a
        // producer of semantic names must not spell them like title references.
        const announce = tx.messages.insert({
          fromKind: 'system',
          content: oldName === null
            ? `This channel's address was set to \`#${input.name}\`. `
              + 'Update any references in your MEMORY.md when you next edit it.'
            : `This channel's address changed from \`#${oldName}\` to \`#${input.name}\`. `
              + `\`#${oldName}\` will never point anywhere else, so old references `
              + 'fail rather than reach the wrong channel — update any in your '
              + 'MEMORY.md when you next edit it.',
          metadata: {
            subtype: systemSubtype('conversation_name_changed'),
            old_name: oldName,
            new_name: input.name,
          },
        });
        return { channel: updated, announce };
      },
    );

    const { channel: updated, announce } = readdressed;
    if (!announce) return { channel: updated };

    // Same post-commit effects as a title rename, for the same reason: every
    // member agent must learn the new address (their MEMORY.md and their prompts
    // carry the old one), and every open UI must refetch the channel lists that
    // now report a different name.
    for (const ca of this.channels.listAgents(updated.id)) {
      await this.deliverBestEffort(
        updated.id,
        ca.agent_id,
        announce.id,
        'channel re-address delivery failed',
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
    const recipients = this.channels
      .listAgents(conversationId)
      .filter(ca => ca.status !== 'active' && ca.status !== 'starting');
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
