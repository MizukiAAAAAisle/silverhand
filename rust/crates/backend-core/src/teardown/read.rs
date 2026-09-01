//! The pre-lock reads both cascades take, and the reason they are only HINTS.
//!
//! Every cascade must read before it writes. The single-agent path dispatches on
//! the stage and purges host-local files fail-closed — remote IO inside a write
//! lock would destroy bytes for a request that then rolls back — and the computer
//! path answers "not yours" without taking a write lock to say no.
//!
//! None of it is the decision. The authoritative facts are re-read inside the
//! mechanism ([`crate::teardown::write::AgentTeardownUnitOfWork`]) and judged there
//! by [`crate::teardown::eligibility::hold_eligibility`] and
//! [`crate::teardown::cascade::admit_cascade`]. A cascade that trusted this face
//! would delete an agent that moved computer meanwhile, or tear down a row whose
//! materialization restarted.

use std::future::Future;

use crate::{
    foundation::identity::{AgentId, HostId},
    foundation::persistence::PersistenceFailure,
    identity_access::capability::computer_access::ComputerOwnershipFacts,
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

    /// Whose computer this is, for the pre-flight access refusal. Absent when the
    /// id is unknown, which that rule folds into the same answer as "someone
    /// else's".
    fn read_computer_ownership(
        &self,
        host_id: &HostId,
    ) -> impl Future<Output = Result<Option<ComputerOwnershipFacts>, PersistenceFailure>> + Send;

    /// The lifecycle halves, for the pre-flight refusal that a platform-owned
    /// computer is not a user request's to end. Separate from
    /// [`Self::read_computer_ownership`] because the two rules are separate: one
    /// projection serving both would let either rule read a fact it has no business
    /// deciding on.
    fn read_computer_lifecycle(
        &self,
        host_id: &HostId,
    ) -> impl Future<Output = Result<Option<ComputerTeardownFacts>, PersistenceFailure>> + Send;
}
