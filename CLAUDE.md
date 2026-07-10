# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Silverhand orchestrates multiple coding-agent CLIs as participants in chat-style conversations. Drivers exist for `claude`, `codex`, `cursor`, `opencode`, and `qoder`; of these `claude`/`codex`/`qoder`/`opencode` are user-selectable in the create/profile pickers, `cursor` has a driver but isn't offered yet (`selectable: false`), and `gemini` is enum-only (no driver). The agent's `runtime` field selects the driver at spawn time; per-runtime UI/capability facts (label, selectability, reasoning-effort options) live in one catalog (`packages/shared/src/runtime-catalog.ts`). It runs in two deployment shapes from the **same backend library**: **embedded** (the Electron desktop app spawns an in-process backend + a local daemon) and **standalone** (a headless `silverhand-server` Node process; agent runtime attaches over an outbound WebSocket). Process orchestration is modeled on `@slock-ai/daemon` (reference impl at `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/`, consulted when spawn/IO behavior diverges) on top of a three-tier **Workspace → Channel → Thread** structure.

Authoritative design docs (read the relevant one before non-trivial work):

- `docs/architecture-principles.md` — **MUST-READ before any new service / route / DB table / migration.** Human/Agent isomorphism checklist, anti-patterns, known-vuln list.
- `docs/core-design.md` — product + data-model authority. **Code that conflicts with this doc is the bug.** §10 = deferred design.
- `docs/permissions.md` + `docs/graded-permissions-v1.md` — authorization model (resource ownership by `viewer_user_id`, graded capabilities).
- `docs/auth-and-host-model.md` — users / sessions / signup toggle, and the host-credential model (bootstrap vs long-lived; a host's credential *is* the daemon's wire identity).
- `docs/silverhand-daemon.md` + `docs/daemon-outbound-protocol.md` — the daemon and the backend↔daemon wire contract (local Unix socket embedded; outbound WebSocket standalone). `docs/multi-daemon-registry.md` for daemon-instance tracking.
- `docs/server-env-config.md` + `docs/build-release.md` — standalone-server env contract; desktop DMG packaging.
- `docs/cli-system.md` — the agent-facing `silverhand` CLI surface, env contract, errors, maintenance checklist.
- `docs/agent-system-prompt-memory.md` — the three-file model (L1 `system_prompt.md`, L2 `MEMORY.md` / `notes/`) and spawn-time prompt assembly.
- `docs/platform-prompt-design.md` — **READ before editing the platform prompt** (`packages/shared/src/platform-prompt.ts`). The canonical section skeleton, load-bearing content that must not be silently dropped, security-critical renderers, and test discipline that hold across edits.
- `docs/agent-run-state.md` — `AgentRunState` lifecycle, snippet accumulation, compaction-as-state, Activity Bubble.
- `docs/app-layout.md` + `docs/design-new-theme.md` — UI structure / interaction spec and theme tokens.
- `docs/progress.md` — recent-changes log; add a dated section after meaningful changes, and prune stale/old entries to keep it short (full history lives in `git log`).
- `docs/electron-install-troubleshooting.md` — fix for `pnpm dev` failing with `Error: Electron uninstall` (it's an `extract-zip` failure, **not** a mirror/download problem).

## Common commands

All commands run from the repo root unless noted.

- `pnpm dev` — full dev launcher (`./scripts/dev.sh`): installs deps if missing, swaps the `better-sqlite3` native binding to the Electron ABI, starts `electron-vite dev`. `--clean` drops build outputs; `--reinstall` wipes `node_modules` + binding cache. If it fails with `Error: Electron uninstall`, electron is half-installed — see `docs/electron-install-troubleshooting.md`.
- `pnpm dev:headless` — backend only, no Electron window. Useful for `curl` smoke-tests against `http://127.0.0.1:<port>`.
- `pnpm test` — vitest under **system node** via `./scripts/test.sh` (swaps the `better-sqlite3` binding back to the Node ABI first). Scope a package and pass through args: `./scripts/test.sh --scope backend tests/foo.test.ts -t 'name'`. The test gate covers `shared backend server host cli desktop`.
- `pnpm typecheck` — `tsc --noEmit` across all workspaces (`pnpm -r typecheck`).
- `pnpm build` / `pnpm clean` — recursive build / clear `dist` + caches.
- `pnpm package` / `pnpm package:dir` — build the desktop DMG / unpacked `.app` (`./scripts/package.sh`; see `docs/build-release.md`). `:dir` skips the DMG for faster smoke testing.

The ABI swap is essential: `better-sqlite3` ships one `.node` binding compiled for a single `NODE_MODULE_VERSION`. Electron and Node 24 use different ABIs, so `dev.sh` / `test.sh` cache per-ABI builds and `cp` the right one into place. **macOS gotcha**: `cp` invalidates the binding's code signature; `scripts/_native.sh` re-applies `codesign --sign - --force` after the swap.

## Workspace layout

pnpm workspaces, all `workspace:*` linked:

- `packages/shared` — DTOs, zod schemas, SQLite migrations, driver interfaces. Host-agnostic, no Node/Electron deps.
- `packages/backend` — the core library: Hono HTTP server, `better-sqlite3` (WAL), repos, services, auth, the `AgentRuntimeHost` abstraction, provisioning. `startBackend({ mode: 'embedded' | 'standalone', ... })` is the single entry; both desktop and the standalone server boot through it.
- `packages/server` — standalone deployment entry (`silverhand-server` bin): a thin wrapper that reads `SILVERHAND_*` env, configures the backend in `standalone` mode (owns DB / HTTP / auth; agent runtime only available once a daemon attaches over outbound WS). See `docs/server-env-config.md`.
- `packages/host` — the `silverhand-daemon` process. **Owns agent spawn, inbox drain, and run-state** (the old `ConversationManager` responsibilities). Contains the agent drivers (`src/drivers/{claude,codex,cursor,opencode,qoder}.ts`; `claude`/`codex`/`qoder` speak the bidirectional `stream-json` protocol via `src/drivers/stream-json.ts`, `opencode` speaks ACP via `src/drivers/acp.ts`, `cursor` is a one-shot `--print` driver) and the daemon↔backend transport (local Unix socket for embedded, outbound WebSocket for standalone).
- `apps/desktop` — Electron main + React renderer (electron-vite, React Query + event WebSocket, Tailwind v4, Radix UI). In the **embedded** shape it spawns the in-process backend and a local daemon; a **remote-only** build instead connects to a standalone server over HTTPS while still managing a local daemon (which attaches to the remote backend over outbound WS).

## Architecture in five facts

1. **Three conversation tiers, one table.** A `workspace` (`kind = 'workspace' | 'dm'`) groups member agents; a `conversation` is one running thread inside it, with `kind ∈ {'channel', 'dm_channel', 'thread'}`. DM workspaces auto-provision a single agent and skip member-picker UI. Channels snapshot the workspace's agents at creation. This is the canonical model — the legacy `channels` / `sessions` tables were dropped in migration (the Workspace→Channel→Thread cutover is done at the DB layer; `docs/workspace-channel-thread-hard-cutover.md` tracks any residual cleanup).

2. **Backend ↔ daemon split via `AgentRuntimeHost`.** The backend never spawns agents directly; it calls the `AgentRuntimeHost` interface (`packages/backend/src/runtime/agent-runtime-host.ts`). Embedded mode delegates to the local daemon over a Unix socket; standalone mode (`outbound-agent-runtime-host.ts`) sends commands to a remote daemon over an outbound WebSocket. The daemon spawns each agent's CLI per `(conversation, agent)` pair, wires `stdin`/`stdout` as `stream-json`, injects `SILVERHAND_*` env, prepends a per-spawn `bin/silverhand` shim to `PATH`, and tracks lifecycle. When no daemon is attached in standalone mode, runtime calls fail with a typed `HostRuntimeDisabledError` — that is expected, not a crash.

3. **Claude stream-json deferred-init watchdog (hard-won).** `claude --input-format stream-json` *deterministically* withholds `system.init` until it receives the first real user message on stdin (verified empirically — `docs/incident-2026-05-08-claude-resume-init-watchdog.md`). So when claude is spawned with an empty inbox the daemon marks `active` with the real pid but does **not** arm the init watchdog; the watchdog arms once a real message lands and stdin gets its first write. **Never "prime" stdin with a synthetic user message** — every well-formed payload triggers a chargeable Anthropic turn and writes to the resume jsonl. A per-handle `drainChain` promise serializes concurrent drains (spawn-time vs. `session_init`) so an inbox row is never written twice.

4. **L1 vs L2 agent state.** L1 files at `~/.silverhand/agents/<id>/` are **identity** (`system_prompt.md` lives here only, shared across every workspace). L2 files at `<workspace>/.silverhand/agents/<id>/` are **workspace memory** (`MEMORY.md`, `notes/`). The DM workspace path coincides with L1, so its L2 sits inside L1. Spawn-time prompt assembly auto-injects `system_prompt.md` (L1), `MEMORY.md` (active L2, 16KB cap), and a workspace memory index — agents don't Read these to recover baseline. Agents pick the layer by **scope** of guidance (global → L1, workspace-scoped → L2). See `docs/agent-system-prompt-memory.md`.

5. **`silverhand` is a PATH command + auth model.** Agents act by running `silverhand message send` etc. In dev and release, `apps/desktop/src/main/index.ts` resolves the launcher to `process.execPath` + the CLI bundle with `ELECTRON_RUN_AS_NODE=1`; the daemon writes a per-spawn `bin/silverhand` shim and prepends it to `PATH`. Most commands call internal backend HTTP routes directly (authenticated by injected `SILVERHAND_*` tokens); freshness-sensitive `message send` and stale-resolution instead route through the daemon socket so the runtime coordinator stamps the observed boundary. That split is load-bearing: a client-TLS gap breaks direct-HTTPS commands (e.g. `task claim`) while socket-routed `message send` still works. At the human layer, auth is **session-token** based (users, email/password, `viewer_user_id`-scoped ownership; signup toggled by `SILVERHAND_DISABLE_SIGNUP`). Hosts carry their own credentials (bootstrap / long-lived) — see `docs/auth-and-host-model.md`.

## Logging and debugging

- File loggers write JSONL to `~/.silverhand/logs/`, one file per process boot. The **backend** process writes three categories:
  - `backend-<utc>.log` — system events (HTTP, scheduler, ws, auth, DB).
  - `agent-<utc>.log` — agent runtime spawn / drain / exit / compaction (owned by the daemon, surfaced through the outbound runtime projection).
  - `cli-<utc>.log` — every `silverhand` CLI invocation (`cli.invoke`, success or failure) plus `cli.preflight_failure` for CLI-side errors that never reach a route. See `docs/cli-system.md` §7.

  The **daemon** process writes its own `daemon-<utc>.log` — daemon lifecycle (boot / shutdown), spawn, and IO-backpressure drops.
- When a conversation never emits `session_init`, likely culprits in order: (a) stdin not written at spawn (verify `drainChain` ran), (b) runtime launcher not on PATH, (c) `--append-system-prompt-file` arg malformed. Silverhand-spawned `claude` pids carry `--append-system-prompt-file /var/folders/.../<conversationId>/<agentId>/spawn-*/system-prompt.md`, which distinguishes them from user-interactive `claude`. (We **append** onto Claude's built-in system prompt, not replace via `--system-prompt-file`.)

## Conventions worth knowing

- **Target platform is macOS only** for v1. Don't add Win/Linux branches (no `frame: false` fallback, no self-drawn window controls, no `process.platform !== 'darwin'` workarounds in the renderer). The `titleBarStyle: 'hiddenInset'` / `trafficLightPosition` lines are guarded by `process.platform === 'darwin'` only because their *values* don't make sense off-mac — not an invitation to write the non-mac branch. See `docs/app-layout.md` §0/§2/§11.
- **Onboarding system messages must be imperative**, not descriptive — descriptive prompts ("welcome, please introduce yourself") frequently produce no reply. See `ONBOARDING_BODY` in `packages/backend/src/provision.ts`.
- **No "stop" affordance in the composer.** Per IM design, message sending is one-shot; agent execution control belongs elsewhere (TBD). Don't reintroduce it.
- **Renderer composer is IME-safe.** Enter sends, Shift+Enter newlines, but `onCompositionStart/End` + `e.nativeEvent.isComposing` must guard against firing during CJK input.
- **Driver platform prompt** (`packages/shared/src/platform-prompt.ts`) prescribes a terse voice: one-or-two-sentence default, no filler acknowledgments, no idle narration, no echoing tool calls. Keep edits consistent with that voice. **Before editing it, read `docs/platform-prompt-design.md`** — the design contract (section order, load-bearing rules, security-critical renderers, test discipline) that any edit must uphold.
- **CLI changes must update both `docs/cli-system.md` and the platform prompt.** Any change to `packages/cli`, agent-facing DTO schemas, internal agent routes, task behavior, or `silverhand` command guidance must keep `docs/cli-system.md` and `packages/shared/src/platform-prompt.ts` in sync in the same change.
- **DDD discipline is how this codebase resists rot.** `docs/core-design.md` is the domain model's source of truth and the **ubiquitous language** — one concept gets one name across code / DB / DTOs / UI / docs (when code conflicts with that doc, the code is the bug). `docs/architecture-principles.md` encodes the core domain invariant (Human/Agent isomorphism). Keep domain logic in services / domain, not leaked into routes, transport, or the renderer; respect bounded-context boundaries between packages (`shared` owns the model + schema, `host` owns runtime, `backend` owns orchestration); model-first, then map to the SQLite schema — never let the schema or a quick patch dictate the model. Naming drift (two names for one lifecycle) is the first rot signal — converge it, don't add a synonym.
- **Better-sqlite3** is used synchronously; backend code assumes WAL mode and single-process writes. No connection pooling.
- **Migrations are append-only.** Old `CREATE TABLE` statements stay in `packages/shared/src/db/migrations.ts` forever (incl. for dropped tables) — presence in that file does not mean the table is live. Add a new versioned migration; never edit a shipped one.

## Network / protocol review gate

Any change to network, TLS, proxy, or wire protocol is **multi-process by default — audit every edge, never just the main path.** `tls.setDefaultCACertificates()` (and most runtime config) is process-local and does not cross the spawn boundary, so enabling a capability in one process does not reach the others.

- **Outbound TLS / CA / proxy** — audit by *who dials out*, not by component list. `enableNodeSystemCa()` runs in desktop-main, the daemon, and the spawned CLI; the standalone `server` is inbound-only (add it there only if it starts making outbound calls). The renderer uses Chromium's own trust store, so Node TLS config is N/A there. Spawned runtime children trust via injected env (`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `HTTP(S)_PROXY` / `NO_PROXY`), not the helper.
- **Wire protocol** — keep the two version constants (`HOST_PROTOCOL_VERSION`, `OUTBOUND_PROTOCOL_VERSION`) synced across both transports (Unix socket embedded + outbound WS standalone).
- **Edges to walk**: renderer↔main (IPC / Chromium net) · main·server↔daemon (Unix socket / outbound WS) · CLI↔daemon socket & CLI↔server HTTPS · daemon↔runtime-child stdio · backend↔renderer event WebSocket (`/api/ws/events`).

State explicitly when a surface is unaffected, rather than leaving it unmentioned.
