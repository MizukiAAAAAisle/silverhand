//! SQLite adapter for agent workspace enrollment.
//!
//! Unlike the foundation proof store, this is a **pure consumer** of an existing
//! product database: it opens a pool against a schema that already exists and
//! creates, migrates, or seeds no schema of its own. It therefore never takes
//! over a database's schema identity — it only reads the `agents` row and writes
//! the `workspace_members` / `workspace_agent_capabilities` edges the product
//! schema already defines.
//!
//! The whole enrollment is one `BEGIN IMMEDIATE` transaction. The membership
//! insert is `INSERT OR IGNORE`, so a re-enrollment is a no-op on the row;
//! `created` is read from that insert's own affected-row count, and the
//! create-only capability seed runs only when it created the row. The join-time
//! candidate is *not* sampled here — the application samples its clock after
//! authorization and hands the candidate in, so a re-enrollment keeps the stored
//! value and the time source stays in the application. Every driver error is
//! handed to the port's caller as the source of a `PersistenceFailure`; nothing
//! is logged here.

use std::time::{SystemTime, UNIX_EPOCH};
use std::{path::Path, time::Duration};

use silverhand_backend_core::access::{
    AddHumanMemberError, AgentAuthorityFacts, AgentEnrollmentReadPort, AgentEnrollmentUnitOfWork,
    AgentId, AgentWorkspaceMembership, Capability, EnrollmentClock, EnrollmentKey,
    HumanEnrollmentCommit, HumanEnrollmentKey, HumanEnrollmentReadPort, HumanEnrollmentUnitOfWork,
    HumanUser, Principal, UserId, WorkspaceRole, WorkspaceUserMembership,
    human_enrollment_authorized,
};
use silverhand_backend_core::persistence::PersistenceFailure;
use sqlx::{
    SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
};
use thiserror::Error;

const ROOT_WRITE_BEGIN: &str = "BEGIN IMMEDIATE";
const POOL_CONNECTIONS: u32 = 4;
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

const SELECT_AGENT_AUTHORITY: &str = "SELECT created_by_user_id FROM agents WHERE id = ?";
const INSERT_MEMBERSHIP: &str =
    "INSERT OR IGNORE INTO workspace_members (workspace_id, agent_id, joined_at) VALUES (?, ?, ?)";
const SELECT_MEMBERSHIP_JOINED_AT: &str =
    "SELECT joined_at FROM workspace_members WHERE workspace_id = ? AND agent_id = ?";
const INSERT_CAPABILITY: &str = "INSERT OR IGNORE INTO workspace_agent_capabilities \
     (workspace_id, agent_id, capability) VALUES (?, ?, ?)";

// Human enrollment writes the `workspace_users` roster row rather than
// `workspace_members`. The actor's role is re-read under the same lock to
// re-derive governance; the target row is `INSERT OR IGNORE`d at the default
// `member` role and then re-read, so a re-enrollment keeps the original role
// (possibly `owner`) and join time.
const SELECT_WORKSPACE_USER_ROLE: &str =
    "SELECT role FROM workspace_users WHERE workspace_id = ? AND user_id = ?";
const INSERT_HUMAN_MEMBERSHIP: &str = "INSERT OR IGNORE INTO workspace_users \
     (workspace_id, user_id, joined_at, role) VALUES (?, ?, ?, 'member')";
const SELECT_HUMAN_MEMBERSHIP: &str =
    "SELECT joined_at, role FROM workspace_users WHERE workspace_id = ? AND user_id = ?";
const SELECT_USER: &str = "SELECT id, name, display_name, avatar_storage_key, created_at, \
     updated_at FROM users WHERE id = ?";

/// A pooled connection to an existing product database, offering only the
/// agent-enrollment ports. It holds no clock: the join-time candidate is passed
/// into the unit of work by the application, which owns the time source.
#[derive(Clone)]
pub struct SqliteAccessStore {
    pool: SqlitePool,
}

/// The production [`EnrollmentClock`]: the host wall clock, read once by the
/// application before the write transaction opens.
///
/// It matches `Date.now()` for every reachable time and never fails. A time at
/// or after the Unix epoch yields a positive millisecond count; a pre-epoch host
/// clock yields a *negative* one (as `Date.now()` returns for dates before 1970)
/// rather than a faked zero or a refusal; and only a time beyond the `i64`
/// millisecond range — hundreds of millions of years out, unreachable in
/// practice — saturates to the nearest bound instead of wrapping. Reading the
/// clock is therefore not a failure mode, so this surface never emits a `500`
/// the product route could not.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl EnrollmentClock for SystemClock {
    fn now_unix_millis(&self) -> i64 {
        unix_millis(SystemTime::now())
    }
}

/// The signed, saturating Unix-millisecond conversion behind [`SystemClock`],
/// split out as a pure function of its input so the epoch, pre-epoch and
/// overflow edges are pinned by fixed-input tests rather than the wall clock.
fn unix_millis(now: SystemTime) -> i64 {
    match now.duration_since(UNIX_EPOCH) {
        // At or after the epoch: a positive count, saturating only past i64::MAX.
        Ok(elapsed) => i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX),
        // Before the epoch: a negative count, saturating only past i64::MIN.
        Err(before) => match i64::try_from(before.duration().as_millis()) {
            Ok(millis) => -millis,
            Err(_) => i64::MIN,
        },
    }
}

/// Startup and driver failures, surfaced only to the composition root that opens
/// the store. The ports below hand the driver error over as a source instead.
#[derive(Debug, Error)]
pub enum SqliteAccessStoreError {
    #[error("database operation failed")]
    Sql(#[from] sqlx::Error),
}

/// A `workspace_users.role` value outside the schema's `CHECK` set. Committed
/// rows cannot hold one, so this is a persistence-integrity fault surfaced as the
/// source of a [`PersistenceFailure`] — never silently coerced to a default.
#[derive(Debug, Error)]
#[error("workspace_users.role holds an unrecognized value: {0}")]
struct CorruptRoleToken(String);

/// The internal outcome of the human-enrollment transaction. `Forbidden` is the
/// in-lock authority refusal (a rollback), kept distinct from the driver
/// failures so the port maps it to the typed [`AddHumanMemberError::Forbidden`]
/// rather than a `500`.
enum HumanEnrollFailure {
    Forbidden,
    Sql(sqlx::Error),
    CorruptRole(String),
}

impl From<sqlx::Error> for HumanEnrollFailure {
    fn from(error: sqlx::Error) -> Self {
        Self::Sql(error)
    }
}

impl SqliteAccessStore {
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, SqliteAccessStoreError> {
        Self::open_with_busy_timeout(path, BUSY_TIMEOUT).await
    }

    /// Opens the pool as a consumer: `create_if_missing` is off, so a database
    /// that has never been migrated is a hard open error rather than a silently
    /// created empty file this adapter has no schema to fill.
    pub async fn open_with_busy_timeout(
        path: impl AsRef<Path>,
        busy_timeout: Duration,
    ) -> Result<Self, SqliteAccessStoreError> {
        let options = SqliteConnectOptions::new()
            .filename(path.as_ref())
            .create_if_missing(false)
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            // An acknowledged enrollment must survive power loss, so WAL runs with
            // FULL — NORMAL would let a recently acknowledged transaction roll back.
            .synchronous(SqliteSynchronous::Full)
            .busy_timeout(busy_timeout);

        let pool = SqlitePoolOptions::new()
            .max_connections(POOL_CONNECTIONS)
            .connect_with(options)
            .await?;

        Ok(Self { pool })
    }

    async fn agent_authority(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<AgentAuthorityFacts>, SqliteAccessStoreError> {
        let created_by: Option<String> = sqlx::query_scalar(SELECT_AGENT_AUTHORITY)
            .bind(agent_id.as_str())
            .fetch_optional(&self.pool)
            .await?;
        Ok(created_by.map(|user_id| AgentAuthorityFacts {
            id: agent_id.clone(),
            created_by_user_id: UserId::new(user_id),
        }))
    }

    #[tracing::instrument(skip(self, seed_on_create))]
    async fn enroll_agent_transaction(
        &self,
        key: EnrollmentKey,
        seed_on_create: &[Capability],
        joined_at_candidate: i64,
    ) -> Result<AgentWorkspaceMembership, SqliteAccessStoreError> {
        // Reserve the single writer before the first statement, so a concurrent
        // enrollment of the same pair serializes here rather than interleaving.
        let mut tx = self.pool.begin_with(ROOT_WRITE_BEGIN).await?;

        let insert = sqlx::query(INSERT_MEMBERSHIP)
            .bind(key.workspace_id.as_str())
            .bind(key.agent_id.as_str())
            .bind(joined_at_candidate)
            .execute(&mut *tx)
            .await?;
        let created = insert.rows_affected() == 1;

        // Seed capabilities only when this transaction created the membership, so
        // re-enrolling a member whose set was later narrowed never re-widens it.
        if created {
            for capability in seed_on_create {
                sqlx::query(INSERT_CAPABILITY)
                    .bind(key.workspace_id.as_str())
                    .bind(key.agent_id.as_str())
                    .bind(capability.as_str())
                    .execute(&mut *tx)
                    .await?;
            }
        }

        // On a re-enrollment the ignored insert kept the original, so the value
        // returned is always re-read from the row, never the candidate binding.
        let stored_joined_at: i64 = sqlx::query_scalar(SELECT_MEMBERSHIP_JOINED_AT)
            .bind(key.workspace_id.as_str())
            .bind(key.agent_id.as_str())
            .fetch_one(&mut *tx)
            .await?;

        tx.commit().await?;

        Ok(AgentWorkspaceMembership {
            workspace_id: key.workspace_id,
            agent_id: key.agent_id,
            joined_at_ms: stored_joined_at,
        })
    }

    async fn user_record(
        &self,
        user_id: &UserId,
    ) -> Result<Option<HumanUser>, SqliteAccessStoreError> {
        let row: Option<(String, String, String, Option<String>, i64, i64)> =
            sqlx::query_as(SELECT_USER)
                .bind(user_id.as_str())
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(
            |(id, name, display_name, avatar_storage_key, created_at, updated_at)| {
                // Mirror `principalAvatarUrl`: a present, non-empty storage key
                // yields a versioned avatar path, otherwise there is no avatar.
                let avatar_url = match avatar_storage_key {
                    Some(ref key) if !key.is_empty() => {
                        Some(format!("/api/users/{id}/avatar?v={updated_at}"))
                    }
                    _ => None,
                };
                HumanUser {
                    id: UserId::new(id),
                    name,
                    display_name,
                    avatar_url,
                    created_at,
                    updated_at,
                }
            },
        ))
    }

    #[tracing::instrument(skip(self))]
    async fn enroll_human_transaction(
        &self,
        key: HumanEnrollmentKey,
        actor: Principal,
        joined_at_candidate: i64,
    ) -> Result<HumanEnrollmentCommit, HumanEnrollFailure> {
        // Reserve the single writer before the first statement, so the actor's
        // authority is re-read and the roster row written under one lock.
        let mut tx = self.pool.begin_with(ROOT_WRITE_BEGIN).await?;

        // In-lock authority re-derivation. Only a human principal has a role row
        // to read; `system` and an agent principal are decided by the rule
        // without one. A demotion that committed after the boundary gate is
        // visible here, so the write refuses instead of enrolling on stale
        // authority.
        let actor_role = if let Principal::Human { user_id } = &actor {
            let token: Option<String> = sqlx::query_scalar(SELECT_WORKSPACE_USER_ROLE)
                .bind(key.workspace_id.as_str())
                .bind(user_id.as_str())
                .fetch_optional(&mut *tx)
                .await?;
            match token {
                Some(token) => Some(
                    WorkspaceRole::parse(&token).ok_or(HumanEnrollFailure::CorruptRole(token))?,
                ),
                None => None,
            }
        } else {
            None
        };
        if !human_enrollment_authorized(&actor, actor_role) {
            // Dropping the transaction rolls it back; nothing was written.
            return Err(HumanEnrollFailure::Forbidden);
        }

        let insert = sqlx::query(INSERT_HUMAN_MEMBERSHIP)
            .bind(key.workspace_id.as_str())
            .bind(key.user_id.as_str())
            .bind(joined_at_candidate)
            .execute(&mut *tx)
            .await?;
        let created = insert.rows_affected() == 1;

        // Re-read the row: a re-enrollment kept the original role and join time,
        // so the member is never assumed from the candidate or the default.
        let (stored_joined_at, role_token): (i64, String) = sqlx::query_as(SELECT_HUMAN_MEMBERSHIP)
            .bind(key.workspace_id.as_str())
            .bind(key.user_id.as_str())
            .fetch_one(&mut *tx)
            .await?;
        let role =
            WorkspaceRole::parse(&role_token).ok_or(HumanEnrollFailure::CorruptRole(role_token))?;

        tx.commit().await?;

        Ok(HumanEnrollmentCommit {
            member: WorkspaceUserMembership {
                workspace_id: key.workspace_id,
                user_id: key.user_id,
                joined_at_ms: stored_joined_at,
                role,
            },
            created,
        })
    }
}

impl AgentEnrollmentReadPort for SqliteAccessStore {
    async fn agent(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<AgentAuthorityFacts>, PersistenceFailure> {
        self.agent_authority(agent_id)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

impl AgentEnrollmentUnitOfWork for SqliteAccessStore {
    async fn enroll_agent(
        &self,
        key: EnrollmentKey,
        seed_on_create: &[Capability],
        joined_at_candidate: i64,
    ) -> Result<AgentWorkspaceMembership, PersistenceFailure> {
        // The driver error is handed over as the source; the refusal is not
        // logged here — the boundary that renders it owns that record.
        self.enroll_agent_transaction(key, seed_on_create, joined_at_candidate)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

impl HumanEnrollmentReadPort for SqliteAccessStore {
    async fn user(&self, user_id: &UserId) -> Result<Option<HumanUser>, PersistenceFailure> {
        self.user_record(user_id)
            .await
            .map_err(PersistenceFailure::from_source)
    }
}

impl HumanEnrollmentUnitOfWork for SqliteAccessStore {
    async fn enroll_human(
        &self,
        key: HumanEnrollmentKey,
        actor: Principal,
        joined_at_candidate: i64,
    ) -> Result<HumanEnrollmentCommit, AddHumanMemberError> {
        // The in-lock authority refusal is a typed `Forbidden`; every driver
        // fault (and the unreachable corrupt-role case) is handed over as the
        // source of a `PersistenceFailure` and rendered as a safe `500`. Nothing
        // is logged here — the boundary that renders it owns that record.
        self.enroll_human_transaction(key, actor, joined_at_candidate)
            .await
            .map_err(|failure| match failure {
                HumanEnrollFailure::Forbidden => AddHumanMemberError::Forbidden,
                HumanEnrollFailure::Sql(error) => {
                    AddHumanMemberError::Persistence(PersistenceFailure::from_source(error))
                }
                HumanEnrollFailure::CorruptRole(token) => AddHumanMemberError::Persistence(
                    PersistenceFailure::from_source(CorruptRoleToken(token)),
                ),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::unix_millis;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn the_epoch_maps_to_zero() {
        assert_eq!(unix_millis(UNIX_EPOCH), 0);
    }

    #[test]
    fn a_time_after_the_epoch_is_a_positive_millisecond_count() {
        let now = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(unix_millis(now), 1_700_000_000_123);
    }

    #[test]
    fn a_pre_epoch_time_is_negative_never_a_faked_zero() {
        let before = UNIX_EPOCH
            .checked_sub(Duration::from_millis(1500))
            .expect("platform represents pre-epoch instants");
        assert_eq!(
            unix_millis(before),
            -1500,
            "a pre-1970 clock must read negative, exactly as Date.now() does"
        );
    }

    #[test]
    fn a_time_beyond_the_i64_millisecond_range_saturates_rather_than_wrapping() {
        let far_future = UNIX_EPOCH
            .checked_add(Duration::from_millis(u64::MAX))
            .expect("platform represents far-future instants");
        assert_eq!(unix_millis(far_future), i64::MAX);
    }
}
