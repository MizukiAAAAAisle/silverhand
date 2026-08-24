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
//! [`Principal`]: crate::identity::Principal

use crate::identity::UserId;

/// The one fact this rule reads. A narrow projection on purpose: it names the
/// single column an ownership question is about, so a computer row that grows a
/// lifecycle, a fleet or a billing column cannot silently become an input to an
/// authorization decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerOwnershipFacts {
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

/// Proof that THIS rule matched THIS requester against the computer's recorded
/// owner.
///
/// Private constructor, and it carries the owner it matched. The owner is not
/// bookkeeping: everything a computer teardown announces afterwards is fanned out
/// on the owner's scope, so the post-commit phase needs the identity the decision
/// was actually made on rather than one re-derived from a row that no longer
/// exists.
///
/// What it proves is narrow — that this rule ran, on some facts. It does not prove
/// the facts were read under a write mechanism, whole and current; a witness minted
/// from a stale read is a well-formed witness. That residual belongs to the
/// persistence contract of whichever mechanism consumes it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComputerAccessHeld {
    owner: UserId,
}

impl ComputerAccessHeld {
    /// The owner this requester matched.
    pub fn owner(&self) -> &UserId {
        &self.owner
    }
}

/// This rule's verdict.
///
/// Not [`crate::capability::decision::Decision`]: that type's `Allow` is a
/// publicly constructible unit variant, so it can carry no seal. A capability that
/// gates a WRITE needs its admitted arm to be unforgeable, and one whose verdict is
/// only rendered does not.
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
    match computer.and_then(|computer| computer.owner.as_ref()) {
        Some(owner) if owner == requester => ComputerAccess::Held(ComputerAccessHeld {
            owner: owner.clone(),
        }),
        _ => ComputerAccess::Refused(ComputerAccessRefused::NotTheirs),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn owned_by(owner: &str) -> ComputerOwnershipFacts {
        ComputerOwnershipFacts {
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
    fn the_owner_is_admitted_and_the_witness_names_them() {
        let ComputerAccess::Held(held) = can_access_computer(&user("u1"), Some(&owned_by("u1")))
        else {
            panic!("expected the owner to be admitted");
        };
        assert_eq!(held.owner(), &user("u1"));
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
            refusal("u1", Some(&ComputerOwnershipFacts { owner: None })),
            Some(ComputerAccessRefused::NotTheirs)
        );
    }
}
