# Silverhand

Silverhand is a macOS-first IM for humans and multiple coding-agent CLIs. The
pnpm monorepo runs one backend library either embedded in Electron or as a
standalone server connected to agent-host daemons.

## Non-Negotiable Invariants

1. **Human and Agent are isomorphic actors.** Shared behavior uses the same
   service methods and `Principal`. Actor differences belong in explicit
   policies, not parallel flows or scattered `principal.kind` branches. Read
   `docs/architecture-principles.md` before adding a service, route, table, or
   migration.

2. **Preserve one domain model and vocabulary.** `docs/core-design.md` is the
   product and data-model authority. Keep domain logic out of routes,
   transports, and the renderer. Converge naming drift instead of adding
   aliases or compatibility wrappers.

3. **Keep control and execution planes separate.** The backend owns IM
   semantics, persistence, auth, and orchestration intent. `packages/host`
   owns agent processes, stdin/stdout, inbox drain, run state, local filesystem
   access, and runtime credentials. The backend must not acquire host-local
   authority.

4. **Security comes from tokens, ownership, and ACL.** Construct principals at
   route boundaries; never trust caller-declared identity headers. Private
   resources require explicit authorization. Hiding a CLI command is not an
   authorization boundary.

5. **Embedded and standalone share contracts.** Electron-local assumptions
   must not leak into backend behavior. Runtime placement follows agent host
   ownership.

6. **Migrations are append-only.** Never edit a shipped migration. Follow the
   migration runner and foreign-key verification contract in
   `docs/architecture-principles.md`.

7. **Network and protocol changes are multi-process changes.** Audit all
   affected process boundaries and both deployment shapes. Process-local
   TLS/proxy state does not cross spawn boundaries; protocol versions must stay
   synchronized across transports.

8. **Never prime Claude stream-json with synthetic user input.** Claude defers
   `system.init` until the first real message; priming creates a chargeable turn
   and pollutes resume history. Read
   `docs/incident-2026-05-08-claude-resume-init-watchdog.md` before changing
   first-message behavior.

9. **Agent-facing contracts change together.** CLI, agent route/DTO, task, or
   command-guidance changes must keep `docs/cli-system.md` and
   `packages/shared/src/platform-prompt.ts` aligned. Read
   `docs/platform-prompt-design.md` before editing the platform prompt.

10. **The v1 target is macOS.** Do not add speculative Windows/Linux UI
    branches without an explicit product decision.

## Commands

- `pnpm dev`: embedded desktop development.
- `pnpm dev:headless`: embedded Electron/backend/daemon without a window; not
  backend-only.
- `pnpm test`: complete test gate.
- `./scripts/test.sh --scope <package> [vitest args]`: targeted tests; use this
  entrypoint because it manages the `better-sqlite3` Node/Electron ABI.
- `pnpm typecheck`, `pnpm build`, `pnpm package`, `pnpm package:dir`.
