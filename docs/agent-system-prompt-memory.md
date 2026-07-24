# Agent system prompt + memory model

Current design, last revised 2026-07-22. Authoritative for `system_prompt.md`,
`MEMORY.md`, `notes/`, and the platform prompt assembly that injects them
on every spawn.

> **2026-06-12 — workspace Consensus removed.** The `CONSENSUS.md`
> concept (an L3 workspace-wide shared file) was dropped: agents rarely
> edited it, and a single shared file blurred multiple agents' separate
> records. Each agent's own L2 `MEMORY.md` / `notes/` is sufficient.
> The model below is the current three-file model; references to
> `CONSENSUS.md` were removed from generation, prompt injection, and
> docs (#task:1086 / #task:1087).

## Goals

- An agent has **one** identity, edited in **one** place. A user who
  shapes the role in `@Alice`'s DM should not have to re-shape it in
  every workspace `@Alice` joins.
- Memory and collaboration patterns that are workspace-scoped (review
  pairings, hand-off rules, work logs) stay with the workspace and do
  not leak across.
- Common context (role, current workspace memory) is loaded for the
  agent on every spawn so it does not need to issue Read calls to recover
  its baseline.
- Current-workspace notes are discoverable through a daemon-generated metadata
  catalog; note bodies remain on disk and load only when their retrieval hooks
  match the task.
- Cross-workspace navigation is path-only: the agent sees an *index* of
  every workspace it belongs to, not the contents — opening a peer
  workspace's MEMORY.md is intentional, not implicit.

## The three files

| Path | Tier | Scope | Who writes |
| --- | --- | --- | --- |
| `~/.silverhand/agents/<id>/system_prompt.md` | L1 | global (all workspaces) | the agent (any workspace), guided by the scope rule |
| `<workspace>/.silverhand/agents/<id>/MEMORY.md` | L2 | one workspace | the agent in that workspace |
| `<workspace>/.silverhand/agents/<id>/notes/*` | L2 | one workspace | the agent in that workspace |

For an agent's DM workspace (`workspace_kind = 'agent_home'`), the
workspace path **coincides with** the L1 directory:
`workspace_path = ~/.silverhand/agents/<id>`. So the same physical
`MEMORY.md` and `notes/` serve as the DM's L2. There is no separate
"DM-L2" copy.

There is no L2 `system_prompt.md`. The role contract is L1-only and is
read directly from `~/.silverhand/agents/<id>/system_prompt.md` by the
system-prompt assembler at every spawn. The single-source-of-truth
invariant is "L1 is the only place `system_prompt.md` exists" — there
is no write-side restriction on which workspace may edit it. Agents
decide where to write by **scope**:

- **Global** (identity / role / working-style guidance) → L1
  `system_prompt.md`. Picked up by every workspace on the agent's next
  spawn.
- **Workspace-scoped** (collaboration patterns, project facts, work
  logs) → that workspace's L2 `MEMORY.md` / `notes/`.

## L2 authoring contract: index first, detail on demand

The workspace root is persistent and may contain shared repositories,
worktrees, artifacts, and task files. It is not exclusively owned by one agent.
The private authoring boundary is the agent's own
`<workspace>/.silverhand/agents/<id>/` L2 directory. Before running git or a
package manager, the agent must select the intended project/worktree inside the
workspace rather than treating cwd layout as a fixed schema or arbitrary cwd
files as additional private-memory tiers. Within that boundary, the agent may
create whatever files and directories the work requires.

`MEMORY.md` must stand alone as the recovery entry point and knowledge router,
not the complete knowledge body. Keep only:

- rules and high-cost traps that must be loaded immediately;
- a Key Knowledge index containing only pinned high-priority
  `topic → file/section + read trigger` routes;
- current Active Context needed to resume real work.

Put explanation, evidence, architecture, important decision history, and
domain detail in flexibly named, domain-specific `notes/` files or canonical
repository docs. Notes may use any useful files or subdirectories; examples are
not a required layout. Every new Markdown note, and an existing note when it is
materially updated, declares a stable unique `name`, a retrieval-oriented
`description`, and `metadata.category` (`user`, `feedback`, or `project`) in
YAML frontmatter. Descriptions name concrete surfaces, symbols, workflows,
failure modes, and when the note should be read; they are not generic topic
summaries and are limited to 200 characters. Other top-level or `metadata`
fields are allowed and ignored by the catalog projection.

At spawn, daemon-host scans the current L2 `notes/**/*.md` without following
symlinks and derives a read-only Memory Notes Catalog. Files without valid
frontmatter stay unchanged on disk and are silently absent from the catalog.
After the first path-sorted declaration, duplicate names are silently omitted.
The injected catalog is capped at 20 entries and 4KB UTF-8 for the complete
rendered block. Both limits omit only complete entries and include the omitted
count in the rendered budget. The catalog carries metadata and paths only;
note bodies never enter the prompt automatically.

Ordinary notes need no duplicate MEMORY pointer; MEMORY pins only high-priority
triggers or active handoffs that must remain prominent every session.
Task status remains on the task board and commit inventories remain in git.
When a note is unusually important on every spawn, pin one retrieval pointer in
MEMORY; ordinary notes rely on the generated catalog.

The agent records durable user preferences, project/domain facts, important
decisions and failed approaches, workspace/channel context, and collaboration
patterns proactively. A significant interaction updates the relevant note;
MEMORY changes only when an immediate rule, knowledge route, or live handoff
changes. A `done`/`closed` task notice removes that task from Active Context in
the same turn. Only reusable lessons move to notes; completed-task timelines do
not remain in MEMORY. Rewriting an entry as `DONE` and keeping it is an explicit
anti-pattern, not a valid status update.

The injected file should target less than 10KB / roughly 80–120 lines. The
16KB reader cap is a truncation boundary, not an authoring target.

## Why no L2 system_prompt

The previous design seeded an L2 `system_prompt.md` snapshot per
workspace. In practice that meant:

1. The user shaped the role in `@Alice`'s DM → only L2-DM updated.
2. `@Alice` joined `#workspace-foo` → backend copied L1 → L2-foo
   *as a snapshot at join time*; the role contract was an empty
   placeholder if nothing had ever been shaped at L1 first.
3. Every new workspace prompted the user to "tell me my role" again.

The fix is to drop the L2 copy and read from L1 directly. There is now
exactly one `system_prompt.md` per agent.

## Spawn-time prompt assembly

Daemon prompt-context assembly loads four local projections and hands them to
`buildPlatformPrompt`:

1. **Role (L1)** — `readFile(~/.silverhand/agents/<agent.id>/system_prompt.md)`,
   missing → empty string. Rendered as the trailing **Initial role**
   section of the prompt.
2. **Current workspace MEMORY.md** — `readFileWithCap(<active L2>/MEMORY.md, 16 KB)`.
   Cap is hard: oversize files are UTF-8-safely truncated and tagged
   `\n…(truncated)`. Missing → empty → renderer shows the missing-hint.
3. **Current workspace note catalog** — recursively enumerate the active L2
   `notes/**/*.md`, parse valid frontmatter locally, and derive metadata-only
   entries. No note bytes cross the server protocol.
4. **Workspace memory index** — for every workspace the agent is a
   member of (`WorkspaceRepo.listForAgent(agentId)`), build
   `{label, memoryPath}`. The current workspace's label is suffixed
   with ` (current)`. Renderer notes that the current workspace's
   memory is already inlined; the rest are reference paths.

The renderer (`buildPlatformPrompt`) then weaves them into named
sections:

```
## Initial role          ← roleSystemPrompt (L1)
## Active Workspace Memory ← currentMemory (L2 of active workspace)
## Memory Notes Catalog  ← current workspace note metadata (daemon-derived)
## Workspace Memory Index ← workspaceMemoryIndex (paths only)
```

These render as the injected tail of the operating manual. The runtime
re-injects the tail on every spawn, so compaction recovery always includes the
current L1 role, active L2 recovery index, current note catalog, and paths to
other workspace indexes.

## Onboarding contract

### DM (`agent_home`) onboarding
Tells the agent it is in its personal DM, that L1 `system_prompt.md` is
shared across every workspace, and that this DM also has its own L2
MEMORY/notes. Updates to L1 from anywhere propagate everywhere on the
next spawn. The agent decides where to write by scope (global → L1;
DM-local notes → DM's L2).

### Regular workspace onboarding
Tells the agent its role is auto-loaded from L1 and that workspace-scoped
collaboration patterns belong in this workspace's MEMORY.md / notes/. The
same scope rule applies: global identity goes to L1, workspace-scoped
guidance goes to L2. There is no execution face that lets the agent jump
to a different conversation; all writes happen in the agent's current
process, which is fine because L1 is a real file the agent can edit
in-place.

## Local realization is per-computer; the index degrades to "unavailable"

Each agent has a `host_id` (the computer its runtime executes on). Each
workspace has a home computer (`workspace_host_id`), but a workspace is a
LOGICAL collaboration domain: on every computer that runs it, the daemon
registry binds it to a computer-local root (the home computer keeps the
user-chosen directory; a guest computer gets a daemon-managed root, and the
home path never crosses computers).

Before a spawn, the backend ensures the ACTIVE workspace's local root and
the agent's L2 seed exist on the agent's computer (blocking, idempotent —
`workspace_provision` without a requested path on a guest, then
`agent_l2_seed`). The workspace memory index is resolve-or-degrade: an
entry the daemon cannot resolve locally renders as _unavailable on this
computer_ — never a fabricated path — and does not block the spawn. It
becomes available when that workspace next runs on this computer.

(Membership host-equality is gone entirely — #task:1600 lifted the
cross-computer entry gates; members join from any computer and their L2
seeds on their own computer's local realization. This prompt-assembly
contract is unchanged by where members live.)

## Migration

Manual. There is no programmatic migration script:

1. Author the canonical role contract in your DM. Either edit
   `~/.silverhand/agents/<id>/system_prompt.md` directly, or ask the
   agent in DM to update it for you.
2. For every regular workspace this agent is in, delete the legacy
   `<workspace>/.silverhand/agents/<id>/system_prompt.md` if it
   exists (it will no longer be re-seeded).
3. Re-spawn the agent. The new prompt picks up L1 system_prompt + L2
   MEMORY/notes automatically.

## Anti-patterns to keep out

- **Do not re-introduce L2 `system_prompt.md`.** Even as a "fallback"
  it re-creates the duplication this design is fixing. The invariant is
  "L1 is the only place `system_prompt.md` exists" — there is no
  per-workspace copy.
- **Do not re-introduce a write-side restriction on L1.** The role can
  be edited from any workspace; agents pick the layer by **scope** of
  the guidance, not by which channel they happen to be in.
- **Do not auto-inject MEMORY.md from peer workspaces.** Cross-context
  pollution risk; the workspace memory index is path-only on purpose.
- **Do not auto-inject note bodies.** The current-workspace catalog is a
  retrieval surface, not another context dump. Peer-workspace notes are not
  enumerated.
- **Do not push agent-side `Read MEMORY.md first` instructions** —
  content is already in the prompt; the second read is wasted budget.
- **Do not add a host-id filter inside `buildWorkspaceMemoryIndex`.**
  Cross-computer members are legal (#task:1600): a peer workspace whose
  local root does not resolve on this computer renders as _unavailable
  on this computer_ — filtering it out entirely would hide real
  memberships and mask membership bugs.
- **Do not re-introduce a workspace `CONSENSUS.md` / Workspace Consensus
  section.** It was removed deliberately (#task:1086): agents rarely
  edited the shared file and one shared doc blurred separate agents'
  records. Per-agent L2 `MEMORY.md` / `notes/` is the home for durable
  workspace knowledge; cross-agent agreements that must be enforced
  belong in the codebase or docs, not a re-injected shared prompt file.
