# Protocol Purity Checklist (Stage C.1 audit catalogue)

> **Status**: draft for review. Owner: @Alice. Companion to
> `docs/remote-backend-roadmap.md` §Stage C. This is the **agreement
> layer** — no code changes are landed under C.1; subsequent PRs (C.2 /
> C.3 / C.4) act on the dispositions recorded here.

## 1. Purpose

Stage C's invariant is: **the renderer's view of the world is
indistinguishable between embedded and remote backends, except for one
fenced auto-bootstrap route**. That invariant fails today because:

1. The main process imports backend internals as JS (`startBackend`,
   `BackendContext`, log sinks) instead of speaking HTTP to them. Under
   remote mode there is nothing to import.
2. Several IPC routes pass server-side state or absolute server-side
   paths to the renderer. Under remote mode those paths don't exist on
   the user's machine.
3. `BackendInfo.mode` is part of the schema but no renderer code
   consumes it. Local-host-only UX therefore can't be gated.

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
| **in-process shortcut** | main-process code that imports backend symbols directly (`startBackend`, `BackendContext`, `createCategorizedLoggers`, …) rather than going over HTTP. | Stays in **embedded** boot path only; Stage D1 extracts the symbols into `packages/server` and main launches that as a child process or in-proc adapter. |
| **embedded-only** | Code that holds embedded-mode invariants (auth_token plaintext, loopback URL, `mode='embedded'` constant). | Keep, but **fence** behind a `mode === 'embedded'` check in **C.4**. Any new caller without the fence is a regression. |
| **mixed** | A single IPC route / file carries fields with different tags (e.g. `backend:info` returns both general protocol metadata and an embedded-only `auth_token`). | The row's notes column MUST enumerate every contributing tag at field-level. Any field promotion (e.g. an OS-IPC field that grows embedded-only assumptions) is a regression unless the table is updated in the same PR. |

> Each **field** carries exactly one tag. If two seem to fit the same
> field, the strictest one wins: **in-process shortcut** beats **data**
> beats **embedded-only** beats **local-host-only UX** beats **OS-IPC**.
> When a route exposes multiple fields with different tags, tag the
> route as **mixed** and break the contributing tags down per field in
> the notes column (e.g. `backend:info`).

## 3. Main-process direct backend imports

Single file: `apps/desktop/src/main/index.ts`.

```ts
import {
  startBackend,
  createCategorizedLoggers,
  type CategorizedLoggers,
  type RunningBackend,
  type FileLogger,
} from '@silverhand/backend';
```

| Symbol | Tag | V1 disposition |
|---|---|---|
| `startBackend` | in-process shortcut | Stays the embedded boot path. Under D1 the implementation moves to `packages/server`; embedded mode re-exports it for in-proc launch, remote mode skips the call entirely. |
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
| `backend:info` | `getBackendInfo` | **mixed** (see notes) | Returns `{url, mode, auth_token, local_host_id?}`. Tag breakdown: **OS-IPC** for `url` + `mode` + `local_host_id` — single source of truth lives in main (`ServerConfig` + the host-claim outcome from Stage B); the renderer needs them to address the backend, choose its auth flow, and gate host-kind UX. **embedded-only** for the `auth_token` field — that field is the legacy embedded shortcut C.4 fences. Under remote mode `auth_token` is `null` and the renderer acquires its session bearer from `getSessionBearer()` (see §6.1). The route itself stays, and C.3 adds `local_host_id` as an additive field; only the `auth_token` field carries the embedded-only constraint. |
| `dialog:pickDirectory` | `pickDirectory` | **local-host-only UX** | Native open dialog. The picked path is on the user's machine; under Stage B that path can only be assigned to a local Host. Caller is `CreateWorkspaceDialog`. C.3 gates the picker on "the workspace's target host kind is `local` and equals this desktop's `local_host_id`". Backend mode is irrelevant — remote-backend + local-Host still picks user-fs paths legitimately. If/when the user has non-local hosts available (remote / sandbox), the create-workspace flow needs an additional "host placement" step that this V1 does not ship (deferred; see roadmap §5 Follow-up); until then default placement is the local Host and the picker stays. |
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

**No "data"-tagged routes today.** That is the good news; the bad news
is `backend:info` smuggles the auth_token through the embedded short
circuit, so C.4 must turn it from "data the renderer trusts" into
"opaque mode hint plus loopback URL". After C.4 the renderer treats
the `auth_token` field as **embedded-only** and acquires the bearer
token through the same signup/login flow it would use against a remote
server.

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
| `features/agents/AgentWorkspaceCard.tsx:53` | `onReveal = () => window.agentHub.showItemInFolder(path)` | Render only when the workspace's owning host satisfies `host.id === local_host_id && host.kind === 'local'`. Backend mode irrelevant. |
| `components/layout/WorkspacesPanel.tsx:127` | `onClick = window.agentHub.showItemInFolder(w.workspace_path)` | Same gating. Requires the workspace DTO to carry `host_id` (Stage B schema lands this on the runtime/workspace placement column; until then default-assume local). |
| `features/workspaces/CreateWorkspaceDialog.tsx:68` | Directory picker for new workspace path | V1 default placement is local Host, so the picker stays. When the create-workspace flow grows a host placement step (follow-up phase), the picker is conditional on "chosen host is local + equals `local_host_id`". Do **not** hide the picker under remote backend — that would break the most common V1 path. |
| `lib/api.ts` `fetchWithInfo` / `apiUpload` / `fetchAttachmentBlob` | Read `info.auth_token` (3 sites) | See §6.1 — these collapse into the single "session bearer" helper C.4 introduces. |
| `lib/ws-client.ts` `openSocket` | Reads `info.auth_token` for WS subprotocol/header | Same — §6.1. |
| `features/me/hooks.ts` avatar fetch | Reads `info.auth_token` manually | Same — §6.1. |
| `features/agents/avatar-hooks.ts` agent avatar fetch | Reads `info.auth_token` manually | Same — §6.1. |

The `viewer_user_id` header (`X_SILVERHAND_PRINCIPAL_HEADER`) flows
through every fetch helper and is unaffected — it's set from `/api/me`
hydration, identical under both modes.

**`local_host_id` propagation to renderer**: Stage B introduces the
`hosts` table and assigns this desktop's local host id when the daemon
claims/registers. Main exposes it to the renderer through an additive
field on `backend:info` (e.g. `local_host_id: string`) — that is a
**data**-tagged extension of an already existing IPC, not a new route,
so it stays inside the C.3 surface without needing a separate
disposition. Renderer caches it on `BackendInfo` and uses it for every
host-kind gate in this table.

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
| `main/config.ts:24-34` `loadOrCreateServerConfig` | Default `ServerConfig` has `mode='embedded'`, hardcoded loopback URL, freshly generated `auth_token` | Keep as embedded default. Add a sibling code path that produces `mode='remote'` when the user fills the server URL in Setup Wizard. The remote variant has `auth_token: null`. |
| `main/index.ts:532-539` `backend:info` handler | Returns `auth_token` verbatim | C.4: when `mode === 'remote'`, omit `auth_token` from the payload (or set to `null`). Type of `BackendInfo.auth_token` becomes `string | null`. |

### 6.1 `BackendInfo.auth_token` consumers

C.4 is **not** just a `fetchWithInfo` edit. Every renderer site that
reads `info.auth_token` must either disappear or route through a
single new helper (working title `getSessionBearer()`) that picks the
right token source per mode:

- embedded → bootstrap session persisted via `safeStorage`
  (initialised by `/auth/embedded-bootstrap` on first launch)
- remote → signup/login session persisted via `safeStorage`

| Site | Today | C.4 disposition |
|---|---|---|
| `apps/desktop/src/preload/index.ts:6` | `auth_token: string` (required) | Becomes `auth_token: string \| null` (embedded: string; remote: null). Renderer never reads it again after C.4 — kept only to let main's headless smoke handshake compile against the same type. |
| `apps/desktop/src/preload/api.d.ts:4` | mirrors preload | Same change. |
| `apps/desktop/src/renderer/lib/api.ts:47` `fetchWithInfo` | `Bearer ${info.auth_token}` | Switch to `Bearer ${await getSessionBearer()}`. |
| `apps/desktop/src/renderer/lib/api.ts:112` `apiUpload` inline `send` | `Bearer ${i.auth_token}` | Same. Consider folding into `fetchWithInfo` shape so there's one auth call site. |
| `apps/desktop/src/renderer/lib/api.ts:164` `fetchAttachmentBlob` | `Bearer ${info.auth_token}` | Same. |
| `apps/desktop/src/renderer/lib/ws-client.ts:193` `openSocket` | `token = info.auth_token` for WS subprotocol/header | Same. The WS session reuses the HTTP bearer; no separate token. |
| `apps/desktop/src/renderer/features/me/hooks.ts:171-181` avatar fetch | manual `Bearer ${info.auth_token}` | Same. |
| `apps/desktop/src/renderer/features/agents/avatar-hooks.ts:43-50` agent avatar fetch | manual `Bearer ${info.auth_token}` | Same. |
| (new) `/auth/embedded-bootstrap` route | does not exist | C.4 lands the route + the four-constraint test matrix (one test per constraint × {happy, violated}). |
| (new) `~/.silverhand/embedded-bootstrap` token file | does not exist | C.4 lands write (mode 0600) at backend boot + consume-on-first-read semantics + regenerate on reboot. |

The tripwire test §7 carries a fourth assertion — **renderer source
tree contains zero references to `auth_token` / `\.auth_token`** —
that is checked in during C.1 as `it.todo()` (or `it.skip()` with a
TODO comment) and is flipped to `it()` by C.4. See §7 for the full
lifecycle; C.1 ships green, C.4 ships green with the assertion
active.

### 6.2 Headless smoke path (dev / `pnpm dev:headless`)

`apps/desktop/src/main/index.ts:852-864` prints the embedded
`auth_token` on stdout as a JSON handshake so `curl`-driven smoke
tests can authenticate. This is a **dev-only embedded-only** surface
and is **out of scope for C.4 renderer changes**, but it is part of
the same embedded-token attack surface and must not be silently
forgotten:

- It is acceptable under embedded mode (loopback only, dev-only flag).
- Under remote mode it must print `auth_token: null` (or omit the
  field). Headless + remote is not a supported V1 flow — the
  expectation is that `dev:headless` only runs against embedded.
- D1 reshapes this when `packages/server` becomes the real headless
  entry point; until then it stays as-is.
- Tripwire whitelist: `main/index.ts:852-864` is the single permitted
  `auth_token` reader in main after C.4. Recorded here so a later
  pass that "removes all auth_token references" doesn't accidentally
  break the dev smoke path.

## 7. Catalogue invariant test

`apps/desktop/src/main/__tests__/protocol-purity.test.ts` is the
single-file tripwire that keeps this document honest. Four assertions
total — **three active in C.1, one parked as `it.todo` until C.4**:

| # | Assertion | C.1 state | Activated by |
|---|---|---|---|
| 1 | Imports from `@silverhand/backend` in `apps/desktop/src/main/**/*.ts` equals exactly the set in §3. | `it()` — active, must pass against the current tree. | C.1 |
| 2 | `ipcMain.handle` channels registered in `apps/desktop/src/main/**/*.ts` equals exactly the set in §4 (including the `mixed`-tagged `backend:info`). | `it()` — active, must pass. | C.1 |
| 3 | Renderer source tree contains zero references to `from '@silverhand/backend'` or `from '@silverhand/backend/...'` (type-only re-exports through `@silverhand/shared` are fine and actively encouraged — shared is the protocol layer). | `it()` — active, must pass. | C.1 |
| 4 | `apps/desktop/src/renderer/**/*.{ts,tsx}` contains zero references to `\.auth_token` or `auth_token:` reads. | `it.todo()` (or `it.skip()` with a TODO comment pointing at this doc §6.1) — checked in but **does not execute** in C.1. | C.4 — its acceptance includes flipping this from `it.todo()` to `it()` and having the suite stay green. |

Why park assertion 4 instead of running it red: a permanently-red
test trains the team to ignore it (and breaks CI gates we want green
for the C.2 / C.3 work that lands in between). Parking it as
`it.todo()` keeps the **intent** in the test file so a reviewer sees
the C.4 plan without consulting this doc, while keeping the suite
green so assertions 1-3 can guard their invariants without being
drowned out by a known failure.

Whitelisted exceptions for assertion 4 (once active): in main,
`index.ts:532-539` (`backend:info` handler) and `index.ts:852-864`
(headless smoke handshake) remain the only permitted readers (see
§6.2). In the renderer: none.

When a PR needs to add a new IPC handler or a new backend import, the
flow is: update this doc + add the disposition row, **then** the test
passes, **then** ship the implementation. No drive-by additions.

The test is implemented with `glob` + `node:fs` reads; no AST tooling
needed. Keep it dependency-free so it runs in the same `pnpm test`
sweep without driving new node_modules.

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
