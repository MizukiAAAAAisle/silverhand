//! Whether a computer is this requester's to act on.
//!
//! One reason to change: which requester a computer answers to. What may then be
//! DONE to it — whether its lifecycle is a user request's to end at all, whether
//! its dependents admit a cascade — is the teardown domain's, and changes for
//! entirely different reasons.
//!
//! The requester is a `UserId` rather than a [`Principal`]: every surface that
//! reaches this rule resolves a session bearer, so an agent or system principal
//! asking about a computer is not a request that exists. Stating that in the
//! signature makes it unaskable instead of answerable-and-refused, and the day a
//! system-initiated face appears it adds an arm HERE rather than deciding it in a
//! route.
//!
//! [`Principal`]: crate::foundation::identity::Principal

use crate::foundation::identity::{HostId, UserId};

/// The facts this rule reads: WHICH computer, and whose it is. A narrow projection
/// on purpose — a computer row that grows a lifecycle, a fleet or a billing column
/// cannot silently become an input to an authorization decision.
///
/// The id is not an input to the decision; it is the coordinate the verdict is
/// ABOUT. Carrying it is what lets a later seal prove that this answer and the
/// facts a write acts on describe one computer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerOwnershipFacts {
    pub id: HostId,
    /// Absent for a computer no user owns.
    pub owner: Option<UserId>,
}

/// Why a computer is not this requester's.
///
/// ONE arm, and deliberately not two: "no such computer" and "someone else's
/// computer" must be indistinguishable, or a requester probing ids learns which
/// ones exist. An ownerless computer answers the same way for the same reason.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComputerAccessRefused {
    NotTheirs,
}

/// Proof that THIS rule matched THIS requester against the recorded owner of THIS
/// computer.
///
/// Private constructor, and it carries both halves of what it matched. The owner is
/// not bookkeeping: everything a computer teardown announces afterwards is fanned
/// out on the owner's scope, so the post-commit phase needs the identity the
/// decision was actually made on rather than one re-derived from a row that no
/// longer exists. The computer is the coordinate — an authorization that does not
/// say what it authorizes can be carried onto another computer's facts, and the
/// seals that consume this witness check it.
///
/// What it does NOT prove is that the facts were read under a write mechanism,
/// whole and current; a witness minted from a stale or filtered read is a
/// well-formed witness. That residual belongs to the persistence contract of
/// whichever mechanism consumes it, and it is a different question from the
/// coordinate — which is closed here, structurally.
///
/// ```compile_fail
/// use silverhand_backend_core::identity_access::capability::computer_access::ComputerAccessHeld;
/// // Assembled from parts, this would authorize a requester no rule matched.
/// let _: ComputerAccessHeld = ComputerAccessHeld {
///     computer: unimplemented!(),
///     owner: unimplemented!(),
/// };
/// ```
///
/// The control for that gate: the same path, named the same way, minted the only
/// way it can be. A `compile_fail` block passes on ANY error, so without this the
/// gate above would also pass on a renamed type.
///
/// ```
/// use silverhand_backend_core::{
///     identity_access::capability::computer_access::{
///         ComputerAccess, ComputerAccessHeld, ComputerOwnershipFacts, can_access_computer,
///     },
///     foundation::identity::{HostId, UserId},
/// };
/// let owner = UserId::parse("u1").unwrap();
/// let ComputerAccess::Held(held) = can_access_computer(
///     &owner,
///     Some(&ComputerOwnershipFacts {
///         id: HostId::parse("h1").unwrap(),
///         owner: Some(owner.clone()),
///     }),
/// ) else {
///     panic!("the owner is admitted");
/// };
/// let held: ComputerAccessHeld = held;
/// assert_eq!(held.computer().as_str(), "h1");
/// assert_eq!(held.owner(), &owner);
/// ```
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerAccessHeld {
    computer: HostId,
    owner: UserId,
}

impl ComputerAccessHeld {
    /// The computer this verdict is about.
    pub fn computer(&self) -> &HostId {
        &self.computer
    }

    /// The owner this requester matched.
    pub fn owner(&self) -> &UserId {
        &self.owner
    }
}

/// This rule's verdict. Not [`crate::identity_access::capability::decision::Decision`]: this one
/// gates a write, so the module rule applies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComputerAccess {
    Held(ComputerAccessHeld),
    Refused(ComputerAccessRefused),
}

/// Is this computer this requester's?
///
/// The absent row is passed in rather than reported as a failure: "no such
/// computer" is a fact about the world, and folding it into the same refusal as
/// "not yours" is the whole point of the single arm.
pub fn can_access_computer(
    requester: &UserId,
    computer: Option<&ComputerOwnershipFacts>,
) -> ComputerAccess {
    match computer {
        Some(facts) if facts.owner.as_ref() == Some(requester) => {
            ComputerAccess::Held(ComputerAccessHeld {
                computer: facts.id.clone(),
                owner: requester.clone(),
            })
        }
        _ => ComputerAccess::Refused(ComputerAccessRefused::NotTheirs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn host() -> HostId {
        HostId::parse("h1").expect("host id")
    }

    fn owned_by(owner: &str) -> ComputerOwnershipFacts {
        ComputerOwnershipFacts {
            id: host(),
            owner: Some(user(owner)),
        }
    }

    fn refusal(
        requester: &str,
        computer: Option<&ComputerOwnershipFacts>,
    ) -> Option<ComputerAccessRefused> {
        match can_access_computer(&user(requester), computer) {
            ComputerAccess::Held(_) => None,
            ComputerAccess::Refused(refused) => Some(refused),
        }
    }

    #[test]
    fn the_owner_is_admitted_and_the_witness_names_them_and_the_computer() {
        let ComputerAccess::Held(held) = can_access_computer(&user("u1"), Some(&owned_by("u1")))
        else {
            panic!("expected the owner to be admitted");
        };
        assert_eq!(held.owner(), &user("u1"));
        // Without this the verdict would not say what it authorizes, and could be
        // carried onto another computer's facts.
        assert_eq!(held.computer(), &host());
    }

    #[test]
    fn an_absent_computer_and_someone_elses_are_the_same_answer() {
        // Distinguishing them would turn this rule into an existence oracle for
        // ids the requester has no relationship to.
        assert_eq!(refusal("u1", None), Some(ComputerAccessRefused::NotTheirs));
        assert_eq!(
            refusal("u1", Some(&owned_by("u2"))),
            Some(ComputerAccessRefused::NotTheirs)
        );
    }

    #[test]
    fn a_computer_no_user_owns_is_no_ones_to_act_on() {
        assert_eq!(
            refusal(
                "u1",
                Some(&ComputerOwnershipFacts {
                    id: host(),
                    owner: None,
                })
            ),
            Some(ComputerAccessRefused::NotTheirs)
        );
    }
}
