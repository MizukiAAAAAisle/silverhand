import {
  internalPaths,
  type ClaimTasksInput,
  type ClaimTasksResult,
  type CreateTasksInput,
  type CreateTasksResult,
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
}
