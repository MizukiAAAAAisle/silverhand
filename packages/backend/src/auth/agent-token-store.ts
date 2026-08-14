import { randomBytes } from 'node:crypto';
import {
  copyRuntimePrincipal,
  runtimePrincipalKey,
  type RuntimePrincipal,
} from './runtime-principal.js';

export type AgentTokenVerifyResult =
  | { ok: true; principal: RuntimePrincipal }
  | {
      ok: false;
      reason: 'missing' | 'unknown' | 'revoked';
    };

interface AgentTokenRecord {
  token: string;
  principal: RuntimePrincipal;
  issuedAt: number;
  revokedAt: number | null;
}

/**
 * Per-backend-process token store for agent-initiated internal requests.
 *
 * This store proves bearer secrecy only. Each record contains the complete
 * discriminated runtime principal; the request verifier separately checks that
 * its custody generation is still current in `agent_runtime_slots`.
 */
export class AgentTokenStore {
  private readonly records = new Map<string, AgentTokenRecord>();
  private readonly tokensByPrincipal = new Map<string, Set<string>>();

  issue(principal: RuntimePrincipal): string {
    const token = randomBytes(32).toString('base64url');
    const record: AgentTokenRecord = {
      token,
      principal: copyRuntimePrincipal(principal),
      issuedAt: Date.now(),
      revokedAt: null,
    };
    this.records.set(token, record);
    const key = runtimePrincipalKey(principal);
    let tokens = this.tokensByPrincipal.get(key);
    if (!tokens) {
      tokens = new Set();
      this.tokensByPrincipal.set(key, tokens);
    }
    tokens.add(token);
    return token;
  }

  verify(token: string | null | undefined): AgentTokenVerifyResult {
    if (!token) return { ok: false, reason: 'missing' };
    const record = this.records.get(token);
    if (!record) return { ok: false, reason: 'unknown' };
    if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
    return { ok: true, principal: copyRuntimePrincipal(record.principal) };
  }

  /** Whether this backend process still owns a usable bearer for an exact
   * principal. DB custody cannot recreate a secret injected into a live child. */
  hasActiveFor(principal: RuntimePrincipal): boolean {
    const tokens = this.tokensByPrincipal.get(runtimePrincipalKey(principal));
    if (!tokens) return false;
    for (const token of tokens) {
      const record = this.records.get(token);
      if (record && record.revokedAt === null) return true;
    }
    return false;
  }

  revoke(token: string | null | undefined): void {
    if (!token) return;
    const record = this.records.get(token);
    if (!record || record.revokedAt !== null) return;
    record.revokedAt = Date.now();
    const tokens = this.tokensByPrincipal.get(
      runtimePrincipalKey(record.principal),
    );
    tokens?.delete(token);
  }

  revokeFor(principal: RuntimePrincipal): void {
    const key = runtimePrincipalKey(principal);
    const tokens = this.tokensByPrincipal.get(key);
    if (!tokens) return;
    for (const token of Array.from(tokens)) this.revoke(token);
    this.tokensByPrincipal.delete(key);
  }
}
