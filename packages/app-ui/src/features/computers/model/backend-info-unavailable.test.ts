import { vi } from "vitest";
let snapshotValue: unknown = null;
vi.mock("@/platform", () => ({
  getPlatform: () => ({
    client: { getConnectionInfo: async () => snapshotValue },
    localHost: { getSnapshot: async () => snapshotValue },
  }),
}));
/**
 * `#task:1630` forward fix — "no BackendInfo yet" must stay unknown.
 *
 * `backend:info` answers `null` while desktop main has no backend handle
 * (window painted before bootstrap finished). The first version of the
 * discriminated attachment surface synthesised a snapshot for that
 * moment: `{mode:'embedded', local_host_status:'error',
 * local_host_ws_attachment:{observable:false}}`. Two visible
 * consequences, both from that one fabrication (Cindy + Norman review):
 *
 *   - `{observable:false}` is read downstream as "this deployment cannot
 *     observe attachments — use your remote authority". For
 *     Desktop→Server that authority is the renderer event WS, which in
 *     an embedded build is a LOCAL socket that reports `connected`
 *     immediately: a pre-bootstrap frame renders Connected, and a save
 *     banner could be dismissed on a purely local signal.
 *   - the fabricated value matched no poll gate (`!observable` bails out
 *     of the connecting poll; the protocol poll needs `mode === 'remote'`),
 *     so a single transient null left every consumer pinned with no
 *     self-heal path.
 *
 * These tests pin the producer side of the fix: the fetcher rejects
 * rather than inventing an observation.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BackendInfoUnavailableError, fetchBackendInfo } from "../hooks/hooks";

function stubBackendInfo(value: unknown): void {
  snapshotValue = value;
}
afterEach(() => {
  snapshotValue = null;
});

describe("fetchBackendInfo — a missing snapshot is a query failure, not a snapshot", () => {
  it("rejects when backend:info answers null", async () => {
    stubBackendInfo(null);
    await expect(fetchBackendInfo()).rejects.toBeInstanceOf(BackendInfoUnavailableError);
  });

  it("never resolves a synthesised unobservable attachment", async () => {
    // The exact shape the previous implementation returned. Stated as a
    // separate assertion because "it throws" and "it does not fabricate
    // THIS" fail for different reasons: a future author who re-adds a
    // fallback snapshot (with any status word) breaks this one.
    stubBackendInfo(null);
    const settled = await fetchBackendInfo().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
    expect(settled.ok).toBe(false);
  });

  it("passes a real snapshot through unchanged", async () => {
    const snapshot = {
      url: "http://127.0.0.1:1234",
      mode: "embedded" as const,
      outbound_protocol_compatibility: null,
      local_host_id: "host-1",
      local_host_status: "claimed" as const,
      local_host_ws_attachment: { observable: true as const, attached_at: null },
      local_host_server_url: "http://127.0.0.1:1234",
    };
    stubBackendInfo(snapshot);
    await expect(fetchBackendInfo()).resolves.toEqual(snapshot);
  });
});
