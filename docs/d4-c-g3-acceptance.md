# D4.c G3 — Multi-user / multi-host acceptance closure

**Status**: D4.c closes G3 (security & multi-host acceptance). D4.d
(create-agent materialize intent) and D4.e (daemon-owned local
data-plane proxy) remain in the M1 path; this document does NOT
claim "D4 final form complete" — it scopes itself to the G3 gate.

**Spec source**: `docs/remote-backend-d4-design.md` §5.3 "G3 —
Multi-user / multi-host smoke + ACL negatives" and §6.3 "Five hard
conditions". Each acceptance row below cites the spec line first,
then the implementation commit(s) and test(s) that pin it.

**Conventions**:

- `commit:<sha>` = first 7 chars of a commit on
  `feature/remote-backend-v1-stage-d4-c-g3`.
- `test:<path>::<describe>::<it>` = a specific test in this repo.
  Filepaths are relative to repo root.
- "Real path" means the test exercises the production code path
  end-to-end (real HTTP listener / real DB / real WS / real
  controller), not a fake/double of the gate under test.

---

## 1. Multi-host topology

**Spec (§5.3)**: Two desktops, each with its own daemon, attach to
the same remote backend. Each daemon registers under its own
user's `host_id`.

| # | Acceptance | Evidence |
|---|---|---|
| M1 | Two distinct daemons (each with its own `host_token`) can be attached simultaneously on the same backend, registered against distinct `host_id`s. | C6 `commit:6a17947` (+ fixup `95bf4e7`). `test:tests/ws/two-daemon-isolation.test.ts::two-daemon attach + isolation::I1 simultaneous attach`. |
| M2 | The two attachments hold distinct `connectionId`s; controller's `activeConnectionCount` reflects both. | Same test, I1 assertions. |

---

## 2. ACL negatives (security perimeter)

All four must pass; this is the security perimeter for V1 remote.

### ACL #1 — Cross-user resource read returns 404 (anti-enumeration)

**Spec (§5.3)**: User A → request workspace / conversation / agent
owned by User B on any `/api/*` route → returns 404 / 403 per
`auth-and-host-model.md §2`. No row leakage in error body.

| Surface | Evidence |
|---|---|
| Host (revoke) | `test:tests/routes/hosts.test.ts::POST /api/hosts/:id/revoke::returns 404 (not 403) for cross-user revoke attempts (no enumeration)`. Asserts 404 + host still active (no side effect). |
| Host (revoke, standalone) | Same file ::`standalone — cross-user revoke still 404 + does NOT call disconnectHost`. Confirms standalone 404 ordering + no WS kick. |
| Host (rotate) | Same file ::`returns 404 for cross-user rotate (no enumeration)`. |
| Workspace (create with foreign host_id) | `test:tests/routes/workspace-conversation-routes.test.ts::POST /api/workspaces::rejects an explicit workspace host owned by another user` — 403 `host_not_owned` preflight. |
| Workspace (cross-host member agents) | C3 `commit:a726f85` (+ fixup `73ba31a`). `test:tests/routes/d4-c3-workspace-placement.test.ts::create::cross-host member_agent_ids → 409 host_mismatch`. |
| Conversation members | `test:tests/routes/conversation-members.test.ts::GET /api/conversations/:id/members::rejects a non-member user with 403`. |
| Agent (`GET /api/agents/:id`) | **C9** `commit:f28facc`. `test:tests/routes/agents.test.ts::GET /api/agents/:id::cross-user GET returns 404 (not 403) — anti-enumeration (G3 ACL #1)`. Closes the gap audited in C9 review (`Acsun_kzRmpNmXZo`). |

### ACL #2 — Invalid / revoked / wrong-kind credential at WS upgrade returns 401/403, no leak

**Spec (§5.3, recast per Cindy review)**: outbound WS attach has
NO "daemon claims a host_id" parameter — the `host_id` is derived
server-side from `HostTokenService.verifyHostToken(bearer)`. The
correct negatives are:

- **Invalid / unknown / revoked `host_token`** → 401 Unauthorized;
  body does not leak `host_id` / `user_id` / row existence.
- **Wrong credential kind** (e.g. a user-session bearer presented
  as a host token, or a non-`long_lived` credential) → 401 by the
  same path; the kind check is part of `verifyHostToken`.
- **Valid `host_token` whose host is not a local-kind host
  supported by V1 standalone** → 403 (a distinct error separating
  "auth failed" from "this host kind is not supported by this
  deployment").

We deliberately do NOT enumerate "foreign host_token" as a
distinct negative: a `host_token` is a bearer credential. If a
caller presents a syntactically valid token issued for some other
user's host, the server cannot distinguish that from the rightful
owner using the bearer alone — that scenario is **credential
compromise**, not a G3 negative. The G3 perimeter is the
verify-and-reject behavior on invalid / revoked / wrong-kind
inputs.

| # | Layer | Evidence |
|---|---|---|
| #2.a | Token service (missing / unknown) | `test:tests/auth/host-token.test.ts::HostTokenService::denies empty or unknown tokens as missing` → `{ok:false, code:'missing'}`. No `hostId` / `userId` in the failure arm. |
| #2.b | Token service (credential revoked) | Same file ::`denies a revoked credential without a grace window` → `{ok:false, code:'credential_revoked'}`. |
| #2.c | Token service (host revoked) | Same file ::`denies a token for a revoked host even when the credential is active` → `{ok:false, code:'host_revoked'}`. |
| #2.d | Token service (wrong credential kind) | Same file ::`does not accept bootstrap credentials as long-lived host tokens` → `{ok:false, code:'credential_not_usable'}`. Bootstrap credentials are not minted via the same lifecycle as `long_lived` host tokens; presenting one at the WS upgrade path produces this typed failure inside `verifyHostToken`. |
| #2.e | WS upgrade — invalid / revoked → 401 | `test:tests/ws/host-ws-server.test.ts::host outbound WebSocket server::rejects missing, unknown, and revoked host tokens before upgrade` — HTTP 401 from the upgrade response. Body is the generic 401, not a host/credential payload. |
| #2.f | WS upgrade — wrong credential kind (user-session bearer) → 401 | Same file ::`rejects user-session bearer tokens before upgrade` — a user-session bearer minted by `authSessions.issueSession(...)` is presented as a host token at the outbound WS upgrade; the upgrade response is HTTP 401. Closes the "wrong-kind credential at the wire perimeter" leg of ACL #2. |
| #2.g | WS upgrade — non-local host kind → 403 | Same file ::`rejects non-local hosts even with a valid host token` — a typed 403, distinct from the 401 auth-failed surface. |

**Note**: the earlier `host_token_owner_mismatch` typed code that
appeared in some draft documents was removed during B.4 / C.x
because the correct upgrade flow has no "daemon-declared host_id"
surface; ownership is established by token verification, not by
daemon self-assertion.

### ACL #3 — Host A spawn into User B's workspace rejected typed

**Spec (§5.3)**: Daemon for host A attempts to spawn agent into
User B's workspace → server rejects with typed code.

| # | Acceptance | Evidence |
|---|---|---|
| #3.a | Workspace create / patch / add-member with cross-host agent → preflight rejects before any side effect. | C3 `commit:a726f85`. `test:tests/routes/d4-c3-workspace-placement.test.ts::create::cross-host member_agent_ids → 409 host_mismatch`. Preflight runs `assertWorkspaceAgentsMatchHost` before `initWorkspaceDir`; workspace count unchanged on rejection. |
| #3.b | The helper scans ALL conversation kinds (channels + threads + dm_channels). | Same test file, P1 round-1 coverage; the helper `assertWorkspaceAgentsMatchHost` is defined at `packages/backend/src/routes.ts:1307` and invoked from the workspace POST / add-member routes. |

**Code mapping**: the implementation's typed code is `host_mismatch`
(409). The spec referenced `host_workspace_not_owned` as a candidate;
the implementation landed on `host_mismatch` because the assertion
fires at the agent-to-workspace host pairing layer (multi-agent
membership), not at the workspace ownership layer.

### ACL #4 — Cross-host event isolation (bidirectional)

**Spec (§5.3)**: Both daemons online simultaneously: messages /
events for User A do NOT appear in User B's daemon's event stream
and vice versa.

| # | Layer | Evidence |
|---|---|---|
| #4.a | Outbound event perimeter (drop before fanout) | C5 `commit:a41f1ec` (+ fixup `13cccf9` + docstring `10bf284`). `test:tests/runtime/outbound-event-fanout-perimeter.test.ts::perimeter::drops cross-host runtime_ready_for_drain BEFORE stateForHost` — step (2) `agent.host_id !== hostId`. |
| #4.b | Workspace ownership perimeter | Same file ::`drops host X agent X + host Y conversation` — step (4) `workspace.workspace_host_id !== hostId` (Cindy P1.a). |
| #4.c | `(cid, aid)` membership perimeter | Same file — step (5) `(cid, aid)` not in `conversation_agents` (Cindy P1.b). |
| #4.d | Daemon-level frames (no `agent_id`) admitted | Same file — daemon-level path admitted unconditionally. |
| #4.e | E2E two-daemon publish isolation (bidirectional) | C6 `commit:6a17947`. `test:tests/ws/two-daemon-isolation.test.ts::isolation::daemon X event publishes to conv X only; daemon Y event publishes to conv Y only (bidirectional)`. |
| #4.f | Fresh-fixture perimeter (attach slot is not a state slot) | Same test, I3. |
| #4.g | Outbound command routing isolation (by id + kind) | Same test, I4 (per Cindy P1: avoids heartbeat flake). |
| #4.h | Disconnect isolation — host X cache cleared, host Y unaffected | Same test, I5 (Cindy round-1 P1: `ready+runtime_status` round-trip pins `getAgentRunStates(convX)` pre/post-disconnect). |

---

## 3. Signup-toggle negative coverage

**Spec (§5.3 + §6.3 hard condition #2 + #5)**: with two users
existing, operator sets `DISABLE_SIGNUP=1` and restarts. After
restart: existing User A's session bearer still authenticates (no
forced logout). Daemon A's host attach is unaffected. New
`POST /auth/signup` returns 403 `signup_disabled`.

| # | Acceptance | Evidence |
|---|---|---|
| S1 | `POST /auth/signup` accepted while `signupEnabled: true`. | C8 `commit:3452d37` (+ fixup `0f513c7`). `test:tests/e2e/standalone-g3-signup-toggle.test.ts` Phase 1. |
| S2 | After close + restart with `signupEnabled: false`, `/api/server/info.signup_enabled === false`. | Same test, Phase 2. |
| S3 | After close + restart with `signupEnabled: false`, `POST /auth/signup` returns 403 typed `{ code: 'signup_disabled' }` (always-mounted route per D4.a Commit 4 `d530479`). | Same test, Phase 2. |
| S4 | Old user-session bearer minted pre-toggle still authenticates `GET /api/me` post-toggle; `body.id` unchanged. (P1.a) | Same test, Phase 2. |
| S5 | Old host_token issued pre-toggle still passes `HostTokenService.verifyHostToken(...)` post-toggle; `host_credentials` row is byte-identical pre/post via `dumpCredentials` deep-equal; `verified.credentialId === preCredential.id`. (P1.b + Cindy round-1 P1 deep-equal) | Same test, Phase 2. |
| S6 | Second restart with `signupEnabled: true` re-opens signup; new signup mints a distinct user. (P2.a: toggle is a reversible knob, not a DB trapdoor.) | Same test, Phase 3. |
| S7 | Env-var resolution (`SILVERHAND_DISABLE_SIGNUP=1`) for the boot-time flag. | `test:tests/auth/config.test.ts` (unit-level for `resolveAuthRuntimeConfig`). |

---

## 4. §6.3 "Five hard conditions" closure

| # | Condition | Evidence |
|---|---|---|
| H1 | Supported deployment model = personal / private (Tailscale / VPN / controlled ingress); not public-internet SaaS. | Documented in `docs/remote-backend-d4-design.md` §4.1 + §10. Non-test acceptance (documentation contract). |
| H2 | `SILVERHAND_DISABLE_SIGNUP=1` part of lock-down runbook; both directions covered by G1 dogfood. | Runbook §12.8 (this commit). G1 dogfood: signup-enabled S1 + signup-disabled S3 above. |
| H3 | Non-loopback bind + signup-enabled → `WARN` line; `/api/server/info` exposes structured `bind_address_scope`. | D4.a Commit 4 `commit:d530479`. `test:tests/boot/boot-warn-bind-scope.test.ts` (WARN line) + `test:tests/shared/bind-address-scope.test.ts` (classification). |
| H4 | No admin role / no first-user-admin auto-promotion / no admin CLI seed in D4. | Negative invariant: no `users.is_admin` column, no `/admin/*` route, no auto-promotion code. Verified by absence in migrations (`packages/shared/src/db/migrations.ts`) and routes (`packages/backend/src/routes.ts`). |
| H5 | G3 includes signup-toggle negative coverage (not "nice to have"). | Rows S1-S7 above. |

---

## 5. Stability and determinism

C9 cleaned up two pre-existing flakes that were observable under
suite load on earlier branch tips:

| Flake | Cause class | Fix | Evidence |
|---|---|---|---|
| Flake A — revoke close `activeConnectionCount` | Test asserted on `activeConnectionCount` / `getAttachment` / `connectionIdForHost` synchronously after the client-side close promise resolved, but the server-side `'close'` listener that clears those maps runs on the next event-loop tick. Cindy P1: the three maps are independent — hand-deleting any one in `disconnectHost` would either fail to flip `activeConnectionCount` or compete with the close listener's cleanup. | C9-1 `commit:0e404bb`. Test-only fix: bounded `waitFor` that polls all three observables simultaneously. No production code change. | `test:tests/ws/host-ws-server.test.ts::disconnectHost::disconnectHost kicks the live attachment with code 1008 / host_revoked (D4.c C2)`. |
| Flake B — `standalone-g2-backend-restart` 12.74s timeout (post-restart second `session_init` projection) | Could not be reproduced after C9-1 across 12 isolated runs + 5 full-suite runs. **Not proven as product bug. No specific root-cause scenario implied** (the post-restart controller is a fresh instance; it cannot return entries from a prior backend's controller, so "stale entries" is not a candidate root cause). | C9 combined: (a) `waitForFreshAttachment(controller, hostId, prevConnectionId)` harness helper that makes the post-restart attach predicate semantically precise — it waits for a fresh `hostws-*` connectionId distinct from the pre-restart one, rather than "any non-null attachment". Defensive determinism. (b) Permanent `onTimeout` diagnostic on the failing `waitFor` to capture observable state (DB row, attachment, active connection count) if the flake recurs. | `test:tests/e2e/standalone-g2-backend-restart.test.ts`. |

The `onTimeout` hook on `waitFor` (added to `tests/e2e/g2-harness.ts`)
is permanent infrastructure: it fires only on failure, so it is a
no-op under normal operation. It does not bandage anything; it
shortens the root-cause loop the next time a `waitFor`-based
restart/reconnect test trips a timeout in CI.

---

## 6. Out of scope for G3 (explicit)

These belong to subsequent M1 work (D4.d / D4.e / D5) and are NOT
part of G3 closure:

- **D4.d**: create-agent materialize intent. Spawning a new agent
  via wire intent rather than direct backend FS write. Currently
  deferred (`tests/routes/agents-no-host-typed-fail.test.ts` 409
  `host_runtime_disabled` marker, C4 `commit:ad719ef`).
- **D4.e**: daemon-owned local data-plane proxy. Agent
  `system_prompt.md` / `MEMORY.md` / `notes/` / `CONSENSUS.md`
  reads and writes proxied through the owning daemon. No
  bidirectional sync; truth lives on the owning daemon.
- **D5.a/b**: envelope unification (embedded loopback adapter
  carries the same outbound frame envelope as the standalone WSS).
- **T1 cloud-only**: blob remote, driver template remote,
  workspace-path remote. Belong to M2.

---

## 7. Branch and merge

- Branch: `feature/remote-backend-v1-stage-d4-c-g3`
- Base: D4.b tip `e34e2b3`
- Worktree: `/Users/shiki/workspace/silverhand-wt-d4-c` (not pushed
  to remote per shiki's autonomous-mandate constraint).
- Commit chain (D4.c only, newest first):
  - C9 `f28facc` (combined: harness helpers + ACL #1 test + docs +
    runbook §12.8).
  - C9-1 `0e404bb` fix(d4.c-9-1): two-daemon revoke close test
    waits for cleanup observable (flake A).
  - C8 fixup `0f513c7` + C8 `3452d37`.
  - C7 fixup `bb0f2db` + C7 `96f0222`.
  - C6 fixup `95bf4e7` + C6 `6a17947`.
  - C5 docstring `10bf284` + C5 fixup `13cccf9` + C5 `a41f1ec`.
  - C4 `ad719ef`.
  - C3 fixup `73ba31a` + C3 `a726f85`.
  - C2 fixup `a596a4b` + C2 `2b10f39`.
  - C1 fixup `dc4d629` + C1 `b2ecf38`.

When this branch lands on `main`, G3 is closed. D4.d design pass
begins next.
