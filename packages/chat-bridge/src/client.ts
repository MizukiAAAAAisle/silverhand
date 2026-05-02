import { internalPaths, type SendMessageTarget } from '@silverhand/shared';
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

  sendMessage(input: {
    content: string;
    target?: SendMessageTarget;
  }): Promise<{ message_id: string }> {
    return this.post(
      internalPaths.agentSendMessage(this.args.sessionId, this.args.agentId),
      input,
    );
  }

  spawnChildSession(input: {
    title: string;
    members: string[];
    context_summary: string;
    initial_prompt: string;
  }): Promise<{ child_session_id: string }> {
    return this.post(
      internalPaths.agentSpawnChild(this.args.sessionId, this.args.agentId),
      input,
    );
  }

  closeSession(input: {
    summary: string;
    posted_to_parent?: boolean;
  }): Promise<{ session: unknown }> {
    return this.post(
      internalPaths.agentCloseSession(this.args.sessionId, this.args.agentId),
      input,
    );
  }
}
