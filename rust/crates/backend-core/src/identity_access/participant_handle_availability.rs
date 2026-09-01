//! Is a proposed participant @-handle still free? — the read behind
//! `GET /api/agents/name-availability`.
//!
//! A participant handle lives in ONE global namespace shared by agents AND human
//! users (`agents.name` UNIQUE + `users.name` UNIQUE + the cross-namespace
//! triggers). "Is this handle free" is therefore NOT a question the agent bounded
//! context owns: it spans both tables, and the answer must be identical whether it
//! is asked by the agent-create form, this probe, or password signup. The one
//! authority for that cross-context question is
//! [`HandleNamespaceRead`](crate::identity_access::human_auth_flows::HandleNamespaceRead); this
//! module composes it with the shared handle FORMAT authority
//! ([`ParticipantHandle::parse`]) so the probe can never report `available` for a
//! handle create would refuse.
//!
//! ## Format is settled FIRST, and short-circuits
//!
//! A malformed handle has no namespace membership to look up and must never reach
//! storage: [`probe_participant_handle`] yields [`Invalid`](ParticipantHandleAvailability::Invalid)
//! having made ZERO port calls. Only a handle that parsed — and is therefore the
//! exact byte sequence a create would store — is looked up. Which format rule
//! refused (empty, over-64, or a character outside the ASCII grammar) is
//! deliberately dropped: this endpoint publishes one undifferentiated `invalid`,
//! mirroring the TypeScript route's `{ available:false, reason:'invalid' }`.
//!
//! ## This is an ADVISORY read
//!
//! Nothing is reserved. `Available` means "neither table held this exact handle at
//! the instant of the read"; a create racing this probe can take it a millisecond
//! later. The terminal authority is the create unit of work plus the UNIQUE indexes
//! and cross-namespace triggers. The single guarantee is CONSISTENCY: the `Invalid`
//! verdict is produced by the very [`ParticipantHandle::parse`] the create path must
//! use, and the lookup is the exact-match `HandleNamespaceRead` both create paths
//! consult, so the probe and the write compare the same handle by the same rule.
//!
//! The verdict is viewer-INDEPENDENT — every authenticated caller gets the same
//! answer for the same handle — which is why the HTTP boundary still demands an
//! authenticated principal before calling (the server layer's concern); a read that
//! does not vary by viewer has no natural reminder it sits behind the perimeter.

use crate::{
    identity_access::human_auth_flows::HandleNamespaceRead,
    identity_access::user_identity::ParticipantHandle, persistence::PersistenceFailure,
};

/// The verdict, as ONE value with three arms.
///
/// The wire carries two fields (`available` and `reason`) that are not independent:
/// `available` is true exactly when the reason is `available`. Projecting both from
/// this single enum in the server layer is what makes the contradictory pair —
/// `available: true` with `reason: "taken"` — unrepresentable rather than merely
/// untested, matching the product `NameAvailabilityDtoSchema` refinement.
///
/// It carries no wire vocabulary of its own: the `available`/`invalid`/`taken`
/// strings are the server layer's mapping, so this domain value stays free of the
/// route's projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ParticipantHandleAvailability {
    /// The handle cannot be stored under any circumstances — empty, over the 64
    /// UTF-16-unit cap, or carrying a character outside the ASCII handle grammar. No
    /// lookup was performed. The specific format rule is deliberately dropped: this
    /// endpoint publishes one undifferentiated `invalid`.
    Invalid,
    /// Neither `agents` nor `users` held the exact handle at the instant of the read.
    /// Advisory, not a reservation.
    Available,
    /// An agent OR a user already holds the exact handle.
    Taken,
}

impl ParticipantHandleAvailability {
    /// Whether the boundary should report the handle as free. Derived from the arm
    /// rather than stored beside a reason, so the two wire fields cannot disagree.
    pub fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }
}

/// Probe one proposed handle against the shared agents∪users handle namespace.
///
/// Format is settled first and short-circuits: a malformed handle yields
/// [`Invalid`](ParticipantHandleAvailability::Invalid) having made ZERO port calls.
/// Only a parsed handle is looked up, via the exact-match cross-namespace authority,
/// and a namespace failure is surfaced as a [`PersistenceFailure`] the server maps to
/// the safe `500` — never a product verdict.
pub async fn probe_participant_handle<N>(
    namespace: &N,
    raw: &str,
) -> Result<ParticipantHandleAvailability, PersistenceFailure>
where
    N: HandleNamespaceRead,
{
    let handle = match ParticipantHandle::parse(raw) {
        Ok(handle) => handle,
        // Every format refusal collapses into one `Invalid`. Which rule fired is not
        // this endpoint's contract, so the issue is dropped here rather than carried
        // outward, and NO port call is made for input the create path would reject.
        Err(_invalid) => return Ok(ParticipantHandleAvailability::Invalid),
    };
    if namespace.is_handle_taken(&handle).await? {
        Ok(ParticipantHandleAvailability::Taken)
    } else {
        Ok(ParticipantHandleAvailability::Available)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io,
        sync::Mutex,
        sync::atomic::{AtomicUsize, Ordering},
    };

    /// Records how many lookups it was asked for so a test can prove a malformed
    /// handle never touches the namespace, and answers with whatever fact the case
    /// wants — including a failure.
    #[derive(Clone)]
    struct FakeNamespace {
        answer: Result<bool, ()>,
        asked: std::sync::Arc<Mutex<Vec<String>>>,
        calls: std::sync::Arc<AtomicUsize>,
    }

    impl FakeNamespace {
        fn taken() -> Self {
            Self::with(Ok(true))
        }

        fn free() -> Self {
            Self::with(Ok(false))
        }

        fn broken() -> Self {
            Self::with(Err(()))
        }

        fn with(answer: Result<bool, ()>) -> Self {
            Self {
                answer,
                asked: std::sync::Arc::new(Mutex::new(Vec::new())),
                calls: std::sync::Arc::new(AtomicUsize::new(0)),
            }
        }

        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl HandleNamespaceRead for FakeNamespace {
        async fn is_handle_taken(
            &self,
            handle: &ParticipantHandle,
        ) -> Result<bool, PersistenceFailure> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.asked.lock().unwrap().push(handle.as_str().to_owned());
            self.answer
                .map_err(|()| PersistenceFailure::from_source(io::Error::other("namespace down")))
        }
    }

    #[tokio::test]
    async fn a_free_handle_is_available() {
        let namespace = FakeNamespace::free();

        let verdict = probe_participant_handle(&namespace, "Alice_9-x")
            .await
            .unwrap();

        assert_eq!(verdict, ParticipantHandleAvailability::Available);
        assert!(verdict.is_available());
        // The exact bytes are what the namespace was asked about — handles are stored
        // verbatim with no fold.
        assert_eq!(namespace.asked(), ["Alice_9-x"]);
    }

    #[tokio::test]
    async fn a_held_handle_is_taken() {
        let namespace = FakeNamespace::taken();

        let verdict = probe_participant_handle(&namespace, "alice").await.unwrap();

        assert_eq!(verdict, ParticipantHandleAvailability::Taken);
        assert!(!verdict.is_available());
    }

    #[tokio::test]
    async fn the_lookup_is_case_sensitive_exactly_as_stored() {
        // `getByName` matches exactly (no COLLATE): a different case is a different
        // handle, so what the probe asks about must be the verbatim spelling.
        let namespace = FakeNamespace::free();

        probe_participant_handle(&namespace, "ALICE").await.unwrap();

        assert_eq!(namespace.asked(), ["ALICE"]);
    }

    #[tokio::test]
    async fn a_malformed_handle_is_invalid_without_touching_the_namespace() {
        // One case per format rule — empty, non-letter lead, illegal character, over
        // the 64 cap — all published as the same undifferentiated `Invalid`, and none
        // allowed to reach storage.
        for raw in ["", "1abc", "a b", "a.b", "@alice", &"a".repeat(65)] {
            let namespace = FakeNamespace::taken();

            let verdict = probe_participant_handle(&namespace, raw).await.unwrap();

            assert_eq!(
                verdict,
                ParticipantHandleAvailability::Invalid,
                "{raw:?} must be invalid"
            );
            assert!(!verdict.is_available());
            assert!(
                namespace.asked().is_empty(),
                "{raw:?} has no membership, so nothing may be looked up"
            );
        }
    }

    #[tokio::test]
    async fn a_namespace_failure_never_becomes_a_product_verdict() {
        let namespace = FakeNamespace::broken();

        probe_participant_handle(&namespace, "alice")
            .await
            .expect_err("a failed lookup has no verdict");
    }
}
