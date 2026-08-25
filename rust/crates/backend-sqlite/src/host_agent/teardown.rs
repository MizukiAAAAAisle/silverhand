//! The single-agent write axis, and the one place the write boundary is spoken.
//!
//! Rust admits a trait through one impl block, so [`AgentTeardownUnitOfWork`] is
//! implemented here for [`SqliteHostAgentStore`]: this file owns `tear_down_agent`
//! inline and delegates the computer axis to [`super::cascade`], keeping the trait
//! surface in one place while each axis keeps its own mechanism.
//!
//! `tear_down_agent` reserves the writer, re-reads the agent's eligibility UNDER the
//! lock, and only then captures and deletes — the re-read is what makes the caller's
//! pre-lock decision safe. The delete touches ONLY the agent row; foreign-key
//! cascades erase the workspace, its conversations and their attachments, which is
//! why the capture is taken first: the storage keys vanish with the rows.

use silverhand_backend_core::{
    persistence::PersistenceFailure,
    teardown::{
        cascade::CascadeConsent,
        contract::TeardownFailure,
        eligibility::{AgentTeardownEligibility, EligibilityVerdict, hold_eligibility},
        write::{
            AgentTeardownCommit, AgentTeardownKey, AgentTeardownUnitOfWork, AgentTornDown,
            ComputerCascadeCommit, ComputerTeardownKey,
        },
    },
};

use super::{
    cascade,
    facts::{capture_agent, select_agent_facts},
    store::SqliteHostAgentStore,
};

/// The single-agent-row delete both write axes use: this axis deletes the one row
/// it re-read, and the computer cascade deletes each dependent through it. Foreign
/// keys erase everything the row owned.
pub(super) const DELETE_AGENT: &str = "DELETE FROM agents WHERE id = ?";

impl AgentTeardownUnitOfWork for SqliteHostAgentStore {
    async fn tear_down_agent(
        &self,
        key: AgentTeardownKey,
        expected: AgentTeardownEligibility,
    ) -> Result<AgentTeardownCommit, TeardownFailure> {
        let mut tx = self
            .begin_root_write()
            .await
            .map_err(PersistenceFailure::from_source)?;

        let facts = match select_agent_facts(&mut tx, &key.agent_id)
            .await
            .map_err(PersistenceFailure::from_source)?
        {
            Some(facts) => facts,
            None => return Ok(AgentTeardownCommit::Gone),
        };

        match hold_eligibility(&expected, facts.clone()) {
            EligibilityVerdict::Moved(moved) => Ok(AgentTeardownCommit::Moved {
                moved,
                facts: Box::new(facts),
            }),
            EligibilityVerdict::Held(held) => {
                let capture = capture_agent(&mut tx, &key.agent_id)
                    .await
                    .map_err(PersistenceFailure::from_source)?;
                sqlx::query(DELETE_AGENT)
                    .bind(key.agent_id.as_str())
                    .execute(&mut *tx)
                    .await
                    .map_err(PersistenceFailure::from_source)?;
                let torn = AgentTornDown::seal(&key.agent_id, held, capture)?;
                tx.commit().await.map_err(PersistenceFailure::from_source)?;
                Ok(AgentTeardownCommit::Committed(Box::new(torn)))
            }
        }
    }

    async fn cascade_computer(
        &self,
        key: ComputerTeardownKey,
        consent: CascadeConsent,
    ) -> Result<ComputerCascadeCommit, TeardownFailure> {
        cascade::cascade_computer(self, key, consent).await
    }
}
