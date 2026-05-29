# Protocol Purity Checklist (Stage C.1 audit catalogue)

> **Status**: draft for review. Owner: @Alice. Companion to
> `docs/remote-backend-roadmap.md` §Stage C. This is the **agreement
> layer** — no code changes are landed under C.1; subsequent PRs (C.2 /
> C.3 / C.4) act on the dispositions recorded here.

## 1. Purpose

Stage C's invariant is: **the renderer's view of the world is
indistinguishable between embedded and remote backends, except for one
fenced auto-bootstrap route**. That invariant fails today because:

1. The embedded main process imports the shared server entrypoint as JS
   (`startEmbeddedSilverhandServer`, `RunningBackend`, log sinks)
   instead of speaking HTTP to it. Under remote mode there is no local
   backend handle to import.
2. Several IPC routes pass server-side state or absolute server-side
   paths to the renderer. Under remote mode those paths don't exist on
   the user's machine.
3. `BackendInfo.local_host_id` and owner-scoped host metadata were not
   consumed by the renderer. Local-host-only UX therefore could not be
   gated by path provenance.

This document enumerates every such site, tags each with its V1
disposition, and defines the tripwire that keeps the catalogue from
silently drifting.

## 2. Disposition vocabulary

Every IPC route / main-process backend interaction gets exactly one tag.

| Tag | Meaning | V1 action |
|---|---|---|
| **OS-IPC** | Native desktop capability the renderer cannot do itself — clipboard, file dialog, system notification, dock badge, window controls. Acceptable forever. | Keep. Audit only for input validation. |
| **data** | Anything the backend already owns (or should own). The renderer must see it via HTTP, even if main proxies the request. | Convert in **C.2**. |
| **local-host-only UX** | Legitimate "reveal in Finder", "open in default app" style affordance that only makes sense when the path lives on the user's machine. **Backend mode is orthogonal**: under remote-backend mode the desktop is still a local Host (Stage B `host.kind='local'`) and workspaces/agent dirs placed on that host are still on the user's filesystem. | Keep, but gate by **path provenance**: only when the path's owning host satisfies `host_id === local_host_id && host.kind === 'local'` (the local Host this desktop registered with the server in Stage B). **Never** gate on backend mode — that would hide legitimate UX from the remote-backend / local-Host case. C.3 lands the gate. |
| **in-process shortcut** | main-process code that imports server/backend symbols directly (`startEmbeddedSilverhandServer`, `BackendContext`, `createCategorizedLoggers`, …) rather than going over HTTP. | Stays in **embedded** boot path only. Stage D1.a moved the embedded launcher to `@silverhand/server`; standalone mode uses the same package with explicit config. |
| **protocol metadata** | Neutral, dual-mode connection info the renderer needs to address the backend and gate per-host UX — `url`, `mode`, `local_host_id`, future `host_kind`. Visible under both embedded and remote modes; carries no embedded-only assumption. Not a "purity hazard"; called out so the catalogue has a precise word that isn't OS-IPC (which would imply native capability) or data (which would imply renderer-readable resource state). | Keep. New protocol-metadata fields are additive on existing IPC routes (typically `backend:info`); they MUST be listed in the relevant §4/§5 row in the same PR they land. |
| **embedded-only** | Code that holds embedded-mode invariants (one-shot bootstrap token file, loopback URL, `mode='embedded'` constant). | Keep, but **fence** behind a `mode === 'embedded'` check. Any new caller without the fence is a regression. |
| **mixed** | A single IPC route / file carries fields with different tags. | The row's notes column MUST enumerate every contributing tag at field-level. Any field promotion (e.g. a protocol-metadata field that grows embedded-only assumptions) is a regression unless the table is updated in the same PR. |

> Each **field** carries exactly one tag. If two seem to fit the same
> field, the strictest one wins: **in-process shortcut** beats **data**
> beats **embedded-only** beats **local-host-only UX** beats **OS-IPC**
> beats **protocol metadata**.
> When a route exposes multiple fields with different tags, tag the
> route as **mixed** and break the contributing tags down per field in
> the notes column (e.g. `backend:info`).

## 3. Main-process direct backend imports

Single file: `apps/desktop/src/main/index.ts`.

```ts
import {
  createCategorizedLoggers,
  startEmbeddedSilverhandServer,
  type CategorizedLoggers,
  type RunningBackend,
  type FileLogger,
} from '@silverhand/server';
```

| Symbol | Tag | V1 disposition |
|---|---|---|
| `startEmbeddedSilverhandServer` | in-process shortcut | Stays the embedded boot path. D1.a moved the shared entrypoint into `packages/server`; embedded mode passes host-derived paths and a `HostClient`, standalone passes env-derived paths and no runtime host. |
| `RunningBackend` (type) | in-process shortcut | Type-only; survives D1 because the embedded launcher still needs the handle. Remote mode never holds one. |
| `createCategorizedLoggers`, `CategorizedLoggers`, `FileLogger` | OS-IPC (sort of — local fs only) | Logger lives on the desktop regardless of where backend runs (we always want desktop-local diagnostics). D1 keeps the call here; backend gets its own server-side logger. |

`apps/desktop/src/main/index.ts` also imports `HostClient`,
`spawnDaemonChild`, `DaemonHandle` from `@silverhand/host`. These are
**daemon-host plumbing, not backend** — they belong to main forever
(daemon and agent co-reside with the user's desktop) and are explicitly
out of scope for Stage C.

**Acceptance test (tripwire)**: a single test in
`apps/desktop/src/main/__tests__/protocol-purity.test.ts` greps the
main source tree for `from '@silverhand/backend'` and asserts the
allowed set equals exactly the symbols listed above. Any new symbol
fails the test until it is added to the table with a disposition.

## 4. IPC route catalogue

Source files: `apps/desktop/src/main/index.ts` (handlers) and
`apps/desktop/src/preload/index.ts` (renderer surface). All routes
listed in the order they appear in main.

| IPC channel | Preload method | Tag | Notes / V1 disposition |
|---|---|---|---|
| `backend:info` | `getBackendInfo` | **protocol metadata** | Returns `{url, mode, local_host_id, local_host_status}` only. Renderer needs this neutral connection/host metadata to address the backend and gate host-kind UX; no bearer or embedded-only auth token crosses IPC after C.4. |
| `auth:getState` | `getAuthState` | **data** | Main-owned auth-session proxy. Renderer receives safe auth state (`authenticated` + user DTO or `unauthenticated`) but never receives the session bearer. Kept as a narrowly-shaped HTTP proxy because main owns `safeStorage` / token lifecycle. |
| `auth:signup` | `signup` | **data** | Main POSTs `/auth/signup`, persists the returned session bearer, and returns only `{ok, user}` or sanitized failure metadata. No token crosses IPC. |
| `auth:login` | `login` | **data** | Same as `auth:signup`, for `/auth/login`. |
| `auth:logout` | `logout` | **data** | Main clears its saved session and best-effort revokes it server-side. Renderer only receives `{ok:true}`. |
| `backend:request` | `backendRequest` | **data** | Central fetch-shaped proxy for renderer HTTP data access. Renderer supplies relative `/api/...` path/method/body; main validates the path, injects the user session bearer, and returns a fetch-like response. This is the C.2 data-IPC conversion point: bespoke data IPCs should not be added outside this row. |
| `backend:upload` | `backendUpload` | **data** | Multipart companion to `backend:request`; renderer serializes `FormData`, main reconstructs it and injects the session bearer. |
| `hosts:rotate` | `rotateHostToken` | **mixed** (data + local-host credential side effect) | Main POSTs `/api/hosts/:id/rotate-token`, writes the returned cleartext `host_token` to `daemon-config.json`, and strips token bytes before replying. Kept as dedicated IPC because the generic `backend:request` proxy explicitly blocks token-bearing host mutation routes. |
| `hosts:revoke` | `revokeHost` | **mixed** (data + local-host credential side effect) | Main POSTs `/api/hosts/:id/revoke`, clears local daemon config when revoking the current local host, and returns sanitized host/local-claim metadata. |
| `dialog:pickDirectory` | `pickDirectory` | **local-host-only UX** | Native open dialog. The picked path is on the user's machine; under Stage B that path can only be assigned to a local Host. Caller is `CreateWorkspaceDialog`. C.3 gates the picker on "the target host kind is `local` and equals this desktop's `local_host_id`". Backend mode is irrelevant — remote-backend + local-Host still picks user-fs paths legitimately. If/when the user has non-local hosts available (remote / sandbox), the create-workspace flow needs an additional "host placement" step that this V1 does not ship (deferred; see roadmap §5 Follow-up); until then default placement is the local Host and the picker stays. |
| `shell:openExternal` | `openExternal` | **OS-IPC** | Strict `https?://` allowlist already enforced. Kept as-is. |
| `attachment:openExternal` | `openAttachmentExternal` | **OS-IPC** | Renderer fetches bytes via HTTP first; main only handles the local tmp-write + Launch Services call. Already protocol-pure. Keep. |
| `shell:showItemInFolder` | `showItemInFolder` | **local-host-only UX** | Caller passes an absolute path served by the backend. Two call sites: `AgentWorkspaceCard` (agent dir) and `WorkspacesPanel` (workspace_path). C.3 gates the button on the **owning host** of that resource: render only when `host_id === local_host_id && host.kind === 'local'`. Under remote-backend mode the gate still surfaces the button whenever the workspace/agent is placed on the local Host — that is the common case in V1 (only kind shipped is `local`). The button only hides for the future "this workspace lives on a remote/sandbox host" case. |
| `window:setAlwaysOnTop` | `setWindowAlwaysOnTop` | **OS-IPC** | Pin Events Window. Kept. |
| `active-conversation:set` | `setActiveConversation` | **OS-IPC** | Renderer ↔ Events-window coupling. No backend touch. Kept. |
| `badge:setCount` | `setBadgeCount` | **OS-IPC** | macOS dock badge. Kept. |
| `export:savePng` | `savePngExport` | **OS-IPC** | Save-dialog + writeFile. Kept. |
| `export:copyPng` | `copyPngExport` | **OS-IPC** | NSImage on clipboard. Kept. |
| `notification:show` | `showSystemNotification` | **OS-IPC** | OS notification + click→focus+`notification:clicked` IPC. Kept. |
| (event) `notification:clicked` | `onNotificationClicked` | **OS-IPC** | Click callback. Kept. |
| (event) `active-conversation:update` | `onActiveConversation` | **OS-IPC** | Kept. |
| (event) `shutdown:progress` | `onShutdownProgress` | **OS-IPC** | Kept. |
| (event) `navigate:settings` | `onNavigateSettings` | **OS-IPC** | App-menu → renderer route. Kept. |

The only data-tagged IPCs are now either the central fetch-shaped
backend proxy (`backend:request` / `backend:upload`) or deliberately
narrow main-owned credential/session boundaries (`auth:*`,
`hosts:*`). C.2's invariant is that no new bespoke renderer data
channel appears without a catalogue row and a reason it cannot use the
central proxy.

**Acceptance test (tripwire)**: the same protocol-purity test asserts
the set of `ipcMain.handle('<channel>', …)` channels in
`apps/desktop/src/main/index.ts` equals exactly the catalogue above.
New handlers fail until added with a tag.

## 5. Renderer → host fs / server-state references

Pure-renderer code (no IPC hop, no fetch) that still assumes the
resource it points at lives on the user's machine. Each entry is a
place C.3 must gate on **owning host kind**, not on backend mode.

| Site | Symptom | C.3 disposition |
|---|---|---|
| `features/agents/AgentWorkspaceCard.tsx` | `window.agentHub.showItemInFolder(path)` for the agent L1 dir | Render only when the agent's `host_id` satisfies `host.id === local_host_id && host.kind === 'local' && host.revoked_at === null`. Backend mode irrelevant. |
| `components/layout/WorkspacesPanel.tsx` | `window.agentHub.showItemInFolder(w.workspace_path)` | Same gating, using `workspace.workspace_host_id` from the workspace DTO. |
| `features/workspaces/CreateWorkspaceDialog.tsx` | Directory picker for new workspace path | V1 default placement is the current local Host, so the picker is enabled only when that host is active and local. When the create-workspace flow grows a host placement step (follow-up phase), the picker is conditional on "chosen host is local + equals `local_host_id`". Do **not** hide it under remote backend — that would break the common remote-backend / local-Host path. |
| `lib/api.ts` `api` / `apiUpload` / `fetchBackendBlob` | Renderer data calls | Already C.2-shaped: these call `backend:request` / `backend:upload`; main injects the session bearer and the renderer never reads it. |
| `features/me/hooks.ts` avatar fetch | Backend blob with auth | Already uses `fetchBackendBlob`, so it inherits the main-owned session proxy. |
| `features/agents/avatar-hooks.ts` agent avatar fetch | Backend blob with auth | Already uses `fetchBackendBlob`, so it inherits the main-owned session proxy. |
| `lib/ws-client.ts` `openSocket` | Opens the event websocket URL from `BackendInfo.url` | C.4 moved WS auth to a main-owned `HttpOnly` session cookie scoped to `/api/ws/events`; renderer sends no bearer-bearing auth frame and only waits for the server `authenticated` frame. |

The `viewer_user_id` header (`X_SILVERHAND_PRINCIPAL_HEADER`) flows
through every fetch helper and is unaffected — it's set from `/api/me`
hydration, identical under both modes.

**`local_host_id` propagation to renderer**: Stage B introduces the
`hosts` table and assigns this desktop's local host id when main
claims/registers the local Host. Main exposes safe metadata to the
renderer through additive fields on `backend:info` (e.g.
`local_host_id: string | null`, `local_host_status`) — that is a
**protocol metadata** extension of an already existing IPC, not a new
route, so it stays inside the C.3 surface without needing a separate
disposition. Renderer combines it with owner-filtered `/api/hosts`
results in `useHostProvenanceGate`; every local-path affordance uses
that gate rather than `BackendInfo.mode`.

## 6. Embedded-only invariants (the `/auth/embedded-bootstrap` fence)

The roadmap requires this route to exist **only** when all four
constraints hold:

1. `mode === 'embedded'`
2. caller is loopback (`127.0.0.1` / `::1`)
3. one-shot (the `~/.silverhand/embedded-bootstrap` token file is
   consumed on first use)
4. boot-session-scoped (token is regenerated on each backend boot)

Any other request to this route returns **404** (not 401/403 — the
route should appear absent under remote mode). Acceptance criteria
mirror roadmap §Stage C.

Existing embedded-only surface that C.4 must touch:

| Site | Embedded-only assumption today | C.4 disposition |
|---|---|---|
| `main/config.ts` `loadOrCreateServerConfig` | Default `ServerConfig` has `mode='embedded'` and a hardcoded loopback URL. C.6 stopped generating the retired long-lived `auth_token`; read-compat remains for old config files only. | Keep as embedded default. Add a sibling code path that produces `mode='remote'` when the user fills the server URL in Setup Wizard. New config writes omit `auth_token`. |
| `main/index.ts` `backend:info` handler | Previously returned the legacy event-WS bearer as `event_auth_token` | C.4 removed that field. Event WS authenticates from the same session subject as HTTP, but the session bearer stays main-owned and travels to WS only as a path-scoped `HttpOnly` cookie. |

### 6.1 Renderer `BackendInfo` token consumers

C.4 is **not** just a route edit. Stage A/B already moved ordinary
HTTP reads/uploads/blob fetches behind the main-owned
`backend:request` / `backend:upload` proxies, so the renderer no
longer reads a bearer for those paths. C.4 also removed the remaining
renderer token surface (`event_auth_token`) by giving WS the same
session subject per mode:

- embedded → bootstrap session persisted via `safeStorage`
  (initialised by `/auth/embedded-bootstrap` on first launch)
- remote → signup/login session persisted via `safeStorage`

| Site | Today | C.4 disposition |
|---|---|---|
| `apps/desktop/src/preload/index.ts` | `event_auth_token: string` used to be required | Removed from renderer-facing `BackendInfo`. |
| `apps/desktop/src/preload/api.d.ts` | mirrored preload | Same change. |
| `apps/desktop/src/renderer/lib/ws-client.ts` `openSocket` | used to send `token = info.event_auth_token` in an auth frame | Now opens the socket from `info.url` only. Electron main maintains an `HttpOnly`, `SameSite=Strict`, `/api/ws/events` cookie and normalizes the WS `Origin`; backend validates the cookie/session before upgrade. |
| `/auth/embedded-bootstrap` route | did not exist | C.4 lands the route + constraint matrix. It is independent of `SILVERHAND_DISABLE_SIGNUP`; disabled signup does not disable embedded bootstrap. |
| `~/.silverhand/embedded-bootstrap` token file | did not exist | C.4 writes the file (0600) before HTTP listen, stores only an in-memory hash, consumes/removes it on successful exchange, and regenerates per backend boot. |

The tripwire test §7 now carries an active fourth assertion —
**renderer-facing source contains zero references to `auth_token` /
`\.auth_token`**. It was checked in during C.1 as `it.todo()` and
activated by C.4 after the WS/session cleanup landed.
TODO comment) and is flipped to `it()` by C.4. See §7 for the full
lifecycle; C.1 ships green, C.4 ships green with the assertion
active.

### 6.2 Headless smoke path (dev / `pnpm dev:headless`)

`pnpm dev:headless` no longer prints or accepts the retired
server-config `auth_token`. Its stdout JSON handshake contains
`{ url, port, bootstrap_token_path, silverhand_dir }`; smoke scripts
read the one-shot token file and exchange it through
`/auth/embedded-bootstrap` for a normal user session bearer:

```sh
BOOTSTRAP=$(tr -d '\n' < "$BOOTSTRAP_TOKEN_PATH")
AUTH=$(curl -sS -X POST "$URL/auth/embedded-bootstrap" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$BOOTSTRAP\"}" | jq -r .user_token)
```

Headless does not auto-consume the bootstrap file in Electron main,
because there is no renderer session to hydrate. Non-headless embedded
startup still consumes the same file internally to persist the desktop
session. D1 may reshape the entrypoint when `packages/server` becomes
the real headless binary, but it must keep this invariant: no
long-lived server-config bearer on stdout and no runtime reads of
`serverConfig.auth_token`.

## 7. Catalogue invariant test

`apps/desktop/src/main/__tests__/protocol-purity.test.ts` is the
single-file tripwire that keeps this document honest. Four assertions
total — **three active in C.1, one parked as `it.todo` until C.4**:

| # | Assertion | C.1 state | Activated by |
|---|---|---|---|
| 1 | Imports from `@silverhand/backend` in `apps/desktop/src/main/**/*.ts` equals exactly the set in §3. | `it()` — active, must pass against the current tree. | C.1 |
| 2 | `ipcMain.handle` channels registered in `apps/desktop/src/main/**/*.ts` equals exactly the set in §4. | `it()` — active, must pass. | C.1 |
| 3 | Renderer source tree contains zero references to `from '@silverhand/backend'` or `from '@silverhand/backend/...'` (type-only re-exports through `@silverhand/shared` are fine and actively encouraged — shared is the protocol layer). | `it()` — active, must pass. | C.1 |
| 4 | `apps/desktop/src/preload/**/*.{ts,tsx}` + `apps/desktop/src/renderer/**/*.{ts,tsx}` contain zero references to `\.auth_token` or `auth_token:` reads. | `it()` — active, must pass. | C.4 |

Assertion 4 scans renderer-facing files. Main-side embedded token
readers are tracked separately in §6: the dev-only headless smoke
handshake remains explicitly documented in §6.2, and the
`/auth/embedded-bootstrap` file reader lives in Electron main only long
enough to exchange for a normal session bearer.

When a PR needs to add a new IPC handler or a new backend import, the
flow is: update this doc + add the disposition row, **then** the test
passes, **then** ship the implementation. No drive-by additions.

The test is implemented with dependency-free recursive `node:fs`
reads; no AST tooling needed. Keep it dependency-free so it runs in
the same `pnpm test` sweep without driving new node_modules.

## 8. Acceptance criteria for closing C.1

- [ ] This document reviewed by Cindy + shiki LGTM.
- [ ] Tripwire test `protocol-purity.test.ts` lands and the suite is
      **green against the current tree**: assertions 1-3 active and
      passing; assertion 4 checked in as `it.todo()` / `it.skip()`
      (its activation is part of C.4's acceptance, not C.1's — see §7).
- [ ] Every IPC handler in main has a row in §4 with a non-blank tag
      (or `mixed` plus a per-field breakdown in the notes column).
- [ ] Every `@silverhand/backend` symbol imported by main has a row in §3.
- [ ] Roadmap §Stage C "PR breakdown C.1" item references this file.

C.2 / C.3 / C.4 each remove one class of debt; the catalogue is updated
**in the same PR** that resolves a row (the tripwire test enforces
this).

## 9. Out of scope (deferred)

- Renderer hardening for SSE/WS over a real network (TLS, keepalive,
  reconnect under outbound proxy) — that is part of Stage D2 / D3,
  not C.
- CLI (`packages/cli`) audit of `SILVERHAND_*` env injection — covered
  in the roadmap's Stage C bullet; spun out into a follow-up doc only
  if the surface turns out to be larger than expected. For V1 the CLI
  already routes every call through `SILVERHAND_SERVER_URL` and the
  per-spawn `bin/silverhand` shim, so the audit is expected to be
  uneventful (one PR to add the assertion, no code change).
- Daemon outbound transport (Stage D2) and orchestration boundary
  (Stage D2.0) — they shape the **daemon ↔ server** wire, not the
  renderer ↔ backend wire that Stage C governs.

---

## Review log

- 2026-05-25 — Initial draft by @Alice (Stage C.1 deliverable).
- 2026-05-25 (round 1) — @Cindy review (#task:574). Two P1 + one P2 absorbed:
  - **P1 local-host-only UX gate**: §2/§4/§5 rewritten. `showItemInFolder` / `pickDirectory` / `CreateWorkspaceDialog` gate is now **path provenance** (`host.id === local_host_id && host.kind === 'local'`), not backend mode. Backend mode is orthogonal to host kind — under remote-backend mode the desktop is still a local Host and user-fs paths remain legitimate. §5 also defines how `local_host_id` reaches the renderer (additive field on `backend:info`).
  - **P1 auth_token consumer list**: §6 split into §6.1 — full enumeration of all 8 sites (3 in `lib/api.ts`, 1 in `ws-client.ts`, 1 in `me/hooks.ts`, 1 in `agents/avatar-hooks.ts`, 2 preload type declarations). §7 grows a 4th tripwire assertion that **renderer source tree contains zero `auth_token` references** — checked in immediately, fails until C.4 lands. Whitelist limited to main's `backend:info` handler and headless smoke handshake.
  - **P2 headless stdout token**: new §6.2 documents the embedded-only dev surface, requires `auth_token: null` (or omit) under remote mode, calls it out of scope for C.4 renderer changes, pins it as the single permitted `auth_token` reader in main post-C.4. D1 reshapes it via `packages/server` entry point.
- 2026-05-25 (round 2) — @Cindy second pass. Two more issues absorbed:
  - **P1 §7 vs §8 contradiction**: §7 originally said assertion 4 was "checked-in and expected to fail until C.4", but §8 required the test to pass against the current tree — C.1 cannot land a default-failing test. Resolved by parking assertion 4 as `it.todo()` (or `.skip` with a TODO comment), keeping suite green through C.1 → C.4; C.4's acceptance includes flipping the assertion to `it()`. §7 rewritten into a per-assertion table; §6.1 closing paragraph aligned; §8 first checkbox restated.
  - **P2 `backend:info` was wrongly single-tagged `embedded-only`**: Cindy noted §5 also requires the route to grow `local_host_id`, which is general protocol metadata, not embedded legacy. New tag **mixed** added to §2 vocabulary with a rule that the notes column must enumerate every contributing tag at field-level. `backend:info` row in §4 retagged to `mixed`, with `url` + `mode` + `local_host_id` called out as **OS-IPC** and `auth_token` as **embedded-only**. C.4's fence is field-scoped, not route-scoped.
- 2026-05-25 (round 3) — @Cindy third pass. One P2 absorbed:
  - **Vocab mismatch — `local_host_id` was tagged both `OS-IPC` (round 2 §4) and `data` (round 1 §5)**, and shoving connection-metadata fields under OS-IPC was conceptually awkward (OS-IPC is "native desktop capability"). Resolved by adding a sixth vocab tag **protocol metadata** in §2 — neutral, dual-mode connection info (`url`, `mode`, `local_host_id`, future `host_kind`) that the renderer needs to address the backend and gate per-host UX. §4 `backend:info` row retagged accordingly (`url` + `mode` + `local_host_id` = protocol metadata; `auth_token` still embedded-only). §5 `local_host_id` propagation paragraph rewritten to use the same word. §4 closing paragraph rewritten so `backend:info` post-C.4 is described as "pure protocol metadata + a nullable embedded-only legacy field". Strictest-wins ordering extended: protocol metadata sits at the bottom (most benign) since it carries no purity hazard.
- 2026-05-26 (C.2/C.3 implementation) — catalogue synced to the post-Stage-A/B tree:
  - **C.2 data IPC**: auth/session, central backend proxy, upload proxy, and host rotate/revoke IPC rows added with token-boundary notes; protocol-purity test now asserts the exact `ipcMain.handle` set.
  - **C.3 host provenance**: local-path UX rows updated to use `local_host_id` + owner-filtered `/api/hosts`; renderer gate is explicitly path provenance, not backend mode.
  - **C.4 carry-forward**: stale `BackendInfo.auth_token` consumer list replaced with the then-current `event_auth_token` WS surface; assertion 4 stayed parked until C.4.
- 2026-05-26 (C.4 implementation) — embedded bootstrap + renderer token cleanup:
  - `/auth/embedded-bootstrap` added as the only embedded-only route delta. Backend writes `~/.silverhand/embedded-bootstrap` before listen, stores only an in-memory hash, rejects non-loopback / remote mode / stale / consumed / wrong tokens as 404, and returns a normal session bearer. `SILVERHAND_DISABLE_SIGNUP=1` does not disable this local bootstrap path.
  - Event WS moved from legacy `serverConfig.auth_token` + `app_settings.viewer_user_id` to the session subject. Electron main owns a path-scoped `HttpOnly` cookie for `/api/ws/events`; renderer sends no bearer-bearing auth frame and `BackendInfo` carries no token field.
  - Assertion 4 is active and scans preload + renderer sources for `auth_token` references. C.6 removes the documented headless smoke exception.
- 2026-05-26 (C.5 implementation) — legacy current-viewer bridge cleanup:
  - Auth success paths and embedded bootstrap no longer write `app_settings.viewer_user_id`; `/api/register` was removed from the public router and shared path catalogue.
  - `SettingsRepo.getViewerUserId()` was removed. Remaining live viewer-scope events derive from `conversation_users`; legacy null-user formatting falls back only when the conversation has exactly one human member.
  - Backend tripwire `legacy-viewer-bridge.test.ts` fails loud on `getViewerUserId`, `bridgeLegacyViewer*`, or new `settings.set(SETTINGS_KEYS.VIEWER_USER_ID)` writes under `packages/backend/src`.
- 2026-05-26 (C.6 implementation) — server-config bearer retirement:
  - Public `/api/*` bearer auth accepts only user session tokens; a retired `serverConfig.auth_token` value is just an invalid bearer, even if a legacy viewer/principal header is present.
  - Event WS cookie auth accepts only user session tokens. `serverConfig.auth_token` is optional read-compat in `ServerConfigSchema`; new desktop writes omit it and runtime code does not read it.
  - `dev:headless` smoke uses the embedded-bootstrap token file and endpoint rather than printing a long-lived bearer on stdout.
