/**
 * UpdateHost — the finalize decision reads ONLY its own transaction scope
 * (#task:1982 W5).
 *
 * The route this replaced decided "is this PATCH the finalize step?" from a
 * snapshot taken before the transaction. These tests inject a scope whose state
 * DISAGREES with such a snapshot in every direction, so a decision made from a
 * preflight read (rather than from the scope) produces a different, observable
 * outcome:
 *  - drift forward (the daemon attached after the preflight) must finalize;
 *  - drift already-done (someone else finalized) must not finalize twice;
 *  - drift to revoked / to another owner must refuse and write nothing.
 *
 * The last two tests use the PRODUCTION SQLite UnitOfWork to pin the two
 * properties a synthetic scope cannot show: the state read happens inside the
 * transaction, and the rename + finalize pair is atomic.
 */
import { describe, expect, it } from 'vitest';
import type { HostDto } from '@silverhand/shared';
import type {
  HostSetupPort,
  HostSetupState,
  HostTxScope,
  HostUnitOfWork,
} from '../../src/auth/host-ports.js';
import { HostRepo } from '../../src/repos/host-repo.js';
import { createSqliteHostPersistence } from '../../src/repos/host-uow.js';
import { updateHost } from '../../src/application/update-host.js';
import { openTestDb } from '../utils/db.js';

const OWNER = 'user-owner';

/**
 * The WIRE projection, not a row: since #task:1982 review round 3 the setup
 * write faces return `HostDto`, so a synthetic scope that handed back a physical
 * row would no longer type-check — which is the point of the change.
 */
function hostDto(over: Partial<HostDto> = {}): HostDto {
  return {
    id: 'host-1',
    name: 'host-1',
    kind: 'remote',
    created_at: 1700000000000,
    revoked_at: null,
    last_seen_at: null,
    activated_at: 1700000001000,
    finalized_at: null,
    connected_host_name: null,
    provisioning_source: 'user_invite',
    status: 'attached',
    placeable: false,
    creator_user_id: OWNER,
    display_label: null,
    ...over,
  };
}

/**
 * A scope that answers from `state` and records every write. `state` is what
 * the TRANSACTION sees; the test's own expectations describe what a stale
 * preflight would have seen instead.
 */
function scopeWith(state: HostSetupState | null) {
  const writes: Array<
    { call: 'updateDisplayLabel'; label: string | null } | { call: 'markFinalized' }
  > = [];
  let dto = hostDto({
    creator_user_id: state?.ownerUserId ?? OWNER,
    revoked_at: state?.revokedAt ?? null,
    activated_at: state?.activatedAt ?? null,
    finalized_at: state?.finalizedAt ?? null,
  });
  const setup: HostSetupPort = {
    getSetupStateForUpdate: () => state,
    updateDisplayLabel: (_hostId, label) => {
      writes.push({ call: 'updateDisplayLabel', label });
      dto = { ...dto, display_label: label };
      return dto;
    },
    markFinalized: (_hostId, finalizedAt) => {
      writes.push({ call: 'markFinalized' });
      dto = { ...dto, finalized_at: finalizedAt };
      return dto;
    },
  };
  const uow: HostUnitOfWork = {
    atomically: fn =>
      fn({
        setup,
        // Neither face belongs to this decision; a use would be a bug, not a
        // no-op.
        credentials: unreachable('credentials'),
        hosts: unreachable('hosts'),
      } as HostTxScope),
  };
  return { uow, writes, current: () => dto };
}

function unreachable(face: string): never {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`updateHost must not touch the ${face} face`);
      },
    },
  ) as never;
}

/** The whole dependency: no row type and no row → DTO callback reaches this use
 *  case any more (R4 — the port projects). */
const deps = (uow: HostUnitOfWork) => ({ uow });

const named = (displayLabel: string | null) =>
  ({ valid: true, displayLabel }) as const;

describe('updateHost — the decision comes from the transaction scope', () => {
  it('drift FORWARD: a preflight that saw pending-attach would 409, but the scope sees an activated host → finalize proceeds', () => {
    // Preflight snapshot: activated_at === null (the daemon had not attached
    // yet). Scope: it has. The pre-#1982 route would have answered
    // `host_pending_attach` from its stale read.
    const s = scopeWith({
      ownerUserId: OWNER,
      revokedAt: null,
      provisioningSource: 'user_invite',
      kind: 'remote',
      activatedAt: 1700000001000,
      finalizedAt: null,
    });
    const result = updateHost(deps(s.uow), {
      hostId: 'host-1',
      requesterUserId: OWNER,
      input: named('Studio'),
    });
    expect(result.kind).toBe('finalized');
    expect(s.writes).toEqual([
      { call: 'updateDisplayLabel', label: 'Studio' },
      { call: 'markFinalized' },
    ]);
    // The returned host IS what the port projected — the use case does not build
    // (or even see) a DTO of its own.
    if (result.kind !== 'finalized') return;
    expect(result.host).toEqual(s.current());
  });

  it('drift ALREADY-DONE: a preflight that saw an unfinalized host would finalize again, but the scope sees finalized_at set → plain rename, no second finalize', () => {
    const s = scopeWith({
      ownerUserId: OWNER,
      revokedAt: null,
      provisioningSource: 'user_invite',
      kind: 'remote',
      activatedAt: 1700000001000,
      finalizedAt: 1700000002000,
    });
    const result = updateHost(deps(s.uow), {
      hostId: 'host-1',
      requesterUserId: OWNER,
      // Blank would be refused on the finalize path; here it is the legal
      // clear-the-label rename — which is exactly the behavioral difference
      // between deciding from the scope and deciding from a stale snapshot.
      input: named(null),
    });
    expect(result.kind).toBe('renamed');
    expect(s.writes).toEqual([{ call: 'updateDisplayLabel', label: null }]);
  });

  it('drift to REVOKED: the scope refuses and writes nothing, whatever the preflight said', () => {
    const s = scopeWith({
      ownerUserId: OWNER,
      revokedAt: 1700000003000,
      provisioningSource: 'user_invite',
      kind: 'remote',
      activatedAt: 1700000001000,
      finalizedAt: null,
    });
    expect(
      updateHost(deps(s.uow), {
        hostId: 'host-1',
        requesterUserId: OWNER,
        input: named('Studio'),
      }).kind,
    ).toBe('revoked');
    expect(s.writes).toEqual([]);
  });

  it('the scope decides identity: another owner, or a vanished row, is notFound — and an invalid body does not change that answer', () => {
    for (const state of [
      {
        ownerUserId: 'someone-else',
        revokedAt: null,
        provisioningSource: 'user_invite' as const,
        kind: 'remote' as const,
        activatedAt: 1700000001000,
        finalizedAt: null,
      },
      null,
    ]) {
      const s = scopeWith(state);
      expect(
        updateHost(deps(s.uow), {
          hostId: 'host-1',
          requesterUserId: OWNER,
          input: named('Studio'),
        }).kind,
      ).toBe('notFound');
      // Identity is settled before the body's shape is discussed: a 400 here
      // would confirm the host exists.
      expect(
        updateHost(deps(s.uow), {
          hostId: 'host-1',
          requesterUserId: OWNER,
          input: { valid: false },
        }).kind,
      ).toBe('notFound');
      expect(s.writes).toEqual([]);
    }
  });

  it('an owner with an invalid body gets invalidInput and no write; a blank label on the finalize path gets labelRequired', () => {
    const finalizable = {
      ownerUserId: OWNER,
      revokedAt: null,
      provisioningSource: 'user_invite' as const,
      kind: 'remote' as const,
      activatedAt: 1700000001000,
      finalizedAt: null,
    };
    const invalid = scopeWith(finalizable);
    expect(
      updateHost(deps(invalid.uow), {
        hostId: 'host-1',
        requesterUserId: OWNER,
        input: { valid: false },
      }).kind,
    ).toBe('invalidInput');
    expect(invalid.writes).toEqual([]);

    for (const label of [null, '   ']) {
      const blank = scopeWith(finalizable);
      expect(
        updateHost(deps(blank.uow), {
          hostId: 'host-1',
          requesterUserId: OWNER,
          input: named(label),
        }).kind,
      ).toBe('labelRequired');
      expect(blank.writes).toEqual([]);
    }
  });

  it('an app-installed or already-finalized host takes the rename path — the finalize predicate is provisioning_source + kind + finalized_at, all read in scope', () => {
    for (const drift of [
      { provisioningSource: 'app_install' as const, kind: 'remote' as const },
      { provisioningSource: 'user_invite' as const, kind: 'local' as const },
    ]) {
      const s = scopeWith({
        ownerUserId: OWNER,
        revokedAt: null,
        activatedAt: 1700000001000,
        finalizedAt: null,
        ...drift,
      });
      // Blank label proves we are NOT on the finalize path (which refuses it).
      expect(
        updateHost(deps(s.uow), {
          hostId: 'host-1',
          requesterUserId: OWNER,
          input: named(null),
        }).kind,
      ).toBe('renamed');
      expect(s.writes).toEqual([{ call: 'updateDisplayLabel', label: null }]);
    }
  });
});

describe('updateHost on the production SQLite UnitOfWork', () => {
  function bootstrap() {
    // The seeded viewer owns the invite — a synthetic owner id would fail the
    // `hosts.user_id` foreign key.
    const { db, viewerUserId } = openTestDb();
    const hosts = new HostRepo(db);
    const invited = hosts.createUserInvite({ userId: viewerUserId });
    hosts.markActivated(invited.id, 1700000001000);
    const persistence = createSqliteHostPersistence(db);
    return { db, hosts, owner: viewerUserId, hostId: invited.id, uow: persistence.uow };
  }

  it('reads the setup state INSIDE the transaction, and commits rename + finalize together', () => {
    const t = bootstrap();
    const readInTransaction: boolean[] = [];
    const observed: HostUnitOfWork = {
      atomically: fn =>
        t.uow.atomically(tx =>
          fn({
            ...tx,
            setup: {
              ...tx.setup,
              getSetupStateForUpdate: hostId => {
                readInTransaction.push(t.db.inTransaction);
                return tx.setup.getSetupStateForUpdate(hostId);
              },
            },
          }),
        ),
    };

    const result = updateHost(
      { uow: observed },
      { hostId: t.hostId, requesterUserId: t.owner, input: named('Studio') },
    );

    expect(result.kind).toBe('finalized');
    // The load-bearing property: the state the decision used was read with the
    // transaction open, not before it.
    expect(readInTransaction).toEqual([true]);
    const row = t.hosts.get(t.hostId);
    expect(row?.display_label).toBe('Studio');
    expect(row?.finalized_at).not.toBeNull();
  });

  it('a finalize write that throws rolls the rename back — the pair is one commit', () => {
    const t = bootstrap();
    const failing: HostUnitOfWork = {
      atomically: fn =>
        t.uow.atomically(tx =>
          fn({
            ...tx,
            setup: {
              ...tx.setup,
              markFinalized: () => {
                throw new Error('finalize-blows-up');
              },
            },
          }),
        ),
    };

    expect(() =>
      updateHost(
        { uow: failing },
        { hostId: t.hostId, requesterUserId: t.owner, input: named('Studio') },
      ),
    ).toThrow('finalize-blows-up');

    const row = t.hosts.get(t.hostId);
    expect(row?.display_label).toBeNull();
    expect(row?.finalized_at).toBeNull();
  });
});
