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
| **local-host-only UX** | Legitimate "reveal in Finder", "open in default app" style affordance that only makes sense when the host is `kind=local` and the path exists on the user's machine. | Keep, but gate behind `info.mode === 'embedded' && host.kind === 'local'` in **C.3**. |
| **in-process shortcut** | main-process code that imports backend symbols directly (`startBackend`, `BackendContext`, `createCategorizedLoggers`, …) rather than going over HTTP. | Stays in **embedded** boot path only; Stage D1 extracts the symbols into `packages/server` and main launches that as a child process or in-proc adapter. |
| **embedded-only** | Code that holds embedded-mode invariants (auth_token plaintext, loopback URL, `mode='embedded'` constant). | Keep, but **fence** behind a `mode === 'embedded'` check in **C.4**. Any new caller without the fence is a regression. |

> A site can carry only one tag. If two seem to fit, the strictest one
> wins: **data** beats **OS-IPC** beats **local-host-only UX**.

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
| `backend:info` | `getBackendInfo` | **embedded-only** | Returns `{url, mode, auth_token}` from `ServerConfig`. Under remote mode `auth_token` must be `null` / absent; renderer's auth header comes from the session that signup/login produced (Stage A). C.3 propagates `mode` to renderer; C.4 strips `auth_token` from remote-mode payload and switches renderer's `fetchWithInfo` to read the session token instead. |
| `dialog:pickDirectory` | `pickDirectory` | **OS-IPC** | Native open dialog. Kept. Only ever used by `CreateWorkspaceDialog`. Under remote mode the picked path is a path on the user's machine — and the new workspace would live on the **server**'s filesystem. C.3 must either disable this control under remote mode or redefine it as "browse server-side directories via HTTP" (out of scope for V1; UI hides the button when `mode !== 'embedded'`). |
| `shell:openExternal` | `openExternal` | **OS-IPC** | Strict `https?://` allowlist already enforced. Kept as-is. |
| `attachment:openExternal` | `openAttachmentExternal` | **OS-IPC** | Renderer fetches bytes via HTTP first; main only handles the local tmp-write + Launch Services call. Already protocol-pure. Keep. |
| `shell:showItemInFolder` | `showItemInFolder` | **local-host-only UX** | Caller passes server-side absolute path. Two call sites: `AgentWorkspaceCard` (reveals agent dir) and `WorkspacesPanel` (reveals workspace_path). Under remote mode those paths don't exist on the user's machine. C.3 gates the button: only render when `info.mode === 'embedded'` AND the path's host is `kind=local`. Don't remove the affordance — it's the only "where did my files go" handle a power user has. |
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

Pure-renderer code (no IPC hop, no fetch) that still assumes co-located
host fs. Each entry is a place C.3 must gate behind
`info.mode === 'embedded'`.

| Site | Symptom | C.3 disposition |
|---|---|---|
| `features/agents/AgentWorkspaceCard.tsx:53` | `onReveal = () => window.agentHub.showItemInFolder(path)` | Render the button only under embedded + `host.kind=local`. |
| `components/layout/WorkspacesPanel.tsx:127` | `onClick = window.agentHub.showItemInFolder(w.workspace_path)` | Same gating. |
| `features/workspaces/CreateWorkspaceDialog.tsx:68` | Directory picker for new workspace path | Under remote mode, hide the picker and require the user to choose a server-known workspace root (V1: forbid create-workspace under remote, surface "remote workspaces are managed server-side"). |
| `lib/api.ts` `fetchWithInfo` | Sends `Authorization: Bearer ${info.auth_token}` unconditionally | C.4 splits paths: embedded → loopback bootstrap session, remote → signed-in session. The eventual bearer token is *the same shape*; only the source differs. |

The `viewer_user_id` header (`X_SILVERHAND_PRINCIPAL_HEADER`) flows
through `fetchWithInfo` and is unaffected — it's set from `/api/me`
hydration, identical under both modes.

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
| `main/index.ts:532-539` `backend:info` handler | Returns `auth_token` verbatim | C.4: when `mode === 'remote'`, omit `auth_token` from the payload (or set to `null`). |
| `renderer/lib/api.ts:35` `getInfo` consumer | Trusts `info.auth_token` exists | C.4: under remote, read bearer from `safeStorage`-backed session instead. `BackendInfo` becomes `{url, mode}` only on the wire; auth is acquired separately. |
| (new) `/auth/embedded-bootstrap` route | does not exist | C.4 lands the route + the four-constraint test matrix (one test per constraint × {happy, violated}). |
| (new) `~/.silverhand/embedded-bootstrap` token file | does not exist | C.4 lands write (mode 0600) at backend boot + consume-on-first-read semantics + regenerate on reboot. |

## 7. Catalogue invariant test

`apps/desktop/src/main/__tests__/protocol-purity.test.ts` is the
single-file tripwire that keeps this document honest. Three assertions:

1. **Imports from `@silverhand/backend` in `apps/desktop/src/main/**/*.ts`**
   equals exactly the set in §3.
2. **`ipcMain.handle` channels registered in `apps/desktop/src/main/**/*.ts`**
   equals exactly the set in §4.
3. **Renderer source tree** contains zero references to
   `from '@silverhand/backend'` or `from '@silverhand/backend/...'`.
   (Type-only re-exports through `@silverhand/shared` are fine and
   actively encouraged — shared is the protocol layer.)

When a PR needs to add a new IPC handler or a new backend import, the
flow is: update this doc + add the disposition row, **then** the test
passes, **then** ship the implementation. No drive-by additions.

The test is implemented with `glob` + `node:fs` reads; no AST tooling
needed. Keep it dependency-free so it runs in the same `pnpm test`
sweep without driving new node_modules.

## 8. Acceptance criteria for closing C.1

- [ ] This document reviewed by Cindy + shiki LGTM.
- [ ] Tripwire test `protocol-purity.test.ts` lands and passes against
      the current tree.
- [ ] Every IPC handler in main has a row in §4 with a non-blank tag.
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
