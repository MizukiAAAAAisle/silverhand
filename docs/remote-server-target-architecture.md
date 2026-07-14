# Server / execution-host topology

> The deployment-shape contract: one control-plane **server**, many **execution
> hosts**. This states the load-bearing boundary between the two planes and the
> non-goals that keep them separate. It is not an auth, wire, or placement spec —
> those have canonical owners:
>
> - `auth-and-host-model.md` — host identity, credentials, rotation, and the
>   current user/host/runtime token model.
> - `daemon-outbound-protocol.md` — the outbound wire/endpoint contract and
>   per-host routing.
> - `orchestration-boundary-v1.md` §5 / §5.1 — control ⟂ execution boundary and
>   host-local path authority.
> - `architecture-principles.md` §9 — control-plane vs execution-plane invariant.

## Topology

One server, many execution hosts:

```
server — durable state / protocol / routing / auth / blob policy (control plane)
  |  HTTP / WS
desktop deployment — user UI client + local daemon host + agent processes
sandbox deployment — headless daemon host + agent processes (host only, no UI)
```

Invariants:

- **The server is the control/state plane. It never spawns agents and never runs
  a daemon.** It owns durable state, auth, routing, blob policy, and the
  daemon-host protocol. The server URL identifies the backend, not where agents
  execute.
- **Desktop is both surfaces in one deployment**: a user UI client and a local
  runtime host (daemon + agent processes). There is no "desktop UI only"
  deployment shape.
- **A daemon and its agents are always co-located.** The daemon is the
  execution-host boundary; every process / filesystem / runtime assumption is
  host-local.
- **The agent CLI is host-local but server-directed**: CLI processes run beside
  the agent and call the server URL outbound with scoped credentials.
- **Placement is host-resolved.** An agent's execution host is `agents.host_id` →
  `hosts.id`, resolved by `RuntimeHostPlacementResolver` and dispatched by
  `host_id` to that host's outbound connection. A local daemon and a user-managed
  remote host are both live placement targets (see `orchestration-boundary-v1.md`
  §5.1 and `daemon-outbound-protocol.md`).

## Non-goals

- **The server does not become an execution host.** A future headless sandbox host
  extends host selection and routing; it never moves spawn or filesystem ownership
  back into the server.
- **Embedded is not a protocol fork.** Embedded mode is protocol-equivalent to
  remote: the renderer talks to the backend over HTTP/WS (not in-memory objects),
  Electron main does not consume backend internals as an application API, API
  responses never require the client to treat server/host absolute paths as local
  UI paths, and CLI/agent calls enter through a server URL + scoped token. Embedded
  differs from remote only by deployment and credential provisioning — so
  protocol-purity is a boundary property of embedded mode itself, not a remote
  feature bolted on later.
