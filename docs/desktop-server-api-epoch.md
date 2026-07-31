# Desktop↔Server API Epoch — contract & upgrade runbook

> #task:1761. This document is the operating manual for the
> `DESKTOP_SERVER_API_EPOCH` axis defined in
> `packages/shared/src/desktop-server-api-epoch.ts` (the single code root).
> Both release-artifact entry points (desktop packaging via
> `scripts/package.sh`, standalone server bundle via the
> `packages/server` build) run `scripts/epoch-runbook-reminder.mjs`, which
> prints this file's path and FAILS THE BUILD if the file is missing.

## 1. What this axis is

One protocol axis per process boundary; an artifact only carries the axes it
participates in:

| Axis | Boundary | Constant |
|---|---|---|
| Host control wire | HostClient ↔ local daemon | `HOST_PROTOCOL_VERSION` (`packages/host/src/protocol.ts`) |
| Outbound wire | remote daemon ↔ server | `OUTBOUND_PROTOCOL_VERSION` (`packages/host/src/outbound-protocol.ts`) |
| **Desktop application API** | desktop ↔ server REST + Event WS | `DESKTOP_SERVER_API_EPOCH` (`packages/shared/src/desktop-server-api-epoch.ts`) |
| DB schema version | server binary ↔ database | migrations — not a network protocol |

Never reuse one axis for another boundary, and never infer compatibility from
app semver, git commit, or build identity.

The contract is **safe version skew (default plan A)**: a compatible pair runs
normally; an incompatible pair is rejected *before any business DTO is read* —
structured HTTP 426 (JSON `UpgradeRequiredBody`) on REST **and** on the
event-WS upgrade response, plus a typed full-screen gate in the desktop
(`app_update_required` / `server_update_required`). We do NOT promise that old
desktops keep working against new servers.

## 2. Where the epoch flows

- **Advertise**: `/api/server/info` → `desktop_api { current_epoch,
  minimum_client_epoch }`.
- **Carry (admission)**: the DEDICATED `x-silverhand-desktop-api-epoch`
  header — a compiled constant rendered to a decimal string, injected by the
  main-process `backendFetch` seam on every REST request and by the WS
  origin-override on the upgrade. Assembling it involves no IO and no schema,
  so an epoch-aware desktop can never fail to send it.
- **Carry (telemetry)**: the fail-open `x-silverhand-client-info` payload
  also carries `desktop_api_epoch` + `minimum_server_api_epoch` for fleet
  observation. It plays NO role in admission; a telemetry assembly failure
  degrades observability only.
- **Enforce (authoritative)**: server-side —
  `installDesktopApiEpochMiddleware` (REST, mounted on `/api/*`) and
  `checkDesktopApiEpochOnUpgrade` (WS), both reading the dedicated header and
  the shared constants.
- **Explain**: desktop `desktopAuthState()` compares ranges right after the
  server-info fetch and returns the typed gate arm.

Exempt REST paths (`DESKTOP_API_EPOCH_EXEMPT_PATHS`, same shared file):
`/api/health`, `/api/server/info`, `/api/hosts/connect-token/resolve`
(daemon surface), `/api/hosts/connect` (daemon WS upgrade; defensive pin —
upgrades bypass middleware anyway). `/auth/*`, `/readyz`, and `/internal/*`
(agent CLI) are outside the `/api/*` mount and structurally unaffected.

## 3. When to bump — decision rule

- **Do NOT bump** for additive, old-side-safe changes: new optional DTO
  field, new endpoint, new optional event field old clients ignore safely.
- **MUST bump — as an atomic triple** for breaking changes (removing/renaming
  a required field; changing a discriminant, nullability, pagination/cursor
  semantics, permission semantics old clients would misinterpret; changing
  event ordering guarantees). In the SAME commit as the breaking change set
  ALL THREE constants to the same new value:

  ```
  DESKTOP_SERVER_API_EPOCH  = N+1
  MINIMUM_CLIENT_API_EPOCH  = N+1
  MINIMUM_SERVER_API_EPOCH  = N+1
  ```

  Bumping only `current` while a minimum stays behind silently re-admits the
  exact incompatible pair plan A exists to reject. The lockstep test in
  `packages/shared/tests/desktop-server-api-epoch.test.ts` enforces this
  structurally: a minimum of 0 is legal ONLY while the current epoch is
  still 1 (the named first-introduction bootstrap, per field); any other
  divergence from `minimum === current` fails the build. A deliberate
  plan-B bridge must change that test together with its adapter and §11
  exit conditions.

Review checklist line: *"Does this diff change any REST DTO / event shape /
behavioral semantics in a way an old desktop would misread? If yes, are ALL
THREE epoch constants bumped to the same value in this same commit?"*

## 4. Release procedure (plan A — default)

1. Land the breaking change + atomic triple bump (one commit).
2. Ship server and desktop from that tree (embedded desktop carries both
   sides, zero skew by construction).
3. Remote deployment order is free. Server-first: old desktops are rejected
   server-side immediately (426), and show the full-screen upgrade gate **on
   their next startup or auth-state re-probe** — that is the accepted plan-A
   behavior, not an incident. Desktop-first: the new desktop shows
   `server_update_required` at startup against the old server.

**Runtime promotion (#task:1763):** server-side fail closed is immediate and
authoritative; a RUNNING desktop additionally promotes into the full-screen
gate without waiting for a restart. The path keeps one authority:

1. Two inputs reach the main-process runtime-upgrade monitor
   (`apps/desktop/src/main/runtime-upgrade-monitor.ts`): a REST proxy 426
   whose body parses as `UpgradeRequiredBody` (suspect — never trusted
   directly), and the `desktop_api` advertisement main fetches inside the
   backend:info handler (authoritative — classified directly). That handler
   is hit by the ws-client's reconnect discovery — `openSocket()` re-runs
   `getBackendInfo()` before EVERY reconnect attempt (first backoff tier
   500ms) — so a rejected WS upgrade promotes within the next reconnect
   cycle; the renderer's 30s backend-info poll is the idle fallback, not
   the primary path.
   There is deliberately NO event-WS arm: spike-verified, Electron's
   webRequest layer cannot observe a failed WS upgrade's status/headers/
   body (only net::ERR_FAILED), so a dead socket carries zero epoch
   semantics and never promotes by itself — promotion comes from the
   discovery that precedes the reconnect, not from the failure.
2. A REST suspect triggers ONE single-flight server-info probe,
   re-classified with the same shared classifier the startup precheck
   uses. Only a confirmed `client_too_old` (from probe or advertisement)
   pushes `epoch:update-required` to the renderer (latched — at most once
   per incompatibility period; the latch is a notification dedupe, not a
   second compatibility state).
3. The renderer invalidates its auth-state query; `getAuthState()` re-runs
   the startup precheck, which returns the `app_update_required` arm and
   unmounts the registered shell through the normal gate order.

Recovery: when a later auth-state probe observes a compatible pair again
(app updated, or server rolled back), the monitor re-arms automatically.
Unrelated failures (network errors, 401/403, foreign 426 bodies, malformed
payloads, unreachable probe) never promote.

**Plan B (one-off N-1 bridge)** is NOT built by default. Only when a release
explicitly requires zero interruption: keep `MINIMUM_CLIENT_API_EPOCH` at N
while the server serves both generations behind a request-epoch switch, ship
desktops, then raise the minimum and delete the adapter. Any such bridge must
carry the §11 exit-condition triple (named contract / observable removal
trigger / owner) inline and adjust the lockstep test in the same commit.

## 5. Observation bootstrap (current state) and its exit

First introduction ships with `MINIMUM_CLIENT_API_EPOCH = 0`:

- pre-epoch desktops (no dedicated header) are classified epoch 0 and
  **still admitted**;
- every event-WS session logs, in `desktop_client_connected`:
  `admission_epoch` (dedicated header, all sessions) plus the telemetry
  `client_info_status` and, when valid, `desktop_api_epoch`;
- symmetric on the client: `MINIMUM_SERVER_API_EPOCH = 0` admits pre-epoch
  servers (no `desktop_api` in server-info).

**Cutoff evidence — the hard gate is `admission_epoch`** (owner: Lio,
#task:1761). Over a representative window the `desktop_client_connected`
distribution must show `admission_epoch = 0` count 0 (or an explicit cutoff
date declared here). Then raise `MINIMUM_CLIENT_API_EPOCH` (to the current
epoch, per the §3 triple discipline) so missing fails closed.

The telemetry `client_info_status` buckets (`missing` / `invalid`) remain
monitored for observability health, but they are NOT cutoff conditions:
after the dedicated-header decoupling they only describe the optional
telemetry channel — an epoch-1 client with a failed telemetry assembly is
safe to admit, and gating the cutoff on those buckets would re-couple
optional telemetry to the admission decision. Raise
`MINIMUM_SERVER_API_EPOCH` independently once fleet servers all advertise.
Neither bridge is permanent fail-open; this section is the §11 record.

## 6. Known residuals

- `ClientInfoSchema` is `.strict()`: an OLD (pre-epoch) server parsing a NEW
  desktop's telemetry header classifies it `invalid`. That consumer is
  log-only — a telemetry blip during mixed fleets, accepted; admission uses
  the dedicated header and is unaffected.
- The desktop-side gate is advisory UX; enforcement authority stays
  server-side (a modified client can skip its own gate but not the 426).
- Race window: if the server bumps between the desktop's server-info
  precheck and a business request, that single request 426s before the next
  re-probe corrects the classification.
