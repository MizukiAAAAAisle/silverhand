# PR-6 Design Draft: Per-agent `agent_home` workspace

Status: **draft r3** — addresses Cindy's r2 blockers; migration mechanism
verified empirically against better-sqlite3@11.10 / SQLite 3.49.

## Goal (unchanged)

Replace global `SYSTEM_DM_WORKSPACE_ID` with **one `agent_home`
workspace per agent**, lifecycle-coupled to the agent (FK CASCADE on
removal). Out of scope: archive/tombstone for retired-agent DMs.

## Migration mechanism (B1 — verified)

### What I tested (better-sqlite3 11.10, SQLite 3.49.2)
On both isolated and v15-shaped DBs (workspaces + conversations +
messages + saved_messages + notifications + workspace_members all
chained by FK), I verified:
- `legacy_alter_table = ON` **alone** does NOT prevent SQLite's
  smart-rename from rewriting child FK clauses (`REFERENCES p` →
  `REFERENCES "p_old"`). Cindy was right.
- `foreign_keys = OFF` **alone** also doesn't help — RENAME still
  rewrites; later DROP cascades wipe child rows; subsequent INSERTs
  on children fail with `no such table: p_old`.
- **Both pragmas together** preserve the original child FK clauses:
  `foreign_keys = OFF` (set OUTSIDE the txn — the pragma is a no-op
  inside one) PLUS `legacy_alter_table = ON` (set inside the txn is
  fine).

End-to-end mock of v16 against a v15-shaped DB: 2 workspaces (1
regular + global system_dm) × 4 conversations × 3 messages × 2
saved × 2 notifications × 2 workspace_members → migration → 3
workspaces (1 regular + 2 agent_home) with all child rows preserved
and re-parented; `PRAGMA foreign_key_check` returns `[]`. Subsequent
`DELETE FROM agents WHERE id='a1'` correctly cascades through
`agent_home → conversations → messages` with the regular workspace's
data untouched. Partial unique index allows `name='engineering'` to
coexist as one regular + one agent_home but rejects two regulars.

### Required runner change (small, opt-in per migration)

`packages/shared/src/db/migrations.ts` — extend `Migration`:
```ts
export interface Migration {
  version: number;
  up: string;
  foreignKeyEscape?: true;   // new optional flag for v16 only
}
```
`packages/backend/src/db.ts` — branch in `runMigrations`:
```ts
for (const m of pending) {
  if (m.foreignKeyEscape) {
    // Both pragmas are connection-level and persist across txns; the
    // runner owns set + restore so escape-mode never leaks into the
    // next migration or any other DDL on this connection. The body
    // is pure DDL/DML.
    db.pragma('foreign_keys = OFF');                       // outside txn (no-op inside)
    db.pragma('legacy_alter_table = ON');
    try {
      db.transaction(() => {
        db.exec(m.up);
        // foreign_key_check INSIDE the txn — failure throws → both
        // body and _migrations row roll back atomically. Putting it
        // outside the txn would leave a half-broken db with the
        // version recorded as committed.
        const v = db.pragma('foreign_key_check') as unknown[];
        if (v.length) {
          throw new Error(
            `migration v${m.version}: foreign_key_check found ${v.length} violations: ${JSON.stringify(v)}`,
          );
        }
        insertMigration.run(m.version);
      })();
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  } else {
    db.transaction(() => { db.exec(m.up); insertMigration.run(m.version); })();
  }
}
```
Per-migration opt-in escape hatch, scoped strictly to one migration's
execution. All other migrations keep today's behavior.

### v16 migration body (single SQL string, `foreignKeyEscape: true`)

The runner sets `foreign_keys=OFF` + `legacy_alter_table=ON` around
this body — the SQL is pure DDL/DML.

```sql
-- (1) rebuild workspaces
ALTER TABLE workspaces RENAME TO workspaces_legacy_v16;
CREATE TABLE workspaces (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  workspace_kind      TEXT NOT NULL CHECK (workspace_kind IN ('regular','agent_home')),
  workspace_path      TEXT NOT NULL,
  workspace_host_id   TEXT NOT NULL REFERENCES hosts(id),
  owner_agent_id      TEXT UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  archived_at         INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (
    (workspace_kind='agent_home' AND owner_agent_id IS NOT NULL) OR
    (workspace_kind='regular'    AND owner_agent_id IS NULL)
  )
);
CREATE UNIQUE INDEX workspaces_regular_name_unique
  ON workspaces(name) WHERE workspace_kind = 'regular';

-- (2) regular rows
INSERT INTO workspaces
  (id, name, description, workspace_kind, workspace_path,
   workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
SELECT id, name, description, 'regular', workspace_path,
       workspace_host_id, NULL, archived_at, created_at, updated_at
  FROM workspaces_legacy_v16
 WHERE workspace_kind = 'regular';

-- (3) agent_home rows derived from agents that own at least one
-- dm_channel today. DEDUPE BY AGENT — an agent may have multiple
-- dm_channels (primary `dm-<agent>` + lazy `Mentions` from
-- mention-cc.ts); they all collapse into ONE agent_home.
INSERT INTO workspaces
  (id, name, description, workspace_kind, workspace_path,
   workspace_host_id, owner_agent_id, archived_at, created_at, updated_at)
SELECT 'wsah_'||a.id, a.name, 'Personal home workspace for '||a.name,
       'agent_home',
       (SELECT c.workspace_path FROM conversations c
         JOIN conversation_agents ca ON ca.conversation_id = c.id
         WHERE c.kind = 'dm_channel'
           AND c.workspace_id = '__system_dm_workspace__'
           AND ca.agent_id = a.id
         ORDER BY c.created_at ASC LIMIT 1),
       a.host_id, a.id, NULL,
       a.created_at, a.created_at
  FROM agents a
 WHERE EXISTS (
   SELECT 1 FROM conversations c
   JOIN conversation_agents ca ON ca.conversation_id = c.id
   WHERE c.kind = 'dm_channel'
     AND c.workspace_id = '__system_dm_workspace__'
     AND ca.agent_id = a.id
 );

-- (4) re-parent dm_channel
UPDATE conversations
   SET workspace_id =
     'wsah_' || (SELECT ca.agent_id FROM conversation_agents ca
                  WHERE ca.conversation_id = conversations.id LIMIT 1)
 WHERE kind = 'dm_channel' AND workspace_id = '__system_dm_workspace__';

-- (5) re-parent threads under those dm_channels
UPDATE conversations
   SET workspace_id = (SELECT root.workspace_id FROM conversations root
                        WHERE root.id = conversations.parent_conversation_id)
 WHERE kind = 'thread' AND workspace_id = '__system_dm_workspace__';

-- (6) retag messages.task_workspace_id
UPDATE messages
   SET task_workspace_id = (SELECT c.workspace_id FROM conversations c
                             WHERE c.id = messages.conversation_id)
 WHERE task_workspace_id = '__system_dm_workspace__';

-- (7) retag saved_messages.workspace_id
UPDATE saved_messages
   SET workspace_id = (SELECT c.workspace_id FROM messages m
                        JOIN conversations c ON c.id = m.conversation_id
                       WHERE m.id = saved_messages.message_id)
 WHERE workspace_id = '__system_dm_workspace__';

-- (8) retag notifications.workspace_id
UPDATE notifications
   SET workspace_id = (SELECT c.workspace_id FROM conversations c
                        WHERE c.id = notifications.conversation_id)
 WHERE workspace_id = '__system_dm_workspace__';
-- (if notifications.source_workspace_id exists, repeat with similar subquery)

-- (9) drop legacy table; legacy table still has the orphan global
-- row but no FK references it (legacy_alter_table=ON kept child FK
-- clauses pointing at "workspaces", which is now the new table).
DROP TABLE workspaces_legacy_v16;
```

The runner runs `PRAGMA foreign_key_check` post-commit and fails the
migration loudly if any reference dangles.

## API / DTO surface (B2 — precision)

### `WorkspaceDto`
- `workspace_kind: 'regular' | 'agent_home'`
- `owner_agent_id: string | null` (null for regular, set for agent_home)
- `dm_channel_id: string | null` — populated **only** for agent_home;
  points to the **primary** dm_channel (the original `dm-<agent>`
  created at agent-provision time). Filled via subquery in
  `WorkspaceRepo.list/get`:
  ```sql
  SELECT
    w.*,
    CASE WHEN w.workspace_kind = 'agent_home' THEN (
      SELECT c.id FROM conversations c
       WHERE c.workspace_id = w.id AND c.kind = 'dm_channel'
       ORDER BY c.created_at ASC, c.id ASC      -- oldest = primary
       LIMIT 1
    ) ELSE NULL END AS dm_channel_id
  FROM workspaces w
  ```

> **Invariant relaxation (r3-impl-amendment from Cindy)**: the
> original "agent_home has exactly one dm_channel" was wrong against
> live data. `mention-cc.ts` lazily creates a secondary `Mentions`
> dm_channel per agent. Final invariant is:
>
> - **agent_home is per-agent unique** (enforced by `owner_agent_id
>   UNIQUE`).
> - **agent_home contains one PRIMARY dm_channel** (the original
>   `dm-<agent>`, oldest by `created_at`) PLUS zero-or-more
>   secondary dm_channels (e.g. Mentions). All siblings share the
>   same agent_home.
> - `WorkspaceDto.dm_channel_id` returns the primary; `GET
>   /api/workspaces/:id/channels` for an agent_home returns ALL
>   dm_channels under that home (renderer treats them as
>   channel-likes).
>
> This avoids a high-risk Mentions→primary message merge migration
> and preserves the existing UI separation.

### Channels endpoint (`GET /api/workspaces/:id/channels`)
- Branch by workspace_kind in the route handler, NOT by relaxing the
  repo filter. Per Cindy: `listChannelsForWorkspace` keeps its strict
  `kind='channel'` semantics; introduce a sibling
  `listDmChannelsForWorkspace(workspaceId): ConversationDto[]`
  (returns all dm_channels under the workspace, ordered by
  `created_at ASC` so the primary `dm-<agent>` comes first).
  Route:
  ```ts
  app.get('/api/workspaces/:id/channels', c => {
    const ws = workspaces.get(c.req.param('id'));
    if (!ws) return c.json({error:'workspace not found'}, 404);
    if (ws.workspace_kind === 'regular') {
      return c.json({ channels: conversations.listChannelsForWorkspace(ws.id) });
    }
    // agent_home: returns the primary dm_channel + any secondaries
    // (Mentions, future per-feature dms) as channel-likes.
    return c.json({ channels: conversations.listDmChannelsForWorkspace(ws.id) });
  });
  ```
  Response shape stays `{ channels: ChannelLikeDto[] }`; renderer
  doesn't have to discriminate beyond reading `kind`.
- **Response type**: introduce `ChannelLikeDto = ChannelDto |
  DmChannelDto` (TS union) on the shared DTO so the renderer accepts
  both shapes without a new branch.

### Routes removed
`DELETE /api/workspaces/system/dm-channels`. Renderer hits
`/api/workspaces` (now returns regular + agent_home with
`dm_channel_id` embedded for the latter).

## Storage kind vs UI/search kind separation (B3)

Per Cindy: the DB-level `workspace_kind` becomes `regular |
agent_home`; the UI / search surface continues to expose `regular |
dm` (no UX rename in this PR). **`WorkspaceDto` does NOT gain a new
`kind` field** — that would create two truths on one DTO. Projection
happens at the consumer:

- `WorkspaceDto.workspace_kind: 'regular' | 'agent_home'` is storage
  truth, the only kind field on the DTO.
- Frontend mapper `workspaceToListItem()` projects to
  `WorkspaceListItem.kind = 'regular' | 'dm'` (today's mapping
  changes from `workspace_kind === 'system_dm' → 'dm'` to
  `workspace_kind === 'agent_home' → 'dm'` — one-line edit).
- `SearchWorkspaceRef.kind` keeps its existing `regular | dm` shape;
  the search-repo projection updates the same way.
- Agent-facing APIs / MCP tools that need DM-vs-regular distinction
  read `workspace_kind === 'agent_home'` directly — no new field
  needed.

### Mapping point
`shared/api/dto.ts`:
```ts
// Storage / DB truth
export const WorkspaceKindSchema = z.enum(['regular','agent_home']);
// (no new `kind` field on WorkspaceDto)
```
Renderer mapper continues to produce `WorkspaceListItem.kind`; only
the source check flips from `'system_dm'` to `'agent_home'`.

## Repo / lifecycle / projection cleanup (carries from r2)

### Membership vs ownership semantics

`workspace_members` is **regular-only** by invariant. agent_home
workspaces never get rows in `workspace_members`; the agent's
relationship to its home is expressed solely via
`workspaces.owner_agent_id` (1:1, UNIQUE FK CASCADE).

Defense-in-depth: add a guard trigger so an accidental insertion
fails loudly:
```sql
CREATE TRIGGER workspace_members_no_agent_home
BEFORE INSERT ON workspace_members
WHEN (SELECT workspace_kind FROM workspaces WHERE id = NEW.workspace_id) = 'agent_home'
BEGIN
  SELECT RAISE(ABORT, 'workspace_members rows must reference regular workspaces only');
END;
```

`WorkspaceRepo.listForAgent(agentId)` returns BOTH relationships in
one ordered list (regular memberships first, then the agent's home):
```sql
SELECT w.* FROM workspaces w
JOIN workspace_members wm ON wm.workspace_id = w.id
WHERE wm.agent_id = ? AND w.workspace_kind = 'regular'
ORDER BY w.name COLLATE NOCASE
UNION ALL
SELECT w.* FROM workspaces w
WHERE w.owner_agent_id = ? AND w.workspace_kind = 'agent_home';
```
Renderer discriminates by `workspace_kind` — same row shape, no
union type.

Delete-impact preview (`computeAgentDeleteImpact(agentId)`):
```ts
{
  regular_memberships: WorkspaceDto[];   // workspaces this agent will leave (regular)
  owned_home: WorkspaceDto | null;       // the agent's agent_home (cascades)
  dm_channel: DmChannelSummary | null;   // for backwards-compatible UI copy
  attachments_count: number;             // best-effort sweep estimate
}
```
The `dm_channel` field is kept so the existing confirm-dialog copy
stays working ("you will lose 12 saved messages, 3 task threads...");
it's derived from `owned_home → its single dm_channel`.

Runtime table (`AgentRuntimeTable`): group by `workspace_kind`. Today
it lumps DM rows into a single "Direct Messages" header by checking
`workspace_kind === 'system_dm'`; after PR-6 it groups by
`workspace_kind === 'agent_home'` (one section per agent, since each
agent has exactly one home, but the renderer can present them
together).

- `workspace-repo.ts`: drop `SYSTEM_DM_WORKSPACE_ID` constant +
  `ensureSystemDmWorkspace`. Add `insertAgentHome(...)`,
  `findAgentHome(agentId)`, `getAgentHomeByOwner(agentId)`. `list()`
  / `listForAgent` filter expands to `IN ('regular','agent_home')`,
  ordered regular first then agent_home (Cindy Q2). `insert()` (regular
  path) rejects `workspace_path` under `<silverhandDir>/agents/`
  (Cindy Q1).
- `task-service.ts` SELECT: collapse the `dm_channel` CASE branches to
  `COALESCE(m.task_workspace_id, conv.workspace_id)` and `w.name`.
- Provisioning (Cindy Q4): `agents.create + workspaces.insertAgentHome
  + conversations.insertDmChannel + conversations.addAgent +
  messages.insertForConversation` all inside one
  `db.transaction(...)`; deliver/start/mkdir post-commit (idempotent).
- Agent DELETE (B6 from r1): keep `attachmentService.sweepForChannel`
  before `DELETE FROM agents`. Cindy verified Q5: AttachmentService
  resolves thread uploads to parent dm_channel, so a single
  `sweepForChannel(dm.id)` covers thread attachments. Add one
  regression test confirming this.

### Other repos with DM/system_dm references (carries from r2)

`search-repo.ts` / `saved-message-repo.ts` / `notification-repo.ts` /
`conversation-read-repo.ts` / `App.tsx unread summary` /
`features/workspaces/hooks.ts` / `EventsApp.tsx` /
`AgentRuntimeTable.tsx` / `DeleteAgentDialog.tsx`: all special-cases
become natural after the migration. Cleanup:
- Replace `workspace_kind === 'system_dm'` with the appropriate check
  for each call site:
  - storage-aware site → `workspace_kind === 'agent_home'`
  - UI projection site → `WorkspaceListItem.kind === 'dm'` /
    `SearchWorkspaceRef.kind === 'dm'` (each consumer projects
    locally; `WorkspaceDto` itself does NOT carry a UI `kind` field)
- Drop the `root.kind === 'dm_channel' → root.id` projections; use
  natural `workspace_id`.

## Test plan

**Migration v16 (vitest, runs migration runner end-to-end):**
- Seed db at v15 with: N agents, dm_channel + thread + tasks + saved
  + notifications under SYSTEM_DM_WORKSPACE_ID, plus a regular
  workspace with own data. Run runMigrations → assert N agent_home
  rows; conversations re-parented; messages/saved/notifications all
  retagged; no row anywhere references `__system_dm_workspace__`;
  `foreign_key_check` empty; partial unique allows
  `name='alice'` regular + `name='alice'` agent_home, rejects two
  regulars; subsequent `DELETE FROM agents WHERE id=…` cascades
  agent_home → dm_channel → messages without touching the regular
  workspace's data.
- **Multi-DM regression**: seed an agent with TWO dm_channels under
  the global system_dm workspace (primary `dm-alice` + secondary
  `Mentions`). Migration produces exactly ONE agent_home (no PK or
  UNIQUE violation); both dm_channels are re-parented to the same
  home; `WorkspaceDto.dm_channel_id` returns the older one (primary);
  `GET /api/workspaces/<wsah_alice>/channels` returns both
  dm_channels ordered by created_at ASC.

**Runner escape branch (vitest, isolated):**
- Test that on success, `legacy_alter_table` and `foreign_keys` are
  both restored to OFF / ON respectively after the migration. Inspect
  via `db.pragma('legacy_alter_table')` and `db.pragma('foreign_keys')`.
- Test rollback: seed a `foreignKeyEscape` migration whose body
  intentionally leaves a dangling FK reference. After invoking
  `runMigrations`, assert: it threw, `_migrations` does NOT have a
  row for that version, the schema/data is unchanged, and the two
  pragmas are still restored to OFF / ON (finally clause runs).

**Provision/route:**
- `POST /api/agents` — exactly one agent_home created with right
  owner, txn rollback on midway failure leaves no orphan.
- `DELETE /api/agents/:id` — `sweepForChannel(dm.id)` runs before
  DB delete; thread attachments included in the sweep (Cindy Q5
  regression).
- `GET /api/workspaces/:id/channels` — works for both kinds; agent_home
  returns the single dm_channel.
- `GET /api/workspaces` — returns both kinds; no row has
  `workspace_kind === 'system_dm'`.

**Repo:**
- `findAgentHome`, `getAgentHomeByOwner` correct.
- Workspace `name` partial unique semantics verified.
- Workspace path validation rejects `<silverhandDir>/agents/*`.

**Service / projection cleanup:**
- TaskService 384 cases stay green after the SELECT collapse.
- Search / saved / notification: at least one assertion per scope
  that DM-originated rows roll up under the agent_home id.
- DTO regression: every agent_home row has
  `WorkspaceDto.workspace_kind === 'agent_home'` and `dm_channel_id`
  populated. UI projection regression: frontend
  `workspaceToListItem()` maps each agent_home row to
  `WorkspaceListItem.kind === 'dm'`; search-repo's
  `SearchWorkspaceRef.kind === 'dm'` for the same row. (No `kind`
  field on the wire `WorkspaceDto`.)

**Frontend smoke (manual, dev session):**
- DM workspace list renders identical to today (agent_home → kind=dm
  in DTO).
- Clicking an agent_home navigates into its dm_channel via
  `dm_channel_id`.
- Unread aggregation matches today's behavior.

## Slicing decision (unchanged)

Single PR. The runner change + migration + repo + DTO + projection
cleanup are tightly coupled.

## Open Questions — all resolved

- Q1 ✅ regular workspace path validation rejects `<silverhandDir>/agents/*`.
- Q2 ✅ regular first then agent_home; renderer regroups.
- Q3 ✅ no DB tombstone; `WorkspaceKindSchema` drops `'system_dm'`
  in this PR. `WorkspaceDto` keeps a single kind field
  (`workspace_kind: 'regular' | 'agent_home'`); UI/search
  `kind: regular|dm` projection happens in renderer mapper +
  search repo, not on the wire DTO (avoids two-truth on one DTO).
- Q4 ✅ create txn covers DB writes; deliver/start/mkdir post-commit.
- Q5 ✅ (Cindy) `AttachmentService.upload` resolves thread →
  parent dm_channel; `sweepForChannel(dm.id)` covers thread
  attachments. Add one regression.

No new open questions. Implementation can start once Cindy r3-OKs.
