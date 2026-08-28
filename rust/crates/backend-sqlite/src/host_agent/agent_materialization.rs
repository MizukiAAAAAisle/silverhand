//! The SQLite adapter for the agent-materialization lifecycle: the reserve INSERT, the
//! two failure compare-and-sets, the reopen compare-and-set, and the crash-recovery bulk
//! fail — each under the store's single-writer reservation.
//!
//! This adapter WITNESSES; it never mints the domain verdict. Every write projects the
//! row it actually touched from its own `RETURNING` clause and hands it back for the core
//! free functions to bind and seal. A guarded compare-and-set that changed no row returns
//! `None` (→ `Lost`); the reserve reports [`ReserveRecord::ConstraintConflict`] from an
//! in-transaction preflight — under the store's single-writer reservation, before the
//! INSERT — of the shared @-handle namespace and the per-creator idempotency key. The
//! preflight, not a driver error kind, is the conflict authority: the two collisions the
//! reserve could hit (the handle uniqueness — including the cross-namespace user/agent
//! trigger that surfaces as an opaque `SQLITE_CONSTRAINT_TRIGGER`, not a unique violation —
//! and the per-creator `idempotency_key` index) both fold into one honest fact, and any
//! error the INSERT itself raises after a clean preflight is a hard fault, not a product
//! answer. There is no activate write here — see the core module docs.

use silverhand_backend_core::{
    agent_materialization::{
        ActivatedAgent, ActivationFlipRow, AgentArmActivation, AgentArmProvisioned,
        AgentMaterializationLookup, AgentMaterializationWrite, IdempotentReservationRow,
        MaterializationFault, MaterializationFlipRow, ReserveAgentInput, ReserveRecord,
        ReservedAgentRow, STALE_MATERIALIZATION_FAILED_CODE,
    },
    agents::session_scope::AgentSessionScope,
    identity::{AgentId, ConversationId, UserId},
    messaging::{
        DirectPairMintIdentityMismatch, DirectPairOpenedFact, DirectPairOpenedPort,
        DirectPairParticipants, MessageId, OpenDirectPairError, ParticipantHandle,
        PrincipalIdentity,
        agent_onboarding::{OnboardingSystemMessage, render_direct_line_body},
    },
    persistence::PersistenceFailure,
};
use sqlx::{Row, SqliteConnection, sqlite::SqliteRow};

use super::store::SqliteHostAgentStore;

/// Insert a fresh `pending_materialization` row and return the columns the domain seals
/// its committed identity against. `display_name` seeds from the handle, matching the
/// TypeScript `reserveForMaterialize`.
const RESERVE_INSERT: &str = "INSERT INTO agents \
        (id, name, display_name, runtime, model, reasoning_effort, fast_mode, \
         host_id, description, session_scope, created_by_user_id, \
         materialization_status, idempotency_key, created_at, updated_at) \
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_materialization', ?, ?, ?) \
    RETURNING id, name, display_name, runtime, model, reasoning_effort, fast_mode, \
              host_id, description, session_scope, created_by_user_id, \
              materialization_status, idempotency_key, created_at, updated_at";

/// Whether a reservation already exists for this `(creator, idempotency_key)` pair — the
/// per-creator half of the reserve preflight, mirroring the partial unique index
/// `idx_agents_idempotency_key_per_user`. Bound with a concrete non-null key, so it never
/// matches the `WHERE idempotency_key IS NOT NULL` rows the index ignores.
const IDEMPOTENCY_TAKEN: &str = "SELECT EXISTS(SELECT 1 FROM agents \
     WHERE created_by_user_id = ? AND idempotency_key = ?)";

/// `pending|failed → failed`, stamping the typed code and timestamp. The status guard is
/// the sole eligibility gate; `active` is deliberately unmatched (a live row's failure
/// surface is destructive delete, not an in-place flip).
const FAIL_CAS: &str = "UPDATE agents \
        SET materialization_status = 'failed', \
            materialization_failed_code = ?, \
            materialization_failed_at = ?, \
            updated_at = ? \
      WHERE id = ? \
        AND materialization_status IN ('pending_materialization', 'failed') \
    RETURNING id, materialization_status, materialization_failed_code, \
              materialization_failed_at, updated_at";

/// `failed → pending_materialization`, clearing the failure columns so a later failure
/// writes a fresh stamp. Strictly `failed`-guarded: pending and active are unmatched.
const REOPEN_CAS: &str = "UPDATE agents \
        SET materialization_status = 'pending_materialization', \
            materialization_failed_code = NULL, \
            materialization_failed_at = NULL, \
            updated_at = ? \
      WHERE id = ? \
        AND materialization_status = 'failed' \
    RETURNING id, materialization_status, materialization_failed_code, \
              materialization_failed_at, updated_at";

/// Crash recovery: fail every row still pending and created strictly before the cutoff,
/// stamping the canonical code, and return the rows it touched. `active`/`failed` rows are
/// unmatched.
const MARK_STALE_FAILED: &str = "UPDATE agents \
        SET materialization_status = 'failed', \
            materialization_failed_code = ?, \
            materialization_failed_at = ?, \
            updated_at = ? \
      WHERE materialization_status = 'pending_materialization' \
        AND created_at < ? \
    RETURNING id, materialization_status, materialization_failed_code, \
              materialization_failed_at, updated_at";

/// Read the row for a `(created_by_user_id, idempotency_key)` pair. The creator and key
/// ride the row's OWN columns so the domain can bind them against the request; the `WHERE`
/// is this adapter's implementation, not the port contract.
const FIND_BY_IDEMPOTENCY: &str = "SELECT id, created_by_user_id, idempotency_key, \
            materialization_status, materialization_failed_code, materialization_failed_at, \
            name, runtime, model, description, host_id, session_scope \
       FROM agents \
      WHERE created_by_user_id = ? \
        AND idempotency_key = ?";

/// The stored `fast_mode` boolean as its `0`/`1`/null column, matching the
/// `fast_mode === undefined ? null : fast_mode ? 1 : 0` the TypeScript reserve applies.
fn fast_mode_column(fast_mode: Option<bool>) -> Option<i64> {
    fast_mode.map(|on| if on { 1 } else { 0 })
}

/// Project the reserve after-image from its `RETURNING` row covering every inserted
/// column. The `AgentId` is decoded from the row's OWN `id`, never the query parameter;
/// the typed columns (runtime, host, session scope, creator, fast_mode) ride back raw for
/// the domain to parse and bind.
fn reserved_agent_row(row: &SqliteRow) -> Result<ReservedAgentRow, sqlx::Error> {
    Ok(ReservedAgentRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        name: row.try_get::<String, _>("name")?,
        display_name: row.try_get::<String, _>("display_name")?,
        runtime: row.try_get::<String, _>("runtime")?,
        model: row.try_get::<Option<String>, _>("model")?,
        reasoning_effort: row.try_get::<Option<String>, _>("reasoning_effort")?,
        fast_mode: row.try_get::<Option<i64>, _>("fast_mode")?,
        host_id: row.try_get::<String, _>("host_id")?,
        description: row.try_get::<Option<String>, _>("description")?,
        session_scope: row.try_get::<String, _>("session_scope")?,
        created_by_user_id: row.try_get::<String, _>("created_by_user_id")?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        idempotency_key: row.try_get::<Option<String>, _>("idempotency_key")?,
        created_at: row.try_get::<i64, _>("created_at")?,
        updated_at: row.try_get::<i64, _>("updated_at")?,
    })
}

/// Project a flip after-image from its `RETURNING` row.
fn flip_row(row: &SqliteRow) -> Result<MaterializationFlipRow, sqlx::Error> {
    Ok(MaterializationFlipRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        materialization_failed_code: row
            .try_get::<Option<String>, _>("materialization_failed_code")?,
        materialization_failed_at: row.try_get::<Option<i64>, _>("materialization_failed_at")?,
        updated_at: row.try_get::<i64, _>("updated_at")?,
    })
}

/// Project a lookup witness. Identity columns are decoded fail-closed; the creator, key,
/// status, and runtime are carried raw for the domain to bind and parse.
fn idempotent_reservation_row(row: &SqliteRow) -> Result<IdempotentReservationRow, sqlx::Error> {
    Ok(IdempotentReservationRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        created_by_user_id: row.try_get::<String, _>("created_by_user_id")?,
        idempotency_key: row.try_get::<Option<String>, _>("idempotency_key")?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        materialization_failed_code: row
            .try_get::<Option<String>, _>("materialization_failed_code")?,
        materialization_failed_at: row.try_get::<Option<i64>, _>("materialization_failed_at")?,
        name: row.try_get::<String, _>("name")?,
        runtime: row.try_get::<String, _>("runtime")?,
        model: row.try_get::<Option<String>, _>("model")?,
        description: row.try_get::<Option<String>, _>("description")?,
        host_id: row.try_get::<String, _>("host_id")?,
        session_scope: row.try_get::<String, _>("session_scope")?,
    })
}

impl AgentMaterializationLookup for SqliteHostAgentStore {
    async fn find_by_idempotency(
        &self,
        creator: &UserId,
        key: &silverhand_backend_core::agent_materialization::IdempotencyKey,
    ) -> Result<Option<IdempotentReservationRow>, PersistenceFailure> {
        let row = sqlx::query(FIND_BY_IDEMPOTENCY)
            .bind(creator.as_str())
            .bind(key.as_str())
            .fetch_optional(self.pool())
            .await
            .map_err(PersistenceFailure::from_source)?;
        match row {
            Some(row) => Ok(Some(
                idempotent_reservation_row(&row).map_err(PersistenceFailure::from_source)?,
            )),
            None => Ok(None),
        }
    }
}

impl AgentMaterializationWrite for SqliteHostAgentStore {
    async fn reserve(
        &self,
        input: &ReserveAgentInput,
        now_ms: i64,
    ) -> Result<ReserveRecord, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        // Preflight both uniqueness axes under the write reservation, before the INSERT.
        // The shared-handle check reuses the one canonical namespace predicate, so it also
        // catches the cross-namespace user/agent collision the trigger would otherwise
        // raise as an opaque constraint error. A hit rolls back as the transaction drops.
        if crate::handle_namespace::handle_taken(&mut *tx, input.name.as_str())
            .await
            .map_err(PersistenceFailure::from_source)?
        {
            return Ok(ReserveRecord::ConstraintConflict);
        }
        let idempotency_taken: i64 = sqlx::query_scalar(IDEMPOTENCY_TAKEN)
            .bind(input.created_by_user_id.as_str())
            .bind(input.idempotency_key.as_str())
            .fetch_one(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        if idempotency_taken != 0 {
            return Ok(ReserveRecord::ConstraintConflict);
        }

        let attempted = sqlx::query(RESERVE_INSERT)
            .bind(input.agent_id.as_str())
            .bind(input.name.as_str())
            .bind(input.name.as_str())
            .bind(input.runtime.as_str())
            .bind(input.model.as_deref())
            .bind(input.reasoning_effort.as_deref())
            .bind(fast_mode_column(input.fast_mode))
            .bind(input.host_id.as_str())
            .bind(input.description.as_deref())
            .bind(input.session_scope.as_str())
            .bind(input.created_by_user_id.as_str())
            .bind(input.idempotency_key.as_str())
            .bind(now_ms)
            .bind(now_ms)
            .fetch_optional(&mut *tx)
            .await;

        match attempted {
            Ok(Some(row)) => {
                let witness = reserved_agent_row(&row).map_err(PersistenceFailure::from_source)?;
                tx.commit().await.map_err(PersistenceFailure::from_source)?;
                Ok(ReserveRecord::Inserted(Box::new(witness)))
            }
            // An `INSERT ... RETURNING` that inserts a row always returns it; no row means
            // a broken invariant, not a product answer.
            Ok(None) => Err(PersistenceFailure::from_source(ReserveReturnedNoRow)),
            // The preflight already folded the two honest conflicts into
            // `ConstraintConflict`; any error the INSERT raises now is a hard fault, never a
            // product answer, and the transaction drops without a commit.
            Err(error) => Err(PersistenceFailure::from_source(error)),
        }
    }

    async fn fail(
        &self,
        agent: &AgentId,
        failed_code: &str,
        failed_at: i64,
        now_ms: i64,
    ) -> Result<Option<MaterializationFlipRow>, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let returned = sqlx::query(FAIL_CAS)
            .bind(failed_code)
            .bind(failed_at)
            .bind(now_ms)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let witness = match returned {
            Some(row) => Some(flip_row(&row).map_err(PersistenceFailure::from_source)?),
            None => None,
        };
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(witness)
    }

    async fn reopen_failed(
        &self,
        agent: &AgentId,
        now_ms: i64,
    ) -> Result<Option<MaterializationFlipRow>, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let returned = sqlx::query(REOPEN_CAS)
            .bind(now_ms)
            .bind(agent.as_str())
            .fetch_optional(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let witness = match returned {
            Some(row) => Some(flip_row(&row).map_err(PersistenceFailure::from_source)?),
            None => None,
        };
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(witness)
    }

    async fn mark_stale_failed(
        &self,
        cutoff_created_at: i64,
        failed_at: i64,
        now_ms: i64,
    ) -> Result<Vec<MaterializationFlipRow>, PersistenceFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        let returned = sqlx::query(MARK_STALE_FAILED)
            .bind(STALE_MATERIALIZATION_FAILED_CODE)
            .bind(failed_at)
            .bind(now_ms)
            .bind(cutoff_created_at)
            .fetch_all(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        let mut rows = Vec::with_capacity(returned.len());
        for row in &returned {
            rows.push(flip_row(row).map_err(PersistenceFailure::from_source)?);
        }
        tx.commit().await.map_err(PersistenceFailure::from_source)?;
        Ok(rows)
    }
}

/// A reserve `INSERT ... RETURNING` that reported success but handed back no row — a broken
/// SQLite invariant the boundary surfaces as a safe `500`, never a product answer.
#[derive(Debug, thiserror::Error)]
#[error("reserve insert returned no row")]
struct ReserveReturnedNoRow;

/// The activation flip: `pending_materialization → active`, strictly pending-guarded and
/// stamping the request clock, returning the after-image the domain seals its identity
/// against. `active`/`failed`/absent rows are unmatched, so a guard miss changes no row —
/// the flip that fires FIRST inside the provisioning transaction and, when it does not win,
/// means nothing has been written. The `RETURNING` carries the OWN id, handle, scope, and
/// creator the dependent graph is provisioned against, never the query parameters.
const FLIP_TO_ACTIVE: &str = "UPDATE agents \
        SET materialization_status = 'active', \
            updated_at = ? \
      WHERE id = ? \
        AND materialization_status = 'pending_materialization' \
    RETURNING id, name, session_scope, created_by_user_id, materialization_status, updated_at";

/// Read the creator's handle from its OWN `users` row, bound to the id the activation flip
/// proved. Reads `name`, the canonical @-handle every principal is addressed by; an absent
/// row is a broken FK invariant the provisioning unit of work surfaces as a fault.
const READ_CREATOR_HANDLE: &str = "SELECT name FROM users WHERE id = ?";

/// Project the activation flip after-image from its `RETURNING` row. The `AgentId` is
/// decoded from the row's OWN `id`; the handle, scope, and creator ride back raw for the
/// domain ([`ActivatedAgent::seal`]) to parse and bind.
fn activation_flip_row(row: &SqliteRow) -> Result<ActivationFlipRow, sqlx::Error> {
    Ok(ActivationFlipRow {
        agent_id: super::decode::agent_id(row.try_get::<String, _>("id")?)?,
        name: row.try_get::<String, _>("name")?,
        materialization_status: row.try_get::<String, _>("materialization_status")?,
        session_scope: row.try_get::<String, _>("session_scope")?,
        created_by_user_id: row.try_get::<String, _>("created_by_user_id")?,
        updated_at: row.try_get::<i64, _>("updated_at")?,
    })
}

/// Run the guarded activation flip on the caller's connection, inside its transaction.
/// `None` means the guarded CAS changed no row (absent, already `active`, or `failed`): the
/// caller has written nothing and rolls back without compensating.
async fn flip_to_active_on(
    conn: &mut SqliteConnection,
    agent: &AgentId,
    now_ms: i64,
) -> Result<Option<ActivationFlipRow>, PersistenceFailure> {
    let returned = sqlx::query(FLIP_TO_ACTIVE)
        .bind(now_ms)
        .bind(agent.as_str())
        .fetch_optional(&mut *conn)
        .await
        .map_err(PersistenceFailure::from_source)?;
    match returned {
        Some(row) => Ok(Some(
            activation_flip_row(&row).map_err(PersistenceFailure::from_source)?,
        )),
        None => Ok(None),
    }
}

/// Read the creator's handle on the caller's connection. `None` means no user row bears the
/// creator id the flip proved — a broken FK invariant, which the provisioning unit of work
/// maps to a fault rather than a product answer.
async fn read_creator_handle_on(
    conn: &mut SqliteConnection,
    creator: &UserId,
) -> Result<Option<String>, PersistenceFailure> {
    sqlx::query_scalar::<_, String>(READ_CREATOR_HANDLE)
        .bind(creator.as_str())
        .fetch_optional(&mut *conn)
        .await
        .map_err(PersistenceFailure::from_source)
}

/// Records whether the direct-pair open announced a freshly minted line, deriving
/// `pair_created` from the fact rather than a second read. `open_direct_pair` announces only
/// on a fresh mint, so a captured fact means this open created the line; a get-or-create that
/// resolved an existing one leaves the flag unset. The announcement itself is deferred to the
/// route/mount slice, so the port only records — it never fails.
#[derive(Default)]
struct RecordingDirectPairOpened {
    captured: std::sync::atomic::AtomicBool,
}

impl RecordingDirectPairOpened {
    fn pair_created(&self) -> bool {
        self.captured.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl DirectPairOpenedPort for RecordingDirectPairOpened {
    type Error = std::convert::Infallible;

    async fn direct_pair_opened(&self, _fact: &DirectPairOpenedFact) -> Result<(), Self::Error> {
        self.captured
            .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

/// Activate an agent-scoped reservation and provision its dependent graph under ONE
/// transaction on the caller's connection.
///
/// The flip fires FIRST: a guard miss (`None`) means nothing has been written, so the caller
/// rolls back and does NOT compensate — the flip returns [`AgentArmActivation::Lost`]. A won
/// flip seals into an [`ActivatedAgent`] whose identity columns come from the write's own
/// after-image, and the graph is named from THAT, never from values a caller recited: the
/// direct line between the agent and its creator (get-or-create, so a concurrent reopen that
/// already opened it resolves rather than conflicts), and the onboarding system message on
/// that line. A dependent-write failure surfaces as a [`MaterializationFault`] — NOT `Lost` —
/// so the caller can tell a win-then-fail (roll back, then stamp the compensating fail in a
/// SEPARATE transaction) from a lost flip (roll back, no compensation).
///
/// The ids the graph mints — the candidate conversation and the onboarding message — are the
/// caller's to supply, so entropy stays outside the transaction and this unit of work is a
/// deterministic function of the reservation it activates. Marked dead in the non-test build
/// until its production consumer lands with the create route's conversation-scope arm; the
/// attribute is a live root, so every helper it reaches stays live too.
#[cfg_attr(not(test), allow(dead_code))]
async fn provision_agent_arm_on(
    conn: &mut SqliteConnection,
    agent: &AgentId,
    candidate_conversation: ConversationId,
    onboarding_message_id: MessageId,
    now_ms: i64,
) -> Result<AgentArmActivation, MaterializationFault> {
    let Some(flip) = flip_to_active_on(conn, agent, now_ms).await? else {
        return Ok(AgentArmActivation::Lost);
    };
    let activated = ActivatedAgent::seal(agent, now_ms, flip)?;

    // This helper provisions the agent arm; the conversation arm is a different dependent
    // graph and a different unit of work. Reaching here with any other scope is a broken
    // invariant, not a product answer.
    if activated.session_scope() != AgentSessionScope::Agent {
        return Err(MaterializationFault::ProvisioningInvariant {
            reason: "agent-arm provisioning sealed a non-agent session scope",
        });
    }

    let creator_handle_raw = read_creator_handle_on(conn, activated.created_by_user_id())
        .await?
        .ok_or(MaterializationFault::ProvisioningInvariant {
            reason: "activation creator names no user row to greet on the direct line",
        })?;
    // The stored handle crosses from agent-identity vocabulary into message addressing here;
    // both grammars are the one @-handle grammar, so a re-parse only fails on a stored value
    // that is not addressable at all — a broken invariant, not a caller mistake.
    let creator_handle = ParticipantHandle::parse(creator_handle_raw).map_err(|_| {
        MaterializationFault::ProvisioningInvariant {
            reason: "activation creator's stored handle is not addressable",
        }
    })?;
    let agent_handle = ParticipantHandle::parse(activated.name().as_str()).map_err(|_| {
        MaterializationFault::ProvisioningInvariant {
            reason: "activated agent's stored handle is not addressable",
        }
    })?;

    // Both endpoints ride the identities the flip and the creator read proved; the ordering
    // is the domain's business. Distinct kinds, so the same-participant guard is a structural
    // invariant here rather than a caller mistake.
    let participants = DirectPairParticipants::between(
        PrincipalIdentity::Human(activated.created_by_user_id().clone()),
        PrincipalIdentity::Agent(activated.agent_id().clone()),
    )
    .map_err(|_| MaterializationFault::ProvisioningInvariant {
        reason: "activation direct line would name a single principal twice",
    })?;

    let recorder = RecordingDirectPairOpened::default();
    let direct_line = crate::messaging::open_direct_pair_on(
        conn,
        candidate_conversation,
        &recorder,
        participants,
        now_ms,
    )
    .await
    .map_err(|error| match error {
        OpenDirectPairError::Mint(failure) => MaterializationFault::Persistence(failure),
        OpenDirectPairError::Identity(DirectPairMintIdentityMismatch) => {
            MaterializationFault::ProvisioningInvariant {
                reason: "direct-pair mint selected endpoints differ from the agent and creator",
            }
        }
        OpenDirectPairError::Announcement(never) => match never {},
    })?;

    let body = render_direct_line_body(&agent_handle, &creator_handle);
    let intent =
        OnboardingSystemMessage::new(direct_line.clone(), onboarding_message_id, body, now_ms);
    crate::messaging::append_onboarding_system_message_on(conn, &intent).await?;

    Ok(AgentArmActivation::Provisioned(
        AgentArmProvisioned::committed(
            activated.agent_id().clone(),
            direct_line,
            intent.id().clone(),
            recorder.pair_created(),
        ),
    ))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use silverhand_backend_core::{
        agent_lifecycle::MaterializationStatus,
        agent_materialization::{
            DEPENDENT_GRAPH_FAILED_CODE, FailOutcome, IdempotencyKey, ReopenOutcome,
            ReserveOutcome, fail_materialization, find_idempotent_reservation,
            mark_stale_materializations_failed, reopen_failed_materialization, reserve_agent,
        },
        agents::runtime::RuntimeKind,
        agents::session_scope::AgentSessionScope,
        identity::HostId,
        user_identity::ParticipantHandle,
    };
    use tempfile::TempDir;

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn idem(key: &str) -> IdempotencyKey {
        IdempotencyKey::parse(key).expect("idempotency key")
    }

    async fn seed_schema(dir: &TempDir, name: &str, seed: &[String]) -> PathBuf {
        let path = dir.path().join(name);
        let mut connection = crate::current_schema::create_current_schema(&path).await;
        for statement in seed {
            sqlx::query(sqlx::AssertSqlSafe(statement.as_str()))
                .execute(&mut connection)
                .await
                .expect("seed statement");
        }
        use sqlx::Connection;
        connection.close().await.expect("close seed connection");
        path
    }

    const USER: &str = "INSERT INTO users (id, name, display_name, created_at, updated_at) \
         VALUES ('u1', 'u1', 'U1', 1, 1)";
    const HOST: &str =
        "INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'h1', 'local', 1)";

    /// Seed one agent row in an arbitrary status with the given create timestamp and key.
    fn seed_agent(
        id: &str,
        status: &str,
        created_at: i64,
        idempotency_key: Option<&str>,
    ) -> String {
        let key = match idempotency_key {
            Some(k) => format!("'{k}'"),
            None => "NULL".to_string(),
        };
        format!(
            "INSERT INTO agents \
             (id, name, display_name, runtime, host_id, created_by_user_id, created_at, \
              updated_at, materialization_status, session_scope, idempotency_key) \
             VALUES ('{id}', '{id}', '{id}', 'claude', 'h1', 'u1', {created_at}, {created_at}, \
                     '{status}', 'conversation', {key})"
        )
    }

    fn base_seed() -> Vec<String> {
        vec![USER.to_string(), HOST.to_string()]
    }

    fn input(id: &str, key: &str) -> ReserveAgentInput {
        ReserveAgentInput {
            agent_id: agent(id),
            name: ParticipantHandle::parse(id).unwrap(),
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(true),
            host_id: HostId::parse("h1").unwrap(),
            description: Some("d".to_string()),
            session_scope: AgentSessionScope::Conversation,
            created_by_user_id: user("u1"),
            idempotency_key: idem(key),
        }
    }

    #[tokio::test]
    async fn reserve_inserts_a_pending_row_and_seals_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "reserve.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let ReserveOutcome::Reserved(reserved) = reserve_agent(&store, &input("a1", "idem-1"), 42)
            .await
            .unwrap()
        else {
            panic!("expected a reserved agent");
        };
        assert_eq!(reserved.agent_id(), &agent("a1"));
        assert_eq!(reserved.created_by_user_id(), &user("u1"));
        assert_eq!(reserved.idempotency_key(), &idem("idem-1"));
        assert_eq!(reserved.created_at(), 42);
        assert_eq!(reserved.updated_at(), 42);

        // The lookup sees the pending row with the metadata the seal proved and the handle
        // mirrored into display_name.
        let hit = find_idempotent_reservation(&store, &user("u1"), &idem("idem-1"))
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(
            hit.materialization_status(),
            MaterializationStatus::PendingMaterialization
        );
        assert_eq!(hit.runtime(), RuntimeKind::Codex);
        assert_eq!(hit.name(), "a1");
        assert_eq!(hit.host_id(), &HostId::parse("h1").unwrap());
        assert_eq!(hit.session_scope(), AgentSessionScope::Conversation);
    }

    #[tokio::test]
    async fn reserve_reports_a_handle_held_by_a_user_as_a_constraint_conflict() {
        // The cross-namespace collision: a user already holds `clash`. The name UNIQUE on
        // `agents` would not fire (no agent holds it), but the `agents_name_unique_against_
        // users_insert` trigger would `RAISE(ABORT)` as an opaque `SQLITE_CONSTRAINT_TRIGGER`
        // — not a unique violation. The preflight catches it as an honest conflict instead
        // of letting it drift to a 500.
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(
            "INSERT INTO users (id, name, display_name, created_at, updated_at) \
             VALUES ('u2', 'clash', 'Clash', 1, 1)"
                .to_string(),
        );
        let path = seed_schema(&dir, "reserve-user-clash.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        assert_eq!(
            reserve_agent(&store, &input("clash", "fresh-key"), 42)
                .await
                .unwrap(),
            ReserveOutcome::ConstraintConflict
        );
    }

    #[tokio::test]
    async fn reserve_reports_a_duplicate_handle_as_a_constraint_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent("a1", "active", 1, Some("other-key")));
        let path = seed_schema(&dir, "reserve-name.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // A different id but the same handle `a1` trips the `name` unique constraint.
        assert_eq!(
            reserve_agent(&store, &input("a1", "fresh-key"), 42)
                .await
                .unwrap(),
            ReserveOutcome::ConstraintConflict
        );
    }

    #[tokio::test]
    async fn reserve_reports_a_duplicate_idempotency_key_as_a_constraint_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent(
            "existing",
            "pending_materialization",
            1,
            Some("idem-1"),
        ));
        let path = seed_schema(&dir, "reserve-idem.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // A fresh handle but the same `(u1, idem-1)` trips the per-creator index.
        assert_eq!(
            reserve_agent(&store, &input("a2", "idem-1"), 42)
                .await
                .unwrap(),
            ReserveOutcome::ConstraintConflict
        );
    }

    #[tokio::test]
    async fn fail_flips_a_pending_row_and_reflips_a_failed_one() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent(
            "a1",
            "pending_materialization",
            1,
            Some("idem-1"),
        ));
        let path = seed_schema(&dir, "fail.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let FailOutcome::Failed(failed) =
            fail_materialization(&store, &agent("a1"), "boom", 10, 11)
                .await
                .unwrap()
        else {
            panic!("expected a failed transition");
        };
        assert_eq!(failed.failed_code(), "boom");
        assert_eq!(failed.failed_at(), 10);
        assert_eq!(failed.updated_at(), 11);

        // failed -> failed re-stamps (the guard admits an already-failed row).
        let FailOutcome::Failed(refailed) =
            fail_materialization(&store, &agent("a1"), "again", 20, 21)
                .await
                .unwrap()
        else {
            panic!("expected a re-stamped failure");
        };
        assert_eq!(refailed.failed_code(), "again");
        assert_eq!(refailed.failed_at(), 20);
    }

    #[tokio::test]
    async fn fail_is_lost_against_an_active_or_absent_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent("a1", "active", 1, Some("idem-1")));
        let path = seed_schema(&dir, "fail-lost.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        assert_eq!(
            fail_materialization(&store, &agent("a1"), "boom", 10, 11)
                .await
                .unwrap(),
            FailOutcome::Lost
        );
        assert_eq!(
            fail_materialization(&store, &agent("missing"), "boom", 10, 11)
                .await
                .unwrap(),
            FailOutcome::Lost
        );
    }

    #[tokio::test]
    async fn reopen_flips_a_failed_row_and_clears_the_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        // A failed row carrying a stale failure stamp, to prove reopen clears it.
        seed.push(
            "INSERT INTO agents \
             (id, name, display_name, runtime, host_id, created_by_user_id, created_at, \
              updated_at, materialization_status, session_scope, idempotency_key, \
              materialization_failed_code, materialization_failed_at) \
             VALUES ('a1', 'a1', 'a1', 'claude', 'h1', 'u1', 1, 1, 'failed', 'conversation', \
                     'idem-1', 'stale', 9)"
                .to_string(),
        );
        let path = seed_schema(&dir, "reopen.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let ReopenOutcome::Reopened(reopened) =
            reopen_failed_materialization(&store, &agent("a1"), 30)
                .await
                .unwrap()
        else {
            panic!("expected a reopened reservation");
        };
        assert_eq!(reopened.updated_at(), 30);

        let hit = find_idempotent_reservation(&store, &user("u1"), &idem("idem-1"))
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(
            hit.materialization_status(),
            MaterializationStatus::PendingMaterialization
        );
        assert_eq!(hit.materialization_failed_code(), None);
        assert_eq!(hit.materialization_failed_at(), None);
    }

    #[tokio::test]
    async fn reopen_is_lost_against_pending_active_or_absent() {
        let dir = tempfile::tempdir().unwrap();
        for status in ["pending_materialization", "active"] {
            let mut seed = base_seed();
            seed.push(seed_agent("a1", status, 1, Some("idem-1")));
            let path = seed_schema(&dir, &format!("reopen-{status}.db"), &seed).await;
            let store = SqliteHostAgentStore::open(&path).await.unwrap();
            assert_eq!(
                reopen_failed_materialization(&store, &agent("a1"), 30)
                    .await
                    .unwrap(),
                ReopenOutcome::Lost
            );
        }

        let path = seed_schema(&dir, "reopen-missing.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();
        assert_eq!(
            reopen_failed_materialization(&store, &agent("missing"), 30)
                .await
                .unwrap(),
            ReopenOutcome::Lost
        );
    }

    #[tokio::test]
    async fn stale_sweep_fails_only_the_old_pending_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_agent(
            "old-pending",
            "pending_materialization",
            5,
            Some("k-old"),
        ));
        seed.push(seed_agent(
            "new-pending",
            "pending_materialization",
            50,
            Some("k-new"),
        ));
        seed.push(seed_agent("old-active", "active", 5, Some("k-active")));
        seed.push(seed_agent("old-failed", "failed", 5, Some("k-failed")));
        let path = seed_schema(&dir, "stale.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        // cutoff strictly greater than old (5), strictly not greater than new (50).
        let swept = mark_stale_materializations_failed(&store, 25, 25, 26)
            .await
            .unwrap();
        assert_eq!(swept, vec![agent("old-pending")]);

        // The new pending row is untouched.
        let new_hit = find_idempotent_reservation(&store, &user("u1"), &idem("k-new"))
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(
            new_hit.materialization_status(),
            MaterializationStatus::PendingMaterialization
        );

        // The swept row carries the canonical code.
        let old_hit = find_idempotent_reservation(&store, &user("u1"), &idem("k-old"))
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(
            old_hit.materialization_status(),
            MaterializationStatus::Failed
        );
        assert_eq!(
            old_hit.materialization_failed_code(),
            Some(STALE_MATERIALIZATION_FAILED_CODE)
        );
        assert_eq!(old_hit.materialization_failed_at(), Some(25));
    }

    #[tokio::test]
    async fn lookup_returns_none_for_an_absent_pair() {
        let dir = tempfile::tempdir().unwrap();
        let path = seed_schema(&dir, "lookup-miss.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();
        assert!(
            find_idempotent_reservation(&store, &user("u1"), &idem("nope"))
                .await
                .unwrap()
                .is_none()
        );
    }

    /// A pending agent-scoped row of the given id, seeded so the activation flip can win it.
    fn seed_scoped_agent(id: &str, status: &str, scope: &str) -> String {
        format!(
            "INSERT INTO agents \
             (id, name, display_name, runtime, host_id, created_by_user_id, created_at, \
              updated_at, materialization_status, session_scope) \
             VALUES ('{id}', '{id}', '{id}', 'claude', 'h1', 'u1', 1, 1, '{status}', '{scope}')"
        )
    }

    /// A direct line between the very same participants provisioning would open (agent `a1`
    /// and its creator `u1`), so get-or-create resolves it rather than minting the candidate.
    const EXISTING_PAIR: &str = "INSERT INTO conversations \
         (id, placement_kind, roster_policy, title, status, endpoint_a_kind, endpoint_a_id, \
          endpoint_b_kind, endpoint_b_id, created_at, updated_at) \
         VALUES ('existing-pair', 'direct_pair', 'fixed', 'DM', 'open', 'agent', 'a1', 'human', \
                 'u1', 1, 1)";

    /// A message already holding the id the onboarding write will mint, so the dependent insert
    /// collides on the primary key only after the flip has won.
    const CLASH_MESSAGE: &str = "INSERT INTO messages \
         (id, conversation_id, from_kind, content, seq, created_at) \
         VALUES ('msg-onboard', 'existing-pair', 'system', 'prior', 1, 1)";

    /// The test-only entry that runs the private provisioning helper as one atomic unit and
    /// applies the same commit/rollback/compensate policy the create route's agent arm will:
    /// commit a `Provisioned` graph, drop a `Lost` flip WITHOUT compensating (nothing was
    /// written), and — on a dependent-graph fault — roll the whole thing back then stamp the
    /// compensating fail in a SEPARATE transaction. It stands in for the mount that lands with
    /// CP-B; the helper itself carries no transaction so it composes into that wider unit.
    async fn provision_and_activate_agent_arm(
        store: &SqliteHostAgentStore,
        agent: &AgentId,
        candidate: ConversationId,
        onboarding_message_id: MessageId,
        now_ms: i64,
    ) -> Result<AgentArmActivation, MaterializationFault> {
        let mut tx = store
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;
        match provision_agent_arm_on(&mut tx, agent, candidate, onboarding_message_id, now_ms).await
        {
            Ok(AgentArmActivation::Provisioned(fact)) => {
                tx.commit().await.map_err(PersistenceFailure::from_source)?;
                Ok(AgentArmActivation::Provisioned(fact))
            }
            Ok(AgentArmActivation::Lost) => {
                drop(tx);
                Ok(AgentArmActivation::Lost)
            }
            Err(fault) => {
                drop(tx);
                fail_materialization(store, agent, DEPENDENT_GRAPH_FAILED_CODE, now_ms, now_ms)
                    .await?;
                Err(fault)
            }
        }
    }

    #[tokio::test]
    async fn activation_provisions_the_agent_arm_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_scoped_agent("a1", "pending_materialization", "agent"));
        let path = seed_schema(&dir, "activate.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let outcome = provision_and_activate_agent_arm(
            &store,
            &agent("a1"),
            ConversationId::parse("pair-new").unwrap(),
            MessageId::parse("msg-onboard").unwrap(),
            99,
        )
        .await
        .unwrap();

        let AgentArmActivation::Provisioned(fact) = outcome else {
            panic!("expected a provisioned agent arm");
        };
        assert_eq!(fact.agent_id(), &agent("a1"));
        assert_eq!(
            fact.direct_line(),
            &ConversationId::parse("pair-new").unwrap()
        );
        assert_eq!(
            fact.onboarding_message_id(),
            &MessageId::parse("msg-onboard").unwrap()
        );
        assert!(fact.pair_created());

        // The row is active, stamped with the request clock.
        let status: String =
            sqlx::query_scalar("SELECT materialization_status FROM agents WHERE id = 'a1'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(status, "active");
        let updated_at: i64 = sqlx::query_scalar("SELECT updated_at FROM agents WHERE id = 'a1'")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(updated_at, 99);

        // The onboarding system message landed on the freshly minted line as its first ordinal.
        let from_kind: String =
            sqlx::query_scalar("SELECT from_kind FROM messages WHERE id = 'msg-onboard'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(from_kind, "system");
        let seq: i64 = sqlx::query_scalar("SELECT seq FROM messages WHERE id = 'msg-onboard'")
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(seq, 1);
        let conversation: String =
            sqlx::query_scalar("SELECT conversation_id FROM messages WHERE id = 'msg-onboard'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(conversation, "pair-new");
    }

    #[tokio::test]
    async fn activation_is_lost_and_writes_nothing_against_a_non_pending_row() {
        let dir = tempfile::tempdir().unwrap();
        for status in ["active", "failed"] {
            let mut seed = base_seed();
            seed.push(seed_scoped_agent("a1", status, "agent"));
            let path = seed_schema(&dir, &format!("lost-{status}.db"), &seed).await;
            let store = SqliteHostAgentStore::open(&path).await.unwrap();

            let outcome = provision_and_activate_agent_arm(
                &store,
                &agent("a1"),
                ConversationId::parse("pair-new").unwrap(),
                MessageId::parse("msg-onboard").unwrap(),
                99,
            )
            .await
            .unwrap();
            assert_eq!(outcome, AgentArmActivation::Lost);

            // The guarded flip changed no row: the status is untouched, no line was minted, no
            // onboarding message written, and no compensating fail was stamped.
            let after: String =
                sqlx::query_scalar("SELECT materialization_status FROM agents WHERE id = 'a1'")
                    .fetch_one(store.pool())
                    .await
                    .unwrap();
            assert_eq!(after, status);
            let convs: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE id = 'pair-new'")
                    .fetch_one(store.pool())
                    .await
                    .unwrap();
            assert_eq!(convs, 0);
            let msgs: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE id = 'msg-onboard'")
                    .fetch_one(store.pool())
                    .await
                    .unwrap();
            assert_eq!(msgs, 0);
        }

        // An absent row is likewise `Lost`, with nothing written.
        let path = seed_schema(&dir, "lost-absent.db", &base_seed()).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();
        let outcome = provision_and_activate_agent_arm(
            &store,
            &agent("missing"),
            ConversationId::parse("pair-new").unwrap(),
            MessageId::parse("msg-onboard").unwrap(),
            99,
        )
        .await
        .unwrap();
        assert_eq!(outcome, AgentArmActivation::Lost);
    }

    #[tokio::test]
    async fn a_dependent_graph_failure_rolls_back_and_stamps_a_separate_fail() {
        let dir = tempfile::tempdir().unwrap();
        let mut seed = base_seed();
        seed.push(seed_scoped_agent("a1", "pending_materialization", "agent"));
        // The line already exists and already holds the id the onboarding write will mint, so the
        // dependent insert collides only after the flip has won.
        seed.push(EXISTING_PAIR.to_string());
        seed.push(CLASH_MESSAGE.to_string());
        let path = seed_schema(&dir, "dependent-fail.db", &seed).await;
        let store = SqliteHostAgentStore::open(&path).await.unwrap();

        let fault = provision_and_activate_agent_arm(
            &store,
            &agent("a1"),
            ConversationId::parse("pair-new").unwrap(),
            MessageId::parse("msg-onboard").unwrap(),
            99,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(fault, MaterializationFault::Persistence(_)),
            "expected a dependent-write persistence fault, got {fault:?}"
        );

        // The whole transaction rolled back — had the flip stuck as `active`, the compensating
        // fail (guarded to pending|failed) would have been Lost and the status stayed `active`.
        // Its landing as `failed` with the dependent code proves rollback AND compensation.
        let status: String =
            sqlx::query_scalar("SELECT materialization_status FROM agents WHERE id = 'a1'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(status, "failed");
        let code: Option<String> =
            sqlx::query_scalar("SELECT materialization_failed_code FROM agents WHERE id = 'a1'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(code.as_deref(), Some(DEPENDENT_GRAPH_FAILED_CODE));

        // The pre-existing line still holds exactly its one seeded message; the candidate line
        // was never minted (get-or-create resolved the existing one).
        let existing_msgs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM messages WHERE conversation_id = 'existing-pair'",
        )
        .fetch_one(store.pool())
        .await
        .unwrap();
        assert_eq!(existing_msgs, 1);
        let candidate: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM conversations WHERE id = 'pair-new'")
                .fetch_one(store.pool())
                .await
                .unwrap();
        assert_eq!(candidate, 0);
    }
}
