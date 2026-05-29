# D5.a — outbound frame adapter unification (R4) acceptance closure

**Status**: D5.a closes the R4 paydown of the embedded loopback
adapter. The embedded backend no longer reaches the daemon through an
in-process `HostClient`; both embedded and standalone now dispatch the
**same outbound frame envelope** through one deployment-neutral
`OutboundFrameAdapter` port — only the transport differs (standalone =
WSS via `HostWsServerController`; embedded = local Unix
`daemon-outbound.sock` via `EmbeddedUnixOutboundFrameAdapter`).

**Spec source**: `docs/remote-backend-d5a-design.md`. Each acceptance
row below cites the spec section first (§8 A1–A6), then the
implementation commit(s) and test(s) that pin it.

**Conventions** (same as `docs/d4-d-acceptance.md`):

- `commit:<sha>` = first 7 chars of a commit on
  `feature/remote-backend-v1-stage-d5-a-design`.
- `test:<path>::<describe>::<it>` = a specific test in this repo.
  Filepaths are relative to repo root.
- "Real path" = production code path end-to-end (real HTTP listener /
  real DB / real outbound transport / real daemon `IntentDispatcher` /
  real `materializeAgent`), not a fake/double of the gate under test.

**R4 anchoring** (`docs/remote-backend-d4-design.md` §9.3): D5.a is the
slice that retires the standard "this IPC is local supervisor/control"
carve-out for the embedded data plane. After D5.a there is no embedded
`HostClient` data-plane path to carve out — the embedded backend speaks
the **formal** server↔daemon outbound envelope over a local socket. The
only `HostClient` left anywhere is desktop-main host-control IPC (A6),
which keeps the carve-out trivially.

---

## 0. Slicing chain

D5.a landed as five slices (plus the design commit) on
`feature/remote-backend-v1-stage-d5-a-design` (base = D4.d tip
`38a4b12`). Per-slice review fixups were squashed into their parent
slice at closeout (this is the post-squash chain):

- `0f13cf4` — design doc (`docs/remote-backend-d5a-design.md`).
- `d5ae2d4` — **D5.a-1**: `OutboundFrameAdapter` port +
  `StandaloneOutboundFrameAdapter` over `HostWsServerController` +
  transport-neutral error aliases + shared
  `runOutboundFrameAdapterContract` harness + standalone runner over a
  real WS.
- `10c8d73` — **D5.a-2**: local outbound frame socket — daemon
  `LocalOutboundFrameServer` (`daemon-outbound.sock`, 0o600) + backend
  `EmbeddedUnixOutboundFrameAdapter`; shared
  `outbound-frame-mapping.ts` + `outbound-write-buffer.ts`
  (transport-neutral 1024/4MiB policy, no unbounded daemon write
  queue). Embedded adapter passes the exact shared contract.
- `0354696` — **D5.a-3**: embedded backend rewire. embedded +
  standalone share `OutboundAgentRuntimeHost` (renamed from
  `ControlPlaneRuntimeHost`) + `OutboundRuntimeEventFanout`; only
  transport differs. Backend `src/` import of `HostClient` driven to
  zero; bridge.ts / daemon-agent-runtime-host.ts /
  daemon-runtime-wiring.ts deleted. Squashed-in Cindy fixups:
  connection-scoped `ready` (P1-1) + boot-connect timing / shutdown
  order (P1).
- `8d7e594` — **D5.a-4**: parity e2e. Shared
  `outbound-parity-contract.ts` run verbatim by both embedded and
  standalone rigs over their real transports + connection-staleness
  e2e. Squashed-in Cindy fixups: macOS socket path EINVAL → short
  `mkdtemp` dir (P1-1), late-frame-no-pollution staleness e2e (P1-2),
  bidirectional envelope assertion (P2) + a teardown-race absorber.
- `<tip>` — **D5.a-5**: this acceptance doc + `routes.ts`
  comment-drift cleanup (behavior-neutral) + `silverhand-daemon.md` /
  `remote-backend-d4-design.md` §9 doc updates + shared g2-harness
  teardown-race fix so the full backend suite exits clean.
  Squashed-in Cindy fixups: daemon-doc historical-framing markers
  (P1), real-hash pin (P2), Open-questions heading nit. *(This entry
  is the chain tip; its own SHA is the `HEAD` printed by
  `git log --oneline 38a4b12..HEAD`.)*

---

## 1. A1 — Backend formal path has no `HostClient`

**Spec**: §8 A1, §2 I3, §6.

- `packages/backend/src/**` imports `HostClient` from
  **zero** files. The only textual occurrence is a doc comment in
  `packages/backend/src/runtime/event-handler.ts` explaining the
  invariant ("extracted so backend `src/` carries ZERO `HostClient`
  imports"). Verified: `rg "import .*HostClient" packages/backend/src`
  → no matches.
- `RuntimeBridge` / `DaemonAgentRuntimeHost` / daemon-runtime-wiring
  are **deleted**, not dead-code-retained
  (`packages/backend/src/runtime/{bridge,daemon-agent-runtime-host,daemon-runtime-wiring}.ts`
  no longer exist).
- The embedded runtime host is `OutboundAgentRuntimeHost`
  (`packages/backend/src/runtime/`, renamed from
  `ControlPlaneRuntimeHost`); both modes drive it through
  `OutboundRuntimeEventFanout`.

**Pins**:

- `test:packages/backend/tests/dependency-guard-no-host-client.test.ts::backend/src → HostClient import boundary (D5.a-3 A1)::no file under packages/backend/src imports HostClient from @silverhand/host`
- `test:…::checkFile recognises banned forms and ignores look-alikes`
  (guards the guard against false negatives).

> A5 (TODO anchor count) is **subordinate evidence** here: `rg
> "TODO\(D5,R4\)" packages apps` returns zero. Per Cindy's D5.a-5
> review note this grep is vacuous on its own (nothing ever wrote that
> anchor into D5.a source); the **authoritative** R4-paydown evidence
> is A1's zero-import boundary above, not the grep.

---

## 2. A2 — Shared adapter contract

**Spec**: §8 A2, §3, §4.3.

The single `runOutboundFrameAdapterContract(label, makeAdapter)`
harness runs verbatim against both adapters:

- `test:packages/backend/tests/runtime/outbound-frame-adapter.standalone.test.ts`
  — `StandaloneOutboundFrameAdapter` over a real WS.
- `test:packages/backend/tests/runtime/outbound-frame-adapter.embedded.test.ts`
  — `EmbeddedUnixOutboundFrameAdapter` over a real
  `LocalOutboundFrameServer`.

Contract cases (`tests/runtime/outbound-frame-adapter-contract.ts`,
7 per adapter = 14 total):

- `round-trips runtime_status command → correlated response`
- `rejects an unconnected host with transport_no_connection before any frame leaves`
- `rejects malformed runtime_start params with transport_invalid_command before send`
- `surfaces an agent_materialize typed wire error with its code intact`
- `refuses a foreign typed error code on a command that does not declare it`
  (negative per-command typed-error pin)
- `rejects a pending command with transport_disconnected when the daemon drops`
- `fails fast when expectedConnectionId no longer matches the live connection`

Result: 7/7 standalone + 7/7 embedded.

---

## 3. A3 — Event projection parity

**Spec**: §8 A3, §3, §5.

A real daemon event emitted through the local Unix envelope enters the
same `OutboundRuntimeEventFanout` and produces the same backend
projection as the standalone WSS path. Pinned by the shared parity
contract (`registerParityPhases`) run by both rigs:

- `test:packages/backend/tests/e2e/parity/outbound-parity-contract.ts::Phase A — runtime_start dispatch → real daemon spawn → session_init projects cli_session_id (same envelope)`
  — run by both `embedded-parity.test.ts` (real in-process
  `runDaemon` over Unix) and `standalone-parity.test.ts` (g2 harness
  over WSS).

Connection-staleness perimeter (cross-connection pollution drop) is
pinned for both transports:

- `test:packages/backend/tests/e2e/parity/connection-staleness.test.ts::D5.a-4 — standalone connection staleness (real WS replacement)::a late event on a REPLACED connection is not projected; the live connection still projects`
- `…::an in-flight command on a replaced connection rejects; a late response on the dead socket cannot resolve it`
- `test:…::D5.a-4 — embedded connection staleness (real EmbeddedUnixOutboundFrameAdapter)::events carry the adapter live connectionId; drop rejects in-flight; a reconnect mints a distinct id and old-connectionId traffic stops`

---

## 4. A4 — D4.d create-agent still works in embedded

**Spec**: §8 A4, §5.1.

`POST /api/agents` does **not** branch on deployment mode. Both modes
dispatch the same wire intent via `ctx.outboundFrameAdapter()`
(`packages/backend/src/routes.ts`, helper
`d5RunMaterializeFromReserved` →
`controller.sendCommand(host_id, 'agent_materialize', …)` where
`controller: OutboundFrameAdapter`). There is no direct
`materializeAgent` call and no `HostClient.call` fallback from the
backend.

**Pins** (real `materializeAgent` end-to-end, embedded transport):

- `test:packages/backend/tests/e2e/parity/outbound-parity-contract.ts::Phase B — POST /api/agents → real adapter → real materializeAgent → row active + real L1 template`
  (run by both rigs)
- `test:…::Phase C — connection-id replacement guard: stale expectedConnectionId rejects, live connection still serves`
- `test:packages/backend/tests/e2e/parity/embedded-parity.test.ts::D5.a-4 embedded parity …::Phase D2 (embedded-only) — captured local Unix frames are the outbound envelope, NOT legacy HostClient IPC`
  — captured local-Unix frames pass
  `OutboundServerToDaemonCommandFrameSchema`; legacy
  `{id,intent,params}` / `{id,result}` IPC shapes FAIL it.
- `test:packages/backend/tests/e2e/parity/standalone-parity.test.ts::D5.a-4 standalone parity …::Phase D3 (standalone) — daemon bounce replaces connectionId: old-id command rejects, new connection serves`

---

## 5. A5 — TODO anchor count

**Spec**: §8 A5.

`rg "TODO\(D5,R4\)" packages apps` → **zero**. As noted in §1, this is
subordinate evidence; A1's zero-import boundary is the authoritative
R4-paydown gate.

---

## 6. A6 — Desktop control IPC is documented as local control

**Spec**: §8 A6, §2 I4, §6.

The only remaining `HostClient` call sites live in
`apps/desktop/src/main/**` and each carries a comment scoping it to
desktop-local supervisor/control, not backend↔daemon formal semantics:

- `apps/desktop/src/main/daemon-generation-attach.ts` — `HostClient`
  readiness gate for the daemon-respawn re-attach path (header comment
  explains it proves the daemon is talking back, not a data-plane
  command).
- `apps/desktop/src/main/remote-backend-handle.ts` — daemon +
  `hostClient` lifecycle/teardown ordering (comment-scoped).

Neither exposes runtime / materialize / data-plane business commands;
those flow through the embedded `EmbeddedUnixOutboundFrameAdapter`. The
desktop main also passes `outboundSocketPath` to the embedded server
and keeps `HostClient` strictly for host-control IPC.

---

## 7. Out of scope for D5.a (explicit)

- **No durable transport queue** (§2 I6, §10): local transport
  liveness is socket-close only; no heartbeat / reconnect buffer on
  the embedded path. A dropped local socket rejects in-flight commands
  the same way a dropped WSS connection does.
- **D4.d semantics unchanged** (§2 I5): the `agent_materialize`
  lifecycle, reconciler, recovery surface, and visibility wideners
  from D4.d are byte-for-byte the same; D5.a only swaps the transport
  beneath the existing route.
- Desktop host-control IPC (ping/status/respawn-attach) stays on
  `HostClient` by design (A6); D5.a does not migrate it.

---

## 8. Gates at D5.a-5 tip

- `pnpm -r typecheck` — clean (all 6 packages).
- Backend full suite — **1383 passed | 1 skipped** (115 files), exit
  0. The full-suite-only unhandled `spawn ENOENT` (a teardown-race
  respawn after `afterAll` removed the runtime cwd) is fixed in this
  slice by attaching a benign `'error'` listener to the shared
  g2-harness `defaultSpawnFn` (`packages/backend/tests/e2e/g2-harness.ts`)
  — behavior-neutral, mirrors the per-test absorber embedded-parity
  already carried.
- Host full suite — **636 passed** (31 files).
- D5.a focused: adapter contract 14/14 (7 standalone + 7 embedded),
  parity 8/8 (Phase A/B/C × 2 rigs + embedded-D2 + standalone-D3),
  connection-staleness 3/3.

---

## 9. Commit chain

Post-squash chain (per-slice review fixups folded into their parent
slice at closeout; safety tag `d5a-pre-squash-backup` preserves the
pre-squash tip):

```
38a4b12  (D4.d tip — base)
0f13cf4  docs(d5.a): design outbound frame adapter unification
d5ae2d4  feat(d5.a-1): OutboundFrameAdapter port + standalone impl + contract harness
10c8d73  feat(d5.a-2): local outbound frame socket — daemon server + embedded adapter
0354696  feat(d5.a-3): unify embedded+standalone runtime on the outbound envelope
8d7e594  test(d5.a-4): outbound frame adapter parity e2e (embedded + standalone)
<tip>    docs(d5.a-5): R4 acceptance closure + comment cleanup + teardown-race fix
```

> The `<tip>` SHA is this very commit (it contains this doc); read it
> from `git log --oneline 38a4b12..HEAD`. Slices D5.a-3/-4/-5 each
> carry their squashed-in review-correction summary in the commit
> body.

> `docs/remote-backend-progress.html` lives on `main` (not this
> feature branch) and is updated separately when D5.a merges — it is
> not part of this worktree's tree, so the design §9 "update
> progress.html" item is deferred to the merge step.
