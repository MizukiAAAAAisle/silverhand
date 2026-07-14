import type { Database as Db } from 'better-sqlite3';
import {
  type ChannelConversationDto,
  type ConversationVisibility,
  type DmChannelDto,
  type MessageDto,
  systemSubtype,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { AgentRuntimeHost } from '../runtime/agent-runtime-host.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo, RepoError } from '../repos/conversation-repo.js';
import type { ConversationReadRepo } from '../repos/conversation-read-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import { publishUnreadUpdatedToConversationViewers } from '../viewer-scope.js';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal.js';

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
 * other failure (workspace missing / not agent_home / a transaction
 * SqliteError) is left to surface as a generic 500.
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
  | 'agent_cannot_create_public';

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
  db: Db;
  conversations: ConversationRepo;
  conversationReads: ConversationReadRepo;
  workspaces: WorkspaceRepo;
  agents: AgentRepo;
  messages: MessageRepo;
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
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly conversationReads: ConversationReadRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly agents: AgentRepo;
  private readonly messages: MessageRepo;
  private readonly events: ScopeEventBus;
  private readonly runtimeHost: AgentRuntimeHost;
  private readonly logger: BackendLogger;

  constructor(opts: ChannelServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.conversationReads = opts.conversationReads;
    this.workspaces = opts.workspaces;
    this.agents = opts.agents;
    this.messages = opts.messages;
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
      const sourceConversation = this.conversations.get(input.actor.conversationId);
      if (!sourceConversation) {
        throw new ActorError(
          'source_conversation_not_found',
          'source conversation not found',
        );
      }
      if (!this.conversations.getAgent(input.actor.conversationId, input.actor.agentId)) {
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

    const created = this.db.transaction((): CreateChannelTxResult => {
      const channel = this.conversations.insertChannel({
        workspaceId: workspace.id,
        workspacePath: workspace.workspace_path,
        title: input.title,
        spawnedByAgentId:
          input.actor.kind === 'agent' ? input.actor.agentId : null,
        visibility: input.visibility,
      });
      for (const memberId of memberAgentIds) {
        this.conversations.addAgent(channel.id, memberId);
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
        ? this.conversations
            .listUsers(input.actor.conversationId)
            .map(u => u.user_id)
        : Array.from(
            new Set([input.actor.userId, ...(explicitUserMemberIds ?? [])]),
          );
      for (const userId of userMemberIds) {
        this.conversations.addUser(channel.id, userId);
      }

      let contextMsg: MessageDto | null = null;
      let promptMsg: MessageDto | null = null;
      if (input.seed && input.actor.kind === 'agent') {
        // Snapshot source identity at insert time so the renderer can
        // draw the Spawned-from chip without a follow-up join, even if
        // the source conversation or agent is later renamed/archived.
        const sourceConv = this.conversations.get(input.actor.conversationId);
        const sourceAgent = this.agents.get(input.actor.agentId);
        contextMsg = this.messages.insertForConversation({
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
        promptMsg = this.messages.insertForConversation({
          conversationId: channel.id,
          fromKind: 'agent',
          fromAgentId: input.actor.agentId,
          content: input.seed.initialPrompt,
        });
      }

      return { channel, contextMsg, promptMsg, humanMemberCount: userMemberIds.length };
    })();

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

    const channel = this.db.transaction((): DmChannelDto => {
      const dm = this.conversations.insertDmChannel({
        workspaceId: workspace.id,
        workspacePath: workspace.workspace_path,
        title: input.title,
        agentId: owner.id,
      });
      this.conversations.addAgent(dm.id, owner.id);
      // Human membership for the freshly-created DM: the creating user is a
      // workspace member (the admin gate already passed), so they are a
      // legitimate member of their own new DM. Without this row a follow-up
      // GET /messages would 403 for the same principal that just created it.
      if (input.actor.kind === 'user') {
        this.conversations.addUser(dm.id, input.actor.userId);
      }
      return dm;
    })();

    this.publishWorkspaceChannelsChanged(workspace.id, channel.id);
    return { channel };
  }

  async setArchived(
    input: SetArchivedInput,
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    const existing = this.conversations.get(input.channelId);
    if (!existing) {
      throw repoError('not_found', 'channel not found');
    }

    const updated = this.conversations.setArchived(
      input.channelId,
      input.archived,
    );
    if (!updated) {
      throw repoError('not_found', 'channel not found');
    }

    // Archiving a channel terminates its agent runtime: an agent still working
    // in an archived channel is doing meaningless work. Stop is best-effort and
    // async (the host may be offline), so "archived ⇒ no runtime" is an eventual
    // state, not an instant invariant — which is exactly why the runtime-state
    // *control-plane* callers (Stop-all, delete-agent purge) keep the COMPLETE
    // conversation view (`listRuntimeConversations` without `excludeArchived`):
    // a straggler runtime left here must still be reachable to stop/purge. Only
    // the display roster excludes archived (see agent-repo). (#task:1398)
    if (input.archived) {
      this.runtimeHost.resolveConversationRuns(updated.id, 'conversation_closed');
      for (const ca of this.conversations.listAgents(updated.id)) {
        void this.runtimeHost.stop(updated.id, ca.agent_id, 'hard').catch(err =>
          this.logger.warn(
            { channelId: updated.id, agentId: ca.agent_id, err },
            'archive channel: runtime stop failed (continuing)',
          ),
        );
      }
    }

    this.publishWorkspaceChannelsChanged(
      updated.workspace_id,
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
    publishUnreadUpdatedToConversationViewers(
      this.events,
      this.conversations,
      this.conversationReads,
      updated.id,
    );
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
   * The title write and the `rename` system-message insert run in a
   * single transaction (better-sqlite3 nests the insert's own
   * transaction via a savepoint) so a failed broadcast can never leave
   * a renamed channel with no audit/notification row. Delivery and the
   * `workspace_channels_changed` publish are post-commit side effects.
   */
  async renameChannel(
    input: RenameChannelInput,
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    const existing = this.conversations.get(input.channelId);
    if (!existing) {
      throw repoError('not_found', 'channel not found');
    }

    const oldTitle = existing.title;
    if (input.title === oldTitle) {
      // No-op: nothing changed, so emit nothing. Re-fetch through the
      // channel-like getter to narrow `existing` (the wider
      // ConversationDto) to a ChannelConversationDto | DmChannelDto.
      const channel = this.conversations.getChannelLike(input.channelId);
      if (!channel) {
        throw repoError('not_found', 'channel not found');
      }
      return { channel };
    }

    const { updated, announce } = this.db.transaction(() => {
      const updated = this.conversations.updateTitle(input.channelId, input.title);
      if (!updated) {
        throw repoError('not_found', 'channel not found');
      }
      const announce = this.messages.insertForConversation({
        conversationId: updated.id,
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
      return { updated, announce };
    })();

    for (const ca of this.conversations.listAgents(updated.id)) {
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
    this.publishWorkspaceChannelsChanged(updated.workspace_id, updated.id);
    return { channel: updated };
  }

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
    const recipients = this.conversations
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
    const recipients = this.conversations
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

function repoError(code: string, message: string): RepoError {
  const err = new Error(message) as RepoError;
  err.code = code;
  return err;
}
