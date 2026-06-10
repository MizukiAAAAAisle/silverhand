# Graded Permissions — design doc

Status: **Layer A infra + Layer C agent-capability UI landed** (local `main`, not pushed). The human
role spine (migration v40) + agent capability spine (v41) + per-route enforcement are live; this round
also shipped the **workspace-level agent capability editor UI** (#task:937, `e8d768a`) and the
**members-response role contract** (#task:938, `d0ba757`, §7). **Deferred to future rounds (§9):**
Layer B role-governance semantics, channel-level agent permission, the human-axis **human role setting**
UI, and denied-action visibility. This doc remains the full model; §7 marks what shipped vs. what was
intentionally not built this round, and §9 tracks the open TODOs.

Scope: **full design, three layers** (shiki `Ja7luA3txnreXRJ0` + `W1urh64o2XkN82ki`), with four
amendments locked by shiki `wYrHEKqTYcme-OB1`:
1. **Ownership transfer (workspace + agent) is out of scope for this round.** Not designed, not
   implemented, not surfaced. Owner is assigned once at migration (§1.2) and is not user-mutable.
2. **`create_tasks` is its own capability**, split out of `write_tasks` (claim/unclaim/status).
3. **Owner migration is trivial**: the local dogfood DB has exactly one human (shiki) → that human
   becomes every workspace's owner. No earliest-joined heuristic, no multi-human backfill logic.
4. **`admin` role stays fully designed in backend/schema/helper/test, but is NOT exposed in UI** yet
   (no admin grant/revoke, no role selector surfacing admin).

| Layer | What it is | Sections | Status |
|---|---|---|---|
| **infra** | DB/schema, permission helpers, route gates, typed error, drift test, migration/default/revoke semantics | §1.2/1.4, §2.1/2.3, §3, §4, §6 | **land first (here)** |
| **role design** | governance semantics of owner/admin/member, agent-capability management rules, which actor edits which permission | §1.1/1.3, §2.2/2.4 | doc-only boundary now |
| **ui** | permission-edit entry points, visibility, prompts, operation flow (admin hidden) | §7 | doc-only boundary now |

The full model is below so helper signatures, the drift registry, and the schema account for all
three layers from the start (Cindy `BpGpGcVn_9qa885f`); we do not implement role/ui yet, but infra is
built to not need rework when they land.

## 0. Why

Today authority is **two-valued** and **axis-confused**:

- `permissions.ts:124-130` — `canMutateWorkspace = canViewWorkspace && principal.kind !== 'agent'`.
  Any human workspace member is effectively admin: rename / archive / delete workspace, add/remove
  members, remove an agent member (which hard-stops its runtime and removes it from every
  conversation, `routes.ts:2862-2880`). No owner/admin/member distinction exists.
- `permissions.ts:206-220` — `canEditAgent` keys on `agents.created_by_user_id` only. Combined with
  "any member can yank an agent from a workspace", a non-creator can remove an agent it cannot edit,
  and an agent whose creator leaves becomes permanently un-editable (orphan).
- Agent-facing authority has **collapsed onto two god-gates**: of the 22 internal agent routes, writes
  funnel through `canPostToConversation`, reads through `canViewConversation`, and a whole surface
  (internal agent schedule routes) is ungated (evidence §3). Per-capability granularity ("read but not
  send", "no channel creation", "read tasks but not create them") is inexpressible.

The fix is **two orthogonal authority axes** — not one ACL with shared columns:

- **Human axis = role-based**, coarse, governance-scoped (workspace, with optional channel override).
- **Agent axis = capability-based**, fine, per-(workspace, agent) action grants.

They never collapse into each other. A workspace owner who is not an agent's creator governs the
workspace but cannot edit that agent's profile; an agent creator who is only an ordinary member edits
the agent but cannot archive the workspace. The single executable proof of orthogonality is a test
asserting **changing one axis does not change the other** (§6.3).

---

## 1. Human axis — role model

Three workspace roles, **all first-class in backend** (schema, helpers, tests): `owner` / `admin` /
`member`. **UI surfaces owner (read-only) + member** for now (amendment 4): no admin grant/revoke, no
selector that can set owner/admin. `admin` is fully modeled so wiring it on later needs no gate/test rework.

**Critical distinction (Cindy `x30tmJFBhD2cedlr` #1): role ≠ membership.** Two independent gates:

- **Workspace role** (`owner`/`admin`/`member`) decides **governance** capability.
- **Conversation membership** (`conversation_users`, already exists) decides **whether you can
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
| Add / remove **agent** as a workspace member (`manage_workspace_agents`) | ✓ | ✓ | ✗ |
| Edit workspace settings — name / description / icon (**includes rename**) | ✓ | ✓ | ✗ |
| Edit agent **capabilities** in this workspace (§2) | ✓ | ✓ | ✗ |
| Channel-level role override (§1.3) | ✓ | ✓ | ✗ |
| Add / remove **human** member | ✓ | ✗ | ✗ |
| Grant / revoke `admin` | ✓ | ✗ | ✗ |
| **Archive / delete** workspace | ✓ | ✗ | ✗ |

Rule of thumb: `admin` = day-to-day operation (channels, agents, capabilities, workspace settings incl.
rename); `owner` = existential + human-roster control (archive/delete, human members, admin grants).
**Exactly one owner per workspace.** (Rename is `admin`, deliberately not owner-only — Cindy
`DSJLtPe7FkicAV0u` #3; it is a setting, not existential. The §1.2 behavior delta lists only the
owner-only existential ops, which do **not** include rename.) Owner is set once at migration (§1.2)
and is not user-mutable this round.

### 1.2 Storage

**No `created_by_user_id` exists on `workspaces` today** (verified — `migrations.ts:341-352` workspaces
table has no creator/owner column; `agents.created_by_user_id` exists, workspaces' does not). So owner
cannot be recovered from schema; the migration must assign it.

- New column `workspaces.owner_user_id` (nullable until backfilled) — the live owner pointer.
- New column `workspace_users.role` (`owner` | `admin` | `member`, default `member` **for new rows**).
- **Migration (trivial — amendment 3, shiki `wYrHEKqTYcme-OB1`):** the local dogfood DB has exactly
  one human. That human becomes every workspace's `owner` (`owner_user_id` = that user, their
  `workspace_users.role` = `owner`). No earliest-joined heuristic, no multi-human backfill branch is
  needed — there is only one human to assign. (If multi-human installs ever exist, the backfill
  strategy is designed then, alongside whatever join/invite flow introduces the second human.)
- Invariant enforced in the repo layer: a workspace always has **exactly one** `owner` row.

**Behavior delta: fully neutral on the current install.** With one human who becomes owner, that human
keeps every capability they have today (owner ⊇ admin ⊇ member). Nothing is stripped. The role spine
just makes future narrowing *expressible* and closes the §0 "any member can archive the workspace"
hole the moment a second human is ever added (they would join as `member`, not implicit admin).

### 1.3 Channel-level role override (designed; phased)

This is a **conversation-scoped governance role override**, not a read/write toggle. Default: a
conversation inherits the actor's workspace role. An **owner/admin** may set a per-channel override
that raises or lowers a specific human's effective **governance role** *within that conversation only*
(e.g. a `member` made channel-`admin` to moderate one channel). Storage:
`conversation_user_roles(conversation_id, user_id, role)` — absent row = inherit workspace role. The
effective role for a conversation governance op = `override ?? workspace_role`. Workspace-scoped
governance ops (archive workspace, grant admin) always read the **workspace** role, never an override.

**Out of scope — read-only channels (Cindy `OmvweHtfw3hkwFB-` #5):** the three roles all can read/post
(subject to `conversation_users`), so the role axis cannot express "this admin is read-only here".
Making a member read-only would require a separate *conversation permission* (e.g. a `can_post` flag),
which is a larger design — explicitly **not** part of this override. The override only re-grades
governance, never gates read/post.

(Delivery: §8 marks this a later layer; it is modeled here so helper signatures and the drift registry
account for it from the start.)

### 1.4 Helper changes

`canMutateWorkspace` / `canManageMembers` stop returning `kind !== 'agent'` and become role-graded:

```
workspaceRole(ctx, principal, workspaceId): 'owner' | 'admin' | 'member' | null
canGovernWorkspace(ctx, principal, workspaceId, minRole): boolean   // role >= minRole
```

Callers pass the minimum role for the op (`'owner'` for archive, `'admin'` for channel/agent member
management). System principals pass unconditionally (mirrors every existing `canX`).

---

## 2. Agent axis — capability model

Capabilities are **per-(workspace, agent)**, stored as the agent's **effective** capability set in
that workspace. **No** "creator-global-default + owner-narrow-only" inheritance (Cindy
`x30tmJFBhD2cedlr` #3 — it re-entangles agent-owner with workspace-owner). The set is authoritative
on its own; **who may edit it** is decided by the human role gate (§1, owner/admin), keeping the axes
orthogonal.

### 2.1 Storage

`workspace_agent_capabilities(workspace_id, agent_id, capability)` — presence = granted. Edited only
through routes gated by `canGovernWorkspace(..., 'admin')`. The agent itself cannot widen its own set.

### 2.2 Capability buckets

Coarse buckets (~11, not 20 atomic ops; Cindy `x30tmJFBhD2cedlr` #4):

| Capability | Covers (internal routes, §3) |
|---|---|
| `read_messages` | read history, search messages, list workspaces/channels |
| `send_messages` | send conversation message (`@mention` of humans rides here) |
| `read_tasks` | list conversation tasks |
| `create_tasks` | **create** new tasks (split out per amendment 2) |
| `write_tasks` | mutate existing tasks — claim / unclaim / update-status |
| `read_attachments` | locate / download attachment |
| `upload_attachments` | upload attachment |
| `create_threads` | open / close a thread |
| `create_channels` | create a top-level channel |
| `manage_conversation_members` | agent adds an existing workspace member into a channel/thread |
| `manage_schedules` | schedule create / cancel (list is self-introspection, §3.2) |

`create_tasks` is deliberately separate from `write_tasks` (amendment 2, shiki `wYrHEKqTYcme-OB1`):
"create a task" (spawn new work onto the board) is a different authority from "claim / advance an
existing task". An agent may be allowed to work the board without being allowed to spawn new tasks, or
vice-versa.

(`agent_self_profile` — avatar upload/delete — is **not** a workspace capability; it stays on
`canEditAgent` self-gate, §3, because it is identity-axis, not workspace-action.)

**Naming: two distinct "member management" concepts (Cindy `OmvweHtfw3hkwFB-` #6).** Do not collapse:
- `manage_workspace_agents` — a **human role** governance op (§1.1): owner/admin adds/removes an agent
  *as a workspace member*. Gated by `canGovernWorkspace(..., 'admin')`. NOT an agent capability.
- `manage_conversation_members` — an **agent capability** (this table): an agent adds an *already-
  workspace-member* participant into a specific channel/thread (the `agentAddConversationMember`
  route). Gated by `canAgentUseCapability`.
These use different helpers on different axes; sharing a name (`manage_members`) would invite wiring
`canGovernWorkspace` where a capability check belongs, or vice-versa.

### 2.3 Default & migration discipline (Cindy `x30tmJFBhD2cedlr` #5)

- Existing memberships seed with the **full** capability set → zero behavioral regression.
- Hard rule: a **newly added** capability must NOT auto-grant to existing agents via a helper default.
  Every new capability ships a migration that explicitly decides default true/false per existing row.
  No silent widening. (A `buildDefaultCapabilities()` helper may exist for *new* memberships, but it
  is never retroactively applied to old rows except by an explicit migration.) Note: splitting
  `create_tasks` out of `write_tasks` (amendment 2) follows this discipline — the migration grants
  `create_tasks` to every existing membership that has `write_tasks`, so the split is behavior-neutral.

### 2.4 Edit lifecycle (full)

- **Read:** `GET /api/workspaces/:id/agents/:aid/capabilities` → current effective set. Gated
  `canViewWorkspace` (any member can see what an agent may do).
- **Edit:** `PUT /api/workspaces/:id/agents/:aid/capabilities` (replace-set semantics) → gated
  `canGovernWorkspace(..., 'admin')`. Validates against the known bucket enum (unknown cap → 400).
- **On agent add to workspace:** capability set seeded from `buildDefaultCapabilities()` (full set in
  v1) at member-add time, in the same transaction as the `workspace_members` insert.
- **On agent remove:** capability rows deleted with the membership (no orphan caps).

**Membership precondition (Cindy `DSJLtPe7FkicAV0u` supplement):** both the read and edit routes MUST
first assert `(workspace_id, agent_id)` is a valid `workspace_members` row before touching the
capability set. Otherwise a workspace member could query or edit a capability set for an agent that
isn't a member of that workspace (reading/writing a phantom set). Invalid pair → 404, before the
capability lookup.

---

## 3. Route → capability map (grounded)

Source: 22 internal agent routes registered `routes.ts:6604-7395` via `internalPaths.*` (verified: 22
function keys in `paths.ts:213`). Current gate read from each handler directly (not grep summaries).

**Scope column = which workspace the capability is evaluated against (Cindy `OmvweHtfw3hkwFB-` #2).**
The agent principal today is `(conversationId, agentId)` — it carries **no** workspace. Several routes
operate cross-workspace/target (`agentListChannels?workspace_id`, `agentSearchMessages workspace_id`,
task selectors, schedule `target_conversation_id`). So `canAgentUseCapability` MUST take an explicit
target scope; "principal's workspace" is insufficient and would either let a source-workspace cap
authorize a target-workspace action or wrongly deny. Each route declares the workspace the cap is
checked on.

| Internal route | Current gate | Capability | Cap evaluated on |
|---|---|---|---|
| `agentCliTrace` | none (telemetry, principal-pinned) | — (`none-justified`: telemetry) | — |
| `agentReadHistory` | `canViewConversation` | `read_messages` | **target** conversation's workspace (route resolves a cross-conversation `target`, `routes.ts:6809`) |
| `agentListWorkspaces` | `canViewConversation` | — (`none-justified`: agent-self workspace index — lists the agent's own memberships, no per-workspace action; see §3.3) | — |
| `agentListChannels` | `canViewConversation` | `read_messages` | **target** `workspace_id` arg (default principal's) |
| `agentSearchMessages` | `canViewConversation` (+ `canAgentAccessWorkspace` cross-ws) | `read_messages` | **resolved target**: `scope='channel'` → `channel.workspace_id` (global id, may differ); else `workspace_id` arg; else principal's |
| `agentSendConversationMessage` | `canPostToConversation` | `send_messages` | principal conversation's workspace |
| `agentCreateThread` | `canPostToConversation` | `create_threads` | principal conversation's workspace |
| `agentCloseThread` | `canPostToConversation` | `create_threads` | principal conversation's workspace |
| `agentCreateChannel` | `canPostToConversation` | `create_channels` | principal conversation's workspace |
| `agentListConversationTasks` | `canViewConversation` | `read_tasks` | **effective** workspace (route supports `workspace_id` arg → other member workspace, `routes.ts:6996`) |
| `agentCreateConversationTasks` | `canPostToConversation` | `create_tasks` | principal conversation's workspace |
| `agentClaimConversationTasks` | `canPostToConversation` | `write_tasks` | **target task's** conversation workspace |
| `agentUnclaimConversationTask` | `canPostToConversation` | `write_tasks` | **target task's** conversation workspace |
| `agentUpdateConversationTaskStatus` | `canPostToConversation` | `write_tasks` | **target task's** conversation workspace |
| `agentUploadAttachment` | `canPostToConversation` | `upload_attachments` | principal conversation's workspace |
| `agentLocateAttachment` | `canViewConversation` | `read_attachments` | principal conversation's workspace |
| `agentAddConversationMember` | `canAddConversationMember` (buried in `addConversationMember` helper = view-equivalent) | `manage_conversation_members` | target conversation's workspace |
| `agentUploadAvatar` | `canEditAgent` (self, URL-pinned) | — (`none-justified`: agent-self profile, stays `canEditAgent`) | — |
| `agentDeleteAvatar` | `canEditAgent` (self) | — (same) | — |
| `agentScheduleCreate` | **none** (only `getAgentPrincipal`) | `manage_schedules` | **target** `target_conversation_id`'s workspace (default principal's) |
| `agentScheduleList` | **none** | — (`none-justified`: agent-self schedule introspection — see §3.2) | — |
| `agentScheduleCancel` | **none** | `manage_schedules` | **resolve schedule → target conversation's** workspace |

### 3.1 Finding — internal schedule routes ungated

The three **internal agent** schedule routes (`agentScheduleCreate/List/Cancel`,
`routes.ts:7321-7395`) have **no conversation or capability gate** — they validate input, take
`getAgentPrincipal`, and call `scheduleService` scoped only by `principal.agentId`. (Scope note,
Cindy `OmvweHtfw3hkwFB-` nit: this is the *internal agent* surface only — the public
`GET /api/agents/:id/schedules`, `routes.ts:4980`, IS gated `canViewAgent` + `canEditAgent`.) Full
scope brings create/cancel under `manage_schedules`; the drift test (§6) forces them to stay declared.

### 3.2 Schedule capability is not flat (Cindy `OmvweHtfw3hkwFB-` #4, `DSJLtPe7FkicAV0u` #2)

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

### 3.3 `agentListWorkspaces` is agent-self index, not `read_messages`

`agentListWorkspaces` (`routes.ts:6840`) gates only `canViewConversation(principal.conversationId)`
then returns the agent's **own** workspace memberships (`buildAgentListWorkspacesDto(agentId)`). Using
a single principal-workspace `read_messages` grant to authorize a global cross-workspace list is
arbitrary (Cindy `DSJLtPe7FkicAV0u` #1). It is declared `none-justified: agent-self workspace index` —
it enumerates the agent's own memberships (which the agent inherently knows), performs no per-workspace
action, and leaks nothing cross-workspace. If per-workspace visibility filtering is ever wanted, it
becomes a real cap then, via migration.

### 3.4 Enforcement contract (shiki-confirmed)

- **(a) Gate at the backend route, never the CLI** (`6IJ8Fh59Ah-pLxLQ`). The route resolves the
  target workspace (per the §3 Scope column) from the agent principal `(conversationId, agentId)` plus
  the request's target args, then looks up `workspace_agent_capabilities` → 403 on miss. CLI is a
  dumb shim — adding a capability never requires a CLI release; capability is enforced in exactly one
  place (no CLI/backend double-implementation drift).
- **(b) Revoke = route-entry check, no in-flight cancellation** (`6IJ8Fh59Ah-pLxLQ`). A request past
  the gate completes; the next 403s. Denial returns a **structured typed code** (Cindy
  `yEuiF91_55KTu-BH`): `{ code: 'capability_denied', capability: 'send_messages' }` — capability as
  its own field, never string-stuffed, so agent/CLI fallback can parse and degrade.

---

## 4. Capability check shape

Parallel to the existing `canX` family, but with an **explicit target scope** (Cindy
`OmvweHtfw3hkwFB-` #2 — the principal carries no workspace, and several routes are cross-workspace):

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

## 5. (reserved)

Ownership transfer is **out of scope for this round** (amendment 1) — no transfer design appears in
this document. Owner is set once at migration (§1.2).

---

## 6. Drift test — the load-bearing protection

Per Cindy (`x30tmJFBhD2cedlr` #6), worth more than per-route unit tests: it fails **when a future
route forgets to declare a capability**, not only on routes that exist today.

### 6.1 Two route registries (agent capability + human governance)

The agent axis is not the only half that drifts — Layer A also re-points `canMutateWorkspace` /
`canManageMembers`, so the **human governance routes** need the same protection (Cindy
`OmvweHtfw3hkwFB-` #3). Two declarative registries:

- **Agent-capability registry** — every `internalPaths.*` agent route → `{ agentCapability |
  'none-justified', scope }`. `'none-justified'` requires an inline reason (telemetry / agent-self
  profile).
- **Human-governance registry** — every public route that mutates workspace/membership/conversation
  governance → `{ minRole, roleScope: 'workspace' | 'conversation' }` (Cindy `DSJLtPe7FkicAV0u` #4 —
  carry `roleScope` from the start so channel-scoped governance §1.3 doesn't force a re-split later).
  `roleScope: 'workspace'` reads the workspace role (archive/delete, human roster, admin grant);
  `roleScope: 'conversation'` reads the **effective conversation role** = `override ?? workspace_role`
  (conversation member add, channel-scoped governance). Must cover at least: workspace update / archive
  / delete / pin; workspace human-member add/remove; workspace agent-member add/remove
  (`manage_workspace_agents`); channel create / archive / pin / delete; conversation member add.
  Without this, the human half drifts back to "any member can do anything" exactly as the agent half
  drifted to `canPostToConversation`.

### 6.2 Coverage test

Enumerate the mounted route table and assert **every** agent internal route appears in the agent-
capability registry, and **every** governance-mutating public route appears in the human-governance
registry, each with a non-empty declaration. A new route with no entry → fail. This is the gate that
stops regression back to a god-gate on either axis.

### 6.3 Cross-axis orthogonality test (the orthogonality proof)

The matrix plus explicit "one axis doesn't move the other":

1. workspace owner, not agent creator → mutate workspace/members; **cannot** edit agent profile.
2. agent creator who is an **ordinary workspace member** (not admin/owner) → edit agent; **cannot**
   archive/delete/rename workspace, manage members, or edit capabilities (those are admin+ per §1.1).
3. plain member → view/post (subject to membership); no destructive/admin; no agent edit.
4. agent-capability change → agent gains/loses that capability; **workspace role unchanged**.
   workspace-role change → governance changes; **agent capabilities unchanged**.

If 6.3 can't be written cleanly, helper naming or column design has re-merged the two owners — that
failure *is* the signal this round buys.

### 6.4 Naming discipline

Helpers/routes/tests for the two axes are named separately (Cindy `O21h_4ORtgSIg0C5`): workspace-role
helpers never reference agent capability and vice-versa. A reader must not be able to mistake the two
owners for one concept.

---

## 7. UI surface

Admin is hidden (amendment 4): owner is shown **read-only** and a newly added human defaults to
`member`; the UI offers no selector that can set someone to owner or admin, and admin grant/revoke
are NOT surfaced. Transfer is absent (amendment 1) — there is no owner-change entry at all.

**What shipped this round vs. what was intentionally not built is marked per bullet.** The reconciliation
reflects shiki's in-flight decisions during landing (`OkOt6hfWe1TkehYR`, `LaxSET_0ob_42pL8`).

- **Workspace settings → Permission (agent capability editor) — SHIPPED** (#task:937, `e8d768a`).
  `WorkspaceSettingsDialog` is a two-nav settings panel: "General" (existing name / working dir /
  archive / delete) and "Permission" (new). The Permission section: pick an agent via a selector
  (avatar + display name + `@handle`), then edit that agent's capability set. Buckets are presented in
  **functional groups** — Message / Task / Channel / Thread / Members / Attachments / Schedules. The
  grouping + labels are pure **UI metadata**; the leaf keys and the values PUT to the backend are the
  11 raw `AGENT_CAPABILITIES` keys (single source — no hand-written second list; a unit test asserts the
  groups cover exactly the 11 keys, no miss/dup). Save is **replace-set**: the full target set is sent
  in one PUT; failure (403 role gate / 400 unknown bucket / network) rolls back the local draft,
  refetches, and shows an error toast. "Cancel" discards the draft.
- **Role gate + members-response contract — SHIPPED** (#task:938, `d0ba757`). The editor is editable
  only for `owner`/`admin`; a `member` sees a **read-only** matrix (switches disabled, **not** hidden)
  plus a notice. The viewer's role is read from `GET /api/workspaces/:id/members`, which now returns
  **two layers of role, single-sourced** through one `workspaceRole()/getUserRole()` path (no second
  truth, no independent recompute):
  - `viewer_role: 'owner' | 'admin' | 'member' | null` — request-scoped **derived sugar** for the gate;
    lives on the members-response envelope, **not** on the persistent `WorkspaceDto`.
  - `human_members[]` upgraded from a bare `UserDto[]` to UserDto display fields **plus** membership
    fields (at least `role`, source `workspace_users.role`; may also carry `workspace_id/user_id/joined_at`)
    — role restored onto the membership edge, reusable by the future human role setting UI (§9).
- **Channel side — intentionally NOT built this round** (shiki `OkOt6hfWe1TkehYR`). Agent permission is
  edited **only** at the workspace layer. The channel surface carries **no** agent-permission entry, no
  read-only inheritance row, and no per-channel policy state — this avoids implying channels have their
  own permission layer and keeps the model clean for a future override. Channel-level agent permission
  is a deferred TODO (§9.1). (The dialog retains dormant deep-link props `initialSection` /
  `focusAgentId` / `highlightCapability` — zero render/cost when unset — so a future "jump straight to
  this agent's bucket" entry can plug in without reworking the editor.)
- **Denied agent actions — UI feedback NOT built this round** (shiki `LaxSET_0ob_42pL8`). The
  expectation is the **agent self-reports** the denial in chat. Verified live: a denied
  `silverhand thread create` returns `{ code: 'capability_denied', details: { capability }, retriable:
  false }` (exit 3), and the agent surfaces that as a participant — the human/agent-isomorphic path,
  better than an implicit editor alarm. This is **not** counted as a gap in the agent permission UI; a
  dedicated denial-visibility optimization is future work, at which point the deep-link seam above can
  be wired.
- **Workspace settings → Members (human role setting) — NOT built this round.** owner/admin/member are
  fully modeled in backend and `human_members[].role` is now exposed, but no human-role management UI
  ships (no grant/revoke, no member add/remove role surface, no transfer). Owner stays read-only and the
  UI only **consumes** `viewer_role` to gate the agent editor. Deferred TODO (§9.2).

---

## 8. Delivery layering (implementation only — design above is whole)

Three layers (shiki `W1urh64o2XkN82ki`), landed in order. **This channel lands `infra` first.**

### Layer A — infra (land first, here)

Pure mechanism. Shippable in steps that each leave the drift test green:

1. **Human role spine.** `workspaces.owner_user_id` + `workspace_users.role` columns + `workspaceRole`/
   `canGovernWorkspace` helpers; migration sets the single local human as owner (§1.2, no heuristic);
   re-point `canMutateWorkspace`/`canManageMembers` off `kind !== 'agent'` onto roles. Add the
   human-governance registry §6.1 + coverage. `admin` exists in schema/helpers/tests but no route
   mints one and UI doesn't surface it (amendment 4).
2. **Agent capability spine.** `workspace_agent_capabilities` table + `canAgentUseCapability(...,scope)`
   + per-route gating per §3 (with the Scope column) + seed-full migration (incl. `create_tasks`
   granted wherever `write_tasks` is) + typed `capability_denied` + agent-capability registry §6.1.
3. **Drift protection.** Both registries' coverage test §6.2 + cross-axis orthogonality test §6.3
   (in-scope cases 1-4).

**Behavior delta of Layer A: fully neutral on the current install.** One human → owner (keeps
everything); agent defaults = full set; `create_tasks` granted alongside existing `write_tasks`. The
only thing that changes is that the model becomes *expressible and tested* — a future second human
would join as `member` instead of implicit admin, which is the §0 hole being closed.

### Layer B — role design

Governance semantics on top of the infra spine: meaningful owner vs admin split in routes, agent
capability management rules (who edits what), channel-level role override (§1.3). This is where policy
choices land (e.g. should admin be able to remove an owner — no). Doc defines the boundary now;
implementation follows after infra is stable.

### Layer C — ui

Permission-edit surfaces (§7). **Shipped this round:** the workspace-level agent capability editor
(#task:937, `e8d768a`) + the members-response role-gate contract (#task:938, `d0ba757`). **Deferred
(§9):** the human role setting UI (owner/admin/member governance; admin grant/revoke stays hidden until
un-deferred), channel-level agent permission / channel override, and denied-action visibility — the
agent self-reports denials for now (§7). Admin grant/revoke stays hidden until explicitly un-deferred.

Phasing is a *delivery* choice; the **design is the full model above** and does not change between
layers.

---

## 9. TODO — deferred to future rounds

Tracked explicitly so the deferred surfaces are not forgotten. Each is designed in the model above but
intentionally not built this round.

### 9.1 Channel-level agent permission

Per-(channel, agent) capability **override** on top of the workspace-level effective set, plus the
channel UI to view/edit it. This round is workspace-only by decision (shiki `OkOt6hfWe1TkehYR`); the
channel surface deliberately holds **no** per-channel permission state, so this can be added on a clean
base. It is the agent-axis twin of the human-axis channel role override (§1.3) — the same
"conversation-scoped override" shape on the other axis. Design note: keep the workspace set as the base
and the channel row as a **sparse** override (absent = inherit), mirroring §1.3's `override ?? base`
resolution, so the two axes stay orthogonal and the drift test (§6) still holds.

### 9.2 Human role setting

The human-axis **role management UI** for workspace roles (`owner` / `admin` / `member`) — *not* a
human capability model; humans are governed by role, agents by capability (§0, the two-axis split).
The backend already models all three roles (`workspace_users.role`) and now exposes them via
`human_members[].role`; this TODO is the missing surface: admin grant/revoke, human member add/remove
with role, and — if/when un-deferred — owner transfer (currently out of scope, amendment 1). Today the
UI only **consumes** `viewer_role` to gate the agent editor and shows owner read-only. Must keep the two
axes separate (§6.4): the human role UI never edits agent capabilities and vice-versa.

### 9.3 Denied-action visibility (related, not a primary TODO)

A dedicated operator-facing surfacing of `capability_denied` events. For now the agent self-reports
denials in chat (§7); a future design may add explicit visibility and wire the dormant editor deep-link
seam (`focusAgentId` / `highlightCapability`) so a click jumps to the offending agent's missing bucket.

---

## Appendix — evidence anchors

- `permissions.ts:124-130` `canMutateWorkspace`; `:206-220` `canEditAgent`; `:155-161`
  `canViewConversation` user arm (membership gate).
- Agent principal shape `(conversationId, agentId)`, no workspace: `permissions.ts:33-39`.
- `workspaces` table has **no** creator/owner column: `migrations.ts:341-352`. `agents.created_by_user_id`
  exists; workspaces' does not.
- 22 internal agent route keys: `paths.ts:213` `internalPaths`. Registered `routes.ts:6604-7395`.
- Internal agent schedule routes ungated: `routes.ts:7321-7395`. Public schedule route gated
  (`canViewAgent` + `canEditAgent`): `routes.ts:4980`.
- Workspace member remove cascade (stop runtime + removeAgent): `routes.ts:2862-2880`.
