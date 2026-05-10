# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Silverhand is an Electron desktop app that orchestrates multiple coding-agent CLIs (currently `claude`) as participants in chat-style channels. It's modeled on `@slock-ai/daemon`'s process orchestration but introduces a three-tier **Workspace → Channel → Thread** structure on top of slock's flat agent list. The reference slock implementation lives at `/Users/shiki/.npm/_npx/277f35d2ed0078b9/node_modules/@slock-ai/daemon/` and is consulted whenever spawn/IO behavior diverges.

Authoritative design docs:
- `docs/architecture-principles.md` — **MUST-READ before any new service / route / DB table / migration**. Human/Agent isomorphism checklist, anti-patterns, known-vuln list.
- `docs/core-design.md` — current architecture, especially §10 "Deferred design".
- `docs/app-layout.md` — UI structure, message rendering, Save, Reply/child-session, titlebar, sidebars, events window. Layout + interaction spec; pairs with the theme guide below.
- `docs/mcp-system.md` — current `mcp__chat__*` tool surface, schemas, side effects, and maintenance checklist.
- `docs/workspace-channel-thread-hard-cutover.md` — remaining work to finish the DB/backend/shared/frontend hard cutover from legacy `channels/sessions` runtime to canonical `workspaces/conversations`.
- `docs/agent-run-state.md` — `AgentRunState` lifecycle, snippet accumulation, compaction-as-state, Activity Bubble; the source of truth for "agent in a channel/thread is doing X" UX.
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
- `packages/backend` — Hono HTTP server, `better-sqlite3` (WAL), `ConversationManager`, provisioning helpers. Host-agnostic; consumed by both the Electron main process and `dev:headless`.
- `packages/chat-bridge` — MCP stdio server (`@modelcontextprotocol/sdk`) bridging the spawned `claude` CLI's `mcp__chat__send_message` calls back to backend HTTP.
- `apps/desktop` — Electron 33 main + React renderer (electron-vite, React Query + SSE, Tailwind v4, Radix UI).

## Architecture in five facts

1. **Workspaces and channels are two tiers.** A `workspace` (regular or DM) groups agents and metadata; a `channel` is one running conversation inside a workspace. DM workspaces (`kind = 'dm'`) auto-provision with a single agent and skip member-picker UI. Regular workspaces can have multiple member agents; channels inherit a snapshot of the workspace's agents at creation time.

2. **Each (channel, agent) pair is a child process.** `ConversationManager` (`packages/backend/src/conversation-manager.ts`) spawns the agent's CLI per channel-agent pair, wires `stdin`/`stdout` as `stream-json`, and tracks lifecycle. Agents reply by calling the `mcp__chat__send_message` tool exposed by chat-bridge. **Critical**: `claude --input-format stream-json` *deterministically* withholds `system.init` until it receives the first real user message on stdin (verified empirically; see `docs/incident-2026-05-08-claude-resume-init-watchdog.md`). The fix is **deferred init watchdog** — when claude is spawned with an empty inbox we mark `active` with the real pid but do not arm the init watchdog; once a real message lands and stdin gets the first write, the existing PR-A three-tier watchdog arms. Do not "prime" stdin with a synthetic user message — every well-formed payload triggers a chargeable Anthropic turn and writes to the resume jsonl. A `drainChain` promise on each `AgentHandle` serializes concurrent drains (spawn-time vs. `session_init` event), so the same inbox row never gets written twice.

3. **L1 vs L2 agent state.** Each agent has L1 files at `~/.silverhand/agents/<id>/` (the canonical `system_prompt.md`, `MEMORY.md`, `notes/`) and L2 working copies at `<workspace>/.silverhand/agents/<id>/` (per-workspace). `provisionWorkspace` / `provisionDmWorkspace` / `joinWorkspace` / `leaveWorkspace` in `packages/backend/src/provision.ts` are the single source of truth for the L1 ↔ L2 lifecycle. **Adding a member must call `joinWorkspace`** — it seeds L2, calls `addAgent` on every open channel in that workspace, broadcasts a system message, and spawns the new agent. Bypassing it leaves agents with missing L2 files.

4. **Inbox flow when an agent is offline.** Messages arriving while an agent isn't running are persisted to the inbox. On the next spawn, `drainInbox` formats them as `stream-json` user messages and writes them to stdin. Re-delivery is idempotent via `markDelivered`.

5. **chat-bridge is launched via `npx tsx` in dev.** `apps/desktop/src/main/index.ts` resolves the launcher to `npx tsx <abs path to cli.ts>` for dev (sidesteps pnpm hoisting variability) and to `process.execPath + dist/cli.js` for packaged builds. The backend's `assertLauncherResolvable` checks the launcher exists on PATH (or as an absolute path) before spawning, failing loudly instead of producing a stuck child.

## Logging and debugging

- File logger writes JSONL to `~/.silverhand/logs/`:
  - `backend-<utc>.log` — backend events (spawns, drains, errors, HTTP errors).
  - `chat-bridge-<conversationId>-<agentId>.log` — per-bridge child output. The backend passes `SILVERHAND_LOG_DIR` via env when spawning chat-bridge.
- When a channel never emits `session_init`, the most likely culprits in order: (a) stdin not primed at spawn time (verify `drainChain` ran), (b) launcher not on PATH, (c) `system-prompt-file` / `mcp-config` arg malformed. Inspect `argv` of the suspect `claude` pid — silverhand-spawned ones carry `--system-prompt-file /var/folders/.../<channelId>/<agentId>/system-prompt.md` which uniquely distinguishes them from user-interactive `claude` invocations.

## Conventions worth knowing

- **Target platform is macOS only** for v1. Don't add Win/Linux compatibility branches (no `frame: false` fallback, no self-drawn min/max/close, no `process.platform !== 'darwin'` workarounds in the renderer). The `titleBarStyle: 'hiddenInset'` / `trafficLightPosition` lines in `apps/desktop/src/main/index.ts` are guarded by `process.platform === 'darwin'` only because their *values* don't make sense off-mac — this isn't an invitation to also write the non-mac branch. See `docs/app-layout.md` §0/§2/§11 for the full scoping.
- **Onboarding system messages must be imperative**, not descriptive — descriptive prompts ("welcome, please introduce yourself") frequently produce no reply. See `ONBOARDING_BODY` in `packages/backend/src/provision.ts` for the slock-aligned template ("Onboarding task (system-triggered): You (@xxx) just joined #foo. 1) send one short greeting via mcp__chat__send_message. 2) Stop after greeting.").
- **No "stop" affordance in the composer.** Per IM design, message sending is one-shot; agent execution control belongs elsewhere (TBD). Don't reintroduce it.
- **Renderer composer is IME-safe.** Enter sends, Shift+Enter newlines, but `onCompositionStart/End` + `e.nativeEvent.isComposing` must guard against firing during CJK input.
- **Driver platform prompt** (`packages/backend/src/drivers/platform-prompt.ts`) prescribes a terse communication style: one-or-two-sentence default, no filler acknowledgments, no idle narration, no echoing of tool calls. Keep edits to it consistent with that voice.
- **MCP system changes must update `docs/mcp-system.md`.** Any change to `packages/chat-bridge/src/server.ts`, chat-bridge client calls, agent-facing DTO schemas, internal MCP routes, task-tool behavior, or `platform-prompt.ts` rules must keep the MCP system document in sync in the same change.
- **Better-sqlite3** is used synchronously; backend code assumes WAL mode and single-process writes. No connection pooling.
