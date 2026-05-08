import type { Database as Db } from 'better-sqlite3';
import type {
  ChannelConversationDto,
  DmChannelDto,
  MessageDto,
} from '@silverhand/shared';
import type { BackendLogger } from '../context.js';
import type { ConversationManager } from '../conversation-manager.js';
import type { AgentRepo } from '../repos/agent-repo.js';
import type { ConversationRepo, RepoError } from '../repos/conversation-repo.js';
import type { MessageRepo } from '../repos/message-repo.js';
import type { WorkspaceRepo } from '../repos/workspace-repo.js';
import type { ScopeEventBus } from '../ws/scope-event-bus.js';
import type { AgentPrincipal, UserPrincipal } from '../auth/principal.js';

/**
 * ChannelService is the single owner of channel create / pin / unpin
 * business side effects. Routes translate auth and input shapes, then call
 * this service; they must not replicate inserts, member fan-out, agent
 * delivery/start, or `workspace_channels_changed` publishing.
 *
 * Contract:
 * - `createChannel` only targets regular workspaces.
 * - Every requested member must exist and already be a workspace member.
 * - Agent actors must be members of their source conversation, and that
 *   source conversation must belong to the target workspace.
 * - Agent routes explicitly snapshot `memberAgentIds` from the current
 *   conversation before calling the service. From a thread, that means thread
 *   members, not parent-channel members.
 * - Seed messages are agent-only.
 * - Channel create/pin/unpin publish `workspace_channels_changed` after the
 *   DB mutation commits.
 */

export type ChannelActor =
  | UserPrincipal
  | AgentPrincipal;

export interface CreateChannelInput {
  workspaceId: string;
  title: string;
  memberAgentIds: string[];
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

export interface SetPinnedInput {
  channelId: string;
  pinned: boolean;
}

export interface SetArchivedInput {
  channelId: string;
  archived: boolean;
}

export type WorkspaceUnsuitableCode =
  | 'workspace_not_found'
  | 'workspace_not_regular';

export class WorkspaceUnsuitableError extends Error {
  constructor(
    public readonly code: WorkspaceUnsuitableCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceUnsuitableError';
  }
}

export type MemberErrorCode =
  | 'agent_not_found'
  | 'agent_not_workspace_member';

export class MemberError extends Error {
  constructor(
    public readonly code: MemberErrorCode,
    public readonly agentId: string,
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
  | 'agent_workspace_mismatch';

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
  workspaces: WorkspaceRepo;
  agents: AgentRepo;
  messages: MessageRepo;
  events: ScopeEventBus;
  conversationManager: ConversationManager;
  logger: BackendLogger;
}

interface CreateChannelTxResult {
  channel: ChannelConversationDto;
  contextMsg: MessageDto | null;
  promptMsg: MessageDto | null;
}

export class ChannelService {
  private readonly db: Db;
  private readonly conversations: ConversationRepo;
  private readonly workspaces: WorkspaceRepo;
  private readonly agents: AgentRepo;
  private readonly messages: MessageRepo;
  private readonly events: ScopeEventBus;
  private readonly conversationManager: ConversationManager;
  private readonly logger: BackendLogger;

  constructor(opts: ChannelServiceOptions) {
    this.db = opts.db;
    this.conversations = opts.conversations;
    this.workspaces = opts.workspaces;
    this.agents = opts.agents;
    this.messages = opts.messages;
    this.events = opts.events;
    this.conversationManager = opts.conversationManager;
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

    const created = this.db.transaction((): CreateChannelTxResult => {
      const channel = this.conversations.insertChannel({
        workspaceId: workspace.id,
        workspacePath: workspace.workspace_path,
        title: input.title,
        spawnedByAgentId:
          input.actor.kind === 'agent' ? input.actor.agentId : null,
      });
      for (const memberId of memberAgentIds) {
        this.conversations.addAgent(channel.id, memberId);
      }

      let contextMsg: MessageDto | null = null;
      let promptMsg: MessageDto | null = null;
      if (input.seed && input.actor.kind === 'agent') {
        contextMsg = this.messages.insertForConversation({
          conversationId: channel.id,
          fromKind: 'system',
          content: input.seed.systemMessageBody,
          metadata: {
            subtype: 'channel_context',
            source_conversation_id: input.actor.conversationId,
            created_by_agent_id: input.actor.agentId,
          },
        });
        promptMsg = this.messages.insertForConversation({
          conversationId: channel.id,
          fromKind: 'agent',
          fromAgentId: input.actor.agentId,
          content: input.seed.initialPrompt,
        });
      }

      return { channel, contextMsg, promptMsg };
    })();

    this.publishWorkspaceChannelsChanged(workspace.id, created.channel.id);
    this.logger.info(
      {
        conversationId: created.channel.id,
        workspaceId: workspace.id,
        actorKind: input.actor.kind,
        actorId: input.actor.kind === 'agent' ? input.actor.agentId : input.actor.userId,
        memberCount: memberAgentIds.length,
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

  async setPinned(
    input: SetPinnedInput,
  ): Promise<{ channel: ChannelConversationDto | DmChannelDto }> {
    const existing = this.conversations.get(input.channelId);
    if (!existing) {
      throw repoError('not_found', 'channel not found');
    }
    if (existing.kind === 'thread') {
      throw repoError('thread', 'threads cannot be pinned');
    }

    const channel = input.pinned
      ? this.conversations.pin(input.channelId)
      : this.conversations.unpin(input.channelId);
    if (!channel) {
      throw repoError('not_found', 'channel not found');
    }
    this.publishWorkspaceChannelsChanged(channel.workspace_id, channel.id);
    return { channel };
  }

  async setArchived(
    input: SetArchivedInput,
  ): Promise<{ channel: ChannelConversationDto }> {
    const existing = this.conversations.get(input.channelId);
    if (!existing) {
      throw repoError('not_found', 'channel not found');
    }
    if (existing.kind !== 'channel') {
      throw repoError('not_archivable', 'only top-level channels can be archived');
    }

    const channel = this.conversations.setArchived(input.channelId, input.archived);
    if (!channel) {
      throw repoError('not_found', 'channel not found');
    }
    this.publishWorkspaceChannelsChanged(channel.workspace_id, channel.id);
    return { channel };
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
      await this.conversationManager.deliverMessage(conversationId, agentId, messageId);
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
          this.conversationManager.deliverMessage(
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
          this.conversationManager.start(conversationId, ca.agent_id).catch(err => {
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
