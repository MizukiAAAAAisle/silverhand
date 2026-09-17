//! Where a computer is in its life, and whether an agent may be placed on it.
//!
//! The three stamps that record a lifecycle are stored; the state they add up to is
//! NOT. It is derived here, once, so no row and no wire projection can carry a
//! status that disagrees with the stamps it was computed from.
//!
//! Placement readiness is the same fact, not a second one: a computer is placeable
//! exactly when it is [`HostLifecycleStatus::Active`]. The wire keeps two fields
//! because its consumers ask two questions, but the domain has one answer, so
//! [`HostLifecycleStatus::placeable`] reads off the status rather than re-deriving
//! it from the stamps — two derivations of one fact is where a drift would live.

/// The stamps the lifecycle rule reads, and only those. A computer row that grows a
/// fleet, billing or attachment column cannot become an input to its status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HostLifecycleStamps {
    /// When a daemon first spoke for this computer.
    pub activated_at: Option<i64>,
    /// When it finished the handshake that makes it usable.
    pub finalized_at: Option<i64>,
    /// When its custody ended. Terminal: it outranks both stamps above.
    pub revoked_at: Option<i64>,
}

/// The closed set of computer lifecycle states, in the order the rule decides them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostLifecycleStatus {
    /// Invited, never heard from.
    Pending,
    /// A daemon has spoken for it, but the handshake never finished.
    Attached,
    /// Finished and not revoked — the only state that admits placement.
    Active,
    /// Custody ended.
    Revoked,
}

impl HostLifecycleStatus {
    /// Whether an agent may be placed on a computer in this state.
    pub fn placeable(self) -> bool {
        matches!(self, Self::Active)
    }
}

/// Which state these stamps add up to. Revocation is checked first because it is
/// terminal: a revoked computer that was once finalized is revoked, not active.
pub fn lifecycle_status(stamps: &HostLifecycleStamps) -> HostLifecycleStatus {
    if stamps.revoked_at.is_some() {
        return HostLifecycleStatus::Revoked;
    }
    if stamps.activated_at.is_some() && stamps.finalized_at.is_some() {
        return HostLifecycleStatus::Active;
    }
    if stamps.activated_at.is_some() {
        return HostLifecycleStatus::Attached;
    }
    HostLifecycleStatus::Pending
}

/// Commit the first valid attachment without finalizing the user's chosen name.
/// Rechecks the authenticated credential and owner under the persistence writer.
pub trait HostActivationPort: Clone + Send + Sync + 'static {
    fn activate_attachment(
        &self,
        host: &str,
        owner: &crate::foundation::identity::UserId,
        credential_id: &str,
        now: i64,
    ) -> impl std::future::Future<
        Output = Result<bool, crate::foundation::persistence::PersistenceFailure>,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamps(
        activated_at: Option<i64>,
        finalized_at: Option<i64>,
        revoked_at: Option<i64>,
    ) -> HostLifecycleStamps {
        HostLifecycleStamps {
            activated_at,
            finalized_at,
            revoked_at,
        }
    }

    /// Every combination of the three stamps, so a reordered branch shows up as a
    /// changed state rather than as a case nobody wrote down.
    #[test]
    fn every_stamp_combination_has_one_state() {
        let at = Some(7);
        let expected = [
            (stamps(None, None, None), HostLifecycleStatus::Pending),
            (stamps(None, at, None), HostLifecycleStatus::Pending),
            (stamps(at, None, None), HostLifecycleStatus::Attached),
            (stamps(at, at, None), HostLifecycleStatus::Active),
            (stamps(None, None, at), HostLifecycleStatus::Revoked),
            (stamps(None, at, at), HostLifecycleStatus::Revoked),
            (stamps(at, None, at), HostLifecycleStatus::Revoked),
            (stamps(at, at, at), HostLifecycleStatus::Revoked),
        ];

        for (stamps, status) in expected {
            assert_eq!(lifecycle_status(&stamps), status, "stamps {stamps:?}");
        }
    }

    /// A finalized computer that was never activated is not usable: both halves of
    /// the handshake are required, and only their conjunction admits placement.
    #[test]
    fn finalized_without_activation_is_not_placeable() {
        let status = lifecycle_status(&stamps(None, Some(7), None));
        assert_eq!(status, HostLifecycleStatus::Pending);
        assert!(!status.placeable());
    }

    #[test]
    fn placeable_is_exactly_the_active_state() {
        let states = [
            HostLifecycleStatus::Pending,
            HostLifecycleStatus::Attached,
            HostLifecycleStatus::Active,
            HostLifecycleStatus::Revoked,
        ];
        for state in states {
            assert_eq!(
                state.placeable(),
                state == HostLifecycleStatus::Active,
                "state {state:?}"
            );
        }
    }
}
