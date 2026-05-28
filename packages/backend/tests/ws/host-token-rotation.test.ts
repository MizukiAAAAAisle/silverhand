import { describe, expect, it } from 'vitest';
import type {
  OutboundServerCommandKind,
  OutboundServerCommandParams,
  OutboundServerCommandResult,
} from '@silverhand/host';
import {
  HOST_TOKEN_ROTATION_GRACE_MS,
  HostTokenService,
  hashHostToken,
} from '../../src/auth/host-token.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import {
  HostTokenRotationCoordinator,
  HostTokenRotationError,
} from '../../src/ws/host-token-rotation.js';
import type { HostWsServerController } from '../../src/ws/host-ws-server.js';
import type { BackendLogger } from '../../src/context.js';
import { openTestDb } from '../utils/db.js';

describe('HostTokenRotationCoordinator', () => {
  it('marks the old credential grace only after daemon confirms config refresh', async () => {
    const { db, viewerUserId } = openTestDb();
    const host = new HostRepo(db).create('owned-local', 'local', {
      userId: viewerUserId,
      installationId: 'installation-rotation',
    });
    const tokens = new HostTokenService(db);
    const old = tokens.issueHostToken({ hostId: host.id });
    const now = 1_700_000_000_000;
    const transport = new FakeHostWsController(async call => {
      expect(call.kind).toBe('rotate_token');
      expect(call.params).toMatchObject({
        host_id: host.id,
        issued_at: now,
        grace_until: now + HOST_TOKEN_ROTATION_GRACE_MS,
      });
      expect(call.params.host_token).not.toBe(old.hostToken);
      expect(credentialCount(db, host.id)).toBe(1);
      return {
        rotated: true,
        host_id: host.id,
        config_refreshed_at: now + 25,
      };
    });
    const coordinator = new HostTokenRotationCoordinator({
      hostTokens: tokens,
      transport,
      logger: testLogger,
      now: () => now,
    });

    const result = await coordinator.rotateHostToken(host.id);

    expect(result).toMatchObject({
      hostId: host.id,
      issuedAt: now,
      graceUntil: now + HOST_TOKEN_ROTATION_GRACE_MS,
      configRefreshedAt: now + 25,
    });
    expect(result.issued.hostToken).not.toBe(old.hostToken);
    expect(transport.calls).toHaveLength(1);
    expect(credentialCount(db, host.id)).toBe(2);

    const rows = db
      .prepare<
        [string],
        {
          token_hash: string;
          consumed_at: number | null;
          revoked_at: number | null;
        }
      >(
        `SELECT token_hash, consumed_at, revoked_at
           FROM host_credentials
          WHERE host_id = ?
          ORDER BY rowid ASC`,
      )
      .all(host.id);
    const oldRow = rows.find(row => row.token_hash === hashHostToken(old.hostToken));
    const newRow = rows.find(row =>
      row.token_hash === hashHostToken(result.issued.hostToken),
    );
    expect(oldRow).toMatchObject({
      consumed_at: now,
      revoked_at: now + HOST_TOKEN_ROTATION_GRACE_MS,
    });
    expect(newRow).toMatchObject({
      consumed_at: null,
      revoked_at: null,
    });
    expect(tokens.verifyHostToken(old.hostToken, {
      now: now + HOST_TOKEN_ROTATION_GRACE_MS - 1,
    })).toMatchObject({ ok: true, hostId: host.id });
    expect(tokens.verifyHostToken(old.hostToken, {
      now: now + HOST_TOKEN_ROTATION_GRACE_MS + 1,
    })).toEqual({ ok: false, code: 'credential_expired' });
    expect(tokens.verifyHostToken(result.issued.hostToken, {
      now: now + HOST_TOKEN_ROTATION_GRACE_MS + 1,
    })).toMatchObject({ ok: true, hostId: host.id });
  });

  it('leaves credential rows unchanged when daemon write fails', async () => {
    const { db, viewerUserId } = openTestDb();
    const host = new HostRepo(db).create('owned-local', 'local', {
      userId: viewerUserId,
      installationId: 'installation-rotation-fail',
    });
    const tokens = new HostTokenService(db);
    const old = tokens.issueHostToken({ hostId: host.id });
    const beforeRows = credentialRows(db, host.id);
    const transport = new FakeHostWsController(async () => ({
      rotated: false,
      reason: 'write_failed',
      message: 'EACCES',
    }));
    const coordinator = new HostTokenRotationCoordinator({
      hostTokens: tokens,
      transport,
      logger: testLogger,
      now: () => 1_700_000_000_000,
    });

    await expect(coordinator.rotateHostToken(host.id)).rejects.toMatchObject({
      code: 'daemon_rejected',
    } satisfies Partial<HostTokenRotationError>);

    expect(credentialRows(db, host.id)).toEqual(beforeRows);
    expect(tokens.verifyHostToken(old.hostToken)).toMatchObject({
      ok: true,
      hostId: host.id,
    });
  });
});

class FakeHostWsController implements HostWsServerController {
  readonly calls: Array<{
    hostId: string;
    kind: OutboundServerCommandKind;
    params: any;
  }> = [];

  constructor(
    private readonly handler: (call: {
      hostId: string;
      kind: OutboundServerCommandKind;
      params: any;
    }) => Promise<unknown>,
  ) {}

  activeConnectionCount(): number {
    return 1;
  }

  connectedHostIds(): string[] {
    return ['host'];
  }

  connectionIdForHost(): string | null {
    return 'conn-1';
  }

  getAttachment(): null {
    // Token-rotation tests don't depend on the attachment registry.
    return null;
  }

  async sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
  ): Promise<OutboundServerCommandResult<K>> {
    const call = { hostId, kind, params };
    this.calls.push(call);
    return await this.handler(call) as OutboundServerCommandResult<K>;
  }

  // D4.c C2 — token-rotation tests don't drive the revoke route, so
  // disconnectHost is a no-op stub for type-shape only.
  disconnectHost(_hostId: string): boolean {
    return false;
  }

  async close(): Promise<void> {
    // no-op
  }
}

const testLogger: BackendLogger = {
  info() {},
  warn() {},
  error() {},
};

function credentialCount(db: ReturnType<typeof openTestDb>['db'], hostId: string): number {
  return db
    .prepare<[string], { c: number }>(
      `SELECT COUNT(*) AS c FROM host_credentials WHERE host_id = ?`,
    )
    .get(hostId)!.c;
}

function credentialRows(
  db: ReturnType<typeof openTestDb>['db'],
  hostId: string,
): Array<Record<string, unknown>> {
  return db
    .prepare<[string], Record<string, unknown>>(
      `SELECT id, host_id, token_hash, kind, expires_at, consumed_at, revoked_at
         FROM host_credentials
        WHERE host_id = ?
        ORDER BY rowid ASC`,
    )
    .all(hostId);
}
