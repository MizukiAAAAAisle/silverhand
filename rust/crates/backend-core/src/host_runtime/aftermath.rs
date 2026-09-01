//! What a change of custody owes the rest of the system once it has committed.
//!
//! Every port here is best-effort BY CONTRACT: the transaction is already durable when
//! they are called, so nothing they report may become a refusal — the computer is
//! revoked whether or not anyone was told. What a failure may still do is be reported,
//! which is why each one returns a source-preserving failure rather than nothing: "the
//! fan-out did not happen" is only actionable with the reason attached, and a port that
//! could not name one would make the silence permanent.
//!
//! They are ports because neither effect has a producer in this backend yet, and they
//! are REQUIRED dependencies — never `Option` — for exactly that reason. The
//! composition root cannot mount a custody door until something real answers them, and
//! a no-op standing in for a missing producer would let a revoke ship that leaves every
//! viewer looking at an Online agent on a computer that no longer exists.

use std::error::Error;

use thiserror::Error as ThisError;

use crate::identity::HostId;

/// One post-commit attempt failed.
///
/// Distinct from [`PersistenceFailure`](crate::foundation::persistence::PersistenceFailure) because
/// the two are read differently by whoever is paged: a persistence failure means the
/// operation may not have happened, and this means it did happen and someone was not
/// told.
#[derive(Debug, ThisError)]
#[error("a post-commit custody effect could not be completed")]
pub struct CustodyEffectFailure {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl CustodyEffectFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// Tell viewers that the agents on a computer have a new availability.
pub trait AgentAvailabilityAnnouncer: Clone + Send + Sync + 'static {
    /// Announce for the WHOLE computer, carrying no availability value.
    ///
    /// Availability is derived from the computer's custody, so the computer is the
    /// coordinate that changed and the value is the reader's to recompute. An
    /// announcement that carried a value would be a second, cached answer to a question
    /// the read face already owns, and the two would eventually disagree.
    ///
    /// It is driven from the committed fact rather than from a socket teardown: an
    /// embedded computer has no connection to tear down, and its agents went Offline
    /// just the same.
    fn agents_availability_changed(
        &self,
        computer: HostId,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;
}

/// Control over the live connection a computer's daemon holds.
pub trait DaemonConnectionControl: Clone + Send + Sync + 'static {
    /// Drop this computer's daemon connection, if it has one.
    ///
    /// "If it has one" is the adapter's answer, not a caller's precondition: a computer
    /// running in-process never had a host connection, and a remote one may have lost it
    /// a second ago. Neither is a failure, and neither may make a caller ask first —
    /// asking would put a second copy of "is this computer connected" in front of the
    /// only component that knows.
    ///
    /// This is optimistic UX, never the authoritative effect of ending custody. The
    /// credential sweep is what stops the daemon from coming back; closing the socket
    /// only stops it from finishing the request it is in the middle of.
    fn disconnect(
        &self,
        computer: HostId,
    ) -> impl Future<Output = Result<(), CustodyEffectFailure>> + Send;
}
