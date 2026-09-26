//! What it means for a teardown's facts to have been SPLICED.
//!
//! Every rule here mints a witness over facts it was handed, and every witness
//! names the row it judged. That is enough to stop an implementation from committing
//! on a comparison it re-stated — but not from assembling one committed outcome out
//! of witnesses and captures about DIFFERENT rows, each individually well-formed.
//! The seals that close that ask this module's questions, and every answer here is
//! the same class of answer: an implementation composed facts that do not describe
//! one aggregate.
//!
//! None of these is a product refusal. A user cannot cause one and cannot act on
//! one: a request whose coordinates do not line up is a defect in the code that read
//! them, so it must surface as its own failure class rather than as a 409 the caller
//! is invited to retry. That is why [`TeardownFailure`] keeps it separate from
//! infrastructure failing, which the same call can also do for reasons nobody wrote.

use thiserror::Error;

use crate::{
    foundation::identity::{AgentId, HostId, UserId},
    foundation::persistence::PersistenceFailure,
};

/// Facts that do not describe one aggregate were composed.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum TeardownContractViolation {
    /// Two facts about different computers, or a request naming one computer
    /// answered with facts about another.
    #[error("teardown facts describe computer {found:?} but {expected:?} was expected")]
    ComputerMismatch { expected: HostId, found: HostId },
    /// Two facts about different agents, or a request naming one agent answered
    /// with facts about another.
    #[error("teardown facts describe agent {found:?} but {expected:?} was expected")]
    AgentMismatch { expected: AgentId, found: AgentId },
    /// A committed teardown reported for a requester other than the one whose
    /// authorization it rests on.
    #[error("teardown was authorized for {expected:?} but reported for {found:?}")]
    RequesterMismatch { expected: UserId, found: UserId },
    /// The reported full teardowns are not exactly the admitted set: one is missing,
    /// one was never admitted, or one is reported twice. All three are the same
    /// defect — a cascade whose report is not the cascade that ran.
    #[error("reported teardowns are not the admitted dependent set")]
    DependentSetMismatch {
        admitted: Vec<AgentId>,
        reported: Vec<AgentId>,
    },
}

/// Why a teardown write did not produce an outcome.
///
/// Two arms, and deliberately not one: infrastructure failing is expected and
/// retryable, while a spliced composition is a defect that no retry changes.
/// Collapsing them would put a code bug behind a message that sends an operator to
/// look at a driver.
#[derive(Debug, Error)]
pub enum TeardownFailure {
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
    #[error(transparent)]
    Contract(#[from] TeardownContractViolation),
}

/// Both facts must name the same computer.
pub(crate) fn same_computer(
    expected: &HostId,
    found: &HostId,
) -> Result<(), TeardownContractViolation> {
    if expected == found {
        return Ok(());
    }
    Err(TeardownContractViolation::ComputerMismatch {
        expected: expected.clone(),
        found: found.clone(),
    })
}

/// Both facts must name the same agent.
pub(crate) fn same_agent(
    expected: &AgentId,
    found: &AgentId,
) -> Result<(), TeardownContractViolation> {
    if expected == found {
        return Ok(());
    }
    Err(TeardownContractViolation::AgentMismatch {
        expected: expected.clone(),
        found: found.clone(),
    })
}
