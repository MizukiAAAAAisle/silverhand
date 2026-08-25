//! The computer write axis: delete a computer and everything rooted on it.
//!
//! One `BEGIN IMMEDIATE` reserves the single writer, then the three authorizations
//! are re-asked UNDER the lock in the order the witness chain fixes — is it theirs
//! ([`can_access_computer`]), may its lifecycle end ([`hold_computer_lifecycle`]),
//! does its dependency set admit the cascade ([`admit_cascade`]) — from facts read
//! inside the lock, never from a pre-flight hint. Access and lifecycle refusals both
//! collapse to `ComputerGone`: the two are indistinguishable to the requester, and
//! the conditional host-row delete re-states the same legality in its own `WHERE`, so
//! a lost race there rolls the whole scope back rather than reporting a delete this
//! request did not cause.
//!
//! Foreign keys do the fan-out. Every admitted agent row is deleted through the
//! single-agent primitive, and only then the host row — `agents.host_id` is
//! `ON DELETE RESTRICT`, so the host cannot go first. A full-teardown dependent has
//! its post-commit work captured before its delete erases the rows that work reads.

use silverhand_backend_core::{
    capability::computer_access::{ComputerAccess, can_access_computer},
    persistence::PersistenceFailure,
    teardown::{
        cascade::{
            CascadeAdmission, CascadeConsent, ComputerLifecycle, admit_cascade,
            hold_computer_lifecycle,
        },
        contract::TeardownFailure,
        eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
        write::{AgentTornDown, ComputerCascade, ComputerCascadeCommit, ComputerTeardownKey},
    },
};

use super::{
    facts::{
        capture_agent, select_agents_on_host, select_computer_lifecycle, select_computer_ownership,
    },
    store::SqliteHostAgentStore,
    teardown::DELETE_AGENT,
};

/// Re-states the legality the witness chain established, so a computer that stopped
/// being a user-managed remote this requester owns matches nothing here and the
/// scope rolls back. The witness answers are the optimization; this `WHERE` is the
/// guarantee.
const DELETE_OWNED_USER_INVITE: &str = "DELETE FROM hosts \
     WHERE id = ? AND user_id = ? AND kind = 'remote' AND provisioning_source = 'user_invite'";

pub(super) async fn cascade_computer(
    store: &SqliteHostAgentStore,
    key: ComputerTeardownKey,
    consent: CascadeConsent,
) -> Result<ComputerCascadeCommit, TeardownFailure> {
    let mut tx = store
        .begin_root_write()
        .await
        .map_err(PersistenceFailure::from_source)?;

    let ownership = select_computer_ownership(&mut tx, &key.host_id)
        .await
        .map_err(PersistenceFailure::from_source)?;
    let ComputerAccess::Held(access) = can_access_computer(&key.user_id, ownership.as_ref()) else {
        return Ok(ComputerCascadeCommit::ComputerGone);
    };

    let lifecycle = match select_computer_lifecycle(&mut tx, &key.host_id)
        .await
        .map_err(PersistenceFailure::from_source)?
    {
        Some(facts) => facts,
        None => return Ok(ComputerCascadeCommit::ComputerGone),
    };
    let ComputerLifecycle::Held(lifecycle) = hold_computer_lifecycle(access, lifecycle)? else {
        return Ok(ComputerCascadeCommit::ComputerGone);
    };

    let dependents = select_agents_on_host(&mut tx, &key.host_id)
        .await
        .map_err(PersistenceFailure::from_source)?;
    let admitted = match admit_cascade(lifecycle, dependents, consent)? {
        CascadeAdmission::Refused(refused) => return Ok(ComputerCascadeCommit::Refused(refused)),
        CascadeAdmission::Admitted(admitted) => admitted,
    };

    let expected = AgentTeardownEligibility::ActiveOn {
        host_id: key.host_id.clone(),
    };
    let mut torn_down = Vec::new();
    for agent in admitted.full_teardowns() {
        let id = agent.id.clone();
        let EligibilityVerdict::Held(held) = hold_eligibility(&expected, agent) else {
            unreachable!("admit_cascade classified this dependent as active on this computer");
        };
        let capture = capture_agent(&mut tx, &id)
            .await
            .map_err(PersistenceFailure::from_source)?;
        sqlx::query(DELETE_AGENT)
            .bind(id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
        torn_down.push(AgentTornDown::seal(&id, held, capture)?);
    }
    for agent in admitted.row_only() {
        sqlx::query(DELETE_AGENT)
            .bind(agent.id.as_str())
            .execute(&mut *tx)
            .await
            .map_err(PersistenceFailure::from_source)?;
    }

    let deleted = sqlx::query(DELETE_OWNED_USER_INVITE)
        .bind(key.host_id.as_str())
        .bind(key.user_id.as_str())
        .execute(&mut *tx)
        .await
        .map_err(PersistenceFailure::from_source)?;
    if deleted.rows_affected() != 1 {
        return Ok(ComputerCascadeCommit::ComputerGone);
    }

    let cascade = ComputerCascade::seal(&key, admitted, torn_down)?;
    tx.commit().await.map_err(PersistenceFailure::from_source)?;
    Ok(ComputerCascadeCommit::Committed(cascade))
}
