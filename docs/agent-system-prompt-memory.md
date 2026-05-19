# Agent system prompt + memory model

Locked design as of 2026-05-20. Authoritative for `system_prompt.md`,
`MEMORY.md`, `notes/`, `CONSENSUS.md`, and the platform prompt assembly
that injects them on every spawn.

## Goals

- An agent has **one** identity, edited in **one** place. A user who
  shapes the role in `@Alice`'s DM should not have to re-shape it in
  every workspace `@Alice` joins.
- Memory and collaboration patterns that are workspace-scoped (review
  pairings, hand-off rules, work logs) stay with the workspace and do
  not leak across.
- Common context (role, current workspace memory, workspace consensus)
  is loaded for the agent on every spawn so it does not need to issue
  Read calls to recover its baseline.
- Cross-workspace navigation is path-only: the agent sees an *index* of
  every workspace it belongs to, not the contents — opening a peer
  workspace's MEMORY.md is intentional, not implicit.

## The four files

| Path | Tier | Scope | Who writes |
| --- | --- | --- | --- |
| `~/.silverhand/agents/<id>/system_prompt.md` | L1 | global (all workspaces) | the agent in **its DM only** |
| `<workspace>/.silverhand/agents/<id>/MEMORY.md` | L2 | one workspace | the agent in that workspace |
| `<workspace>/.silverhand/agents/<id>/notes/*` | L2 | one workspace | the agent in that workspace |
| `<workspace>/.silverhand/CONSENSUS.md` | workspace | one workspace | every member, by agreement |

For an agent's DM workspace (`workspace_kind = 'agent_home'`), the
workspace path **coincides with** the L1 directory:
`workspace_path = ~/.silverhand/agents/<id>`. So the same physical
`MEMORY.md` and `notes/` serve as the DM's L2. There is no separate
"DM-L2" copy.

There is no L2 `system_prompt.md`. The role contract is L1-only and is
read directly from `~/.silverhand/agents/<id>/system_prompt.md` by the
system-prompt assembler at every spawn.

## Why no L2 system_prompt

The previous design seeded an L2 `system_prompt.md` snapshot per
workspace. In practice that meant:

1. The user shaped the role in `@Alice`'s DM → only L2-DM updated.
2. `@Alice` joined `#workspace-foo` → backend copied L1 → L2-foo
   *as a snapshot at join time*; the role contract was an empty
   placeholder if nothing had ever been shaped at L1 first.
3. Every new workspace prompted the user to "tell me my role" again.

The fix is to drop the L2 copy and read from L1 directly. The agent in
a non-DM workspace treats the role as read-only; if the user wants a
global change there, the agent redirects to the DM.

## Spawn-time prompt assembly

`ConversationManager.buildPromptContext(conversation, workspace, agent)`
loads the four pieces and hands them to `buildPlatformPrompt`:

1. **Role (L1)** — `readFile(~/.silverhand/agents/<agent.id>/system_prompt.md)`,
   missing → empty string. Rendered as the trailing **Initial role**
   section of the prompt.
2. **Current workspace MEMORY.md** — `readFileWithCap(<active L2>/MEMORY.md, 16 KB)`.
   Cap is hard: oversize files are UTF-8-safely truncated and tagged
   `\n…(truncated)`. Missing → empty → renderer shows the missing-hint.
3. **Workspace CONSENSUS.md** — `readFileWithCap(<workspace>/.silverhand/CONSENSUS.md, 4 KB)`.
   Same semantics.
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
## Workspace Consensus    ← currentConsensus (workspace CONSENSUS.md)
## Workspace Memory Index ← workspaceMemoryIndex (paths only)
```

These render after the session-context block and before the bulk of
the operating manual, so the agent sees them up-front.

## Onboarding contract

### DM (`agent_home`) onboarding
Tells the agent it is in its personal DM and that this DM is the
**only** place where its global identity (L1 `system_prompt.md`) may be
edited. When the user gives durable role guidance, the agent updates L1
directly.

### Regular workspace onboarding
Tells the agent its role is auto-loaded from L1 and that workspace-scoped
collaboration patterns belong in this workspace's MEMORY.md / notes/.
If the user asks for a global role change, the agent redirects them to
the DM — it does **not** attempt to act in the DM from here. There is
no cross-conversation execution face.

## Host-equality is a membership precondition, not a runtime filter

Each agent has a `host_id` (where its runtime executes). Each workspace
has a `workspace_host_id` (where its files live). Same host = same
trust domain; an agent on the same host can read every file under that
host's filesystem.

We enforce `agent.host_id == workspace.workspace_host_id` at the
moment an agent is added to a workspace (the membership precondition).
Once that check passes, no runtime path filter is needed: the workspace
memory index is built from `listForAgent`, and every entry in it is
guaranteed to live on the same host the agent is currently running on.

When remote sandbox runtimes ship, the same precondition picks up the
new constraint — `addAgentToWorkspace` will reject mixed-host pairs —
without changing the prompt assembly.

## Migration

Manual. There is no programmatic migration script:

1. Author the canonical role contract in your DM. Either edit
   `~/.silverhand/agents/<id>/system_prompt.md` directly, or ask the
   agent in DM to update it for you.
2. For every regular workspace this agent is in, delete the legacy
   `<workspace>/.silverhand/agents/<id>/system_prompt.md` if it
   exists (it will no longer be re-seeded).
3. Re-spawn the agent. The new prompt picks up L1 system_prompt + L2
   MEMORY/notes + workspace CONSENSUS automatically.

## Anti-patterns to keep out

- **Do not re-introduce L2 `system_prompt.md`.** Even as a "fallback"
  it re-creates the duplication this design is fixing.
- **Do not auto-inject MEMORY.md from peer workspaces.** Cross-context
  pollution risk; the workspace memory index is path-only on purpose.
- **Do not push agent-side `Read MEMORY.md first` instructions** —
  content is already in the prompt; the second read is wasted budget.
- **Do not add a host-id filter inside `buildWorkspaceMemoryIndex`.**
  Host equality is enforced at membership time; runtime filtering is
  redundant and can mask membership bugs.
