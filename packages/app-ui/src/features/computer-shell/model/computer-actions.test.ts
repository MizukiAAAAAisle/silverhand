import { describe, expect, it } from "vitest";
import type { HostDto } from "@silverhand/shared";
import { computerActions, type ComputerActionsInput } from "./computer-actions";

const VIEWER = "viewer-1";
const CURRENT = "host-current";
const OTHER = "host-other";

function makeHost(overrides: Partial<HostDto>): HostDto {
  return {
    id: OTHER,
    name: "other",
    kind: "remote",
    created_at: 0,
    revoked_at: null,
    last_seen_at: null,
    activated_at: 0,
    finalized_at: 0,
    connected_host_name: null,
    provisioning_source: "user_invite",
    status: "active",
    placeable: true,
    creator_user_id: VIEWER,
    display_label: null,
    ...overrides,
  } as HostDto;
}

function run(input: Partial<ComputerActionsInput> & { host: HostDto }) {
  return computerActions({
    viewerId: VIEWER,
    currentLocalHostId: CURRENT,
    ...input,
  });
}

describe("computerActions — four-matrix invariants", () => {
  it("current app-managed → refresh + revoke (no connection, no delete)", () => {
    const result = run({
      host: makeHost({
        id: CURRENT,
        provisioning_source: "app_install",
      }),
    });
    expect(result).toEqual({
      connection: false,
      delete: false,
      refresh: true,
      revoke: true,
    });
  });

  it("other app-managed → revoke only (no refresh — refresh needs current-host)", () => {
    const result = run({
      host: makeHost({
        id: OTHER,
        provisioning_source: "app_install",
      }),
    });
    expect(result).toEqual({
      connection: false,
      delete: false,
      refresh: false,
      revoke: true,
    });
  });

  it("user-managed non-revoked → connection + delete (no refresh, no revoke)", () => {
    const result = run({
      host: makeHost({
        id: OTHER,
        provisioning_source: "user_invite",
      }),
    });
    expect(result).toEqual({
      connection: true,
      delete: true,
      refresh: false,
      revoke: false,
    });
  });

  it("revoked host → no credential/lifecycle mutation (any provisioning source)", () => {
    for (const source of ["app_install", "user_invite", "system"] as const) {
      // Both possible revoked signals — `status: 'revoked'` and non-null
      // `revoked_at` — should be terminal on their own.
      for (const revokedShape of [
        { status: "revoked" as const, revoked_at: null },
        { status: "active" as const, revoked_at: 1_000 },
      ]) {
        const result = run({
          host: makeHost({
            id: CURRENT,
            provisioning_source: source,
            ...revokedShape,
          }),
        });
        expect(result).toEqual({
          connection: false,
          delete: false,
          refresh: false,
          revoke: false,
        });
      }
    }
  });
});

describe("computerActions — ownership & current-host gates", () => {
  it("non-owner sees no mutations, even on their current host", () => {
    const result = run({
      host: makeHost({
        id: CURRENT,
        provisioning_source: "app_install",
        creator_user_id: "someone-else",
      }),
    });
    expect(result).toEqual({
      connection: false,
      delete: false,
      refresh: false,
      revoke: false,
    });
  });

  it("unauthenticated viewer sees no mutations", () => {
    const result = computerActions({
      host: makeHost({ id: CURRENT, provisioning_source: "app_install" }),
      viewerId: null,
      currentLocalHostId: CURRENT,
    });
    expect(result).toEqual({
      connection: false,
      delete: false,
      refresh: false,
      revoke: false,
    });
  });

  it("app-managed current-host with no local session (currentLocalHostId=null) → revoke only", () => {
    const result = run({
      host: makeHost({ id: CURRENT, provisioning_source: "app_install" }),
      currentLocalHostId: null,
    });
    // Refresh needs an active local session to target; without one, the
    // action is not offerable. Revoke is still coherent (control-plane
    // authoritative, offline-completable per doc §4.2).
    expect(result).toEqual({
      connection: false,
      delete: false,
      refresh: false,
      revoke: true,
    });
  });

  it("active `system` row fails closed to NONE — not silently app-managed", () => {
    // Falsifier: a backend-placeholder host (e.g. `ensureStandaloneServer`)
    // is owned by the viewer and non-revoked, but has no daemon config to
    // rotate and no revoke-preserves-agents semantics. A `!== 'user_invite'`
    // discriminator would have categorized it as app-managed and rendered
    // Refresh/Revoke over it; the exact `app_install` match keeps it clean.
    const result = run({
      host: makeHost({
        id: CURRENT,
        provisioning_source: "system",
      }),
    });
    expect(result).toEqual({
      connection: false,
      delete: false,
      refresh: false,
      revoke: false,
    });
  });

  it("user-managed and app-managed action sets never overlap", () => {
    for (const provisioning_source of ["user_invite", "app_install"] as const) {
      const result = run({
        host: makeHost({ id: CURRENT, provisioning_source }),
      });
      const userSet = result.connection || result.delete;
      const appSet = result.refresh || result.revoke;
      expect(userSet && appSet).toBe(false);
    }
  });
});
