import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ServerFrame } from "@silverhand/shared";

vi.mock("@/features/workspaces/hooks", () => ({ useWorkspaces: vi.fn() }));
vi.mock("@/lib/ws-client", () => ({}));
import { relatedUsersChanged, relatedUsersKey, resetRelatedUsers } from "./related-users";

const scopes = new Set(["workspace:owned"]);
function event(scope: string, kind: string, payload: unknown): ServerFrame {
  return { type: "event", scope, kind, payload, seq: 1, epoch: "test" } as ServerFrame;
}

describe("related humans invalidation", () => {
  it.each([
    ["workspace:owned", "workspace_members_changed", { workspace_id: "owned" }, true],
    ["workspace:other", "workspace_members_changed", { workspace_id: "other" }, false],
    ["workspace:owned", "workspace_members_changed", { workspace_id: "other" }, false],
    ["viewer:me", "viewer_workspaces_changed", { change: "removed" }, true],
    ["viewer:other", "viewer_workspaces_changed", {}, false],
    ["app", "user_changed", { user_id: "peer" }, true],
  ] as const)("matches %s / %s to the precise authority", (scope, kind, payload, expected) => {
    expect(relatedUsersChanged(event(scope, kind, payload), "me", scopes)).toBe(expected);
  });

  it("refetches on replay gaps and scoped loss of authority", () => {
    for (const scope of ["app", "viewer:me", "workspace:owned"]) {
      const frame = { type: "snapshot_required", scope } as ServerFrame;
      expect(relatedUsersChanged(frame, "me", scopes)).toBe(true);
    }
    for (const scope of ["workspace:owned", "workspace:other"]) {
      const frame: ServerFrame = { type: "error", code: "forbidden", scope, message: "denied" };
      expect(relatedUsersChanged(frame, "me", scopes)).toBe(scope === "workspace:owned");
    }
  });

  it("drops revoked rows and ignores an old pending response without touching another viewer", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(relatedUsersKey("other"), { users: ["other-peer"] });
    qc.setQueryData(relatedUsersKey("me"), { users: ["revoked"] });
    let finishOld!: (value: { users: string[] }) => void;
    let calls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: relatedUsersKey("me"),
      queryFn: () => {
        if (++calls === 1) {
          return new Promise<{ users: string[] }>((resolve) => { finishOld = resolve; });
        }
        return Promise.resolve({ users: [] });
      },
    });
    const unsubscribe = observer.subscribe(() => {});

    await resetRelatedUsers(qc, "me");
    expect(qc.getQueryData(relatedUsersKey("me"))).toEqual({ users: [] });
    finishOld({ users: ["revoked"] });
    await Promise.resolve();
    await Promise.resolve();
    expect(qc.getQueryData(relatedUsersKey("me"))).toEqual({ users: [] });
    expect(qc.getQueryData(relatedUsersKey("other"))).toEqual({ users: ["other-peer"] });

    unsubscribe();
    qc.clear();
  });
});
