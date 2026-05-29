# Remote server target architecture

> **Status**: working baseline, 2026-05-25. This document records the target
> topology and migration order for "desktop connects to any server URL". It is
> a planning reference, not an implementation spec.
>
> **Related docs**:
> - `multi-daemon-registry.md` owns the local-first `RuntimeHostRegistry`
>   mechanics.
> - `silverhand-daemon.md` owns the current daemon execution-plane scope.
> - `architecture-principles.md` owns the control-plane vs execution-plane
>   boundary.

## 1. Target topology

The target deployment has one server and many execution hosts.

```
server
  state / protocol / routing / auth / blob
    |
    | HTTP / WS
    |
desktop deployment
  user UI client + local daemon host + agent processes

sandbox deployment
  headless daemon host + agent processes
```

Key invariants:

- **Server is the control/state plane.** It owns durable state, auth, routing,
  blob metadata/storage policy, and daemon-host protocol. It does not spawn
  agent processes and does not run daemons. The server URL identifies backend,
  not where agents execute.
- **Desktop is both surfaces in one deployment.** It is the user surface UI and
  a local runtime host `(daemon, agent processes)`. There is no target
  "desktop UI only" deployment. With today's product shape, this is the only
  execution host, so agents run on the user's machine.
- **Sandbox is runtime host only.** It has no user UI surface. It runs a daemon
  and agent processes, and connects to the same server through the same
  daemon-host protocol.
- **Daemon and agent are always co-located.** The daemon is the execution host
  boundary; any process/fs/runtime assumption is host-local.
- **Agent CLI is host-local but server-directed.** CLI processes run beside the
  agent and call the server URL outbound with scoped credentials.

Current scope starts with desktop-local execution only. Sandbox is a future
second execution-host deployment, not a reason for the backend server to run
agents.

## 2. Current runtime split

The old in-process backend runtime has already been removed. Current code is
not "backend directly spawns agents"; it is a hybrid split:

Already daemon-side:

- `packages/host/src/daemon/supervisor/index.ts` owns child process spawn,
  runtime env, stdin/stdout/stderr, lifecycle locks, init watchdogs, runtime
  pidfiles, parsed-event fanout, and run-state projection.
- Driver instances and process supervision live in `packages/host` /
  `silverhand-daemon`.

Still backend-side, by design today:

- `packages/backend/src/runtime/daemon-agent-runtime-host.ts` adapts backend
  conversation/agent state into daemon `runtime_*` intents.
- It assembles prompt context, prepares spawn files, issues agent-scoped
  tokens/env, coordinates inbox delivery, owns run-state cache/SSE projection,
  and calls `HostClient.runtimeStart/runtimeWake/runtimeStop/...`.
- `RuntimeDeliveryCoordinator` decides wake / queue / respawn routing from
  durable backend state.

Therefore the main gap is not "move runtime out of backend". The main gap is:

> Upgrade the backend daemon adapter from **single local `HostClient`** to a
> **multi-host registry** that can route intents to the correct daemon host.

## 3. Protocol baseline

Before visible remote-server UX, embedded mode should already behave like a
remote deployment at the protocol boundary:

- renderer talks to backend through HTTP/WS, not backend memory objects;
- Electron main does not use backend internals as an application API;
- API responses do not require the client to interpret server/host absolute
  filesystem paths as local UI paths;
- CLI/agent calls enter through a server URL and scoped token;
- embedded differs from remote only by deployment and credential provisioning.

This is the reason Phase 0 is a protocol-purity sweep rather than a settings
feature.

## 4. Migration phases

### Phase 0: Protocol-purity sweep

Make embedded mode protocol-equivalent to remote mode:

- remove or classify desktop-main shortcuts that consume backend internals;
- split local OS IPC capabilities from server data APIs;
- stop renderer from treating `workspace_path` or other absolute paths as
  local UI paths unless the selected runtime host is explicitly local;
- ensure CLI/agent entry flows through server URL + token contracts.

This phase is an isolated refactor and does not require product decisions about
workspace fs, memory source of truth, sandbox UX, or auth provider.

### Phase 1: RuntimeHostRegistry local-only

Implement the multi-host data model while still running only one local daemon:

- replace single `BackendContext.hostClient` assumptions with
  `RuntimeHostRegistry`;
- add `conversation_agents.runtime_host_id` or equivalent placement state;
- expand run-state cache keys to include host/daemon generation;
- route every runtime intent through registry lookup, even when the only entry
  is the desktop-local daemon.

This is the shared foundation for local desktop runtime plus future sandbox
hosts.

### Phase 2: Standalone server entrypoint

Make `packages/backend` start as a standalone service:

- provide a real server binary / command;
- configure DB path, storage path, listen host/port, and server config through
  service config/env;
- keep embedded desktop as a deployment variant, not a separate contract.

This can remain single-tenant initially.

### Phase 3: Desktop remote connection skeleton

Add the visible user connection surface on top of the protocol baseline:

- settings UI for server URL, connect/disconnect, auth state, and errors;
- main-process connection state provider for renderer;
- remote mode skips local backend startup but still includes local daemon-host
  deployment in desktop;
- desktop shutdown must not stop remote server state.

This phase is not enough for a useful remote runtime by itself. The desktop can
connect to a remote backend as a UI client, but the remote backend still cannot
reach the user's local daemon until Phase 4 adds daemon-host outbound
connectivity.

### Phase 4: Outbound daemon-host protocol and headless host deployment

Flip daemon connectivity from backend-dials-local-socket to
daemon-host-connects-outbound:

- host token bootstrap / provisioning;
- daemon host registration and capability reporting;
- outbound WS/HTTP transport for spawn/wake/status/event frames;
- headless daemon config, logs, pid/signal handling, and restart policy for
  sandbox deployment;
- desktop local daemon uses the same daemon-host protocol as sandbox.

For the current product, this is the phase that makes remote backend useful for
agent execution: the user's desktop daemon registers with the backend and the
backend can route spawn/wake/status traffic to that local execution host.
Because the current execution host is the user's desktop, Phase 4 is a required
part of "desktop connects to remote backend and agents still run locally"; it
is not a sandbox-only enhancement.

This phase also needs an orchestration-boundary decision for the current
`DaemonAgentRuntimeHost` responsibilities:

- server-owned candidates: global state, ordering, identity, permissions,
  scheduling intent, durable delivery state, auditability;
- daemon-host-owned candidates: local filesystem materialization, spawn files,
  concrete env injection, runtime binary/driver instances, init watchdogs, and
  child process lifecycle.

The chosen boundary determines whether the daemon-host protocol carries a
coarse abstract intent or a finer execution recipe.

### Phase 5: Decision-driven cleanup

These depend on explicit product/architecture decisions:

- `[depends: workspace-fs-decision]` Is workspace fs logical server state with
  host-specific mounts, or is a workspace bound to one execution host?
- `[depends: L1L2-source-of-truth]` Are L1/L2 memories server truth with
  host-local cache, or host-local files that may fork across hosts?
- `[depends: sandbox-placement-flow]` How does a user pick local vs sandbox
  execution, and how does the server select a daemon host?
- `[depends: server-auth-mode]` Is the server self-hosted simple auth, SaaS,
  OAuth/SSO, pairing-code based, or something else?

Regardless of auth provider, the permission model must distinguish user tokens,
host tokens, and agent/conversation-scoped runtime tokens.

## 5. Auth baseline candidate

The first remote-server auth model should avoid a global bearer token. The
recommended baseline is a self-hosted pairing flow, pending product approval:

- **First-pair bootstrap**: first server boot generates a one-time root pairing
  code and prints it to stdout/log once. Pairing consumes it and creates the
  owner user.
- **Add device**: an authenticated desktop user can request a short-lived
  pairing code for another desktop.
- **Recovery**: an admin CLI can generate a one-time pairing code if all
  desktops are lost.
- **Pair result**: pairing returns separate credentials:
  - `user_token` for UI-client calls;
  - `host_token` for this desktop's local daemon-host connection;
  - `device_id` for revocation and device management.
- **Embedded mode**: auto-pairs internally and persists the same user/host
  credential shape, so embedded remains a deployment special case rather than
  a protocol fork.
- **Transport**: remote pairing/token issuance requires HTTPS. Plain HTTP is
  only acceptable for loopback embedded deployments.

Suggested first product constraint: single-owner self-hosted server. This
matches today's "one user, one desktop" shape while still allowing multiple
paired devices later. Multi-user / SSO can build on the same user-token and
host-token split when product scope requires it.
