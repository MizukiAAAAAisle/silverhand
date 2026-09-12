# Daemon runtime lifecycle verification

> TS backend 退役说明：文中的 `packages/backend` / `packages/server` 源码与测试坐标属于迁移期历史，已从当前仓库删除；现行控制面位于 `rust/crates`。迁移权威仍在 `packages/shared/src/db`，独立回归数据在 `rust/test-fixtures`，现行构建与验证见 [testing.md](testing.md)。

This is the review and installation gate for task 2174. It deliberately does
not operate on a running Silverhand profile, database, daemon, or Qoder
session.

## Automated isolation contract

Run from the task worktree:

```sh
pnpm --filter @silverhand/backend typecheck
pnpm --filter @silverhand/host typecheck
pnpm --filter @silverhand/backend exec vitest run \
  tests/e2e/standalone-route-runtime.test.ts \
  -t "public clear-session|pre-init, during-init"
pnpm --filter @silverhand/backend exec vitest run \
  tests/repos/conversation-inbox-repo.test.ts \
  tests/runtime/outbound-event-fanout.test.ts \
  tests/runtime/runtime-fanout-adapter.test.ts
```

The lifecycle test prints every database, socket, pid, log, runtime-pid, and
agent-root coordinate before starting its subprocess tree. The test fails
closed if a coordinate is outside its temporary root or overlaps the current
Silverhand/Qoder profile roots.

Required observations:

- Public clear-session traverses HTTP → outbound socket → daemon under the
  production Desktop `spawnDaemonChild` supervisor. The daemon PID and
  generation remain unchanged; only the target child exits and can clean-start;
  two sibling PIDs remain unchanged and both continue receiving messages.
- Pre-init exit, init-watchdog failure, and running child crash leave the daemon
  PID/generation and sibling runtimes unchanged and usable.
- A 105-row backlog drains as ordered prefixes of at most 20 rows. The
  JSON-encoded `{ delivery_ids, deliveries, text }` subobject is at most
  256KiB; this is the batch-admission budget, not a claim about the complete
  `runtime_deliver` protocol frame. Every inbox id is acknowledged once.
- A single unrepresentable delivery is marked failed with
  `encoded_oversize`; the next FIFO row still advances.
- Existing failure contracts cover dispatch rejection (claim→write), child
  exit before init acknowledgement (write→session_init), and connection loss
  after dispatch but before acknowledgement (session_init→ack). Unacknowledged
  leases return to pending and replay on the current connection.

One legal chat message is already capped at 64KiB UTF-8 by the shared message
ingress contract, so the 256KiB delivery-subobject budget admits a normal
single delivery. The host protocol independently rejects complete frames over
1MiB; that protocol hard cap remains a separate contract and is not reported
as the 256KiB batch invariant.

## Qoder resume matrix — intentionally not automated yet

The incident hypothesis is a two-variable matrix, not an `auth_required`
shortcut:

| Authenticated | Resume id | Pending backlog | Required observation                                      |
| ------------- | --------- | --------------- | --------------------------------------------------------- |
| yes           | absent    | 0               | spawn args, first ready/terminal/result, child/daemon PID |
| yes           | present   | 0               | same, plus exact resume failure classification/cause      |
| yes           | absent    | ~90             | pending injection time and bounded batch sequence         |
| yes           | present   | ~90             | resume readiness vs first input, exit, and bounded drain  |

Do not run this matrix against the current Qoder profile. The installed Qoder
binary exposes `XDG_CONFIG_HOME`, but no reviewed contract yet proves that all
credential, agent, transcript, and session state can be redirected away from
the user's live roots. Until that contract exists, this matrix remains an
installation-window manual gate using a separately provisioned OS/profile
environment. No production `auth_required`, `resume_failed`, resume-id clearing,
or automatic clean-start policy is claimed by this change.

## Installation and rollback gate

The candidate application may be packaged independently, but must not replace
the installed app until review approval. Before installation, record the
current app artifact/version and retain it unchanged. Rollback is application
binary replacement only: stop the candidate at the approved window, restore
the retained prior application, and relaunch it against the unchanged data
root. Do not reset sessions or edit the database as part of rollback.
