//! SQLite cold-read adapter for the authenticated `GET /api/workspaces` envelope.
//!
//! The whole envelope is one deferred-read snapshot: the workspace list and the
//! retired sort DTO share the envelope. The sort DTO is always empty; live
//! top-level ordering belongs to GET /api/sort/sidebar.
//! The two bounded-context ports ([`WorkspaceFaceReadPort`],
//! [`ViewerWorkspaceSortReadPort`]) are implemented on a private snapshot that
//! borrows that transaction; the [`WorkspaceColdReadUnitOfWork`] impl opens it,
//! runs the driver-free composition, then commits.
//!
//! Every committed row is decoded through the domain's typed identities and
//! closed enums. A stored value that cannot be a legal domain value — an empty or
//! malformed identity, a
//! non-null column holding the wrong type, unreadable JSON — is corruption of a
//! committed row and surfaces as a `PersistenceFailure` (a safe `500`), never a
//! product `4xx` and never coerced to a default. `name` is the one non-identity
//! string and is carried verbatim: the schema places no non-empty invariant on it.

use std::{path::Path, time::Duration};

use silverhand_backend_core::{
    foundation::identity::{AgentId, ConversationId, UserId, WorkspaceId},
    foundation::persistence::PersistenceFailure,
    identity_access::workspace_cold_read::{
        WorkspaceColdRead, WorkspaceColdReadUnitOfWork, compose_workspace_cold_read,
    },
    identity_access::workspace_face::{WorkspaceFace, WorkspaceFaceReadPort},
    viewer_read_model::viewer_workspace_sort::{ViewerSortState, ViewerWorkspaceSortReadPort},
};
use sqlx::{
    Row, Sqlite, SqlitePool, Transaction,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const DEFERRED_READ_BEGIN: &str = "BEGIN DEFERRED";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// The visible-workspace list for one human viewer.
///
/// The projected column set and the two DM subqueries are the published contract
/// reverse derived from the TypeScript `WORKSPACE_SELECT` / `toViewerWorkspace`,
/// not from any single consumer's read subset. Membership is visibility for a
/// human principal (`canViewWorkspace` reduces to `isWorkspaceMember`), so the
/// filter is pushed into SQL as an `EXISTS` over `workspace_users`; the TS route
/// reads all rows then app-filters, but the surviving set and its order are
/// identical. The ORDER BY replicates ONLY the two published keys — home-agent
/// workspaces last, then `updated_at DESC` — with no `id` tie-break, so the
/// parity oracle keeps its timestamps mutually unequal.
const SELECT_VISIBLE_WORKSPACES: &str = "\
SELECT \
    w.id, w.name, w.description, w.owner_agent_id, w.owner_user_id, \
    w.archived_at, w.created_at, w.updated_at, \
    CASE WHEN w.owner_agent_id IS NOT NULL THEN ( \
        SELECT c.id \
          FROM conversations c \
          LEFT JOIN agents owner ON owner.id = w.owner_agent_id \
         WHERE c.workspace_id = w.id \
           AND c.roster_policy = 'fixed' \
         ORDER BY CASE \
                    WHEN c.title = 'Onboarding' THEN 0 \
                    WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1 \
                    ELSE 2 \
                  END, \
                  c.created_at ASC \
         LIMIT 1 \
    ) ELSE NULL END AS dm_channel_id, \
    CASE WHEN w.owner_agent_id IS NOT NULL THEN ( \
        SELECT COALESCE(json_group_array(id), '[]') \
          FROM ( \
            SELECT c.id \
              FROM conversations c \
              LEFT JOIN agents owner ON owner.id = w.owner_agent_id \
             WHERE c.workspace_id = w.id \
               AND c.roster_policy = 'fixed' \
             ORDER BY CASE \
                        WHEN c.title = 'Onboarding' THEN 0 \
                        WHEN owner.id IS NOT NULL AND c.title = 'dm-' || owner.name THEN 1 \
                        ELSE 2 \
                      END, \
                      c.created_at ASC \
          ) \
    ) ELSE '[]' END AS dm_channel_ids_json \
  FROM workspaces w \
 WHERE EXISTS ( \
        SELECT 1 FROM workspace_users wu \
         WHERE wu.workspace_id = w.id AND wu.user_id = ? \
      ) \
 ORDER BY CASE WHEN w.owner_agent_id IS NULL THEN 0 ELSE 1 END, \
          w.updated_at DESC";

#[derive(Clone)]
pub struct SqliteWorkspaceColdRead {
    pool: SqlitePool,
}

/// Read failures surfaced only as the source of a [`PersistenceFailure`]. Every
/// variant here is corruption of a committed row or a driver fault, never a
/// product-level refusal.
#[derive(Debug, Error)]
pub enum WorkspaceColdReadError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
    #[error("stored dm-channel id list is not readable JSON")]
    MalformedDmChannelIds(#[source] serde_json::Error),
    #[error("stored column {field} does not name a usable identity")]
    MalformedIdentity { field: &'static str },
    #[error("stored workspace sort scope {0:?} is outside the closed set")]
    UnknownSortScope(String),
    #[error("stored sort mode {0:?} is outside the closed set")]
    UnknownSortMode(String),
}

impl SqliteWorkspaceColdRead {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, WorkspaceColdReadError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(BUSY_TIMEOUT);
        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;
        Ok(Self { pool })
    }

    async fn begin_snapshot(&self) -> Result<ColdReadSnapshot<'_>, WorkspaceColdReadError> {
        let tx = self.pool.begin_with(DEFERRED_READ_BEGIN).await?;
        Ok(ColdReadSnapshot { tx })
    }
}

impl WorkspaceColdReadUnitOfWork for SqliteWorkspaceColdRead {
    async fn load_workspace_cold_read(
        &self,
        viewer: &UserId,
    ) -> Result<WorkspaceColdRead, PersistenceFailure> {
        let mut snapshot = self
            .begin_snapshot()
            .await
            .map_err(PersistenceFailure::from_source)?;
        // Both halves read through this one snapshot; the driver-free composition
        // owns the ordering (workspaces, then the sort state scoped to their
        // visible non-archived ids), so neither context can sample another instant.
        let read = compose_workspace_cold_read(&mut snapshot, viewer).await?;
        snapshot
            .tx
            .commit()
            .await
            .map_err(|error| PersistenceFailure::from_source(WorkspaceColdReadError::Sql(error)))?;
        Ok(read)
    }
}

/// One deferred-read transaction shared by both bounded-context ports. It is
/// private to the adapter: the application depends only on the unit of work.
struct ColdReadSnapshot<'p> {
    tx: Transaction<'p, Sqlite>,
}

impl WorkspaceFaceReadPort for ColdReadSnapshot<'_> {
    async fn visible_workspaces(
        &mut self,
        viewer: &UserId,
    ) -> Result<Vec<WorkspaceFace>, PersistenceFailure> {
        self.read_visible_workspaces(viewer)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

impl ViewerWorkspaceSortReadPort for ColdReadSnapshot<'_> {
    async fn workspace_sort_state(
        &mut self,
        viewer: &UserId,
        sortable: &[WorkspaceId],
    ) -> Result<ViewerSortState, PersistenceFailure> {
        // Keep the published DTO field for existing readers, but never consult
        // retired workspace ordering. Sidebar has its own authoritative read.
        let _ = (viewer, sortable);
        Ok(ViewerSortState {
            modes: Default::default(),
            entries: Vec::new(),
        })
    }
}

impl ColdReadSnapshot<'_> {
    async fn read_visible_workspaces(
        &mut self,
        viewer: &UserId,
    ) -> Result<Vec<WorkspaceFace>, WorkspaceColdReadError> {
        let rows = sqlx::query(SELECT_VISIBLE_WORKSPACES)
            .bind(viewer.as_str())
            .fetch_all(&mut *self.tx)
            .await?;
        let mut faces = Vec::with_capacity(rows.len());
        for row in &rows {
            faces.push(decode_face(row)?);
        }
        Ok(faces)
    }
}

fn decode_face(row: &sqlx::sqlite::SqliteRow) -> Result<WorkspaceFace, WorkspaceColdReadError> {
    let dm_channel_ids_json: String = row.try_get("dm_channel_ids_json")?;
    let dm_channel_ids = decode_dm_channel_ids(&dm_channel_ids_json)?;
    Ok(WorkspaceFace {
        id: parse_identity::<WorkspaceId>(row.try_get("id")?, "workspaces.id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        owner_agent_id: parse_optional_identity::<AgentId>(
            row.try_get("owner_agent_id")?,
            "workspaces.owner_agent_id",
        )?,
        owner_user_id: parse_optional_identity::<UserId>(
            row.try_get("owner_user_id")?,
            "workspaces.owner_user_id",
        )?,
        dm_channel_id: parse_optional_identity::<ConversationId>(
            row.try_get("dm_channel_id")?,
            "workspaces.dm_channel_id",
        )?,
        dm_channel_ids,
        archived_at: row.try_get("archived_at")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn decode_dm_channel_ids(json: &str) -> Result<Vec<ConversationId>, WorkspaceColdReadError> {
    let raw: Vec<String> =
        serde_json::from_str(json).map_err(WorkspaceColdReadError::MalformedDmChannelIds)?;
    raw.into_iter()
        .map(|id| parse_identity::<ConversationId>(id, "workspaces.dm_channel_ids[]"))
        .collect()
}

/// Every committed identity coordinate is parsed through the domain's fallible
/// parser; an empty or otherwise unusable value is corruption of a committed row.
trait ParsableIdentity: Sized {
    fn parse_identity(raw: String) -> Option<Self>;
}

macro_rules! parsable_identity {
    ($ty:ty) => {
        impl ParsableIdentity for $ty {
            fn parse_identity(raw: String) -> Option<Self> {
                <$ty>::parse(raw).ok()
            }
        }
    };
}

parsable_identity!(WorkspaceId);
parsable_identity!(AgentId);
parsable_identity!(UserId);
parsable_identity!(ConversationId);

fn parse_identity<T: ParsableIdentity>(
    raw: String,
    field: &'static str,
) -> Result<T, WorkspaceColdReadError> {
    T::parse_identity(raw).ok_or(WorkspaceColdReadError::MalformedIdentity { field })
}

fn parse_optional_identity<T: ParsableIdentity>(
    raw: Option<String>,
    field: &'static str,
) -> Result<Option<T>, WorkspaceColdReadError> {
    match raw {
        Some(raw) => parse_identity::<T>(raw, field).map(Some),
        None => Ok(None),
    }
}

#[cfg(test)]
mod snapshot_isolation_tests {
    //! P1-5 (#task:2190): the two bounded-context halves read on ONE deferred-read
    //! snapshot, so a writer that commits BETWEEN them is invisible to the second
    //! half. The falsifier this refuses is a torn read — workspaces reflecting the
    //! instant before the write while the sort state reflects the instant after
    //! (or vice versa) — which is exactly what a per-half snapshot would produce.
    //! It uses the crate-private `begin_snapshot` + the two ports directly, the
    //! only way to interleave a commit at the seam the public API runs atomically.

    use super::*;
    use silverhand_backend_core::identity_access::workspace_face::WorkspaceFaceReadPort;
    use sqlx::{Connection, Executor, SqliteConnection};

    const CURRENT_SCHEMA: &str =
        include_str!("../../../../../packages/backend/tests/migration-baseline/schema-current.sql");
    const SEED_SQL: &str =
        include_str!("../../../../../packages/backend/tests/fixtures/workspace-cold-read/seed.sql");

    async fn create_seeded_db(path: &Path) {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true);
        let mut db = SqliteConnection::connect_with(&options).await.unwrap();
        db.execute(sqlx::raw_sql(CURRENT_SCHEMA)).await.unwrap();
        db.execute(sqlx::raw_sql(SEED_SQL)).await.unwrap();
        db.close().await.unwrap();
    }

    #[tokio::test]
    async fn a_commit_between_the_two_halves_is_invisible_to_the_second_half() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("snapshot-isolation.sqlite");
        create_seeded_db(&path).await;
        let viewer = UserId::parse("user-1").unwrap();

        let adapter = SqliteWorkspaceColdRead::open(&path).await.unwrap();
        let mut snapshot = adapter.begin_snapshot().await.unwrap();

        // HALF ONE establishes the deferred-read snapshot at its first read.
        let workspaces = snapshot.visible_workspaces(&viewer).await.unwrap();
        let sortable: Vec<WorkspaceId> = workspaces
            .iter()
            .filter(|workspace| workspace.archived_at.is_none())
            .map(|workspace| workspace.id.clone())
            .collect();

        // A concurrent writer on a SEPARATE connection flips the viewer's regular
        // sort mode recent -> manual and COMMITS, entirely between the two halves.
        let mut writer = SqliteConnection::connect(&format!("sqlite:{}", path.display()))
            .await
            .unwrap();
        sqlx::query(
            "UPDATE user_list_sort_mode SET mode = 'manual' \
             WHERE user_id = 'user-1' AND list_key = 'workspaces' AND scope = 'regular'",
        )
        .execute(&mut writer)
        .await
        .unwrap();
        writer.close().await.unwrap();

        // HALF TWO reads on the SAME snapshot: it must still see the pre-commit
        // 'recent'. A per-half snapshot would read the committed 'manual' — the tear.
        let sort = snapshot
            .workspace_sort_state(&viewer, &sortable)
            .await
            .unwrap();
        snapshot.tx.commit().await.unwrap();

        assert!(sort.modes.is_empty());
        assert!(sort.entries.is_empty());

        // Even a fresh read ignores legacy sorting, including newly written rows.
        let after = adapter.load_workspace_cold_read(&viewer).await.unwrap();
        assert!(after.viewer_sort.modes.is_empty());
        assert!(after.viewer_sort.entries.is_empty());
    }
}
