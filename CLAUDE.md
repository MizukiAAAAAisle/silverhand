# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Silverhand is an Electron desktop app that orchestrates multiple coding-agent CLIs (currently `claude`) as participants in chat-style channels. It's modeled on `@slock-ai/daemon`'s process orchestration but introduces a two-tier **Channel + Multi-Session** structure on top of slock's flat agent list. The reference slock implementation lives at `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/` and is consulted whenever spawn/IO behavior diverges.

Authoritative design docs:
- `docs/core-design.md` — current architecture, especially §10 "Deferred design".
- `docs/app-layout.md` — UI structure, message rendering, Save, Reply/child-session, titlebar, sidebars, events window. Layout + interaction spec; pairs with the theme guide below.
- `docs/design-new-theme.md` — theme/token guide (colors, spacing, typography per theme).
- `docs/progress.md` — append-only history; add a dated section after meaningful changes.
- `docs/electron-agent-hub.md` — original product/architecture brief.

## Common commands

All commands run from the repo root unless noted.

- `pnpm dev` — full dev launcher (`./scripts/dev.sh`): installs deps if missing, swaps the `better-sqlite3` native binding to the Electron ABI (cached per-ABI under `node_modules/.bsq-cache/`), starts `electron-vite dev`. Use `--clean` to drop build outputs, `--reinstall` to wipe `node_modules` and the binding cache.
- `pnpm dev:headless` — backend only (no Electron window). Useful for `curl` smoke-tests against `http://127.0.0.1:<port>`.
- `pnpm test` — runs vitest under **system node** via `./scripts/test.sh`. The script swaps the `better-sqlite3` binding back to the Node ABI before invoking vitest. Pass-through args supported: `./scripts/test.sh packages/backend/src/foo.test.ts -t 'name'`.
- `pnpm typecheck` — `tsc --noEmit` across all workspaces (`pnpm -r typecheck`).
- `pnpm build` / `pnpm clean` — recursive build / clear `dist` + caches.

The ABI swap is essential: `better-sqlite3` ships a single `.node` binding compiled for one `NODE_MODULE_VERSION`. Electron 33 and Node 24 use different ABIs, so `dev.sh` and `test.sh` cache per-ABI builds and `cp` the right one into place. **macOS gotcha**: `cp` invalidates the binding's code signature; `scripts/_native.sh` re-applies `codesign --sign - --force` after the swap.

## Workspace layout

pnpm workspaces, all `workspace:*` linked:

- `packages/shared` — DTOs, zod schemas, SQLite migrations, driver interfaces. Host-agnostic.
- `packages/backend` — Hono HTTP server, `better-sqlite3` (WAL), `SessionManager`, provisioning helpers. Host-agnostic; consumed by both the Electron main process and `dev:headless`.
- `packages/chat-bridge` — MCP stdio server (`@modelcontextprotocol/sdk`) bridging the spawned `claude` CLI's `mcp__chat__send_message` calls back to backend HTTP.
- `apps/desktop` — Electron 33 main + React renderer (electron-vite, React Query + SSE, Tailwind v4, Radix UI).

## Architecture in five facts

1. **Channels and sessions are two tiers.** A `channel` (regular or DM) groups agents and metadata; a `session` is one running conversation inside a channel. DM channels (`kind = 'dm'`) auto-provision with a single agent and skip member-picker UI. Regular channels can have multiple member agents; sessions inherit a snapshot of the channel's agents at creation time.

2. **Each (session, agent) pair is a child process.** `SessionManager` (`packages/backend/src/session-manager.ts`) spawns the agent's CLI per session-agent pair, wires `stdin`/`stdout` as `stream-json`, and tracks lifecycle. Agents reply by calling the `mcp__chat__send_message` tool exposed by chat-bridge. **Critical**: `claude --input-format stream-json` hangs intermittently if stdin starts empty, so `start()` schedules `drainInbox(handle)` immediately after spawn. A `drainChain` promise on each `AgentHandle` serializes concurrent drains (spawn-time vs. `session_init` event), so the same inbox row never gets written twice.

3. **L1 vs L2 agent state.** Each agent has L1 files at `~/.silverhand/agents/<id>/` (the canonical `system_prompt.md`, `MEMORY.md`, `notes/`) and L2 working copies at `<workspace>/.silverhand/agents/<id>/` (per-channel). `provisionChannel` / `provisionDmChannel` / `joinChannel` / `leaveChannel` in `packages/backend/src/provision.ts` are the single source of truth for the L1 ↔ L2 lifecycle. **Adding a member must call `joinChannel`** — it seeds L2, calls `addAgent` on every open session in that channel, broadcasts a system message, and spawns the new agent. Bypassing it leaves agents with missing L2 files.

4. **Inbox flow when an agent is offline.** Messages arriving while an agent isn't running are persisted to the inbox. On the next spawn, `drainInbox` formats them as `stream-json` user messages and writes them to stdin. Re-delivery is idempotent via `markDelivered`.

5. **chat-bridge is launched via `npx tsx` in dev.** `apps/desktop/src/main/index.ts` resolves the launcher to `npx tsx <abs path to cli.ts>` for dev (sidesteps pnpm hoisting variability) and to `process.execPath + dist/cli.js` for packaged builds. The backend's `assertLauncherResolvable` checks the launcher exists on PATH (or as an absolute path) before spawning, failing loudly instead of producing a stuck child.

## Logging and debugging

- File logger writes JSONL to `~/.silverhand/logs/`:
  - `backend-<utc>.log` — backend events (spawns, drains, errors, HTTP errors).
  - `chat-bridge-<sessionId>-<agentId>.log` — per-bridge child output. The backend passes `SILVERHAND_LOG_DIR` via env when spawning chat-bridge.
- When a session never emits `session_init`, the most likely culprits in order: (a) stdin not primed at spawn time (verify `drainChain` ran), (b) launcher not on PATH, (c) `system-prompt-file` / `mcp-config` arg malformed. Inspect `argv` of the suspect `claude` pid — silverhand-spawned ones carry `--system-prompt-file /var/folders/.../<sessionId>/<agentId>/system-prompt.md` which uniquely distinguishes them from user-interactive `claude` invocations.

## Conventions worth knowing

- **Target platform is macOS only** for v1. Don't add Win/Linux compatibility branches (no `frame: false` fallback, no self-drawn min/max/close, no `process.platform !== 'darwin'` workarounds in the renderer). The `titleBarStyle: 'hiddenInset'` / `trafficLightPosition` lines in `apps/desktop/src/main/index.ts` are guarded by `process.platform === 'darwin'` only because their *values* don't make sense off-mac — this isn't an invitation to also write the non-mac branch. See `docs/app-layout.md` §0/§2/§11 for the full scoping.
- **Onboarding system messages must be imperative**, not descriptive — descriptive prompts ("welcome, please introduce yourself") frequently produce no reply. See `ONBOARDING_BODY` in `packages/backend/src/provision.ts` for the slock-aligned template ("Onboarding task (system-triggered): You (@xxx) just joined #foo. 1) send one short greeting via mcp__chat__send_message. 2) Stop after greeting.").
- **No "stop" affordance in the composer.** Per IM design, message sending is one-shot; agent execution control belongs elsewhere (TBD). Don't reintroduce it.
- **Renderer composer is IME-safe.** Enter sends, Shift+Enter newlines, but `onCompositionStart/End` + `e.nativeEvent.isComposing` must guard against firing during CJK input.
- **Driver platform prompt** (`packages/backend/src/drivers/platform-prompt.ts`) prescribes a terse communication style: one-or-two-sentence default, no filler acknowledgments, no idle narration, no echoing of tool calls. Keep edits to it consistent with that voice.
- **Better-sqlite3** is used synchronously; backend code assumes WAL mode and single-process writes. No connection pooling.
