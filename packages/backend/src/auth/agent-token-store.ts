import { randomBytes } from 'node:crypto';

export type AgentTokenVerifyResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'missing' | 'unknown' | 'revoked' | 'principal_mismatch';
    };

interface AgentTokenRecord {
  token: string;
  conversationId: string;
  agentId: string;
  issuedAt: number;
  revokedAt: number | null;
}

/**
 * Per-backend-process token store for agent-initiated internal requests.
 *
 * Tokens are scoped to one (conversationId, agentId) runtime launch and are
 * revoked when that launch exits. This carries the old MCP process-binding
 * property into the CLI path: changing SILVERHAND_CONVERSATION_ID or
 * SILVERHAND_AGENT_ID in bash is not enough to gain another principal.
 */
export class AgentTokenStore {
  private readonly records = new Map<string, AgentTokenRecord>();
  private readonly tokensByPrincipal = new Map<string, Set<string>>();

  issue(conversationId: string, agentId: string): string {
    const token = randomBytes(32).toString('base64url');
    const record: AgentTokenRecord = {
      token,
      conversationId,
      agentId,
      issuedAt: Date.now(),
      revokedAt: null,
    };
    this.records.set(token, record);
    const key = principalKey(conversationId, agentId);
    let tokens = this.tokensByPrincipal.get(key);
    if (!tokens) {
      tokens = new Set();
      this.tokensByPrincipal.set(key, tokens);
    }
    tokens.add(token);
    return token;
  }

  verify(
    token: string | null | undefined,
    conversationId: string,
    agentId: string,
  ): AgentTokenVerifyResult {
    if (!token) return { ok: false, reason: 'missing' };
    const record = this.records.get(token);
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
    if (record.conversationId !== conversationId || record.agentId !== agentId) {
      return { ok: false, reason: 'principal_mismatch' };
    }
    return { ok: true };
  }

  revoke(token: string | null | undefined): void {
    if (!token) return;
    const record = this.records.get(token);
    if (!record || record.revokedAt !== null) return;
    record.revokedAt = Date.now();
    const tokens = this.tokensByPrincipal.get(
      principalKey(record.conversationId, record.agentId),
    );
    tokens?.delete(token);
  }

  revokeFor(conversationId: string, agentId: string): void {
    const key = principalKey(conversationId, agentId);
    const tokens = this.tokensByPrincipal.get(key);
    if (!tokens) return;
    for (const token of Array.from(tokens)) this.revoke(token);
    this.tokensByPrincipal.delete(key);
  }
}

function principalKey(conversationId: string, agentId: string): string {
  return `${conversationId}:${agentId}`;
}
