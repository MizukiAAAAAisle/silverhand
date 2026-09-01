//! Is a proposed regular-workspace name still free? — the read behind
//! `GET /api/workspaces/name-availability`.
//!
//! This is a DIFFERENT question from [`crate::identity_access::workspace_name`]'s. That module
//! answers whether a name is *storable at all* (format), a verdict computable from
//! the string alone. This one answers whether the regular-workspace namespace
//! *already holds* the name's folded key — a database fact about other rows. The
//! two are composed here, in that order, because a malformed name has no key to
//! look up and must never reach the database.
//!
//! ## The namespace is REGULAR workspaces only
//!
//! An agent-home workspace stores no `name_key` (`owner_agent_id IS NOT NULL`,
//! `name_key IS NULL`) and so is not in this namespace at all. A home named
//! "Agent Home" does not make "Agent Home" taken for a regular workspace. That is
//! not an adapter detail to be discovered from SQL: it is the definition of the
//! namespace this module speaks for, and [`RegularWorkspaceNamespace`] is named for
//! it so no implementation can quietly widen the set.
//!
//! Membership is likewise NOT consulted. Uniqueness is global across the product's
//! regular workspaces, so a name held by a workspace the caller cannot even see is
//! still taken. The answer is viewer-INDEPENDENT — every authenticated caller gets
//! the same verdict for the same name — which is exactly why the HTTP boundary
//! still demands an authenticated principal before calling: a route whose result
//! does not vary by viewer has no natural reminder that it is behind the perimeter,
//! so the requirement is made structural there rather than inferred here.
//!
//! ## This is an ADVISORY read, and says so
//!
//! Nothing is reserved. `Available` means "no regular workspace held this key at
//! the instant of the read", and a create racing this probe can take the name a
//! millisecond later. The terminal uniqueness authority is the create unit of work
//! plus the unique index on `workspaces.name_key`; this module exists so a person
//! typing a name learns the likely answer before they submit, and it must never be
//! read as a reservation. The single guarantee worth having is CONSISTENCY: the
//! `Invalid` verdict is produced by the very same [`CanonicalWorkspaceName::parse`]
//! the create path must use, so the probe can never report `available` for a name
//! create would refuse as malformed.
//!
//! ## The positive answer is identity-bound
//!
//! `Taken` is a claim about a specific key. A lookup adapter therefore returns the
//! row's OWN `name_key` ([`HeldName`]) rather than a boolean, and
//! [`probe_workspace_name`] binds it against the key it asked about. A row whose
//! key is a different name is not a `taken` answer — it is a misdirected read, and
//! it takes the safe-500 seam.
//!
//! Be honest about the reach of that bind: it catches a positive attributed to the
//! wrong key, not a fabricated NEGATIVE. No structure here can prove a row absent;
//! only the unique index can, at write time. This is the same asymmetry the create
//! path already lives with, and it is the reason the index — not this read — is the
//! authority.

use std::future::Future;

use thiserror::Error;

use crate::{
    identity_access::workspace_name::CanonicalWorkspaceName, persistence::PersistenceFailure,
};

/// The verdict, as ONE value with three arms.
///
/// The wire carries two fields (`available` and `reason`) that are not independent:
/// `available` is true exactly when the reason is `available`. Projecting both from
/// this single enum is what makes the contradictory pair — `available: true` with
/// `reason: "taken"` — unrepresentable rather than merely untested. The TypeScript
/// DTO enforces the same agreement with a runtime `refine`; here it is a property
/// of the type.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceNameAvailability {
    /// The name cannot be stored under any circumstances — empty, over the cap, or
    /// carrying a forbidden code point. No lookup was performed. The specific
    /// [`crate::identity_access::workspace_name::WorkspaceNameIssue`] is deliberately dropped: this
    /// endpoint publishes one undifferentiated `invalid`, so which rule refused is
    /// not a wire contract.
    Invalid,
    /// No regular workspace held the key at the instant of the read. Advisory, not
    /// a reservation.
    Available,
    /// A regular workspace already holds the key.
    Taken,
}

impl WorkspaceNameAvailability {
    /// Whether the boundary should report the name as free. Derived from the arm
    /// rather than stored beside it, so the two wire fields cannot disagree.
    pub fn is_available(self) -> bool {
        matches!(self, Self::Available)
    }
}

/// The raw read fact: the `name_key` a regular workspace actually holds.
///
/// A boolean would be unbindable — the boundary could not tell an honest `true`
/// from one computed for another name. The row's own key is carried instead so
/// [`probe_workspace_name`] can hold it against the key it asked for. The field is
/// public because it is data, not a verdict; a fake that fabricates the wrong key
/// is precisely the case the bind exists to reject.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeldName {
    pub name_key: String,
}

/// The regular-workspace name namespace: the set of `name_key` values that are
/// spoken for. Agent-home workspaces are not in it.
///
/// The port takes a [`CanonicalWorkspaceName`], never a raw string, so no
/// implementation can be handed an unnormalized or unvalidated name to fold on its
/// own — the key it queries is always the one this product's single case-fold
/// authority produced.
pub trait RegularWorkspaceNamespace {
    fn holder_of_name(
        &self,
        name: &CanonicalWorkspaceName,
    ) -> impl Future<Output = Result<Option<HeldName>, PersistenceFailure>> + Send;
}

/// Why a probe produced no verdict at all. Neither arm is a product answer: both
/// take the safe-500 seam, because the endpoint's own vocabulary
/// (`available`/`invalid`/`taken`) has no way to say "the read was wrong".
#[derive(Debug, Error)]
pub enum WorkspaceNameProbeError {
    #[error("regular-workspace namespace lookup failed")]
    Persistence(#[from] PersistenceFailure),
    /// The lookup reported a holder for a DIFFERENT key than the one asked about.
    /// The keys are kept for diagnostics and tests, never for the wire.
    #[error("namespace lookup reported a holder of a different name key")]
    NameIdentity { requested: String, held: String },
}

/// Probe one proposed name against the regular-workspace namespace.
///
/// Format is settled FIRST and short-circuits: a malformed name yields
/// [`WorkspaceNameAvailability::Invalid`] having made ZERO port calls, because
/// there is no canonical key to look up and no reason to touch storage for input
/// the create path would reject anyway. Only a name that parsed — and therefore
/// carries the pinned fold of itself — is looked up, and the holder it finds is
/// bound to that key before `Taken` is returned.
pub async fn probe_workspace_name<N>(
    namespace: &N,
    raw: &str,
) -> Result<WorkspaceNameAvailability, WorkspaceNameProbeError>
where
    N: RegularWorkspaceNamespace,
{
    let name = match CanonicalWorkspaceName::parse(raw) {
        Ok(name) => name,
        // Every format refusal collapses into one `Invalid`. Which rule fired is
        // deliberately not this endpoint's contract, so the issue is dropped here
        // rather than carried outward.
        Err(_issue) => return Ok(WorkspaceNameAvailability::Invalid),
    };
    match namespace.holder_of_name(&name).await? {
        None => Ok(WorkspaceNameAvailability::Available),
        Some(held) if held.name_key == name.key() => Ok(WorkspaceNameAvailability::Taken),
        Some(held) => Err(WorkspaceNameProbeError::NameIdentity {
            requested: name.key().to_owned(),
            held: held.name_key,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io, sync::Mutex};

    /// Records the keys it was asked about so a test can prove a lookup did NOT
    /// happen, and answers with whatever fact the case wants — including a
    /// dishonest one.
    struct FakeNamespace {
        answer: Result<Option<HeldName>, ()>,
        asked: Mutex<Vec<String>>,
    }

    impl FakeNamespace {
        fn holding(name_key: &str) -> Self {
            Self {
                answer: Ok(Some(HeldName {
                    name_key: name_key.to_owned(),
                })),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn empty() -> Self {
            Self {
                answer: Ok(None),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn broken() -> Self {
            Self {
                answer: Err(()),
                asked: Mutex::new(Vec::new()),
            }
        }

        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl RegularWorkspaceNamespace for FakeNamespace {
        async fn holder_of_name(
            &self,
            name: &CanonicalWorkspaceName,
        ) -> Result<Option<HeldName>, PersistenceFailure> {
            self.asked.lock().unwrap().push(name.key().to_owned());
            self.answer.clone().map_err(|()| {
                PersistenceFailure::from_source(io::Error::other("namespace unavailable"))
            })
        }
    }

    #[tokio::test]
    async fn a_free_name_is_available() {
        let namespace = FakeNamespace::empty();

        let verdict = probe_workspace_name(&namespace, "Design Team")
            .await
            .unwrap();

        assert_eq!(verdict, WorkspaceNameAvailability::Available);
        assert!(verdict.is_available());
    }

    #[tokio::test]
    async fn the_namespace_is_asked_about_the_folded_key_not_the_typed_bytes() {
        let namespace = FakeNamespace::empty();

        probe_workspace_name(&namespace, "  Straße  ")
            .await
            .unwrap();

        // Trimmed, NFC, pinned full fold — the same key the create path stores, so
        // the probe and the unique index compare the same value.
        assert_eq!(namespace.asked(), ["strasse"]);
    }

    #[tokio::test]
    async fn a_held_key_is_taken_however_the_caller_spelled_the_name() {
        for raw in ["Regular", "regular", "REGULAR", "  Regular  "] {
            let namespace = FakeNamespace::holding("regular");

            let verdict = probe_workspace_name(&namespace, raw).await.unwrap();

            assert_eq!(
                verdict,
                WorkspaceNameAvailability::Taken,
                "{raw:?} must collide with the held key"
            );
            assert!(!verdict.is_available());
        }
    }

    #[tokio::test]
    async fn a_malformed_name_is_invalid_without_touching_the_namespace() {
        // One case per format rule, all published as the same undifferentiated
        // `Invalid`, and none of them allowed to reach storage.
        for raw in ["", "   ", "\u{3000}", &"a".repeat(65), "a\u{200d}b"] {
            let namespace = FakeNamespace::holding("anything");

            let verdict = probe_workspace_name(&namespace, raw).await.unwrap();

            assert_eq!(
                verdict,
                WorkspaceNameAvailability::Invalid,
                "{raw:?} must be invalid"
            );
            assert!(!verdict.is_available());
            assert!(
                namespace.asked().is_empty(),
                "{raw:?} has no key, so nothing may be looked up"
            );
        }
    }

    #[tokio::test]
    async fn a_holder_of_a_different_key_is_a_misdirected_read_not_a_taken_answer() {
        let namespace = FakeNamespace::holding("some other workspace");

        let error = probe_workspace_name(&namespace, "Design Team")
            .await
            .expect_err("a holder of another key cannot answer this probe");

        let WorkspaceNameProbeError::NameIdentity { requested, held } = error else {
            panic!("expected an identity violation, got {error:?}");
        };
        assert_eq!(requested, "design team");
        assert_eq!(held, "some other workspace");
    }

    #[tokio::test]
    async fn a_namespace_failure_never_becomes_a_product_verdict() {
        let namespace = FakeNamespace::broken();

        let error = probe_workspace_name(&namespace, "Design Team")
            .await
            .expect_err("a failed lookup has no verdict");

        assert!(matches!(error, WorkspaceNameProbeError::Persistence(_)));
    }
}
