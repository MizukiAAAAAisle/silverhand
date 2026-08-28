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
    agent_lifecycle::MaterializationStatus, agents::runtime::RuntimeKind,
    agents::session_scope::AgentSessionScope, identity::AgentId, identity::ConversationId,
    identity::HostId, identity::UserId, messaging::MessageId,
    messaging::agent_onboarding::OnboardingWritten, persistence::PersistenceFailure,
    user_identity::ParticipantHandle,
};

/// The canonical `materialization_failed_code` the crash-recovery sweep stamps on a row a
/// boot found still pending. Pinned here so the reconciler and any reader agree on the one
/// token, and it never drifts into an adapter literal.
pub const STALE_MATERIALIZATION_FAILED_CODE: &str = "backend_crash_during_materialize";

/// The canonical `materialization_failed_code` a provisioning attempt stamps when the row
/// won the activation flip but its dependent graph could not be written. The compensating
/// fail runs in a SEPARATE transaction after the provisioning transaction — flip and graph
/// together — rolled back, so this code names "activated then could not finish the graph",
/// distinct from the crash-recovery sweep's. Pinned here so the code never drifts into an
/// adapter literal.
pub const DEPENDENT_GRAPH_FAILED_CODE: &str = "dependent_row_insert_failed";

/// A client-supplied idempotency token for a create attempt. It is a dedup key, not an
/// identity coordinate, but it is not arbitrary: it carries the same envelope the create
/// route admits (`/^[A-Za-z0-9_-]{1,64}$/`), so an illegal key is unconstructable rather
/// than a value that reaches the per-creator unique index. The partial index keys on it
/// only `WHERE idempotency_key IS NOT NULL`; a sealed key is always non-null.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotencyKey(String);

/// A create request whose idempotency key is outside the admitted envelope. A request
/// classification failure at admission, never a persisted fact — the key never reaches a
/// write.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("idempotency key must be 1-64 characters of [A-Za-z0-9_-]")]
pub struct InvalidIdempotencyKey;

impl IdempotencyKey {
    /// Parse a client-supplied key against the admitted envelope. The bound is on the
    /// character class first, so any multi-byte input is rejected before the length check
    /// and byte length equals character length for every legal key.
    pub fn parse(raw: impl AsRef<str>) -> Result<Self, InvalidIdempotencyKey> {
        let raw = raw.as_ref();
        let legal_chars = raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if legal_chars && (1..=64).contains(&raw.len()) {
            Ok(Self(raw.to_string()))
        } else {
            Err(InvalidIdempotencyKey)
        }
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
    /// The `@`-handle, already validated at the request boundary; the reserve seeds
    /// `display_name` from it, mirroring the TypeScript. Typed so a raw string can
    /// never reopen an illegal-handle entry point into the write.
    pub name: ParticipantHandle,
    pub runtime: RuntimeKind,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: Option<bool>,
    pub host_id: HostId,
    pub description: Option<String>,
    pub session_scope: AgentSessionScope,
    pub created_by_user_id: UserId,
    pub idempotency_key: IdempotencyKey,
}

/// The raw witness the reserve INSERT returns, decoded from its `RETURNING` clause covering
/// every column the INSERT wrote. Identity/typed columns are carried raw (as the database
/// stored them) so the domain — not the adapter — parses and binds them against the
/// request; a column that disagrees with the input is a broken write, not a product answer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservedAgentRow {
    /// Decoded from the `RETURNING id`, never the query parameter.
    pub agent_id: AgentId,
    pub name: String,
    pub display_name: String,
    pub runtime: String,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    /// The stored `0`/`1`/null boolean column, decoded by the domain.
    pub fast_mode: Option<i64>,
    pub host_id: String,
    pub description: Option<String>,
    pub session_scope: String,
    pub created_by_user_id: String,
    pub materialization_status: String,
    pub idempotency_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a reserve observed. `ConstraintConflict` means the adapter's in-transaction
/// preflight — under the write reservation, before the INSERT — found the requested handle
/// already held in the shared @-namespace OR the `(creator, idempotency_key)` pair already
/// present. It says only "some uniqueness the reserve would collide with already holds",
/// never which one: the single consumer folds it into its `nameTaken` answer, and the
/// preflight covers exactly the two collisions the write could hit (the handle uniqueness —
/// including the cross-namespace user/agent trigger — and the per-creator idempotency
/// index).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReserveOutcome {
    /// Boxed to keep the enum small: the sealed reservation is wide, the conflict arm
    /// carries nothing.
    Reserved(Box<ReservedAgent>),
    ConstraintConflict,
}

/// A sealed reservation: the pending row proven, column by column, to carry exactly what
/// the reserve requested. Minted only by [`reserve_agent`], so holding one is proof the
/// reserve durably inserted a `pending_materialization` row whose every persisted column
/// replays the request. Every committed column it carries is read back from the write's own
/// `RETURNING` row (the database's truth) — including its timestamps — except the
/// idempotency key, which is the already-validated request key this seal proved equal to
/// the persisted one, kept as its typed newtype rather than re-parsed from the row string.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservedAgent {
    agent_id: AgentId,
    name: String,
    display_name: String,
    runtime: RuntimeKind,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: Option<bool>,
    host_id: HostId,
    description: Option<String>,
    session_scope: AgentSessionScope,
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
        if row.name != input.name.as_str() {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness names a different handle than the request",
            });
        }
        // The reserve seeds display_name from the handle; a divergence means the write
        // stopped mirroring it.
        if row.display_name != input.name.as_str() {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness did not seed display_name from the handle",
            });
        }
        let runtime = RuntimeKind::parse(&row.runtime).ok_or(
            MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness carries an unknown runtime",
            },
        )?;
        if runtime != input.runtime {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness runtime differs from the request",
            });
        }
        if row.model != input.model {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness model differs from the request",
            });
        }
        if row.reasoning_effort != input.reasoning_effort {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness reasoning_effort differs from the request",
            });
        }
        let fast_mode = decode_fast_mode(row.fast_mode).ok_or(
            MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness carries a non-boolean fast_mode column",
            },
        )?;
        if fast_mode != input.fast_mode {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness fast_mode differs from the request",
            });
        }
        let host_id = HostId::parse(row.host_id).map_err(|_| {
            MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness carries an empty host",
            }
        })?;
        if host_id != input.host_id {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness names a different host than the request",
            });
        }
        if row.description != input.description {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness description differs from the request",
            });
        }
        let session_scope = AgentSessionScope::parse(&row.session_scope).ok_or({
            MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness carries an unknown session scope",
            }
        })?;
        if session_scope != input.session_scope {
            return Err(MaterializationFault::ReserveWitnessMismatch {
                reason: "reserve witness session scope differs from the request",
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
            agent_id: row.agent_id,
            name: row.name,
            display_name: row.display_name,
            runtime,
            model: row.model,
            reasoning_effort: row.reasoning_effort,
            fast_mode,
            host_id,
            description: row.description,
            session_scope,
            created_by_user_id,
            idempotency_key: input.idempotency_key.clone(),
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn runtime(&self) -> RuntimeKind {
        self.runtime
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn reasoning_effort(&self) -> Option<&str> {
        self.reasoning_effort.as_deref()
    }

    pub fn fast_mode(&self) -> Option<bool> {
        self.fast_mode
    }

    pub fn host_id(&self) -> &HostId {
        &self.host_id
    }

    pub fn description(&self) -> Option<&str> {
        self.description.as_deref()
    }

    pub fn session_scope(&self) -> AgentSessionScope {
        self.session_scope
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

/// Decode the stored `fast_mode` column: `0`/`1`/null → `Some(false)`/`Some(true)`/`None`,
/// matching the `fast_mode === undefined ? null : fast_mode ? 1 : 0` the reserve writes.
/// Any other integer is a corrupt column, surfaced to the caller as a witness mismatch.
fn decode_fast_mode(raw: Option<i64>) -> Option<Option<bool>> {
    match raw {
        None => Some(None),
        Some(0) => Some(Some(false)),
        Some(1) => Some(Some(true)),
        Some(_) => None,
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

/// The raw witness the activation flip (`pending_materialization → active`) returns,
/// decoded from its `RETURNING` clause. It carries at least the columns the dependent
/// graph is provisioned against — the row's OWN id, handle, session scope, and creator —
/// so the graph names subjects the write proved, never values a caller recited. Typed
/// columns ride back raw for the domain to parse and bind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivationFlipRow {
    /// Decoded from the `RETURNING id`, never the query parameter.
    pub agent_id: AgentId,
    pub name: String,
    pub materialization_status: String,
    pub session_scope: String,
    pub created_by_user_id: String,
    /// The row's OWN creation moment, decoded from `RETURNING created_at`. The direct
    /// line the dependent graph opens rides THIS clock, not the activation clock, so a
    /// retried activation resolves the same durable pair timestamp the first attempt
    /// wrote — matching the row that authored it.
    pub created_at: i64,
    pub updated_at: i64,
}

/// A sealed activation: the row proven to read `active`, bound to the requested agent, with
/// its handle, session scope, and creator parsed from the flip's own after-image. Minted
/// only by [`ActivatedAgent::seal`], so holding one is proof the guarded
/// `pending_materialization → active` flip changed the row and that every identity the
/// dependent graph needs was read from the write's `RETURNING` row — not recited by the
/// caller. It is the input the provisioning unit of work reads to name the direct line's
/// participants and read the creator's handle in the same transaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivatedAgent {
    agent_id: AgentId,
    name: ParticipantHandle,
    session_scope: AgentSessionScope,
    created_by_user_id: UserId,
    created_at: i64,
    updated_at: i64,
}

impl ActivatedAgent {
    /// Bind the flip after-image against the requested agent and seal its identity columns.
    /// A row that names a different agent, is not `active`, or carries an unusable handle,
    /// scope, or creator is a fault — never a sealed activation the graph would build on.
    pub fn seal(
        agent: &AgentId,
        now_ms: i64,
        row: ActivationFlipRow,
    ) -> Result<Self, MaterializationFault> {
        if &row.agent_id != agent {
            return Err(MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness names a different agent than the request",
            });
        }
        let status = MaterializationStatus::parse(&row.materialization_status).map_err(|_| {
            MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness carries an unknown materialization status",
            }
        })?;
        if status != MaterializationStatus::Active {
            return Err(MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness is not active",
            });
        }
        let name = ParticipantHandle::parse(&row.name).map_err(|_| {
            MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness carries an unusable handle",
            }
        })?;
        let session_scope = AgentSessionScope::parse(&row.session_scope).ok_or({
            MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness carries an unknown session scope",
            }
        })?;
        let created_by_user_id = UserId::parse(row.created_by_user_id).map_err(|_| {
            MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness carries an empty creator",
            }
        })?;
        if row.updated_at != now_ms {
            return Err(MaterializationFault::ActivationWitnessMismatch {
                reason: "activation witness updated_at differs from the request clock",
            });
        }
        Ok(Self {
            agent_id: row.agent_id,
            name,
            session_scope,
            created_by_user_id,
            created_at: row.created_at,
            updated_at: now_ms,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn name(&self) -> &ParticipantHandle {
        &self.name
    }

    pub fn session_scope(&self) -> AgentSessionScope {
        self.session_scope
    }

    pub fn created_by_user_id(&self) -> &UserId {
        &self.created_by_user_id
    }

    /// The row's own `created_at`, the clock the direct line is opened on.
    pub fn created_at(&self) -> i64 {
        self.created_at
    }

    pub fn updated_at(&self) -> i64 {
        self.updated_at
    }
}

/// The committed fact of an agent-scoped provisioning: the row is `active` AND its dependent
/// graph — the direct line between the agent and its creator, and the onboarding system
/// message on that line — is written in the same transaction. It carries the minimal
/// post-commit ids that prove the graph, no more: a reader that needs the full agent
/// projection re-reads it through the projection authority. `pair_created` distinguishes a
/// freshly minted line from a get-or-create that resolved an existing one; it is derived
/// from whether the open announced, never from a second read.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentArmProvisioned {
    agent_id: AgentId,
    direct_line: ConversationId,
    onboarding_message_id: MessageId,
    pair_created: bool,
}

impl AgentArmProvisioned {
    /// Seal the committed graph from its sealed sub-facts: the activation (which names the
    /// agent), the direct line the same transaction opened and whether that open minted it,
    /// and the onboarding message's own sealed after-image. This is the ONLY mint — a caller
    /// cannot recite an `active`-and-graph-complete verdict, because each sub-fact is itself
    /// a sealed witness the adapter could not forge, and this function re-checks that the
    /// onboarding message actually landed on the line the provisioning opened. The agent id
    /// and message id are read from those sealed facts, never from parameters.
    pub fn seal(
        activated: &ActivatedAgent,
        direct_line: ConversationId,
        pair_created: bool,
        onboarding: OnboardingWritten,
    ) -> Result<Self, MaterializationFault> {
        if onboarding.conversation() != &direct_line {
            return Err(MaterializationFault::OnboardingWitnessMismatch {
                reason: "onboarding message landed on a line other than the opened direct line",
            });
        }
        Ok(Self {
            agent_id: activated.agent_id().clone(),
            direct_line,
            onboarding_message_id: onboarding.id().clone(),
            pair_created,
        })
    }

    pub fn agent_id(&self) -> &AgentId {
        &self.agent_id
    }

    pub fn direct_line(&self) -> &ConversationId {
        &self.direct_line
    }

    pub fn onboarding_message_id(&self) -> &MessageId {
        &self.onboarding_message_id
    }

    pub fn pair_created(&self) -> bool {
        self.pair_created
    }
}

/// What an in-transaction activation-and-provision observed. `Lost` means the guarded
/// `pending_materialization → active` flip changed no row (the reservation was absent,
/// already `active`, or `failed`): NOTHING was written, so the caller rolls the transaction
/// back and does NOT compensate. `Provisioned` means the flip won and the dependent graph is
/// staged in the same transaction, ready to commit. A dependent-write FAILURE is neither arm
/// — it surfaces as a [`MaterializationFault`], so a win-then-fail is structurally distinct
/// from a lost flip and only the former lets the caller stamp the compensating fail.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentArmActivation {
    Provisioned(AgentArmProvisioned),
    Lost,
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
    host_id: HostId,
    session_scope: AgentSessionScope,
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
        let host_id = HostId::parse(row.host_id).map_err(|_| {
            MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness carries an empty host",
            }
        })?;
        let session_scope = AgentSessionScope::parse(&row.session_scope).ok_or({
            MaterializationFault::LookupWitnessMismatch {
                reason: "idempotency witness carries an unknown session scope",
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
            host_id,
            session_scope,
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

    pub fn host_id(&self) -> &HostId {
        &self.host_id
    }

    pub fn session_scope(&self) -> AgentSessionScope {
        self.session_scope
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
    #[error("activation flip after-image disagreed with the request: {reason}")]
    ActivationWitnessMismatch { reason: &'static str },
    /// A provisioning-stage invariant the dependent graph depends on was broken: the sealed
    /// reservation's creator names no user row, or the arm reached a reservation of the wrong
    /// session scope. Neither is a caller mistake — the reservation is the store's own prior
    /// fact — so it surfaces as a safe `500`, never a product answer.
    #[error("agent provisioning invariant broken: {reason}")]
    ProvisioningInvariant { reason: &'static str },
    #[error("idempotency lookup witness disagreed with the request: {reason}")]
    LookupWitnessMismatch { reason: &'static str },
    /// The onboarding message's sealed after-image landed on a conversation other than the
    /// direct line the same unit of work opened. The graph is internally inconsistent — the
    /// write proved a message on a line the provisioning did not name — so it surfaces as a
    /// safe `500`, never a product answer.
    #[error("agent onboarding witness disagreed with the provisioned graph: {reason}")]
    OnboardingWitnessMismatch { reason: &'static str },
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
/// inserted row or the conflict the adapter's in-transaction preflight detected. The
/// inserted arm is boxed to keep the enum small against the empty conflict arm.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReserveRecord {
    Inserted(Box<ReservedAgentRow>),
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
            ReserveOutcome::Reserved(Box::new(ReservedAgent::seal(input, now_ms, *row)?))
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
        IdempotencyKey::parse("idem-1").expect("idempotency key")
    }

    fn input() -> ReserveAgentInput {
        ReserveAgentInput {
            agent_id: agent("a1"),
            name: ParticipantHandle::parse("a1").unwrap(),
            runtime: RuntimeKind::Codex,
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(true),
            host_id: host("h1"),
            description: Some("d".to_string()),
            session_scope: AgentSessionScope::Conversation,
            created_by_user_id: user("u1"),
            idempotency_key: key(),
        }
    }

    fn faithful_reserved_row(now_ms: i64) -> ReservedAgentRow {
        ReservedAgentRow {
            agent_id: agent("a1"),
            name: "a1".to_string(),
            display_name: "a1".to_string(),
            runtime: "codex".to_string(),
            model: Some("gpt".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: Some(1),
            host_id: "h1".to_string(),
            description: Some("d".to_string()),
            session_scope: "conversation".to_string(),
            created_by_user_id: "u1".to_string(),
            materialization_status: "pending_materialization".to_string(),
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
            reserve: Some(ReserveRecord::Inserted(Box::new(faithful_reserved_row(7)))),
            ..Default::default()
        };
        let ReserveOutcome::Reserved(reserved) = reserve_agent(&port, &input(), 7).await.unwrap()
        else {
            panic!("expected a reserved agent");
        };
        assert_eq!(reserved.agent_id(), &agent("a1"));
        assert_eq!(reserved.name(), "a1");
        assert_eq!(reserved.display_name(), "a1");
        assert_eq!(reserved.runtime(), RuntimeKind::Codex);
        assert_eq!(reserved.model(), Some("gpt"));
        assert_eq!(reserved.reasoning_effort(), Some("high"));
        assert_eq!(reserved.fast_mode(), Some(true));
        assert_eq!(reserved.host_id(), &host("h1"));
        assert_eq!(reserved.description(), Some("d"));
        assert_eq!(reserved.session_scope(), AgentSessionScope::Conversation);
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
        // Every load-bearing column the reserve wrote must replay against the request; a
        // liar-writer that drifts on any one of them is a fault, not a sealed reservation.
        let mut wrong_agent = faithful_reserved_row(7);
        wrong_agent.agent_id = agent("other");

        let mut not_pending = faithful_reserved_row(7);
        not_pending.materialization_status = "active".to_string();

        let mut unknown_status = faithful_reserved_row(7);
        unknown_status.materialization_status = "smuggled".to_string();

        let mut wrong_name = faithful_reserved_row(7);
        wrong_name.name = "other".to_string();

        let mut unmirrored_display = faithful_reserved_row(7);
        unmirrored_display.display_name = "Other".to_string();

        let mut unknown_runtime = faithful_reserved_row(7);
        unknown_runtime.runtime = "smuggled".to_string();

        let mut wrong_runtime = faithful_reserved_row(7);
        wrong_runtime.runtime = "claude".to_string();

        let mut wrong_model = faithful_reserved_row(7);
        wrong_model.model = Some("other".to_string());

        let mut wrong_reasoning = faithful_reserved_row(7);
        wrong_reasoning.reasoning_effort = Some("low".to_string());

        let mut corrupt_fast_mode = faithful_reserved_row(7);
        corrupt_fast_mode.fast_mode = Some(2);

        let mut wrong_fast_mode = faithful_reserved_row(7);
        wrong_fast_mode.fast_mode = Some(0);

        let mut empty_host = faithful_reserved_row(7);
        empty_host.host_id = String::new();

        let mut wrong_host = faithful_reserved_row(7);
        wrong_host.host_id = "h2".to_string();

        let mut wrong_description = faithful_reserved_row(7);
        wrong_description.description = None;

        let mut unknown_scope = faithful_reserved_row(7);
        unknown_scope.session_scope = "smuggled".to_string();

        let mut wrong_scope = faithful_reserved_row(7);
        wrong_scope.session_scope = "agent".to_string();

        let mut empty_creator = faithful_reserved_row(7);
        empty_creator.created_by_user_id = String::new();

        let mut wrong_creator = faithful_reserved_row(7);
        wrong_creator.created_by_user_id = "u2".to_string();

        let mut wrong_key = faithful_reserved_row(7);
        wrong_key.idempotency_key = Some("other".to_string());

        let mut missing_key = faithful_reserved_row(7);
        missing_key.idempotency_key = None;

        let mut wrong_created_at = faithful_reserved_row(7);
        wrong_created_at.created_at = 8;

        let mut wrong_updated_at = faithful_reserved_row(7);
        wrong_updated_at.updated_at = 8;

        for row in [
            wrong_agent,
            not_pending,
            unknown_status,
            wrong_name,
            unmirrored_display,
            unknown_runtime,
            wrong_runtime,
            wrong_model,
            wrong_reasoning,
            corrupt_fast_mode,
            wrong_fast_mode,
            empty_host,
            wrong_host,
            wrong_description,
            unknown_scope,
            wrong_scope,
            empty_creator,
            wrong_creator,
            wrong_key,
            missing_key,
            wrong_created_at,
            wrong_updated_at,
        ] {
            let port = ScriptedWrite {
                reserve: Some(ReserveRecord::Inserted(Box::new(row))),
                ..Default::default()
            };
            assert!(matches!(
                reserve_agent(&port, &input(), 7).await.unwrap_err(),
                MaterializationFault::ReserveWitnessMismatch { .. }
            ));
        }
    }

    #[test]
    fn idempotency_key_admits_only_the_route_envelope() {
        assert!(IdempotencyKey::parse("idem-1").is_ok());
        assert!(IdempotencyKey::parse("A_z0-9").is_ok());
        assert!(IdempotencyKey::parse("a".repeat(64)).is_ok());
        // Empty, over-length, illegal punctuation, whitespace, and multi-byte are all out
        // of the `/^[A-Za-z0-9_-]{1,64}$/` envelope.
        assert!(IdempotencyKey::parse("").is_err());
        assert!(IdempotencyKey::parse("a".repeat(65)).is_err());
        assert!(IdempotencyKey::parse("has space").is_err());
        assert!(IdempotencyKey::parse("dots.not.ok").is_err());
        assert!(IdempotencyKey::parse("café").is_err());
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

    fn faithful_activation_row(now_ms: i64) -> ActivationFlipRow {
        ActivationFlipRow {
            agent_id: agent("a1"),
            name: "a1".to_string(),
            materialization_status: "active".to_string(),
            session_scope: "agent".to_string(),
            created_by_user_id: "u1".to_string(),
            created_at: 10,
            updated_at: now_ms,
        }
    }

    #[test]
    fn activation_seals_a_bound_active_row() {
        let sealed = ActivatedAgent::seal(&agent("a1"), 7, faithful_activation_row(7)).unwrap();
        assert_eq!(sealed.agent_id(), &agent("a1"));
        assert_eq!(sealed.name(), &ParticipantHandle::parse("a1").unwrap());
        assert_eq!(sealed.session_scope(), AgentSessionScope::Agent);
        assert_eq!(sealed.created_by_user_id(), &user("u1"));
        assert_eq!(sealed.updated_at(), 7);
        // The row's own created_at (10) rides the seal independent of the activation clock (7),
        // so the dependent direct line can be opened on the row's durable timestamp.
        assert_eq!(sealed.created_at(), 10);
    }

    #[test]
    fn activation_rejects_a_witness_that_disagrees() {
        // The activation is the ONLY reader that binds the graph's subjects; a flip
        // after-image that drifts on the agent, status, handle, scope, creator, or clock is
        // a fault, never a sealed activation the dependent graph would build on.
        let mut wrong_agent = faithful_activation_row(7);
        wrong_agent.agent_id = agent("other");

        let mut not_active = faithful_activation_row(7);
        not_active.materialization_status = "pending_materialization".to_string();

        let mut unknown_status = faithful_activation_row(7);
        unknown_status.materialization_status = "smuggled".to_string();

        let mut unusable_handle = faithful_activation_row(7);
        unusable_handle.name = String::new();

        let mut unknown_scope = faithful_activation_row(7);
        unknown_scope.session_scope = "smuggled".to_string();

        let mut empty_creator = faithful_activation_row(7);
        empty_creator.created_by_user_id = String::new();

        let mut wrong_stamp = faithful_activation_row(7);
        wrong_stamp.updated_at = 8;

        for row in [
            wrong_agent,
            not_active,
            unknown_status,
            unusable_handle,
            unknown_scope,
            empty_creator,
            wrong_stamp,
        ] {
            assert!(matches!(
                ActivatedAgent::seal(&agent("a1"), 7, row).unwrap_err(),
                MaterializationFault::ActivationWitnessMismatch { .. }
            ));
        }
    }

    fn onboarding_written_on(
        line: &ConversationId,
        id: &str,
    ) -> crate::messaging::agent_onboarding::OnboardingWritten {
        use crate::messaging::agent_onboarding::{OnboardingSystemMessage, OnboardingWriteWitness};
        let intent = OnboardingSystemMessage::agent_direct_line(
            line.clone(),
            crate::messaging::MessageId::parse(id).unwrap(),
            &crate::messaging::ParticipantHandle::parse("a1").unwrap(),
            &crate::messaging::ParticipantHandle::parse("u1").unwrap(),
            7,
        );
        intent
            .seal_written(OnboardingWriteWitness {
                id: id.to_string(),
                conversation: line.as_str().to_string(),
                from_kind: "system".to_string(),
                subtype: Some("onboarding".to_string()),
                seq: 1,
                head_latest_seq: 1,
            })
            .unwrap()
    }

    #[test]
    fn provisioned_seal_mints_from_sealed_sub_facts() {
        let activated = ActivatedAgent::seal(&agent("a1"), 7, faithful_activation_row(7)).unwrap();
        let line = ConversationId::parse("pair-1").unwrap();
        let onboarding = onboarding_written_on(&line, "msg-1");

        let provisioned =
            AgentArmProvisioned::seal(&activated, line.clone(), true, onboarding).unwrap();
        // The ids ride the sealed facts, never a parameter: the agent from the activation, the
        // message from the onboarding write, the line from the opened pair.
        assert_eq!(provisioned.agent_id(), &agent("a1"));
        assert_eq!(provisioned.direct_line(), &line);
        assert_eq!(
            provisioned.onboarding_message_id(),
            &crate::messaging::MessageId::parse("msg-1").unwrap()
        );
        assert!(provisioned.pair_created());
    }

    #[test]
    fn provisioned_seal_rejects_an_onboarding_message_on_a_foreign_line() {
        let activated = ActivatedAgent::seal(&agent("a1"), 7, faithful_activation_row(7)).unwrap();
        // The message was sealed as written on `pair-1`, but the pair the provisioning opened is
        // `pair-2`: the graph is internally inconsistent and must not mint a verdict.
        let onboarding = onboarding_written_on(&ConversationId::parse("pair-1").unwrap(), "msg-1");
        assert!(matches!(
            AgentArmProvisioned::seal(
                &activated,
                ConversationId::parse("pair-2").unwrap(),
                true,
                onboarding,
            )
            .unwrap_err(),
            MaterializationFault::OnboardingWitnessMismatch { .. }
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
        assert_eq!(hit.session_scope(), AgentSessionScope::Conversation);
        assert_eq!(hit.host_id(), &host("h1"));
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

        let mut empty_host = faithful_lookup_row();
        empty_host.host_id = String::new();

        let mut unknown_scope = faithful_lookup_row();
        unknown_scope.session_scope = "smuggled".to_string();

        for row in [
            wrong_creator,
            wrong_key,
            unknown_runtime,
            empty_host,
            unknown_scope,
        ] {
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
