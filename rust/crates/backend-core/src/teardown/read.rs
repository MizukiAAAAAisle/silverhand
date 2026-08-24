//! The pre-lock reads both cascades take, and the reason they are only HINTS.
//!
//! Every cascade must read before it writes. The single-agent path dispatches on
//! the stage and purges host-local files fail-closed — remote IO inside a write
//! lock would destroy bytes for a request that then rolls back — and the computer
//! path answers "not yours" without taking a write lock to say no.
//!
//! None of it is the decision. The authoritative facts are re-read inside the
//! mechanism ([`crate::teardown::write::AgentTeardownUnitOfWork`]) and judged there
//! by [`crate::teardown::eligibility::eligibility_moved`] and
//! [`crate::teardown::cascade::cascade_refusal`]. A cascade that trusted this face
//! would delete an agent that moved computer meanwhile, or tear down a row whose
//! materialization restarted.

use std::future::Future;

use crate::{
    identity::{AgentId, HostId},
    persistence::PersistenceFailure,
    teardown::facts::{AgentRuntimeSessionFacts, AgentTeardownFacts, ComputerTeardownFacts},
};

/// The read-only face, safe outside any transaction.
pub trait AgentTeardownReadPort: Clone + Send + Sync + 'static {
    /// Pre-flight dispatch and purge routing. Absent when the id is unknown.
    fn read_agent_facts(
        &self,
        agent_id: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentTeardownFacts>, PersistenceFailure>> + Send;

    /// Whether a durable deletion intent exists for this agent. Narrower than
    /// [`Self::read_agent_facts`] on purpose: the outbound dispatch gate consults
    /// it per frame, and it must not depend on a projection that would let a new
    /// column become an input to a routing decision.
    fn is_deletion_pending(
        &self,
        agent_id: &AgentId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;

    /// The pre-commit stop list for the single-agent path — a hint like the rest of
    /// this face. The capture taken inside the write is the authoritative live set
    /// and is re-stopped in FULL afterwards, so a seat this one stopped early is
    /// stopped again rather than trusted.
    fn list_runtime_sessions(
        &self,
        agent_id: &AgentId,
    ) -> impl Future<Output = Result<Vec<AgentRuntimeSessionFacts>, PersistenceFailure>> + Send;

    /// Pre-flight ownership and lifecycle refusals for the computer path.
    fn read_computer_facts(
        &self,
        host_id: &HostId,
    ) -> impl Future<Output = Result<Option<ComputerTeardownFacts>, PersistenceFailure>> + Send;
}
