import {
  internalPaths,
  type AgentListChannelsDto,
  type AgentListWorkspacesDto,
  type AgentReadHistoryDto,
  type AgentReadHistoryInput,
  type AgentSearchMessagesDto,
  type AgentSearchMessagesInput,
  type AttachmentDto,
  type AttachmentLocateDto,
  type ClaimTasksInput,
  type ClaimTasksResult,
  type CreateTasksInput,
  type CreateTasksResult,
  type ScheduleCancelInput,
  type ScheduleCancelOutput,
  type ScheduleCreateInput,
  type ScheduleCreateOutput,
  type ScheduleListInput,
  type ScheduleListOutput,
  type SendMessageTarget,
  type TaskMutationResult,
  type TaskStatus,
  type TaskSummaryDto,
} from '@silverhand/shared';
import type { BridgeArgs } from './args.js';
import { log } from './logger.js';

export class BackendClient {
  constructor(private readonly args: BridgeArgs) {}

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.args.authToken}`,
      'X-Agent-Hub-Caller': 'chat-bridge',
      'Content-Type': 'application/json',
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.args.serverUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
      });
    } catch (err) {
      log('error', { url, err }, 'http: fetch threw (network unreachable?)');
      throw err;
    }
    if (!res.ok) {
      const text = await res.text();
      log('error', { url, status: res.status, body: text }, 'http: non-2xx');
      throw new Error(`POST ${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  private async get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const qs = query
      ? '?' +
        Object.entries(query)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&')
      : '';
    const url = `${this.args.serverUrl}${path}${qs}`;
    const res = await fetch(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      const text = await res.text();
      log('error', { url, status: res.status, body: text }, 'http: non-2xx');
      throw new Error(`GET ${path} failed: ${res.status} ${text}`);
    }
    return (await res.json()) as T;
  }

  sendMessage(input: {
    content: string;
    target?: SendMessageTarget;
    attachment_ids?: string[];
  }): Promise<{ message_id: string }> {
    return this.post(
      internalPaths.agentSendConversationMessage(
        this.args.conversationId,
        this.args.agentId,
      ),
      input,
    );
  }

  createThread(input: {
    title: string;
    members?: string[];
    context_summary: string;
    initial_prompt: string;
  }): Promise<{ thread_id: string }> {
    return this.post(
      internalPaths.agentCreateThread(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  createChannel(input: {
    title: string;
    context_summary: string;
    initial_prompt: string;
  }): Promise<{ channel_id: string }> {
    return this.post<{ channel_id: string }>(
      internalPaths.agentCreateChannel(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  closeThread(input: {
    summary: string;
    posted_to_parent?: boolean;
  }): Promise<{ thread: unknown }> {
    return this.post(
      internalPaths.agentCloseThread(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  readHistory(input: AgentReadHistoryInput): Promise<AgentReadHistoryDto> {
    return this.post(
      internalPaths.agentReadHistory(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  listWorkspaces(): Promise<AgentListWorkspacesDto> {
    return this.get(
      internalPaths.agentListWorkspaces(this.args.conversationId, this.args.agentId),
    );
  }

  listChannels(input: { workspace_id?: string } = {}): Promise<AgentListChannelsDto> {
    return this.get(
      internalPaths.agentListChannels(this.args.conversationId, this.args.agentId),
      { workspace_id: input.workspace_id },
    );
  }

  searchMessages(
    input: AgentSearchMessagesInput,
  ): Promise<AgentSearchMessagesDto> {
    return this.post(
      internalPaths.agentSearchMessages(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  // ── Task tools ──────────────────────────────────────────────────
  listTasks(filters: {
    workspace_id?: string;
    conversation_id?: string;
    status?: TaskStatus | 'all';
  }): Promise<{ tasks: TaskSummaryDto[] }> {
    return this.get(
      internalPaths.agentListConversationTasks(
        this.args.conversationId,
        this.args.agentId,
      ),
      {
        workspace_id: filters.workspace_id,
        conversation_id: filters.conversation_id,
        status: filters.status,
      },
    );
  }

  createTasks(input: CreateTasksInput): Promise<CreateTasksResult> {
    return this.post(
      internalPaths.agentCreateConversationTasks(
        this.args.conversationId,
        this.args.agentId,
      ),
      input,
    );
  }

  claimTasks(input: ClaimTasksInput): Promise<ClaimTasksResult> {
    return this.post(
      internalPaths.agentClaimConversationTasks(
        this.args.conversationId,
        this.args.agentId,
      ),
      input,
    );
  }

  unclaimTask(task_number: number): Promise<TaskMutationResult> {
    return this.post(
      internalPaths.agentUnclaimConversationTask(
        this.args.conversationId,
        this.args.agentId,
      ),
      { task_number },
    );
  }

  updateTaskStatus(input: {
    task_number: number;
    status: TaskStatus;
  }): Promise<TaskMutationResult> {
    return this.post(
      internalPaths.agentUpdateConversationTaskStatus(
        this.args.conversationId,
        this.args.agentId,
      ),
      input,
    );
  }

  // ── Schedule tools ──────────────────────────────────────────────
  // Per-agent surface; routes hang off the calling conversation only
  // for principal resolution, not for schedule ownership.
  createSchedule(input: ScheduleCreateInput): Promise<ScheduleCreateOutput> {
    return this.post(
      internalPaths.agentScheduleCreate(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  listSchedules(input: ScheduleListInput): Promise<ScheduleListOutput> {
    return this.post(
      internalPaths.agentScheduleList(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  cancelSchedule(input: ScheduleCancelInput): Promise<ScheduleCancelOutput> {
    return this.post(
      internalPaths.agentScheduleCancel(this.args.conversationId, this.args.agentId),
      input,
    );
  }

  // ── Attachment tools ────────────────────────────────────────────
  /** Upload a file the agent has on disk. Backend derives channel
   *  ownership from the calling conversation; agents never specify
   *  channel_id directly. */
  async uploadAttachment(input: {
    filename: string;
    contentType: string | null;
    buffer: Buffer;
  }): Promise<AttachmentDto> {
    const url =
      this.args.serverUrl
      + internalPaths.agentUploadAttachment(
        this.args.conversationId,
        this.args.agentId,
      );
    const form = new FormData();
    const blob = new Blob([input.buffer], {
      type: input.contentType ?? 'application/octet-stream',
    });
    form.append('file', blob, input.filename);
    let res: Response;
    try {
      // Bearer auth only — Content-Type is set automatically by FormData.
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.args.authToken}`,
          'X-Agent-Hub-Caller': 'chat-bridge',
        },
        body: form,
      });
    } catch (err) {
      log('error', { url, err }, 'http: upload fetch threw (network unreachable?)');
      throw err;
    }
    if (!res.ok) {
      const text = await res.text();
      log('error', { url, status: res.status, body: text }, 'http: upload non-2xx');
      throw new Error(`POST upload_file failed: ${res.status} ${text}`);
    }
    return (await res.json()) as AttachmentDto;
  }

  /** Locate an attachment by id. Backend enforces the attachment must
   *  belong to the agent's current channel; cross-channel ids return 404. */
  locateAttachment(attachmentId: string): Promise<AttachmentLocateDto> {
    return this.get(
      internalPaths.agentLocateAttachment(
        this.args.conversationId,
        this.args.agentId,
        attachmentId,
      ),
    );
  }
}
