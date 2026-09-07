# Rust backend Wave 2 execution plan

Status date: 2026-08-28

This document is the durable recovery authority for the current Rust migration
wave. Task bodies and Git remain authoritative for live status, exact tips, and
verification results; this document owns the cross-lane plan, dependency graph,
counting rules, and integration cadence.

Mandatory preflight for every lane:
[`rust-backend-migration-pitfalls.md`](./rust-backend-migration-pitfalls.md).
Each new migration task copies only its relevant checks into Acceptance; review
adds only reusable findings back to that playbook.

## Starting point and counting

- Canonical integration base: `a45108e6371e011123f52984b75d23c108d32f05`
  (`#2223`, FINAL PASS, local/unpushed when this plan was updated).
- Closed product-route universe: 181 routes.
- Strictly landed and mounted after `#2223`: **67/181 (37.0%)**. This is
  mechanically witnessed by the composition presence ledger (55 human doors +
  3 runtime doors + 2 WebSockets + 7 anonymous faces), not copied from the
  earlier estimate.
- `#2223` mounted the previous 17 component-complete residuals: workspace
  metadata/read 4, human identity/session 5, host custody lifecycle 4, and
  human directory/avatar 4.
- “Implemented” and “landed” are separate counters. A leaf completion does not
  move the landed count; only the integration writer may mount routes and edit
  the route ledgers.

The next 24-route batch targets **91/181 (50.3%)** only after its leaves are
integrated. Leaf completion never moves this number.

## Session and ownership rule

Every non-Cindy agent is conversation-scoped. The same display name in another
channel is a different session and inherits no hidden context. Each lane has one
writer and Cindy as reviewer. Lio is intentionally excluded from this wave.
Closed prior leaves (`#2220`–`#2222`) are recorded in their task bodies and are
not repeated here.

## Accepted integration baseline

`#2223` is complete at `a45108e6`. It preserved the three Wave 2 leaves with
real no-ff convergence, mounted all 17 residual routes, and moved every
method/path exactly once in the ledgers.

The root now owns one Rust-specific **128 MiB resource ceiling**. A declared
oversize `Content-Length` gets the perimeter's 413; an undeclared/chunked body is
still hard-bounded, but the downstream reader owns its final wire error. This is
intentionally not a uniform-413 contract. Product caps remain tighter and exact
(for example avatar 5 MiB + 1 byte for `avatar_too_large`).

## Active post-`#2223` parallel batch

All lanes start from exact `a45108e6`, use fresh conversation-scoped sessions,
and have one writer. Alice owns two independent sessions; Toby owns one. Lio is
not included. Leaves remain unmounted and never edit `backend-app` or route
ledgers; a later integration task performs convergence and moves the landed
count.

The accepted tree mechanically confirms this exact 24-route split:

- **Toby — remaining host management (6):** POST
  `/api/hosts/{id}/disconnect`; GET+PUT `/api/hosts/{id}/proxy-config`; GET
  `/api/hosts/{id}/runtime-catalog`; PATCH `/api/hosts/{id}`; GET
  `/api/hosts/{id}/status`. Proxy config and runtime catalogue also make this
  lane the owner of the one shared owning-host correlated RPC production root
  (connection-generation pin, timeout, typed failure mapping); it must not build
  a dispatcher per route.
- **Alice — public agent lifecycle/avatar (10):** GET
  `/api/agents/name-availability`; POST `/api/agents`; PATCH+DELETE
  `/api/agents/{id}`; PUT `/api/agents/{id}/runtime`; POST
  `/api/agents/{id}/clear-session`; POST `/api/agents/{id}/stop`; and
  POST+DELETE+GET `/api/agents/{id}/avatar`. This lane owns the one canonical
  AgentId-keyed agents-row write and agent-avatar blob production authorities;
  internal routes consume them later rather than minting parallel stores.
- **Alice, separate session — internal agent profile/MCP (8):** GET+POST
  `/internal/agents/{aid}/profile/mcp`; POST
  `/internal/agents/{aid}/profile/mcp/probe`; POST+DELETE
  `/internal/agents/{aid}/avatar`; GET+POST
  `/internal/agents/{aid}/profile`; GET
  `/internal/agents/{aid}/peer-profile`. Read-side authorities close here;
  mutating profile/avatar components consume typed requirements that integration
  adapts to the public-lifecycle lane's one persistence/blob owner. The three MCP
  routes likewise deliver full components against a typed data-plane
  requirement; integration adapts it to Toby's shared outbound owner rather
  than minting a second transport authority.

The remaining closed-universe residuals (embedded bootstrap, agent workspace/
chat/schedule reads, and CLI trace) are intentionally outside this batch.

## Delivery and review rules

- Implement large leaves as small internal WIP commits so compaction recovery
  uses `git log`, not memory. Present one stable tip for review.
- Treat route families that reuse accepted authorities as a fast lane. Spend one
  short inventory pass identifying the exact TS contract, then implement against
  the existing identity/storage/event ports. Do not redesign domain boundaries,
  add sealed wrapper layers, or build cross-language fixtures without a concrete
  drift risk.
- A fast-lane leaf runs focused crate tests while building and runs fmt,
  diff-check, cold clippy, and its relevant crate suites once at the stable tip.
  Full-workspace gates belong to convergence/integration unless the leaf changes
  a workspace-wide contract.
- Review fast-lane leaves for correctness, security, authority forks, and missing
  effects. Non-blocking naming/documentation hygiene is recorded for later and
  must not create repeated review rounds.
- During review, fixes are forward-only. Do not amend, rebase, reset, or squash
  reviewed evidence.
- After FINAL PASS, the owner produces one clean tree-equivalent commit for
  delivery; shiki owns final history shaping and push.
- No fake/no-op production effect may be used to make a route mountable.
- A green compile is not evidence that a multi-leg production effect is
  complete. Each required leg needs a discriminating test or reviewable
  production-path proof.
- Each task body is the canonical live Acceptance Summary and retains only the
  final scope, decisions, verification, and residuals—not round-by-round history.

## Worktree retirement

After an integration tip receives FINAL PASS and before deleting absorbed
checkouts:

1. prove the new tip contains every accepted leaf/integration tip;
2. verify every candidate worktree is clean;
3. remove obsolete checkouts only after those two checks; stop and report instead
   of deleting any dirty or unabsorbed worktree;
4. audit local branches and refs separately: ancestry, unique commits,
   remote/push state, and whether a ref is the sole recovery evidence;
5. delete a branch/ref directly only when the audit proves unambiguous absorbed
   ancestry, no unique commits, no required recovery role, and no active/dirty
   checkout. Retain and report anything uncertain; no extra approval is needed
   for the unambiguous set. Never delete by prefix or glob, including `task-*`
   or `archive/*`.

The integration worktree remains until shiki completes final tree-equivalent
shaping and push.

## Recovery procedure

After context compaction:

1. read this document for the plan and lane boundaries;
2. treat `#2223` as the accepted baseline and read live tasks `#2224`, `#2225`,
   and `#2226` for current owners, worktrees, tips, and blockers;
3. inspect Git/worktrees before acting—never reconstruct live state from memory;
4. review or integrate at the earliest satisfied dependency boundary;
5. update this document only when the cross-lane plan or counting model changes.
