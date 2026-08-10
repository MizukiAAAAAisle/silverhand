# Graded Permissions

Two orthogonal authority axes govern this system — **not** one ACL with shared columns:

- **Human axis = role-based**, coarse, workspace-scoped governance.
- **Agent axis = capability-based**, fine, per-(workspace, agent) action grants.

They never collapse into each other. A workspace owner who is not an agent's creator governs the
workspace but cannot edit that agent's profile; an agent creator who is only an ordinary member edits
the agent but cannot archive the workspace. The single executable proof of orthogonality is a test
asserting **changing one axis does not change the other** (§6.3).

---

## 1. Human axis — role model

Three workspace roles, **all first-class in backend** (schema, helpers, tests): `owner` / `admin` /
`member`. **UI surfaces owner (read-only) + member**: no admin grant/revoke, no
selector that can set owner/admin. `admin` is fully modeled so wiring it on in UI needs no gate/test rework.

**Critical distinction: role ≠ membership.** Two independent gates:

- **Workspace role** (`owner`/`admin`/`member`) decides **governance** capability.
- **Conversation membership** (`conversation_users`) decides **whether you can
  see / post in** a specific channel/thread.

A workspace `admin` not in a private thread cannot read it; a plain `member` in a channel can post.
Every governance op below is *additionally* subject to conversation membership where it touches a
specific conversation.

### 1.1 Role → operation matrix

| Operation | owner | admin | member |
|---|---|---|---|
| Read workspace / list channels (subject to conv membership) | ✓ | ✓ | ✓ |
| Post / read in a conversation (subject to `conversation_users`) | ✓ | ✓ | ✓ |
| Create / delete channel | ✓ | ✓ | ✗ |
| Add / remove **an agent you created** as a workspace member | ✓ | ✓ | ✓ |
| Add **someone else's agent** as a workspace member (enrollment, §3) | ✗ | ✗ | ✗ |
| Remove **someone else's agent** from the workspace roster (`manage_workspace_agents`) | ✓ | ✓ | ✗ |
| Add **your own agent** to a channel **you are a member of** | ✓ | ✓ | ✓ |
| Add a **human** to a channel | ✓ | ✓ | ✗ |
| Remove **another human** from a channel — `conversation_users` only (#task:1688) | ✓ | ✓ | ✗ |
| Leave a channel **yourself** (subject to the exit guards below, no role needed) | ✓ | ✓ | ✓ |
| Add **someone else's agent** — already a workspace member — to a channel | ✓ | ✓ | ✗ |
| Add **someone else's agent** — *not yet* a workspace member — to a channel (it would enroll) | ✗ | ✗ | ✗ |
| Edit workspace settings — name / description / icon (**includes rename**) | ✓ | ✓ | ✗ |
| Edit **capabilities** of **an agent you created** in this workspace (§2, #task:1777) | ✓ | ✓ | ✓ |
| Edit **capabilities** of **someone else's** agent in this workspace (§2) | ✓ | ✓ | ✗ |
| Add **human** member | ✓ | ✓ | ✗ |
| Remove **human** member / change human role | ✓ | ✗ | ✗ |
| Leave the **workspace** yourself (#task:1930) | ✗ | ✓ | ✓ |
| Grant / revoke `admin` | ✓ | ✗ | ✗ |
| **Archive / delete** workspace | ✓ | ✗ | ✗ |

Rule of thumb: `admin` = day-to-day operation (channels, agents, capabilities, workspace settings incl.
rename, adding humans as workspace members); `owner` = existential + human-role/removal control
(archive/delete, human role changes/removal, admin grants).
**Exactly one owner per workspace.** (Rename is `admin`, deliberately not owner-only;
it is a setting, not existential.)

**Placement authority is two independent factors** (#task:1683, shiki 2026-07-28). The rows above that
admit a `member` are not a softening of `manage_workspace_agents`: on any roster write the required
rank follows the **class of data being written**, and it is ANDed with the roster floor, never
substituted for it.

- Factor 1 — **roster authority**: the workspace role (`canGovernWorkspace`) for the workspace
  roster; MEMBERSHIP OF THE TARGET CONVERSATION (`canAddConversationMember` = `canViewConversation`)
  for a channel roster. No role and no agent of yours is a way into a channel you are not in.
- Factor 2 — **agent ownership**: `canEnrollAgent` (the agent's creator, §3). This factor is graded
  **per verb, not per route**: `admin` is an OR-arm alongside ownership only on **removal** from the
  workspace roster (it governs the whole roster and must be able to clean it up). On **enrollment**
  there is no OR-arm at all — an agent that is not yet a workspace member can be brought in only by
  its creator, so an `owner`/`admin` reaching for someone else's not-yet-enrolled agent is refused
  exactly like a `member` is (`agent_not_owned`). Same route, opposite answers by verb.
- Consequence: a plain `member` can complete the delegation flow end to end (bring their own agents
  in, place them in their own channels, take them back out) without an admin, and still cannot touch
  the people roster or anybody else's agents. And no role enrolls on someone's behalf — the way to
  get a teammate's agent into a workspace is to add the teammate, who brings their own agents.

**Removing a human is graded by WHICH roster it writes** (#task:1688). The workspace human roster is
`owner`-only (existential, and it carries role control); a CHANNEL's human roster is `admin`, the same
day-to-day governance as creating, renaming, archiving that channel or adding a human to it. Nothing
outside the one `conversation_users` edge changes — the `workspace_users` row, the user row, the
target's role, and every other channel stay as they were.

Two guards keep the channel grade from becoming a god-gate, and one rule keeps the verbs apart:

- **Floor**: the caller must be a member of that channel (`canViewConversation`). Governance is not a
  way into a channel you are not in — the same floor the channel-add route has. It is checked FIRST,
  above the conversation's own shape: `kind` and `closed_at` are as private as the roster rows, so
  answering them earlier would sort unknown ids into DM / closed / invisible-channel buckets. An
  outsider gets ONE 403 for all three (a nonexistent id keeps the route-wide 404 convention).
- **Rank**: governance is not transitive upward. An `admin` may not remove a member who OUTRANKS them
  (authoritative roles on both sides — `workspaceRole` for the actor, `userWorkspaceRole` for the
  target), so admin-removes-`owner` is refused (`target_outranks_actor`).
- **Self is a different verb**: removing yourself is `POST /api/channels/:id/leave` (member-only
  self-service, no role); asking the removal route to remove you is refused (`self_target`). Both
  paths evaluate ONE exit-eligibility predicate for the member whose edge would end
  (`evaluateChannelMemberExitEligibility`): archived channel, the workspace owner of a private
  channel, and the last human of a private channel are blocked no matter who asked. A target with no
  membership row is an idempotent success, not a refusal.

Two consequences of the floor + rank guards: `channel_owner` and `last_human_member` are structurally
unreachable through third-party removal today (the caller would have to be the owner removing
themselves, or a non-member of a private channel). They stay in the shared predicate because they are
the SAME rule self-leave enforces, and each becomes reachable the moment its invariant changes
(co-owners; admins gaining non-member visibility).

**Leaving the WORKSPACE yourself** is `POST /api/workspaces/:id/leave` (#task:1930, shiki 2026-08-09) —
the same self-service logic one level up, so it needs no role either, only an existing membership. It
writes the caller's `workspace_users` row and EVERY `conversation_users` row they hold in that
workspace, in one transaction (the owner-driven human-removal cascade, reused). Three properties follow
from it being EXISTENTIAL rather than day-to-day:

- The **owner is refused** (`owner_removal_unsupported`) — exactly one owner per workspace and no
  ownership transfer, so the owner's exit is Delete. Letting an owner leave requires modelling transfer
  first; it is not a gate to relax.
- The per-channel exit guards **do not apply**. A private channel where the leaver is the last human
  must not veto leaving the workspace. The cost is real and accepted: that channel is then stranded —
  no human, admins included, can see or re-join a private channel — because exit freedom outranks the
  recoverability of a sub-resource. This is the second documented
  exception to `evaluateChannelMemberExitEligibility` ("every path" there means every path that ends a
  channel edge as its own unit of work), alongside owner-driven human removal.
- The leaver's **agents stay enrolled**. A human leaving takes no agent with them; those agents remain
  governable by `admin` (the member∧creator arm no longer holds for the departed creator). Accepted
  residual, not an oversight.

A **non-member** is refused (`not_member`, 403) rather than answered idempotently: unlike a
third-party removal, where an absent target row means the caller's goal is already true, here the
caller is asserting a membership they do not have — idempotency must not outrank the permission model.


### 1.2 Storage

- `workspaces.owner_user_id` — the live owner pointer. The denormalized convenience pointer;
  the authoritative role source is `workspace_users.role`, not this column.
- `workspace_users.role` (`owner` | `admin` | `member`, default `member` for new rows) — the
  authoritative governance role.
- Invariant enforced in the repo layer: a workspace always has **exactly one** `owner` row.

### 1.3 Helpers

The human governance gate is role-graded:

```
workspaceRole(ctx, principal, workspaceId): 'owner' | 'admin' | 'member' | null
canGovernWorkspace(ctx, principal, workspaceId, minRole): boolean   // role >= minRole
userWorkspaceRole(ctx, workspaceId, userId): 'owner' | 'admin' | 'member' | null
workspaceRoleOutranks(higher, lower): boolean                      // strict rank compare
```

`userWorkspaceRole` is the TARGET-scoped counterpart of `workspaceRole` — same authority
(`workspace_users.role`), asked about the person being acted ON rather than the caller. It exists for
the two rules that are properties of the target: the private-channel owner-anchor guard and the
actor↔target rank comparison (`workspaceRoleOutranks`, #task:1688). Neither takes a principal, so
neither can be fed a forged identity.

`canGovernWorkspace` is the sole governance gate; the forbidden old two-valued gate it replaced,
`canMutateWorkspace` (which returned `kind !== 'agent'`, making every human member admin-equivalent),
no longer exists. Callers pass the minimum role for the op (`'owner'` for archive, `'admin'` for
channel management and anything touching the people roster). System principals pass unconditionally
(mirrors every existing `canX`).

On a **composite** route the role passed here is the route FLOOR, and the handler then grades by the
class of data being written (§1.1, "two independent factors"): the agent-roster routes pass
`'member'` and AND that with `canEnrollAgent` — unconditionally when the write ENROLLS an agent, and
with an `admin` OR-arm only when it REMOVES one. `HUMAN_GOVERNANCE_ROUTES`
declares the floor, never the highest rank the route can demand, and every inner escalation is spelled
out in that entry's `note` — a declaration that claimed `admin` while the live floor was `member`
would make the registry state the opposite of the gate it documents. `permissions-registry.test.ts`
drives the real routes at and below each declared `member` floor, so the declaration cannot drift
away from behaviour in either direction.

---

## 2. Agent axis — capability model

Capabilities are **per-(workspace, agent)**, stored as the agent's **effective** capability set in
that workspace. **No** "creator-global-default + owner-narrow-only" inheritance (it
re-entangles agent-owner with workspace-owner). The set is authoritative
on its own; **who may edit it** is a single-layer co-editor gate (§2.4, #task:1777): workspace
**admin** (governs the whole roster's caps) OR a **member who created the agent** (their own
placement authority). There is exactly one set — no ceiling/desired-set layers — edited
last-write-wins. The axes stay orthogonal: this is a human-side gate ON the agent axis, never the
agent's own capability reading itself.

**Structural isolation is the floor beneath capabilities.** An agent never sees a
conversation it is not a member of — not because a route forbids it, but because
**there is no agent "read someone else's messages" route at all**. Inbound
delivery (`drainInbox`) only ever writes the agent's own conversation to its
stdin; the capability set narrows what an agent may do *within* the
conversations it is already structurally bound to. Capability grants therefore
widen authority on top of structural isolation; they can never breach it.

### 2.1 Storage

`workspace_agent_capabilities(workspace_id, agent_id, capability)` — presence = granted. Edited only
through the route gated by `canEditAgentCapabilities` (admin ∨ member-who-created-the-agent, §2.4).
The agent itself can never widen its own set: the creator arm reuses `canEnrollAgent`, which is
`false` for every agent principal, so no agent principal ever passes this gate.

### 2.2 Capability buckets

Coarse buckets (11, not 20 atomic ops):

| Capability | Covers (internal routes, §3) |
|---|---|
| `read_messages` | read history, search messages, list workspaces/channels |
| `send_messages` | send conversation message (`@mention` of humans rides here) |
| `read_tasks` | list conversation tasks |
| `create_tasks` | **create** new tasks |
| `write_tasks` | mutate existing tasks — claim / unclaim / update-status |
| `read_attachments` | locate / download attachment |
| `upload_attachments` | upload attachment |
| `create_threads` | retired legacy bucket (old isolated thread create/close removed; retained only for DB/backward compatibility) |
| `create_channels` | create a top-level channel |
| `manage_conversation_members` | agent adds an existing workspace member into a channel/thread |
| `manage_schedules` | schedule create / cancel (list is self-introspection, §3.2) |

`create_tasks` is deliberately separate from `write_tasks`:
"create a task" (spawn new work onto the board) is a different authority from "claim / advance an
existing task". An agent may be allowed to work the board without being allowed to spawn new tasks, or
vice-versa.

(`agent_self_profile` — avatar upload/delete — is **not** a workspace capability; it stays on
`canEditAgent` self-gate, §3, because it is identity-axis, not workspace-action.)

**Naming: two distinct "member management" concepts.** Do not collapse:
- `manage_workspace_agents` — a **human role** governance op (§1.1): adds/removes an agent *as a
  workspace member*. Gated by `canGovernWorkspace(..., 'member')` as the floor, then graded by target
  **and by verb** (#task:1683): **add** requires `canEnrollAgent` (the agent's creator) with no role
  OR-arm — no `owner`/`admin` enrolls someone else's agent; **remove** is `admin` OR `canEnrollAgent`,
  so an admin can clean up the whole roster. Ownership and role never substitute for each other in
  either direction. NOT an agent capability.
- `manage_conversation_members` — an **agent capability** (this table): an agent adds an *already-
  workspace-member* participant into a specific channel/thread (the `agentAddConversationMember`
  route). Gated by `canAgentUseCapability`. An agent principal can never auto-provision a workspace
  membership, so a non-workspace target is `workspace_membership_required` for it.
These use different helpers on different axes; sharing a name (`manage_members`) would invite wiring
`canGovernWorkspace` where a capability check belongs, or vice-versa.

### 2.3 Default discipline

- Existing memberships hold the **full** capability set.
- Hard rule: a **newly added** capability must NOT auto-grant to existing agents via a helper default.
  Every new capability ships a migration that explicitly decides default true/false per existing row.
  No silent widening. (A `buildDefaultCapabilities()` helper may exist for *new* memberships, but it
  is never retroactively applied to old rows except by an explicit migration.)

### 2.4 Edit lifecycle

- **Read:** `GET /api/workspaces/:id/agents/:aid/capabilities` → current effective set. Gated
  `canViewWorkspace` (any member can see what an agent may do).
- **Edit:** `PUT /api/workspaces/:id/agents/:aid/capabilities` (replace-set semantics) → gated
  `canEditAgentCapabilities` = `admin(ws) ∨ (member(ws) ∧ canEnrollAgent(agent))` (#task:1777,
  approved #1775 option A). Admin governs the whole roster's caps; otherwise a member may edit the
  caps of an agent **they created** — the same ownership factor as enrollment (§1.3), and the
  `member(ws)` floor means a departed creator (no live workspace role) can no longer reach in.
  Validates against the known bucket enum (unknown cap → 400).
- **Why co-editor is safe (adds no new escalation):** enrollment already seeds the **full** set (§2.3),
  so a creator can already grant their agent everything by placing it. Editing afterward is single-layer
  last-write-wins, not a new privilege. If an admin narrows a member's agent, the creator can re-open it;
  the only durable constraint on a member's own agent is to remove it from the workspace. This is the
  accepted trade for keeping "your agent is yours to configure" true without a two-layer ceiling.
- **On agent add to workspace:** capability set seeded from `buildDefaultCapabilities()` (full set)
  at member-add time, in the same transaction as the `workspace_members` insert.
- **On agent remove:** capability rows deleted with the membership (no orphan caps).

**Ordering (edit route):** workspace 404 → **authorization** (`canEditAgentCapabilities`) → pair 404 →
write. Authorization runs BEFORE the `(workspace_id, agent_id)` membership 404 so that a caller who is
neither admin nor the agent's creator cannot use the 403-vs-404 difference to probe whether a pair
exists; only an authorized caller ever learns an invalid pair (then 404, before any capability write).
The GET route stays viewer-gated then pair-404. Either way the pair 404 precedes touching the set, so
no phantom set is ever read or written.

**Freshness (explicit, #task:1777):** there is **no realtime cross-device editor sync**. Enforcement is
always live — `canAgentUseCapability` reads the DB per request, so the security boundary is never stale.
The editor is authoritative on fetch (GET open) and on its own PUT response (returns the full set). A
second co-editor's already-open page may be stale and its submit is last-write-wins — the accepted
single-layer concurrency contract, not a bug. `replaceSet` therefore publishes no invalidation event by
design; adding one would be the only way to converge two open editors, and v1 deliberately does not.

---

## 3. Route → capability map

Source: the internal agent routes registered via `internalPaths.*`. Gate read from each handler
directly.

**Scope column = which workspace the capability is evaluated against.**
The agent principal is `(conversationId, agentId)` — it carries **no** workspace. Several routes
operate cross-workspace/target (`agentListChannels?workspace_id`, `agentSearchMessages workspace_id`,
task selectors, schedule `target_conversation_id`). So `canAgentUseCapability` MUST take an explicit
target scope; "principal's workspace" is insufficient and would either let a source-workspace cap
authorize a target-workspace action or wrongly deny. Each route declares the workspace the cap is
checked on.

| Internal route | Conversation gate | Capability | Cap evaluated on |
|---|---|---|---|
| `agentCliTrace` | none (telemetry, principal-pinned) | — (`none-justified`: telemetry) | — |
| `agentReadHistory` | `canViewConversation` | `read_messages` | **target** conversation's workspace (route resolves a cross-conversation `target`) |
| `agentListWorkspaces` | `canViewConversation` | — (`none-justified`: agent-self workspace index — lists the agent's own memberships, no per-workspace action; see §3.3) | — |
| `agentListChannels` | `canViewConversation` | `read_messages` | **target** `workspace_id` arg (default principal's) |
| `agentSearchMessages` | `canViewConversation` (+ `canAgentAccessWorkspace` cross-ws) | `read_messages` | **resolved target**: `conversation_id` selector → that conversation's workspace (global id, may differ); else `workspace_id` arg (or `current_workspace: true` → principal's); else principal's |
| `agentSendConversationMessage` | `canPostToConversation` | `send_messages` | principal conversation's workspace |
| `agentCreateChannel` | `canPostToConversation` | `create_channels` | principal conversation's workspace |
| `agentListConversationTasks` | `canViewConversation` | `read_tasks` | **effective** workspace (route supports `workspace_id` arg → other member workspace) |
| `agentCreateConversationTasks` | `canPostToConversation` | `create_tasks` | principal conversation's workspace |
| `agentClaimConversationTasks` | `canPostToConversation` | `write_tasks` | **target task's** conversation workspace |
| `agentUnclaimConversationTask` | `canPostToConversation` | `write_tasks` | **target task's** conversation workspace |
| `agentUpdateConversationTaskStatus` | `canPostToConversation` | `write_tasks` | **target task's** conversation workspace |
| `agentUploadAttachment` | `canPostToConversation` | `upload_attachments` | principal conversation's workspace |
| `agentLocateAttachment` | `canViewConversation` | `read_attachments` | principal conversation's workspace |
| `agentAddConversationMember` | `canAddConversationMember` (buried in `addConversationMember` helper = view-equivalent) | `manage_conversation_members` | target conversation's workspace |
| `agentUploadAvatar` | `canEditAgent` (self, URL-pinned) | — (`none-justified`: agent-self profile, stays `canEditAgent`) | — |
| `agentDeleteAvatar` | `canEditAgent` (self) | — (same) | — |
| `agentScheduleCreate` | `manage_schedules` gate | `manage_schedules` | **target** `target_conversation_id`'s workspace (default principal's) |
| `agentScheduleList` | — | — (`none-justified`: agent-self schedule introspection — see §3.2) | — |
| `agentScheduleCancel` | `manage_schedules` gate | `manage_schedules` | **resolve schedule → target conversation's** workspace |

### 3.1 Schedule capability is not flat

`scheduleService` supports explicit `target_conversation_id`, and list/cancel operate on the agent's
**global** schedule list by id. A single flat per-workspace `manage_schedules` check is wrong because
a per-(workspace,agent) capability needs a workspace target:

- **create** → evaluate `manage_schedules` on the **target conversation's** workspace (where the wake
  fires), defaulting to the principal conversation's workspace when no target given.
- **cancel** → first resolve `schedule_id` → its target conversation → that conversation's workspace,
  then check `manage_schedules`. (Prevents cancelling a schedule whose target sits in a workspace the
  agent has lost the cap in.)
- **list** → **agent-self introspection**, registry-declared `none-justified` (NOT `manage_schedules`).
  It returns the agent's own schedules across all targets; there is no single workspace target to check
  a per-workspace cap against, and it leaks nothing the agent doesn't already own.

Note: the *internal agent* schedule surface is distinct from the public
`GET /api/agents/:id/schedules`, which is gated `canViewAgent` + `canEditAgent`. The drift test (§6)
forces the internal create/cancel routes to stay declared under `manage_schedules`.

### 3.2 `agentListWorkspaces` is agent-self index, not `read_messages`

`agentListWorkspaces` gates only `canViewConversation(principal.conversationId)`
then returns the agent's **own** workspace memberships (`buildAgentListWorkspacesDto(agentId)`). Using
a single principal-workspace `read_messages` grant to authorize a global cross-workspace list is
arbitrary. It is declared `none-justified: agent-self workspace index` —
it enumerates the agent's own memberships (which the agent inherently knows), performs no per-workspace
action, and leaks nothing cross-workspace. If per-workspace visibility filtering is ever wanted, it
becomes a real cap then, via migration.

### 3.3 Enforcement contract

- **(a) Gate at the backend route, never the CLI.** The route resolves the
  target workspace (per the §3 Scope column) from the agent principal `(conversationId, agentId)` plus
  the request's target args, then looks up `workspace_agent_capabilities` → 403 on miss. CLI is a
  dumb shim — adding a capability never requires a CLI release; capability is enforced in exactly one
  place (no CLI/backend double-implementation drift).
- **(b) Revoke = route-entry check, no in-flight cancellation.** A request past
  the gate completes; the next 403s. Denial returns a **structured typed code**:
  `{ code: 'capability_denied', capability: 'send_messages' }` — capability as
  its own field, never string-stuffed, so agent/CLI fallback can parse and degrade.

---

## 4. Capability check shape

Parallel to the existing `canX` family, but with an **explicit target scope** (the
principal carries no workspace, and several routes are cross-workspace):

```
canAgentUseCapability(ctx, principal, capability, scope): boolean
//   principal.kind === 'agent'  (principal is (conversationId, agentId), NO workspace)
//   scope = { workspaceId }  resolved by the route per §3 Scope column
//           (from a target conversation / workspace_id arg / resolved schedule|task),
//           defaulting to the principal conversation's workspace.
// Looks up workspace_agent_capabilities for (scope.workspaceId, principal.agentId).
// System principals pass.
```

A route MUST resolve `scope` from the actual target it is about to act on, never from the principal's
home workspace alone — otherwise a source-workspace grant could authorize a target-workspace action.

Each internal route gates as: **existing conversation gate (membership/view) AND
`canAgentUseCapability`**. The conversation gate is *not* removed — capability is an additional
narrowing on top of "is this agent even in this conversation", preserving the role-vs-membership
separation (§1).

---

## 5. Drift test — the load-bearing protection

Worth more than per-route unit tests: it fails **when a future
route forgets to declare a capability**, not only on routes that exist today.

### 5.1 Two route registries (agent capability + human governance)

The agent axis is not the only half that drifts — the human governance gate (`canGovernWorkspace`)
can regress just as easily, so the **human governance routes** need the same protection. Two
declarative registries:

- **Agent-capability registry** — every `internalPaths.*` agent route → `{ agentCapability |
  'none-justified', scope }`. `'none-justified'` requires an inline reason (telemetry / agent-self
  profile).
- **Human-governance registry** — every public route that mutates workspace/membership/conversation
  governance → `{ minRole, roleScope: 'workspace' | 'conversation' }`, where `minRole` is the route
  **floor** and any per-target escalation is stated in the entry's `note` (§1.3).
  `roleScope: 'workspace'` reads the workspace role (archive/delete, human-member add,
  human-member role/remove, admin grant);
  `roleScope: 'conversation'` reads the effective conversation role (conversation member add). Must
  cover at least: workspace update / archive / delete / pin; workspace human-member add; workspace
  human-member role/remove; workspace agent-member add/remove (`manage_workspace_agents`); channel
  create / archive / pin / delete; conversation member add.
  Without this, the human half drifts back to "any member can do anything" exactly as the agent half
  drifted to `canPostToConversation`.

### 5.2 Coverage test

Enumerate the mounted route table and assert **every** agent internal route appears in the agent-
capability registry, and **every** governance-mutating public route appears in the human-governance
registry, each with a non-empty declaration. A new route with no entry → fail. This is the gate that
stops regression back to a god-gate on either axis.

**Coverage is not truthfulness.** Listing a route proves only that someone declared it; it says
nothing about the declared value still matching the gate — and a registry that advertises itself as
the authority SSOT while stating the opposite of the live gate is worse than no registry, because
reviewers read it instead of the code (found by Cindy on #task:1683, where three composite routes had
drifted to a `member` floor while still declaring `admin`). So every `member`-floor declaration is
additionally **probed against the real route**: driven once at the floor with the target class the
floor admits (must not be 403) and once from below the floor (must be 403), with the probe set
asserted equal to the declared set so a new member-floor entry cannot skip its probe.

### 5.3 Cross-axis orthogonality test (the orthogonality proof)

The matrix plus explicit "one axis doesn't move the other":

1. workspace owner, not agent creator → mutate workspace/members; **cannot** edit agent profile, and
   **cannot** enroll someone else's agent — while it CAN remove one from the roster. The role governs
   the roster; ownership governs enrollment (#task:1683, verb-asymmetric on purpose).
2. agent creator who is an **ordinary workspace member** (not admin/owner) → edit agent, place /
   retract THAT agent on the workspace roster and in channels they belong to, **and edit THAT agent's
   capability set** (co-editor arm, §2.4, #task:1777); **cannot** archive/delete/rename workspace, add
   humans, touch someone else's agents, or edit **another** agent's capabilities (those need admin+ per
   §1.1).
3. plain member → view/post (subject to membership); no destructive/admin; no agent edit. Owning an
   agent grants no roster write in a conversation they are not a member of — the conversation floor is
   membership, and no factor substitutes for it.
4. agent-capability change → agent gains/loses that capability; **workspace role unchanged**.
   workspace-role change → governance changes; **agent capabilities unchanged**.

If 5.3 can't be written cleanly, helper naming or column design has re-merged the two owners — that
failure *is* the signal this protection buys.

### 5.4 Naming discipline

Helpers/routes/tests for the two axes are named separately: workspace-role
helpers never reference agent capability and vice-versa. A reader must not be able to mistake the two
owners for one concept.

---

## 6. UI surface

Admin is hidden: owner is shown **read-only** and a newly added human defaults to
`member`; the UI offers no selector that can set someone to owner or admin, and admin grant/revoke
are NOT surfaced. There is no owner-change entry.

The agent-permission editing surface lives at the workspace layer; the human-role surface is
deliberately absent (see the per-bullet contracts below).

- **Workspace settings → Permission (agent capability editor).**
  `WorkspaceSettingsDialog` is a two-nav settings panel: "General" (name / working dir /
  archive / delete) and "Permission". The Permission section: pick an agent via a selector
  (avatar + display name + `@handle`), then edit that agent's capability set. Buckets are presented in
  **functional groups** — Message / Task / Channel / Thread / Members / Attachments / Schedules. The
  grouping + labels are pure **UI metadata**; the leaf keys and the values PUT to the backend are the
  11 raw `AGENT_CAPABILITIES` keys (single source — no hand-written second list; a unit test asserts the
  groups cover exactly the 11 keys, no miss/dup). Save is **replace-set**: the full target set is sent
  in one PUT; failure (403 role gate / 400 unknown bucket / network) rolls back the local draft,
  refetches, and shows an error toast. "Cancel" discards the draft.
- **Edit gate — per selected agent (#task:1777).** Editability is recomputed for the *selected* agent,
  mirroring the backend `canEditAgentCapabilities`: editable when the viewer is `owner`/`admin`, OR a
  workspace `member` who is that agent's creator (`AgentDto.created_by_user_id` === viewer). A viewer who
  is neither sees a **read-only** matrix (switches disabled, **not** hidden) plus a notice; the read-only
  vs editable state can differ from one selected agent to the next. The creator arm carries the
  `member(ws)` floor: a `viewer_role: null` viewer (non-member, or role not yet hydrated) is never
  editable — fail-closed, and the backend remains the sole authorization boundary (a stale editable
  affordance still gets a 403 on PUT, which rolls back). The viewer's role is read from
  `GET /api/workspaces/:id/members`, single-sourced through one `workspaceRole()/getUserRole()` path
  (no second truth, no independent recompute):
  - `viewer_role: 'owner' | 'admin' | 'member' | null` — request-scoped **derived sugar** for the gate;
    lives on the members-response envelope, **not** on the persistent `WorkspaceDto`.
  - `human_members[]` carries UserDto display fields **plus** membership
    fields (at least `role`, source `workspace_users.role`; may also carry `workspace_id/user_id/joined_at`)
    — role lives on the membership edge, reusable by a future human role setting UI.
- **Channel side — not part of the model.** Agent permission is
  edited **only** at the workspace layer. The channel surface carries **no** agent-permission entry, no
  read-only inheritance row, and no per-channel policy state — this avoids implying channels have their
  own permission layer.
- **Denied agent actions — agent self-reports the denial in chat.** A denied
  `silverhand channel create` returns `{ code: 'capability_denied', details: { capability }, retriable:
  false }` (exit 3), and the agent surfaces that as a participant — the human/agent-isomorphic path,
  rather than an implicit editor alarm.
- **Workspace settings → Members (human role setting) — absent.** owner/admin/member are
  fully modeled in backend and `human_members[].role` is exposed, but no human-role management UI
  ships (no grant/revoke, no member add/remove role surface, no transfer). Owner stays read-only and the
  UI only **consumes** `viewer_role` to gate the agent editor.
