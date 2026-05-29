# D5.a — outbound frame adapter unification (design pass)

**Status**: draft round 0 for review.

**Goal**: close the R4 drift left open by D4. After D5.a,
backend-to-daemon runtime/materialize traffic uses the same outbound
frame envelope in embedded and standalone deployments. The transport
may differ (local Unix socket vs WSS); the command/event envelope,
schemas, error taxonomy, and backend dispatch path must not differ.

**Base**: D4.d closed at `38a4b12` on
`feature/remote-backend-v1-stage-d4-d-design`.

**Non-goal**: D5.a does not add D4.e data-plane proxy intents, does
not change cloud deployment shape, and does not implement multi-host
automatic migration or failover. It pays down the protocol-envelope
drift so D4.e can add new business intents without opening a second
embedded-only protocol path.

---

## 1. Problem Statement

D4.d successfully moved create-agent materialization into the
`agent_materialize` outbound intent, but the repo still has two
backend-to-daemon expression forms:

1. **Standalone**: daemon opens WSS to backend. Backend sends
   `OutboundServerToDaemonCommandFrame` through
   `HostWsServerController.sendCommand`; daemon replies with
   `OutboundDaemonToServerCommandResponseFrame` and emits
   `OutboundDaemonToServerEventFrame`.
2. **Embedded**: backend receives a `HostClient` connected to the
   daemon's Unix socket. Backend sends local IPC request frames
   `{ id, intent, params }`; daemon replies `{ id, result|error }`
   and emits local `EventFrame` objects consumed by
   `HostClient.subscribe`.

The second path is the R4 drift documented in
`docs/remote-backend-d4-design.md` §9: the same runtime business
semantics are encoded in a local daemon RPC API instead of the
outbound frame envelope.

D5.a closes that by making embedded backend use a local transport
adapter that carries the **outbound frame envelope**. The existing
desktop-only daemon-control IPC may remain, but backend production
code must no longer use `HostClient` / `RuntimeBridge` /
`DaemonAgentRuntimeHost` as its formal daemon path.

---

## 2. Hard Invariants

### I1. Same Formal Envelope

For `runtime_*`, `agent_materialize`, and future D4.e data-plane
commands, both modes must use:

- `OutboundServerToDaemonCommandFrameSchema`
- `OutboundDaemonToServerCommandResponseFrameSchema`
- `OutboundDaemonToServerEventFrameSchema`
- `outboundServerCommandSchemas[kind]` for params/result/error

No embedded-only `{ intent, params }` command path may carry these
formal semantics after D5.a.

### I2. Transport Adapter, Not Protocol Fork

Transport differences are allowed:

- standalone: authenticated WSS, host token bearer, backend accepts a
  daemon-initiated connection.
- embedded: local Unix socket, same uid, filesystem permission
  perimeter, backend initiates the connection.

The frame envelope over the transport is not allowed to differ.

### I3. Backend Must Stop Importing `HostClient`

After D5.a, `packages/backend/src/**` must not import `HostClient`
from `@silverhand/host`. Backend runtime wiring depends on an
`OutboundFrameAdapter` interface instead.

This is the core acceptance guard: hiding `HostClient` behind another
class while still using its local request/subscribe protocol would not
close R4.

### I4. Desktop Host-Control IPC Is Isolated

`host_outbound_attach`, `host_outbound_detach`, and
`host_outbound_reload` are desktop-main-to-daemon local control
operations. They are not server-to-daemon formal semantics.

D5.a does not need to remove that local IPC. It must isolate it:

- allowed consumers: `apps/desktop/src/main/**` and tests for that
  desktop control surface.
- forbidden consumers: backend runtime/materialize/data-plane code.
- forbidden shortcut: adding D4.e or runtime semantics to the
  desktop-control IPC because "it is already local".

### I5. D4.d Semantics Stay Fixed

`agent_materialize` remains formal server-to-daemon semantics. D5.a
must not replace the D4.d handler, change sentinel rules, or add a
second materialization path. It only changes how embedded backend
reaches the existing intent.

### I6. No Durable Transport Queue

Local adapter reconnect/backoff may mirror `HostClient` or outbound
WSS behavior, but transport-level durable queues remain forbidden.
Delivery-backed retry stays in `RuntimeDeliveryCoordinator` and the
DB inbox; control commands fail fast.

---

## 3. Chosen Architecture

D5.a introduces one backend-facing port:

```ts
export interface OutboundFrameAdapter {
  activeConnectionCount(): number;
  connectedHostIds(): string[];
  connectionIdForHost(hostId: string): string | null;
  getAttachment(hostId: string): HostWsAttachment | null;
  sendCommand<K extends OutboundServerCommandKind>(
    hostId: string,
    kind: K,
    params: OutboundServerCommandParams<K>,
    opts?: { timeoutMs?: number; expectedConnectionId?: string },
  ): Promise<OutboundServerCommandResult<K>>;
  close(): Promise<void>;
}
```

This is intentionally close to `HostWsServerController`. The point is
not to invent a new command vocabulary; it is to make both transports
look like "a live outbound-frame connection for host H".

Implementations:

1. **StandaloneOutboundFrameAdapter**: thin wrapper over
   `HostWsServerController`.
2. **EmbeddedUnixOutboundFrameAdapter**: connects to a daemon-local
   Unix socket that speaks the same outbound frame envelope.

`OutboundRuntimeEventFanout` should depend on this adapter contract
instead of `HostWsServerController`. Then embedded and standalone can
share the same event projection / delivery coordinator / run-state
logic.

---

## 4. Local Unix Envelope Transport

### 4.1 Separate Socket, No Mode Negotiation

D5.a should add a separate local socket for the formal envelope path,
for example:

```text
~/.silverhand/run/daemon-outbound.sock
```

Do **not** multiplex the old `HostClient` protocol and the outbound
envelope on the same socket with a "mode" handshake.

Reason:

- current `DaemonServer` immediately emits a local `ready` event that
  old `HostClient` expects;
- outbound-frame clients expect `direction/type/kind` envelopes;
- multiplexing would make first-frame ordering and parser errors
  ambiguous;
- separate sockets let desktop local-control IPC remain isolated
  while backend formal traffic moves cleanly.

### 4.2 Daemon Side: `LocalOutboundFrameServer`

The daemon runs a second server beside the existing local control
server:

- accepts Unix-socket clients;
- reads NDJSON;
- accepts only `OutboundServerToDaemonCommandFrame` and heartbeat
  frames if heartbeats are enabled for the local transport;
- dispatches command frames through the existing `IntentDispatcher`;
- returns `OutboundDaemonToServerCommandResponseFrame`;
- broadcasts daemon events as `OutboundDaemonToServerEventFrame`.

It must reuse the same mapping code the WSS daemon client uses:

- command params/result/error schemas from
  `outboundServerCommandSchemas`;
- event mapping from local `EventFrame` to outbound event frame;
- result/error drift checks before writing bytes.

It must not own DB state and must not know route-level ACL. The
backend still owns placement and ACL.

### 4.3 Backend Side: `EmbeddedUnixOutboundFrameAdapter`

The embedded adapter:

- is constructed with the local `hostId` from `HostRepo.ensureLocal`;
- connects to the daemon's `daemon-outbound.sock`;
- mints one local `connectionId` per successful socket connection;
- surfaces `getAttachment(hostId)` and `connectionIdForHost(hostId)`
  for the same reattach-race guards D4.d uses;
- maps connection failures to the existing transport-code family:
  `transport_no_connection`, `transport_disconnected`,
  `transport_timeout`, `transport_send_failed`,
  `transport_invalid_command`, `transport_response_mismatch`;
- forwards daemon events into the same `HostWsEventSink` shape that
  `OutboundRuntimeEventFanout` already consumes.

The adapter must reject any `hostId` other than the constructed local
host id with `transport_no_connection`. Embedded has exactly one
local host connection.

### 4.4 Authentication / Perimeter

Standalone WSS authenticates with `host_token`.

Embedded local envelope transport uses:

- same uid process boundary;
- Unix socket mode `0o600`;
- a socket path under the user's `~/.silverhand/run/`.

No bearer token is required on the local socket for M1. Adding one
would not improve the same-user desktop threat model and would risk
inventing a second local credential surface.

Runtime event ownership checks remain backend-side in
`OutboundRuntimeEventFanout.assertEventOwnership`. The local adapter
does not trust daemon-supplied `agent_id` / `conversation_id` any
more than WSS does.

---

## 5. Backend Wiring After D5.a

### 5.1 Embedded Mode

Current embedded:

```text
startBackend({ mode: 'embedded', hostClient })
  → createDaemonRuntimeHost(...)
  → RuntimeBridge(hostClient)
  → RuntimeEventHandler(client.subscribe)
```

After D5.a:

```text
startBackend({ mode: 'embedded', outboundFrameAdapter })
  → ControlPlaneRuntimeHost(() => outboundFanout)
  → OutboundRuntimeEventFanout({ transport: () => outboundFrameAdapter })
```

The name `ControlPlaneRuntimeHost` may be misleading once both modes
use it. Either rename it in the implementation slice
(`OutboundAgentRuntimeHost`) or leave the rename to a cleanup commit,
but the behavior must be shared: all runtime commands go through the
adapter and all runtime events go through `OutboundRuntimeEventFanout`.

### 5.2 Standalone Mode

Standalone keeps accepting daemon WSS attachments through
`installHostWebSocketServer`. The only required change is adapting
the controller to the same `OutboundFrameAdapter` interface.

### 5.3 `BackendContext`

`BackendContext.hostWsController` should be replaced or complemented
by a neutral name, for example:

```ts
outboundFrameAdapter?: () => OutboundFrameAdapter | null;
```

Routes that need attachment state (`POST /api/agents`,
host attach UI checks, future D4.e proxy routes) should call the
neutral accessor, not `hostWsController`, so embedded and standalone
use the same readiness semantics.

---

## 6. What Happens To `HostClient`

`HostClient` is not deleted in D5.a unless implementation cost is
small. It is narrowed conceptually:

- **Allowed**: desktop-main local daemon control (`host_outbound_*`,
  ping/status/debug if still needed by desktop boot diagnostics).
- **Forbidden**: backend runtime/materialize/data-plane formal
  semantics.

Acceptance should include a dependency guard:

```text
packages/backend/src/** MUST NOT import `HostClient` from
@silverhand/host after D5.a.
```

If code cleanup is cheap, split or rename this surface to
`HostControlClient` so the old name cannot be misread as the
backend's formal daemon protocol. If not, leave the rename as a
follow-up but keep the backend import guard mandatory.

---

## 7. Error And Disconnect Semantics

D5.a should introduce a transport-neutral error class, or rename the
current WSS-specific one:

```ts
type OutboundFrameTransportErrorCode =
  | 'transport_no_connection'
  | 'transport_timeout'
  | 'transport_disconnected'
  | 'transport_send_failed'
  | 'transport_invalid_command'
  | 'transport_response_mismatch';
```

Both adapters throw this error family for transport failures. Route
mapping stays unchanged:

- `transport_no_connection` / `transport_disconnected` →
  `host_attach_pending` (503) where the existing route already maps
  daemon unavailability.
- `transport_timeout` → route-local timeout code where already
  defined (`materialize_timeout`, `clear_session_timeout`, etc.).
- `transport_invalid_command` / `transport_response_mismatch` →
  `internal_error` / 502-style internal route response, depending on
  the current route taxonomy.

Command response errors remain per-command wire errors. D5.a must not
globally widen error surfaces.

---

## 8. Acceptance Matrix

D5.a is done only when all of these are true.

### A1. Backend Formal Path Has No `HostClient`

- `packages/backend/src/**` imports no `HostClient`.
- `RuntimeBridge` / `DaemonAgentRuntimeHost` are not constructed by
  production backend wiring. If kept, they are dead/legacy code with
  no production call site, or removed.

### A2. Shared Adapter Contract

The same contract test runs against:

1. `StandaloneOutboundFrameAdapter` wrapping `HostWsServerController`;
2. `EmbeddedUnixOutboundFrameAdapter` connected to
   `LocalOutboundFrameServer`.

Minimum contract cases:

- `runtime_status` request/response round-trip;
- `runtime_start` parameter validation rejects malformed params;
- `agent_materialize` typed error stays scoped to
  `agent_materialize`;
- transport disconnect rejects pending command with
  `transport_disconnected`;
- `expectedConnectionId` mismatch fails before dispatch.

### A3. Event Projection Parity

A real daemon event emitted through the local Unix envelope transport
enters `OutboundRuntimeEventFanout` and produces the same backend
projection as the standalone WSS path.

Minimum event pins:

- `ready` hydrates / marks daemon key for that host;
- `runtime_ready_for_drain` can drive delivery-backed drain after
  hydrate;
- cross-host event perimeter checks still drop mismatched
  `(host_id, agent_id, conversation_id)` claims.

### A4. D4.d Create-Agent Still Works In Embedded

`POST /api/agents` in embedded mode must use the adapter path and
send a real `agent_materialize` outbound command frame. There must
be no direct call to `materializeAgent` and no `HostClient.call`
fallback from the backend.

### A5. TODO Anchor Count

Code grep for the mandatory D4 anchor returns zero production
hotspots:

```bash
rg "TODO\\(D5,R4\\)" packages apps
```

The design/roadmap may mention the historical anchor format, but no
source code path may still point at D5 as future R4 work.

### A6. Desktop Control IPC Is Documented As Local Control

Any remaining `HostClient` / local-control IPC call site in
`apps/desktop/src/main/**` must carry a short comment saying it is
desktop-local supervisor/control, not backend↔daemon formal
semantics. It must not expose runtime/materialize/data-plane
business commands.

---

## 9. Implementation Slicing

### D5.a-1 — Contract And Adapters (No Behavior Change)

- Add `OutboundFrameAdapter` interface in backend runtime/ws layer.
- Add `StandaloneOutboundFrameAdapter` wrapper over
  `HostWsServerController`.
- Rename/generalize `HostWsCommandTransportError` if needed.
- Add contract-test harness with the standalone adapter as the first
  implementation.

### D5.a-2 — Local Envelope Socket In `packages/host`

- Add daemon-side `LocalOutboundFrameServer` on
  `daemon-outbound.sock`.
- Add host/client-side `LocalOutboundFrameClient` or
  `EmbeddedUnixOutboundFrameAdapter` transport that reads/writes
  `OutboundFrame` NDJSON.
- Share the same command-response / event mapping helpers as WSS.
- Unit-test raw frame bytes and per-command error scoping.

### D5.a-3 — Embedded Backend Rewire

- Change embedded `startBackend` options to take the local
  `OutboundFrameAdapter`, not `HostClient`.
- Wire embedded runtime through `OutboundRuntimeEventFanout` +
  `ControlPlaneRuntimeHost` (or renamed equivalent).
- Keep desktop-main local `HostClient` only for host-control IPC.
- Add dependency guard: backend cannot import `HostClient`.

### D5.a-4 — Parity E2E

- Run one embedded e2e and one standalone e2e through the same
  adapter contract:
  - real runtime command dispatch;
  - real event projection;
  - `agent_materialize` create flow;
  - reconnect / connection-id replacement guard.
- Assert the captured local Unix frames match outbound envelope
  schemas, not old IPC request/response schemas.

### D5.a-5 — Cleanup And Docs

- Update `docs/silverhand-daemon.md`,
  `docs/remote-backend-d4-design.md` §9, and
  `docs/remote-backend-progress.html`.
- Remove or mark legacy-only any unused `RuntimeBridge` /
  `DaemonAgentRuntimeHost` code after production wiring is gone.
- Add `docs/d5-a-r4-acceptance.md` with the final evidence matrix.

---

## 10. Out Of Scope

- D4.e data-plane proxy commands.
- Durable offline queues.
- Multi-host failover or migration.
- Remote cloud deployment hardening.
- Changing `host_outbound_attach` / reload / detach UX semantics.
- Replacing desktop-main local-control IPC unless it is cheap and
  clearly isolated from backend formal semantics.

---

## 11. Review Questions

Round-0 review should focus on these:

1. **Separate socket vs mode negotiation**: this draft chooses a
   separate `daemon-outbound.sock` because it keeps local-control IPC
   and formal outbound envelope physically isolated. If we choose mode
   negotiation instead, the design must explain how the old immediate
   `ready` event and new outbound envelope first frame cannot race or
   confuse either parser.
2. **`ControlPlaneRuntimeHost` naming**: behavior becomes shared after
   D5.a; either rename during D5.a or accept a temporary misleading
   name with a cleanup task.
3. **HostClient cleanup depth**: mandatory requirement is backend
   import guard; optional cleanup is a `HostControlClient` rename /
   helper narrowing for desktop main.
4. **Adapter attachment source**: embedded adapter uses backend-known
   local `hostId` and local socket liveness, not daemon-declared
   `host_id`. This matches existing local-host ownership, but review
   should confirm it is the right spoofing boundary.
