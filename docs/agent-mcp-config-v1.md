# Profile MCP v1 — per-subject custom MCP servers

Status: **canonical** (locked 2026-06-15, shiki + Alice + Cindy). Implements
#task:1135.

This doc is the source of truth for the `profile mcp` feature: how a subject
(agent today, human later) declares extra MCP servers, where that config lives,
how it is loaded additively into each runtime at spawn, and the CLI / UI / wire
surfaces. Code that conflicts with this doc is the bug.

## 1. Goal & shape

Let each **subject** carry its own set of MCP servers that are loaded **in
addition to** whatever MCP the underlying runtime already has (the user's own
`~/.claude.json` / project `.mcp.json` / `~/.codex/config.toml`). The subject's
servers are an **additive layer**, never a replacement.

- **Scope = `profile`** — the executing subject's global / L1 config. For an
  agent this is its L1 home (the computer slot's `agents/<id>/` dir, resolved
  by the daemon), shared across every
  workspace. `profile` is deliberately subject-agnostic: a human can have a
  profile too, with no change to the CLI language. (Human/Agent isomorphism —
  see `docs/architecture-principles.md`.)
- **Workspace-scoped MCP is explicitly future**, under a *different* domain
  noun (`silverhand workspace mcp …`), not this doc. See §9.

## 2. Storage — local L1 file, single source of truth

The raw config is a JSON file at the subject's L1 home:

```
<app-root>/computers/<computer_id>/agents/<agentId>/mcp.json
```

The L1 home is the daemon-resolved coordinate — one join of the computer
slot's `agents` root and the agent id (`resolveAgentDir`, #task:1813). No
process derives it from `homedir()`, and no fs path crosses the wire.

- **The file is the only source of truth for the raw config.** The backend / DB
  store **no** raw JSON. (A future column MAY cache *derived* metadata —
  `has_mcp_config`, `updated_at`, `last_validation_error`, a hash — purely for
  list/status display; never the raw bytes. Not in v1.)
- Rationale (locked): (a) consistent with the existing L1 model —
  `system_prompt.md` / `MEMORY.md` are already host-local-fs truth the backend
  never reads/writes as content; MCP config is the same identity layer. (b) The
  spawn consumer needs the config *on the host fs* anyway. (c) The write flow is
  agent-mediated (an agent runs the CLI while live on its host), so the host is
  always online when writing — the one advantage of DB (offline central edit) is
  unused. DB-as-truth would split the agent-identity model and add a sync path.

### 2.1 Raw format

The raw file uses the **standard MCP `mcpServers` map** (the same shape Claude's
`--mcp-config` and the ecosystem `.mcp.json` use), so it is copy-paste
compatible with what users already know:

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "ghp_…" }
    },
    "linear": { "type": "http", "url": "https://mcp.linear.app/sse" }
  }
}
```

Supported per-server forms (v1):

- **stdio** (default): `{ command, args?, env? }`.
- **http** / **sse**: `{ type: "http" | "sse", url, headers? }`.

`type` defaults to `"stdio"` when `command` is present. Unknown top-level keys on
a server are rejected at write/validate time (fail-loud, §6). No secret
interception — this is the user's own trusted local file (locked: shiki).

## 3. Runtime name prefixing — domain in the name from v1

Each server's **raw name is the user-visible truth** (CLI/UI always show it).
The name handed to the *runtime* is private and **carries the scope domain as a
prefix from v1**:

```
profile layer    → silverhand_profile__<rawName>
workspace layer  → silverhand_workspace__<rawName>   (future)
```

Why prefix now, not later: a runtime identifies an MCP server by its name —
OAuth state, approval grants, and caches are keyed on it. If v1 shipped a bare
`silverhand__github` and a later workspace layer forced a rename to
`silverhand_profile__github`, every runtime would treat it as a brand-new server
and reset that state. Baking the domain in from v1 means profile and workspace
layers can also define the same raw name and coexist without shadowing — zero
migration.

Spawn logs emit `scope/rawName -> runtimeName` for diagnosis.

## 4. Loading — additive, per-runtime adapter, spawn-time only

At each spawn the daemon reads the subject's L1 `mcp.json`, hands the parsed
canonical config to the runtime's **adapter**, and folds the adapter's output
into the spawn. Pure agent-global; effect takes hold on the **next spawn** (no
hot reload).

The adapter contract is **mechanism-agnostic** — given the canonical config it
returns spawn-time *additions*: extra argv, extra env, and/or temp files to
write under the per-spawn temp dir. Both adapters compose with the existing
spawn-prep temp dir (`spawn-prep.ts`) and are cleaned up with it.

### 4.1 Claude adapter

- Generate a per-spawn temp JSON file containing the prefixed `mcpServers` map.
- Pass `--mcp-config <tempPath>` (verified present in claude 2.1.174).
- **Never** pass `--strict-mcp-config` (that *replaces* the user's MCP). Plain
  `--mcp-config` is additive on top of the user's own MCP.
- **Never** call `claude mcp add` (that writes the user's config).

### 4.2 Codex adapter

Codex has no "extra config file" flag; the confirmed additive mechanism
is `-c` / `--config` overrides, which sit at the top of codex's config layering
and merge over the user's `~/.codex/config.toml`. So:

- Emit **one `-c` override per server**:
  `-c mcp_servers.<prefixedName>=<inline-TOML-table>`. Per-server (not one
  override of the whole `mcp_servers` table) so it *merges* with the user's
  existing servers instead of replacing the table.
- The inline-TOML value is produced by a **TOML serializer** (handles
  string/array/nested-table quoting for `args` / `env` / `http_headers`), never
  hand concatenated. `-c` and its value are separate argv elements (no shell, no
  re-parsing).
- Each canonical server is first projected to **Codex's native key names**
  (`toCodexServerConfig`): stdio → `command` / `args` / `env`; remote (canonical
  `http`/`sse`) → `url` + `http_headers` (canonical `headers`). Codex has **no
  `type` discriminator** — the remote transport is inferred (`streamable_http`)
  from `url` — and does not understand the canonical `type`/`headers` keys, so
  emitting them verbatim would leave a remote server silently unusable.
- **Never** write `~/.codex/config.toml`; **never** call `codex mcp add`.
- **Verified** against the bundled binary `codex-cli 0.140.0`
  (`/Applications/Codex.app/Contents/Resources/codex` — the native bundle the
  daemon prefers via `runtimes.ts` PLATFORM_CANDIDATES, *not* a PATH `codex`):
  `codex app-server` accepts the `-c mcp_servers.*` overrides; `codex mcp add
  --url …` round-trips to `url` / `http_headers` (table) / `bearer_token_env_var`
  / `env_http_headers` with transport `streamable_http` and no `type` key,
  matching the projection. Canonical `env_http_headers` / `bearer_token_env_var`
  are a future schema addition (v1 canonical carries only `headers`).

## 5. CLI surface — the `profile` domain noun

`profile` is a new top-level domain noun for the **executing subject's global
config**. MCP is its first facet; avatar / display-name / model prefs are
expected future facets — which is exactly why MCP is *not* a bare top-level
`mcp` noun. This requires a three-level grammar `silverhand profile <facet>
<verb>` (a contained sub-noun extension of the otherwise two-level dispatcher;
no other noun is affected).

```bash
silverhand profile mcp get                 # print current subject's raw mcp.json (or empty)
silverhand profile mcp set < mcp.json      # validate + atomically write raw from stdin
silverhand profile mcp validate < mcp.json # validate only; never writes
```

- The subject is the **caller** — in agent runtime, the agent itself, resolved
  from its injected `SILVERHAND_*` identity. No `--agent` flag in v1; a future
  human CLI managing another agent adds `--agent <handle|id>` (orthogonal
  selector), and workspace-scope MCP is the separate `workspace` noun.
- `set` / `validate` read the **raw JSON from stdin** (mirrors `message send`).

## 6. Failure semantics — write strict, spawn loud-but-non-blocking

Two distinct stages, and within spawn two distinct failure *classes*:

- **Write stage (`set` / `validate`): strict fail-loud.** Bad JSON, bad schema,
  or a config the adapters can't map → the CLI returns a readable error and
  **nothing is persisted**. A bad file never reaches disk.
- **Spawn stage — adapter/mapping layer: loud, all-or-nothing, non-blocking.**
  The write stage already validated, so a spawn-time failure means the file was
  hand-edited / half-written / unreadable. In that case the **entire** profile
  MCP layer is dropped (never a silent partial subset), a prominent diagnostic is
  surfaced (agent-log + run-state), and **the agent still spawns**. A broken MCP
  config must not make the agent undeployable.
- **Spawn stage — MCP server runtime init: not our concern.** Once a valid
  config is handed to claude/codex/qoder, a server failing to connect is the
  runtime's
  MCP health / tool-availability problem. Silverhand does **not** pre-check or
  block spawn on it; it only surfaces diagnostics. v1 has no `required: true`, so
  one external MCP process failing never blocks the agent.

## 7. UI — Agent pane

The agent pane shows the raw `mcp.json` under the label **Profile MCP** (not a
bare "MCP JSON"), reading the **local file** content (not a DB copy) so there is
no drift. When the workspace layer lands it sits beside it as **Workspace MCP**.

The pane reads via the public mirror `GET /api/agents/:id/profile/mcp`
(`{ raw: string | null }`, null = no `mcp.json`). Its read gate is **stricter
than agent visibility**: raw `mcp.json` can carry secrets (env tokens, HTTP auth
headers), so a same-workspace teammate who can *see* the agent (`canViewAgent`)
is still **403**'d unless they can *edit* it (`canEditAgent` = creator/self).
"We don't censor the owner's own secrets" means we don't inspect the file, NOT
that any viewer may read it.

## 8. Wire & module layout

- **`packages/shared`** — canonical zod schema (`McpConfig`), the pure
  runtime-agnostic translation helpers (canonical → claude JSON; canonical →
  codex `-c` overrides via a TOML-value serializer), and the prefix helper. No
  node deps in the pure parts.
- **`packages/host`** —
  - protocol commands `agent_profile_mcp_read` / `agent_profile_mcp_write`
    (params keyed by `agent_id`; daemon resolves L1 via `resolveAgentDir` and
    reads / atomically writes `mcp.json`).
  - drivers `{claude,codex}.ts` call the shared adapters at `buildArgs` time;
    spawn-prep writes any temp files.
- **`packages/backend`** — `runtime/workspace-data-plane.ts` dispatch wrappers +
  internal-agent routes the CLI hits (`GET`/`POST profile mcp`), resolving the
  caller agent's owning host.
- **`packages/cli`** — `commands/profile.ts` + sub-noun grammar in
  `commands/index.ts`.
- **Docs** — this file; `docs/cli-system.md` and
  `packages/shared/src/platform-prompt.ts` updated in the same change (CLI
  contract rule).

## 9. Forward compatibility — domains split by noun

Scope is carried by the **noun**, not a `--scope` flag, so each domain owns its
storage + permission boundary cleanly:

- `silverhand profile …` — the subject's L1/global config (mcp now; avatar /
  display-name / model prefs later).
- `silverhand workspace …` — the workspace domain (workspace mcp / settings /
  member defaults later).

Runtime prefixes stay domain-named (`silverhand_profile__` /
`silverhand_workspace__`). The canonical raw JSON and the adapter contract are
shared across domains, so adding the workspace layer later reuses everything
below the CLI noun.
