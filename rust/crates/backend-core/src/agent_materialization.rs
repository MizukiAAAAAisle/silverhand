//! The durable agent-materialization lifecycle: reserve a pending row, fail it, reopen a
//! failed one for retry, and bulk-fail the ones a crash left pending.
//!
//! Creating an agent is not one write. A row is first *reserved* in
//! `pending_materialization`, then a separate step builds the dependent graph (the DM
//! channel, the onboarding message, …) and only then may the row become `active`. This
//! module owns the durable primitives of that lifecycle that stand on their own: the
//! creator-scoped idempotency lookup, the reserve INSERT, the two failure transitions,
//! and the crash-recovery bulk fail.
//!
//! This is a distinct write authority from the capability-neutral
//! [`crate::agent_profile_write`] row writer and the [`crate::runtime_transition`] lock
//! lifecycle: the profile writer edits an existing row's columns from a before-image, and
//! runtime-transition is a lock state machine; this is the `materialization_status`
//! directed state machine plus the INSERT that seeds it.
//!
//! # There is deliberately no `pending → active` transition here
//!
//! The product invariant is not "the status column flipped to `active`" but "a committed
//! `active` row always carries its full dependent graph". Activation therefore must ride
//! the same transaction that writes the graph — a transaction-scoped capability delivered
//! together with the dependents, never a standalone primitive. A production store method
//! that flips a row to `active` on its own would be a permanent, legal entry point to an
//! `active`-but-graph-less row. So this authority has no activate method *by
//! construction*: the omission is the boundary, not an oversight. `failed → pending`
//! (reopen for retry) is present because it introduces no such hazard — it only returns a
//! row to the pending stage the reserve already established.
//!
//! # The adapter witnesses; the domain mints the verdict
//!
//! Every write projects the row it actually touched from its own `RETURNING` clause, and
//! the free functions here bind the subject and seal it field by field. A CAS that
//! matched no row surfaces as [`FailOutcome::Lost`] / [`ReopenOutcome::Lost`]: `Lost`
//! means only "the guarded compare-and-set changed no row". It does NOT interpret the
//! winner's status — a caller that needs to know whether the row is now `active`,
//! `failed`, still pending, or gone must authoritatively re-read; this module never forges
//! a product verdict out of a missing `RETURNING` row.
//!
//! The idempotency lookup is likewise sealed: `WHERE (created_by_user_id, idempotency_key)`
//! is this adapter's implementation, not the port contract, so the row it returns is bound
//! against the requested creator and key here before any caller reads its status or
//! metadata. A row that names a different creator or key is a broken adapter, a fault, not
//! a hit.

use std::future::Future;

use thiserror::Error;

use crate::{
    agent_lifecycle::MaterializationStatus, agents::runtime::RuntimeKind, identity::AgentId,
    identity::HostId, identity::UserId, persistence::PersistenceFailure,
};

/// The canonical `materialization_failed_code` the crash-recovery sweep stamps on a row a
/// boot found still pending. Pinned here so the reconciler and any reader agree on the one
/// token, and it never drifts into an adapter literal.
pub const STALE_MATERIALIZATION_FAILED_CODE: &str = "backend_crash_during_materialize";

/// A client-supplied idempotency token for a create attempt. Opaque: it is a dedup key,
/// not an identity coordinate, so any non-null string the client sent is a legal key (the
/// partial unique index keys on it only `WHERE idempotency_key IS NOT NULL`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotencyKey(String);

impl IdempotencyKey {
    pub fn new(raw: impl Into<String>) -> Self {
        Self(raw.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The already-validated inputs of a reserve INSERT, carried verbatim to the write. Legal
/// tuning against the runtime and handle availability are upstream admission's job; this
/// value is what the reserve persists and seals its committed identity against.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReserveAgentInput {
    pub agent_id: AgentId,
    /// The `@`-handle; the reserve seeds `display_name` from it, mirroring the TypeScript.
    pub name: String,
    pub runtime: RuntimeKind,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub host_id: HostId,
    pub description: Option<String>,
    pub session_scope: String,
    pub created_by_user_id: UserId,
    pub idempotency_key: IdempotencyKey,
}

/// The raw witness the reserve INSERT returns, decoded from its `RETURNING` clause. The
/// domain — not the adapter — decides whether the persisted status/creator/key match the
/// request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservedAgentRow {
    /// Decoded from the `RETURNING id`, never the query parameter.
    pub agent_id: AgentId,
    pub materialization_status: String,
    pub created_by_user_id: String,
    pub idempotency_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a reserve observed. `ConstraintConflict` is a unique-index violation the adapter
/// detected by the driver's error *kind* — never by parsing an index name or message — so
/// it says only "some unique constraint rejected the row" (the agent handle or the
/// per-user idempotency key). The single consumer folds it into its `nameTaken` answer;
/// splitting the two would force the adapter to claim which constraint fired, which it
/// cannot honestly do without canonical re-reads it has no reason to run.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReserveOutcome {
    Reserved(ReservedAgent),
    ConstraintConflict,
}

/// A sealed reservation: the pending row proven to carry the requested creator and key.
/// Minted only by [`reserve_agent`], so holding one is proof the reserve durably inserted
/// a `pending_materialization` row for this exact agent, creator, and idempotency key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservedAgent {
    agent_id: AgentId,
    created_by_user_id: UserId,
    idempotency_key: IdempotencyKey,
    created_at: i64,
    updated_at: i64,
}

impl ReservedAgent {
    fn seal(
        input: &ReserveAgentInput,
        now_ms: i64,
        row: ReservedAgentRow,
    ) -> Result<Self, MaterializationFault> {
        if row.agent_id != input.agent_id {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness names a different agent than the request",
            });
        }
        let status = MaterializationStatus::parse(&row.materialization_status).map_err(|_| {
            MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness carries an unknown materialization status",
            }
        })?;
        if status != MaterializationStatus::PendingMaterialization {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness is not pending_materialization",
            });
        }
        let created_by_user_id = UserId::parse(row.created_by_user_id).map_err(|_| {
            MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness carries an empty creator",
            }
        })?;
        if created_by_user_id != input.created_by_user_id {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness names a different creator than the request",
            });
        }
        if row.idempotency_key.as_deref() != Some(input.idempotency_key.as_str()) {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness idempotency key differs from the request",
            });
        }
        if row.created_at != now_ms || row.updated_at != now_ms {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness timestamps differ from the request clock",
            });
        }
        Ok(Self {
            agent_id: input.agent_id.clone(),
            created_by_user_id,
            idempotency_key: input.idempotency_key.clone(),
            created_at: now_ms,
            updated_at: now_ms,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn created_by_user_id(&self) -> &UserId {
        &self.created_by_user_id
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

/// The raw witness a failure transition returns, decoded from its `RETURNING` clause.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializationFlipRow {
    pub agent_id: AgentId,
    pub materialization_status: String,
    pub materialization_failed_code: Option<String>,
    pub materialization_failed_at: Option<i64>,
    pub updated_at: i64,
}

/// What a `pending|failed → failed` observed. `Lost` = the guarded CAS changed no row
/// (absent, or already `active`); the caller re-reads to learn which.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FailOutcome {
    Failed(FailedMaterialization),
    Lost,
}

/// A sealed failure: the row proven to read `failed` with the requested code and stamp.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FailedMaterialization {
    agent_id: AgentId,
    failed_code: String,
    failed_at: i64,
    updated_at: i64,
}

impl FailedMaterialization {
    fn seal(
        agent: &AgentId,
        failed_code: &str,
        failed_at: i64,
        now_ms: i64,
        row: MaterializationFlipRow,
    ) -> Result<Self, MaterializationFault> {
        seal_flip_subject(agent, &row, MaterializationStatus::Failed, now_ms)?;
        if row.materialization_failed_code.as_deref() != Some(failed_code) {
            return Err(MaterializationFault::FlipWitnessMismatch {
                reason: "failed witness code differs from the request",
            });
        }
        if row.materialization_failed_at != Some(failed_at) {
            return Err(MaterializationFault::FlipWitnessMismatch {
                reason: "failed witness timestamp differs from the request",
            });
        }
        Ok(Self {
            agent_id: agent.clone(),
            failed_code: failed_code.to_string(),
            failed_at,
            updated_at: now_ms,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn failed_code(&self) -> &str {
        &self.failed_code
    }

    pub fn failed_at(&self) -> i64 {
        self.failed_at
    }

    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

/// What a `failed → pending` (reopen for retry) observed. `Lost` = the guarded CAS changed
/// no row (absent, or not `failed`); the caller re-reads to learn which.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReopenOutcome {
    Reopened(ReopenedReservation),
    Lost,
}

/// A sealed reopen: the row proven back in `pending_materialization` with the failure
/// columns cleared.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReopenedReservation {
    agent_id: AgentId,
    updated_at: i64,
}

impl ReopenedReservation {
    fn seal(
        agent: &AgentId,
        now_ms: i64,
        row: MaterializationFlipRow,
    ) -> Result<Self, MaterializationFault> {
        seal_flip_subject(
            agent,
            &row,
            MaterializationStatus::PendingMaterialization,
            now_ms,
        )?;
        if row.materialization_failed_code.is_some() || row.materialization_failed_at.is_some() {
            return Err(MaterializationFault::FlipWitnessMismatch {
                reason: "reopen witness did not clear the failure columns",
            });
        }
        Ok(Self {
            agent_id: agent.clone(),
            updated_at: now_ms,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

/// The subject/status/stamp checks every flip after-image shares: same agent as the
/// request, the expected post-image status, and the request's clock on `updated_at`.
fn seal_flip_subject(
    agent: &AgentId,
    row: &MaterializationFlipRow,
    expected: MaterializationStatus,
    now_ms: i64,
) -> Result<(), MaterializationFault> {
    if &row.agent_id != agent {
        return Err(MaterializationFault::FlipWitnessMismatch {
            reason: "flip witness names a different agent than the request",
        });
    }
    let status = MaterializationStatus::parse(&row.materialization_status).map_err(|_| {
        MaterializationFault::FlipWitnessMismatch {
            reason: "flip witness carries an unknown materialization status",
        }
    })?;
    if status != expected {
        return Err(MaterializationFault::FlipWitnessMismatch {
            reason: "flip witness status is not the transition target",
        });
    }
    if row.updated_at != now_ms {
        return Err(MaterializationFault::FlipWitnessMismatch {
            reason: "flip witness updated_at differs from the request clock",
        });
    }
    Ok(())
}

/// The raw witness the idempotency lookup returns: the row read for
/// `(created_by_user_id, idempotency_key)`, decoded from the SELECT. The creator and key
/// come from the row's OWN columns so the domain can bind them against the request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotentReservationRow {
    pub agent_id: AgentId,
    pub created_by_user_id: String,
    pub idempotency_key: Option<String>,
    pub materialization_status: String,
    pub materialization_failed_code: Option<String>,
    pub materialization_failed_at: Option<i64>,
    pub name: String,
    pub runtime: String,
    pub model: Option<String>,
    pub description: Option<String>,
    pub host_id: String,
    pub session_scope: String,
}

/// A sealed idempotency hit: an existing reservation bound to the requested creator and
/// key, carrying exactly the persisted fields the create outcome decision reads. It holds
/// no `template_choice` — that is not a database column; the use case derives it from its
/// own single constant and must not mistake it for a committed fact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotentReservation {
    agent_id: AgentId,
    created_by_user_id: UserId,
    idempotency_key: IdempotencyKey,
    materialization_status: MaterializationStatus,
    materialization_failed_code: Option<String>,
    materialization_failed_at: Option<i64>,
    name: String,
    runtime: RuntimeKind,
    model: Option<String>,
    description: Option<String>,
    host_id: String,
    session_scope: String,
}

impl IdempotentReservation {
    fn seal(
        requested_creator: &UserId,
        requested_key: &IdempotencyKey,
        row: IdempotentReservationRow,
    ) -> Result<Self, MaterializationFault> {
        let created_by_user_id = UserId::parse(row.created_by_user_id).map_err(|_| {
            MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness carries an empty creator",
            }
        })?;
        if &created_by_user_id != requested_creator {
            return Err(MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness names a different creator than the request",
            });
        }
        if row.idempotency_key.as_deref() != Some(requested_key.as_str()) {
            return Err(MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness key differs from the request",
            });
        }
        let materialization_status = MaterializationStatus::parse(&row.materialization_status)
            .map_err(|_| MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness carries an unknown materialization status",
            })?;
        let runtime = RuntimeKind::parse(&row.runtime).ok_or({
            MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness carries an unknown runtime",
            }
        })?;
        Ok(Self {
            agent_id: row.agent_id,
            created_by_user_id,
            idempotency_key: requested_key.clone(),
            materialization_status,
            materialization_failed_code: row.materialization_failed_code,
            materialization_failed_at: row.materialization_failed_at,
            name: row.name,
            runtime,
            model: row.model,
            description: row.description,
            host_id: row.host_id,
            session_scope: row.session_scope,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn created_by_user_id(&self) -> &UserId {
        &self.created_by_user_id
    }

    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    pub fn materialization_status(&self) -> MaterializationStatus {
        self.materialization_status
    }

    pub fn materialization_failed_code(&self) -> Option<&str> {
        self.materialization_failed_code.as_deref()
    }

    pub fn materialization_failed_at(&self) -> Option<i64> {
        self.materialization_failed_at
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn runtime(&self) -> RuntimeKind {
        self.runtime
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    pub fn session_scope(&self) -> &str {
        &self.session_scope
    }
}

/// A fault in the materialization lifecycle — a driver error, or a witness that disagrees
/// with the request. Every arm is an internal invariant break the boundary surfaces as a
/// safe `500`; none is a product answer. The `reason` is a static label for the boundary
/// log, small enough to keep the error variant off `clippy::result_large_err`.
#[derive(Debug, Error)]
pub enum MaterializationFault {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error("reserve after-image disagreed with the request: {reason}")]
    ReserveWitnessMismatch { reason: &'static str },
    #[error("materialization flip after-image disagreed with the request: {reason}")]
    FlipWitnessMismatch { reason: &'static str },
    #[error("idempotency lookup witness disagreed with the request: {reason}")]
    LookupWitnessMismatch { reason: &'static str },
}

/// The creator-scoped idempotency lookup. A read, not a write, so it takes no writer
/// reservation; the port returns the row it read for the `(creator, key)` pair, and the
/// caller ([`find_idempotent_reservation`]) binds it against the request.
pub trait AgentMaterializationLookup: Send + Sync {
    fn find_by_idempotency(
        &self,
        creator: &UserId,
        key: &IdempotencyKey,
    ) -> impl Future<Output = Result<Option<IdempotentReservationRow>, PersistenceFailure>> + Send;
}

/// The durable materialization writes. Each is short and holds no remote IO: the reserve
/// is one INSERT; the flips are one guarded compare-and-set each; the sweep is one bulk
/// update. Each returns a DB witness the free functions in this module seal. There is no
/// activate method — see the module docs.
pub trait AgentMaterializationWrite: Send + Sync {
    /// Insert a `pending_materialization` row, returning the row it wrote or a unique
    /// constraint conflict.
    fn reserve(
        &self,
        input: &ReserveAgentInput,
        now_ms: i64,
    ) -> impl Future<Output = Result<ReserveRecord, PersistenceFailure>> + Send;

    /// `pending|failed → failed`, stamping the code and timestamp; returns the after-image
    /// or `None` when the guarded CAS changed no row.
    fn fail(
        &self,
        agent: &AgentId,
        failed_code: &str,
        failed_at: i64,
        now_ms: i64,
    ) -> impl Future<Output = Result<Option<MaterializationFlipRow>, PersistenceFailure>> + Send;

    /// `failed → pending`, clearing the failure columns; returns the after-image or `None`
    /// when the guarded CAS changed no row.
    fn reopen_failed(
        &self,
        agent: &AgentId,
        now_ms: i64,
    ) -> impl Future<Output = Result<Option<MaterializationFlipRow>, PersistenceFailure>> + Send;

    /// Crash recovery: fail every row still `pending_materialization` and older than the
    /// cutoff, returning the ids it transitioned.
    fn mark_stale_failed(
        &self,
        cutoff_created_at: i64,
        failed_at: i64,
        now_ms: i64,
    ) -> impl Future<Output = Result<Vec<MaterializationFlipRow>, PersistenceFailure>> + Send;
}

/// What a reserve write observed at the adapter, before the domain seals it: either the
/// inserted row or a unique-constraint conflict the driver reported by error *kind*.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReserveRecord {
    Inserted(ReservedAgentRow),
    ConstraintConflict,
}

/// Look up an existing reservation for `(creator, key)` and bind it against the request.
/// A row whose own creator/key columns disagree with the request is a broken adapter — a
/// fault, never a hit an outcome would be decided from.
pub async fn find_idempotent_reservation<L: AgentMaterializationLookup>(
    port: &L,
    creator: &UserId,
    key: &IdempotencyKey,
) -> Result<Option<IdempotentReservation>, MaterializationFault> {
    match port.find_by_idempotency(creator, key).await? {
        Some(row) => Ok(Some(IdempotentReservation::seal(creator, key, row)?)),
        None => Ok(None),
    }
}

/// Reserve a pending row and seal the witness. A conflict passes through as
/// [`ReserveOutcome::ConstraintConflict`]; a persisted row that disagrees with the request
/// on subject, status, creator, key, or clock is a fault, never a sealed reservation.
pub async fn reserve_agent<W: AgentMaterializationWrite>(
    port: &W,
    input: &ReserveAgentInput,
    now_ms: i64,
) -> Result<ReserveOutcome, MaterializationFault> {
    Ok(match port.reserve(input, now_ms).await? {
        ReserveRecord::Inserted(row) => {
            ReserveOutcome::Reserved(ReservedAgent::seal(input, now_ms, row)?)
        }
        ReserveRecord::ConstraintConflict => ReserveOutcome::ConstraintConflict,
    })
}

/// Fail a pending-or-failed row and seal the after-image against the requested code and
/// stamp. A missing after-image is [`FailOutcome::Lost`] (the caller re-reads); an
/// after-image that disagrees is a fault.
pub async fn fail_materialization<W: AgentMaterializationWrite>(
    port: &W,
    agent: &AgentId,
    failed_code: &str,
    failed_at: i64,
    now_ms: i64,
) -> Result<FailOutcome, MaterializationFault> {
    Ok(
        match port.fail(agent, failed_code, failed_at, now_ms).await? {
            Some(row) => FailOutcome::Failed(FailedMaterialization::seal(
                agent,
                failed_code,
                failed_at,
                now_ms,
                row,
            )?),
            None => FailOutcome::Lost,
        },
    )
}

/// Reopen a failed row for retry and seal the after-image. A missing after-image is
/// [`ReopenOutcome::Lost`] (the caller re-reads); an after-image that disagrees is a fault.
pub async fn reopen_failed_materialization<W: AgentMaterializationWrite>(
    port: &W,
    agent: &AgentId,
    now_ms: i64,
) -> Result<ReopenOutcome, MaterializationFault> {
    Ok(match port.reopen_failed(agent, now_ms).await? {
        Some(row) => ReopenOutcome::Reopened(ReopenedReservation::seal(agent, now_ms, row)?),
        None => ReopenOutcome::Lost,
    })
}

/// Sweep the rows a crash left pending and seal each after-image as `failed` with the
/// canonical code and stamp, returning the ids it transitioned. A swept row whose
/// after-image is not the requested failure is a fault, not a silently dropped id.
pub async fn mark_stale_materializations_failed<W: AgentMaterializationWrite>(
    port: &W,
    cutoff_created_at: i64,
    failed_at: i64,
    now_ms: i64,
) -> Result<Vec<AgentId>, MaterializationFault> {
    let rows = port
        .mark_stale_failed(cutoff_created_at, failed_at, now_ms)
        .await?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        let agent = row.agent_id.clone();
        FailedMaterialization::seal(
            &agent,
            STALE_MATERIALIZATION_FAILED_CODE,
            failed_at,
            now_ms,
            row,
        )?;
        ids.push(agent);
    }
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn key() -> IdempotencyKey {
        IdempotencyKey::new("idem-1")
    }

    fn input() -> ReserveAgentInput {
        ReserveAgentInput {
            agent_id: agent("a1"),
            name: "a1".to_string(),
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(true),
            host_id: host("h1"),
            description: Some("d".to_string()),
            session_scope: "conversation".to_string(),
            created_by_user_id: user("u1"),
            idempotency_key: key(),
        }
    }

    fn faithful_reserved_row(now_ms: i64) -> ReservedAgentRow {
        ReservedAgentRow {
            agent_id: agent("a1"),
            materialization_status: "pending_materialization".to_string(),
            created_by_user_id: "u1".to_string(),
            idempotency_key: Some("idem-1".to_string()),
            created_at: now_ms,
            updated_at: now_ms,
        }
    }

    #[derive(Default)]
    struct ScriptedWrite {
        reserve: Option<ReserveRecord>,
        fail: Option<Option<MaterializationFlipRow>>,
        reopen: Option<Option<MaterializationFlipRow>>,
        stale: Vec<MaterializationFlipRow>,
    }

    impl AgentMaterializationWrite for ScriptedWrite {
        async fn reserve(
            &self,
            _input: &ReserveAgentInput,
            _now_ms: i64,
        ) -> Result<ReserveRecord, PersistenceFailure> {
            Ok(self.reserve.clone().expect("reserve scripted"))
        }

        async fn fail(
            &self,
            _agent: &AgentId,
            _failed_code: &str,
            _failed_at: i64,
            _now_ms: i64,
        ) -> Result<Option<MaterializationFlipRow>, PersistenceFailure> {
            Ok(self.fail.clone().expect("fail scripted"))
        }

        async fn reopen_failed(
            &self,
            _agent: &AgentId,
            _now_ms: i64,
        ) -> Result<Option<MaterializationFlipRow>, PersistenceFailure> {
            Ok(self.reopen.clone().expect("reopen scripted"))
        }

        async fn mark_stale_failed(
            &self,
            _cutoff_created_at: i64,
            _failed_at: i64,
            _now_ms: i64,
        ) -> Result<Vec<MaterializationFlipRow>, PersistenceFailure> {
            Ok(self.stale.clone())
        }
    }

    struct ScriptedLookup(Option<IdempotentReservationRow>);

    impl AgentMaterializationLookup for ScriptedLookup {
        async fn find_by_idempotency(
            &self,
            _creator: &UserId,
            _key: &IdempotencyKey,
        ) -> Result<Option<IdempotentReservationRow>, PersistenceFailure> {
            Ok(self.0.clone())
        }
    }

    #[tokio::test]
    async fn reserve_seals_a_faithful_pending_row() {
        let port = ScriptedWrite {
            reserve: Some(ReserveRecord::Inserted(faithful_reserved_row(7))),
            ..Default::default()
        };
        let ReserveOutcome::Reserved(reserved) = reserve_agent(&port, &input(), 7).await.unwrap()
        else {
            panic!("expected a reserved agent");
        };
        assert_eq!(reserved.agent_id(), &agent("a1"));
        assert_eq!(reserved.created_by_user_id(), &user("u1"));
        assert_eq!(reserved.idempotency_key(), &key());
        assert_eq!(reserved.created_at(), 7);
        assert_eq!(reserved.updated_at(), 7);
    }

    #[tokio::test]
    async fn reserve_passes_through_a_constraint_conflict() {
        let port = ScriptedWrite {
            reserve: Some(ReserveRecord::ConstraintConflict),
            ..Default::default()
        };
        assert_eq!(
            reserve_agent(&port, &input(), 7).await.unwrap(),
            ReserveOutcome::ConstraintConflict
        );
    }

    #[tokio::test]
    async fn reserve_rejects_a_witness_that_disagrees() {
        let mut wrong_agent = faithful_reserved_row(7);
        wrong_agent.agent_id = agent("other");

        let mut not_pending = faithful_reserved_row(7);
        not_pending.materialization_status = "active".to_string();

        let mut wrong_creator = faithful_reserved_row(7);
        wrong_creator.created_by_user_id = "u2".to_string();

        let mut wrong_key = faithful_reserved_row(7);
        wrong_key.idempotency_key = Some("other".to_string());

        let mut missing_key = faithful_reserved_row(7);
        missing_key.idempotency_key = None;

        let mut wrong_stamp = faithful_reserved_row(7);
        wrong_stamp.updated_at = 8;

        for row in [
            wrong_agent,
            not_pending,
            wrong_creator,
            wrong_key,
            missing_key,
            wrong_stamp,
        ] {
            let port = ScriptedWrite {
                reserve: Some(ReserveRecord::Inserted(row)),
                ..Default::default()
            };
            assert!(matches!(
                reserve_agent(&port, &input(), 7).await.unwrap_err(),
                MaterializationFault::ReserveWitnessMismatch { .. }
            ));
        }
    }

    #[tokio::test]
    async fn fail_seals_the_after_image() {
        let port = ScriptedWrite {
            fail: Some(Some(MaterializationFlipRow {
                agent_id: agent("a1"),
                materialization_status: "failed".to_string(),
                materialization_failed_code: Some("boom".to_string()),
                materialization_failed_at: Some(11),
                updated_at: 12,
            })),
            ..Default::default()
        };
        let FailOutcome::Failed(failed) = fail_materialization(&port, &agent("a1"), "boom", 11, 12)
            .await
            .unwrap()
        else {
            panic!("expected a failed transition");
        };
        assert_eq!(failed.agent_id(), &agent("a1"));
        assert_eq!(failed.failed_code(), "boom");
        assert_eq!(failed.failed_at(), 11);
        assert_eq!(failed.updated_at(), 12);
    }

    #[tokio::test]
    async fn fail_passes_through_a_lost_guard() {
        let port = ScriptedWrite {
            fail: Some(None),
            ..Default::default()
        };
        assert_eq!(
            fail_materialization(&port, &agent("a1"), "boom", 11, 12)
                .await
                .unwrap(),
            FailOutcome::Lost
        );
    }

    #[tokio::test]
    async fn fail_rejects_a_disagreeing_after_image() {
        let base = MaterializationFlipRow {
            agent_id: agent("a1"),
            materialization_status: "failed".to_string(),
            materialization_failed_code: Some("boom".to_string()),
            materialization_failed_at: Some(11),
            updated_at: 12,
        };

        let mut wrong_agent = base.clone();
        wrong_agent.agent_id = agent("other");

        let mut not_failed = base.clone();
        not_failed.materialization_status = "pending_materialization".to_string();

        let mut wrong_code = base.clone();
        wrong_code.materialization_failed_code = Some("other".to_string());

        let mut wrong_failed_at = base.clone();
        wrong_failed_at.materialization_failed_at = Some(99);

        let mut wrong_stamp = base.clone();
        wrong_stamp.updated_at = 13;

        for row in [
            wrong_agent,
            not_failed,
            wrong_code,
            wrong_failed_at,
            wrong_stamp,
        ] {
            let port = ScriptedWrite {
                fail: Some(Some(row)),
                ..Default::default()
            };
            assert!(matches!(
                fail_materialization(&port, &agent("a1"), "boom", 11, 12)
                    .await
                    .unwrap_err(),
                MaterializationFault::FlipWitnessMismatch { .. }
            ));
        }
    }

    #[tokio::test]
    async fn reopen_seals_a_cleared_pending_row() {
        let port = ScriptedWrite {
            reopen: Some(Some(MaterializationFlipRow {
                agent_id: agent("a1"),
                materialization_status: "pending_materialization".to_string(),
                materialization_failed_code: None,
                materialization_failed_at: None,
                updated_at: 20,
            })),
            ..Default::default()
        };
        let ReopenOutcome::Reopened(reopened) =
            reopen_failed_materialization(&port, &agent("a1"), 20)
                .await
                .unwrap()
        else {
            panic!("expected a reopened reservation");
        };
        assert_eq!(reopened.agent_id(), &agent("a1"));
        assert_eq!(reopened.updated_at(), 20);
    }

    #[tokio::test]
    async fn reopen_rejects_an_uncleared_failure() {
        let port = ScriptedWrite {
            reopen: Some(Some(MaterializationFlipRow {
                agent_id: agent("a1"),
                materialization_status: "pending_materialization".to_string(),
                materialization_failed_code: Some("stale".to_string()),
                materialization_failed_at: None,
                updated_at: 20,
            })),
            ..Default::default()
        };
        assert!(matches!(
            reopen_failed_materialization(&port, &agent("a1"), 20)
                .await
                .unwrap_err(),
            MaterializationFault::FlipWitnessMismatch { .. }
        ));
    }

    #[tokio::test]
    async fn reopen_passes_through_a_lost_guard() {
        let port = ScriptedWrite {
            reopen: Some(None),
            ..Default::default()
        };
        assert_eq!(
            reopen_failed_materialization(&port, &agent("a1"), 20)
                .await
                .unwrap(),
            ReopenOutcome::Lost
        );
    }

    #[tokio::test]
    async fn stale_sweep_returns_each_transitioned_id() {
        let port = ScriptedWrite {
            stale: vec![
                MaterializationFlipRow {
                    agent_id: agent("a1"),
                    materialization_status: "failed".to_string(),
                    materialization_failed_code: Some(
                        STALE_MATERIALIZATION_FAILED_CODE.to_string(),
                    ),
                    materialization_failed_at: Some(30),
                    updated_at: 31,
                },
                MaterializationFlipRow {
                    agent_id: agent("a2"),
                    materialization_status: "failed".to_string(),
                    materialization_failed_code: Some(
                        STALE_MATERIALIZATION_FAILED_CODE.to_string(),
                    ),
                    materialization_failed_at: Some(30),
                    updated_at: 31,
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            mark_stale_materializations_failed(&port, 25, 30, 31)
                .await
                .unwrap(),
            vec![agent("a1"), agent("a2")]
        );
    }

    #[tokio::test]
    async fn stale_sweep_faults_on_a_non_canonical_after_image() {
        let port = ScriptedWrite {
            stale: vec![MaterializationFlipRow {
                agent_id: agent("a1"),
                materialization_status: "failed".to_string(),
                materialization_failed_code: Some("not-canonical".to_string()),
                materialization_failed_at: Some(30),
                updated_at: 31,
            }],
            ..Default::default()
        };
        assert!(matches!(
            mark_stale_materializations_failed(&port, 25, 30, 31)
                .await
                .unwrap_err(),
            MaterializationFault::FlipWitnessMismatch { .. }
        ));
    }

    fn faithful_lookup_row() -> IdempotentReservationRow {
        IdempotentReservationRow {
            agent_id: agent("a1"),
            created_by_user_id: "u1".to_string(),
            idempotency_key: Some("idem-1".to_string()),
            materialization_status: "active".to_string(),
            materialization_failed_code: None,
            materialization_failed_at: None,
            name: "a1".to_string(),
            runtime: "codex".to_string(),
            model: Some("gpt".to_string()),
            description: Some("d".to_string()),
            host_id: "h1".to_string(),
            session_scope: "conversation".to_string(),
        }
    }

    #[tokio::test]
    async fn lookup_seals_a_bound_hit() {
        let port = ScriptedLookup(Some(faithful_lookup_row()));
        let hit = find_idempotent_reservation(&port, &user("u1"), &key())
            .await
            .unwrap()
            .expect("a hit");
        assert_eq!(hit.agent_id(), &agent("a1"));
        assert_eq!(hit.created_by_user_id(), &user("u1"));
        assert_eq!(hit.materialization_status(), MaterializationStatus::Active);
        assert_eq!(hit.runtime(), RuntimeKind::Codex);
        assert_eq!(hit.session_scope(), "conversation");
        assert_eq!(hit.host_id(), "h1");
    }

    #[tokio::test]
    async fn lookup_returns_none_for_a_miss() {
        let port = ScriptedLookup(None);
        assert!(
            find_idempotent_reservation(&port, &user("u1"), &key())
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn lookup_rejects_a_witness_bound_to_another_request() {
        let mut wrong_creator = faithful_lookup_row();
        wrong_creator.created_by_user_id = "u2".to_string();

        let mut wrong_key = faithful_lookup_row();
        wrong_key.idempotency_key = Some("other".to_string());

        let mut unknown_runtime = faithful_lookup_row();
        unknown_runtime.runtime = "smuggled".to_string();

        for row in [wrong_creator, wrong_key, unknown_runtime] {
            let port = ScriptedLookup(Some(row));
            assert!(matches!(
                find_idempotent_reservation(&port, &user("u1"), &key())
                    .await
                    .unwrap_err(),
                MaterializationFault::LookupWitnessMismatch { .. }
            ));
        }
    }
}
