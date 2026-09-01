//! Ending a computer's custody.
//!
//! Everything this door can do is decided before the write and re-asked by the write
//! itself. The verdict that admitted the requester is CONSUMED to name the row, so the
//! computer being changed and the computer that was authorized cannot be two computers.
//! Whether this call is the transition that ends custody is answered by the UPDATE's own
//! reach rather than by a read taken before the lock, so two requests arriving together
//! produce one transition and one announcement.
//!
//! Revoking is idempotent and deliberately narrow: it ends custody and kills every
//! credential, and it removes NOTHING — not the computer, not its agents, not anything
//! placed on them. Placement is the boundary that fails closed afterwards. A cascade
//! here would make "this machine is gone" mean "the work on it is gone".

use thiserror::Error;

use super::{
    aftermath::{AgentAvailabilityAnnouncer, CustodyEffectFailure, DaemonConnectionControl},
    computer::ComputerRecord,
    environment::{Clock, ClockFailure, now_ms},
    read::OwnedComputer,
};
use crate::{
    foundation::persistence::PersistenceFailure,
    identity::{HostId, UserId},
    identity_access::capability::computer_access::ComputerAccessHeld,
};

/// The one reason an owner may not revoke a computer that is theirs.
///
/// A user-managed computer has no revoke half-state at all. The user brought the
/// machine, so both things revoke exists for are already covered by narrower doors:
/// rotation replaces a credential the user believes is compromised, and deletion removes
/// the computer once nothing depends on it. A third, half-dead state would leave a
/// computer the user can see, cannot use, and never asked us to keep.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("revoke is not supported for user-managed computers")]
pub struct UserManagedComputer;

/// A revoke that passed the product refusal but has not been stamped with an instant.
///
/// The two steps are separate on purpose. [`Self::admit`] answers the one product refusal
/// — a user-managed computer has no revoke — reading NOTHING but the record, and the
/// instant is added afterwards by [`Self::stamp`]. So a failing clock cannot turn the
/// deterministic `409` a user-managed computer earns into a `500`: the refusal is decided
/// before the clock is ever consulted. This mirrors the TypeScript route, which answers
/// `remote + user_invite` with a `409` before it calls `Date.now()`, and it encodes that
/// order in the types rather than trusting Rust's argument-evaluation order to preserve
/// it — `admit(owned, now_ms(clock)?)` would read the clock FIRST.
///
/// The record is consumed here, not carried past admission: everything the write still
/// needs — which row — travels on the verdict via [`RevokeComputerAttempt::computer`].
pub struct AdmittedRevoke {
    access: ComputerAccessHeld,
}

impl AdmittedRevoke {
    /// Decide, from an admitted computer, whether this door is the right one for it —
    /// reading nothing but the record, and never the clock.
    ///
    /// The refusal is answered here and NOT re-asked inside the write lock, unlike
    /// credential eligibility. It reads how the computer was provisioned, and no
    /// committed transition turns an app-managed computer into a user-managed one — the
    /// only write that touches `provisioning_source` after creation is a claim adopting
    /// an unclaimed placeholder, which moves it to `app_install`. So the answer cannot
    /// go stale in the direction that matters: a computer this admits stays admissible.
    /// Falsifier: add a transition INTO user-managed and this check has to move in-lock.
    pub fn admit(owned: OwnedComputer) -> Result<Self, UserManagedComputer> {
        let (access, record) = owned.into_parts();
        if record.is_user_managed() {
            return Err(UserManagedComputer);
        }
        Ok(Self { access })
    }

    /// Stamp the admitted revoke with the instant every write it drives will carry.
    ///
    /// Read only AFTER admission, so a clock failure is reachable only for a computer this
    /// door would otherwise revoke — never for the user-managed one it refuses.
    pub fn stamp(self, at: i64) -> RevokeComputerAttempt {
        RevokeComputerAttempt {
            access: self.access,
            at,
        }
    }
}

/// An admitted revoke, stamped with the instant it will write.
///
/// The record is deliberately NOT carried. It was read before the lock, and the only
/// thing the write needs from it — which row — comes from the verdict instead, via
/// [`Self::computer`]. That is what makes it impossible for a stale record to send the
/// write at a different row than the one authorization named.
///
/// The only source is [`AdmittedRevoke::stamp`], reached only through
/// [`AdmittedRevoke::admit`]. Assembling one from parts would bypass the refusal and the
/// verdict both:
///
/// ```compile_fail
/// use silverhand_backend_core::host_runtime::revoke::RevokeComputerAttempt;
/// let _: RevokeComputerAttempt = RevokeComputerAttempt {
///     access: unimplemented!(),
///     at: 1,
/// };
/// ```
///
/// The control for that gate: the same path, named the same way, minted the only way it
/// can be. A `compile_fail` block passes on ANY error, so without this the gate above
/// would also pass on a renamed type or a dropped accessor.
///
/// ```
/// use silverhand_backend_core::{
///     host_runtime::{
///         computer::{ComputerRecord, HostKind, ProvisioningSource},
///         read::find_owned_computer,
///         revoke::AdmittedRevoke,
///     },
///     identity::{HostId, UserId},
/// };
/// let owner = UserId::parse("u1").unwrap();
/// let record = ComputerRecord {
///     id: HostId::parse("h1").unwrap(),
///     name: "local".to_owned(),
///     kind: HostKind::Local,
///     created_at: 1,
///     owner: Some(owner.clone()),
///     installation_id: Some("i1".to_owned()),
///     last_seen_at: Some(1),
///     activated_at: Some(1),
///     finalized_at: Some(1),
///     revoked_at: None,
///     provisioning_source: ProvisioningSource::AppInstall,
///     display_label: None,
/// };
/// let Some(owned) = find_owned_computer(&owner, Some(record)) else {
///     panic!("the owner is admitted");
/// };
/// let attempt = AdmittedRevoke::admit(owned).unwrap().stamp(7);
/// assert_eq!(attempt.computer().as_str(), "h1");
/// assert_eq!(attempt.at(), 7);
/// ```
#[derive(Debug, Eq, PartialEq)]
pub struct RevokeComputerAttempt {
    access: ComputerAccessHeld,
    at: i64,
}

impl RevokeComputerAttempt {
    /// The row to write — the verdict's computer, which is the only one it can be.
    pub fn computer(&self) -> &HostId {
        self.access.computer()
    }

    /// Who was admitted. Not a write input: custody ends for the computer, not for a
    /// requester, and the owner column is left exactly as it was so a revoked computer
    /// still reads back as this user's.
    pub fn owner(&self) -> &UserId {
        self.access.owner()
    }

    /// The single instant stamped on the computer and on every credential it kills.
    pub fn at(&self) -> i64 {
        self.at
    }
}

/// What the revoke transaction left behind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevokedComputer {
    /// The computer as it stands after the write, read back INSIDE the same transaction:
    /// the answer the user gets is the state that was written, not a state a second read
    /// might already have moved past.
    pub computer: ComputerRecord,
    /// Whether THIS transaction ended custody, as the tombstone UPDATE's own reach.
    ///
    /// A pre-lock read cannot answer this: two requests that both saw a live computer
    /// would both believe they ended custody, and the fan-out driven off that belief
    /// would fire twice for one transition.
    pub custody_ended_now: bool,
}

/// The one write that ends custody.
pub trait RevokeComputerUnitOfWork: Clone + Send + Sync + 'static {
    /// Stamp the computer, kill its credentials, and read the computer back — in ONE
    /// transaction.
    ///
    /// Three clauses belong to the adapter and are NOT re-decided in this crate, because
    /// a second copy of any of them would be a second authority with no consumer:
    ///
    /// - **The tombstone moves once.** `revoked_at` is set only where it IS NULL, and
    ///   how many rows that reached is [`RevokedComputer::custody_ended_now`]. A repeat
    ///   revoke must not advance a tombstone the user already has.
    /// - **The credential sweep is unconditional.** Every credential of this computer
    ///   that is still live dies at [`RevokeComputerAttempt::at`], on a repeat revoke
    ///   too — the sweep is also the reconciliation of an earlier run that stamped the
    ///   computer and then failed, and skipping it there would leave a working token on
    ///   a dead computer forever.
    /// - **The sweep is not a [`CredentialSweep`](super::custody::CredentialSweep).**
    ///   That pair belongs to rotation, where one credential is kept and the others were
    ///   superseded by it. Here nothing is kept, so nothing was superseded, and writing
    ///   `consumed_at` would describe a dead credential to the verifier as one inside a
    ///   grace window.
    ///
    /// `Ok(None)` means no row carries that id under the lock. It is a fact, not a
    /// refusal: naming what it means is [`RevokeComputer`]'s.
    fn revoke_computer(
        &self,
        attempt: RevokeComputerAttempt,
    ) -> impl Future<Output = Result<Option<RevokedComputer>, PersistenceFailure>> + Send;
}

/// A committed revoke, and anything about it that could not be told.
///
/// The failures are handed back rather than logged here, because this crate has no
/// logger and, more importantly, because each one carries its own operator meaning: an
/// unannounced revoke leaves viewers stale, and an unclosed connection leaves a daemon
/// mid-request. A single collapsed "aftermath failed" would page someone with neither.
#[derive(Debug)]
pub struct EndedComputerCustody {
    /// The computer as committed, for the wire projection.
    pub computer: ComputerRecord,
    /// Set only when this call ended custody and the announcement failed.
    pub availability_announcement_failure: Option<CustodyEffectFailure>,
    /// Set when closing the daemon's connection failed.
    pub daemon_disconnect_failure: Option<CustodyEffectFailure>,
}

/// Why a revoke produced no answer at all.
///
/// [`Self::Refused`] is the product's own 409; every other arm is a fault, and the door
/// above maps them to a generic failure without telling the user which.
#[derive(Debug, Error)]
pub enum RevokeComputerError {
    #[error(transparent)]
    Refused(#[from] UserManagedComputer),
    /// The row an admitted verdict named was not there under the write lock.
    ///
    /// A fault, not a 404: this door only reaches the write with a computer it just read
    /// and authorized, and nothing it can be racing against removes such a row —
    /// deletion is a user-managed computer's operation, and this one refused those. So
    /// the absence means a rule elsewhere started deleting rows this one still admits.
    /// Falsifier: give an app-managed computer a delete path and the absence becomes an
    /// ordinary lost race that should answer 404.
    #[error("computer {} disappeared from under an admitted revoke", computer.as_str())]
    ComputerVanished { computer: HostId },
    #[error(transparent)]
    Clock(#[from] ClockFailure),
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

/// End a computer's custody: the refusal, the one transaction, and the two things the
/// rest of the system is owed afterwards.
#[derive(Clone)]
pub struct RevokeComputer<U, A, D, C> {
    unit_of_work: U,
    availability: A,
    daemons: D,
    clock: C,
}

impl<U, A, D, C> RevokeComputer<U, A, D, C>
where
    U: RevokeComputerUnitOfWork,
    A: AgentAvailabilityAnnouncer,
    D: DaemonConnectionControl,
    C: Clock,
{
    pub fn new(unit_of_work: U, availability: A, daemons: D, clock: C) -> Self {
        Self {
            unit_of_work,
            availability,
            daemons,
            clock,
        }
    }

    /// Takes the computer already resolved and admitted for this requester, so ownership
    /// is settled before anything here runs and this module never sees a coordinate it
    /// would have to authorize itself.
    ///
    /// The announcement fires only on the transition; the disconnect is attempted every
    /// time. That asymmetry is the point of each effect: an announcement describes a
    /// change, and a repeat revoke changed nothing, while a daemon still holding a socket
    /// after a repeat revoke is exactly the state that repeat is there to reconcile.
    pub async fn execute(
        &self,
        owned: OwnedComputer,
    ) -> Result<EndedComputerCustody, RevokeComputerError> {
        // Refuse a user-managed computer BEFORE the clock is read: the product's `409` is
        // deterministic, so a clock failure may only turn the app-managed branch into a
        // fail-closed `500` — never this refusal into one.
        let admitted = AdmittedRevoke::admit(owned)?;
        let attempt = admitted.stamp(now_ms(&self.clock)?);
        let computer = attempt.computer().clone();

        let Some(revoked) = self.unit_of_work.revoke_computer(attempt).await? else {
            return Err(RevokeComputerError::ComputerVanished { computer });
        };

        let availability_announcement_failure = if revoked.custody_ended_now {
            self.availability
                .agents_availability_changed(computer.clone())
                .await
                .err()
        } else {
            None
        };
        let daemon_disconnect_failure = self.daemons.disconnect(computer).await.err();

        Ok(EndedComputerCustody {
            computer: revoked.computer,
            availability_announcement_failure,
            daemon_disconnect_failure,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::host_runtime::computer::{HostKind, ProvisioningSource};

    const NOW: i64 = 1_700_000_000_123;

    #[derive(Debug, Error)]
    #[error("the fan-out is down")]
    struct FanOutDown;

    #[derive(Debug, Error)]
    #[error("the clock is broken")]
    struct BrokenClock;

    #[derive(Clone, Copy, Debug, Default)]
    struct FixedClock;

    impl Clock for FixedClock {
        type Error = BrokenClock;
        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Ok(NOW)
        }
    }

    #[derive(Clone, Copy, Debug, Default)]
    struct FailingClock;

    impl Clock for FailingClock {
        type Error = BrokenClock;
        fn unix_time_ms(&self) -> Result<i64, Self::Error> {
            Err(BrokenClock)
        }
    }

    #[derive(Debug, Default)]
    struct Log {
        writes: Vec<(String, i64)>,
        announcements: Vec<String>,
        disconnects: Vec<String>,
    }

    /// Plays the adapter and both aftermath producers, so a test can see exactly which
    /// of the three ran. It derives `custody_ended_now` from the row the way the real
    /// UPDATE does rather than taking it as a knob, so a repeat revoke cannot be faked
    /// into announcing.
    #[derive(Clone)]
    struct World {
        row: Option<ComputerRecord>,
        announcement_fails: bool,
        disconnect_fails: bool,
        log: Arc<Mutex<Log>>,
    }

    impl World {
        fn holding(row: ComputerRecord) -> Self {
            Self {
                row: Some(row),
                announcement_fails: false,
                disconnect_fails: false,
                log: Arc::default(),
            }
        }

        fn empty() -> Self {
            Self {
                row: None,
                announcement_fails: false,
                disconnect_fails: false,
                log: Arc::default(),
            }
        }

        fn log(&self) -> std::sync::MutexGuard<'_, Log> {
            self.log.lock().expect("the log is not poisoned")
        }

        fn revoker(&self) -> RevokeComputer<Self, Self, Self, FixedClock> {
            RevokeComputer::new(self.clone(), self.clone(), self.clone(), FixedClock)
        }
    }

    impl RevokeComputerUnitOfWork for World {
        async fn revoke_computer(
            &self,
            attempt: RevokeComputerAttempt,
        ) -> Result<Option<RevokedComputer>, PersistenceFailure> {
            self.log()
                .writes
                .push((attempt.computer().as_str().to_owned(), attempt.at()));
            let Some(mut computer) = self.row.clone() else {
                return Ok(None);
            };
            let custody_ended_now = computer.revoked_at.is_none();
            if custody_ended_now {
                computer.revoked_at = Some(attempt.at());
            }
            Ok(Some(RevokedComputer {
                computer,
                custody_ended_now,
            }))
        }
    }

    impl AgentAvailabilityAnnouncer for World {
        async fn agents_availability_changed(
            &self,
            computer: HostId,
        ) -> Result<(), CustodyEffectFailure> {
            self.log().announcements.push(computer.into_inner());
            if self.announcement_fails {
                return Err(CustodyEffectFailure::from_source(FanOutDown));
            }
            Ok(())
        }
    }

    impl DaemonConnectionControl for World {
        async fn disconnect(&self, computer: HostId) -> Result<(), CustodyEffectFailure> {
            self.log().disconnects.push(computer.into_inner());
            if self.disconnect_fails {
                return Err(CustodyEffectFailure::from_source(FanOutDown));
            }
            Ok(())
        }
    }

    fn user(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn record(
        kind: HostKind,
        provisioning_source: ProvisioningSource,
        revoked_at: Option<i64>,
    ) -> ComputerRecord {
        ComputerRecord {
            id: HostId::parse("h1").expect("host id"),
            name: "local".to_owned(),
            kind,
            created_at: 1,
            owner: Some(user("u1")),
            installation_id: Some("i1".to_owned()),
            last_seen_at: Some(1),
            activated_at: Some(1),
            finalized_at: Some(1),
            revoked_at,
            provisioning_source,
            display_label: None,
        }
    }

    fn app_managed(revoked_at: Option<i64>) -> ComputerRecord {
        record(HostKind::Local, ProvisioningSource::AppInstall, revoked_at)
    }

    fn owned(row: &ComputerRecord) -> OwnedComputer {
        let Some(owned) = super::super::read::find_owned_computer(&user("u1"), Some(row.clone()))
        else {
            panic!("the owner is admitted");
        };
        owned
    }

    #[tokio::test]
    async fn a_user_managed_computer_is_refused_before_anything_happens() {
        let row = record(HostKind::Remote, ProvisioningSource::UserInvite, None);
        let world = World::holding(row.clone());

        let error = world
            .revoker()
            .execute(owned(&row))
            .await
            .expect_err("a user-managed computer has no revoke");

        assert!(matches!(error, RevokeComputerError::Refused(_)));
        let log = world.log();
        assert!(log.writes.is_empty());
        assert!(log.announcements.is_empty());
        assert!(log.disconnects.is_empty());
    }

    /// Falsifier for the refusal-before-clock order: a user-managed computer earns a
    /// deterministic `409`, and a broken clock must not upgrade it to a `500`. Reading the
    /// clock first — `admit(owned, now_ms(clock)?)` — would turn this refusal into a fault.
    #[tokio::test]
    async fn a_user_managed_computer_is_refused_even_when_the_clock_is_broken() {
        let row = record(HostKind::Remote, ProvisioningSource::UserInvite, None);
        let world = World::holding(row.clone());
        let revoker =
            RevokeComputer::new(world.clone(), world.clone(), world.clone(), FailingClock);

        let error = revoker
            .execute(owned(&row))
            .await
            .expect_err("a user-managed computer has no revoke");

        assert!(matches!(error, RevokeComputerError::Refused(_)));
        let log = world.log();
        assert!(log.writes.is_empty());
        assert!(log.announcements.is_empty());
        assert!(log.disconnects.is_empty());
    }

    /// The control: an app-managed computer DOES read the clock, so a broken clock there
    /// is the safe `500` — reached only after admission, and still before any write.
    #[tokio::test]
    async fn an_app_managed_revoke_with_a_broken_clock_is_a_fault_before_any_write() {
        let row = app_managed(None);
        let world = World::holding(row.clone());
        let revoker =
            RevokeComputer::new(world.clone(), world.clone(), world.clone(), FailingClock);

        let error = revoker
            .execute(owned(&row))
            .await
            .expect_err("a broken clock cannot stamp a revoke");

        assert!(matches!(error, RevokeComputerError::Clock(_)));
        let log = world.log();
        assert!(log.writes.is_empty());
        assert!(log.announcements.is_empty());
        assert!(log.disconnects.is_empty());
    }

    /// A system-provisioned computer is not user-managed, so this door is still its own —
    /// the refusal is about who holds the lifecycle, not about how the row was created.
    #[tokio::test]
    async fn a_system_computer_is_not_user_managed_and_is_revocable() {
        let row = record(HostKind::Remote, ProvisioningSource::System, None);
        let world = World::holding(row.clone());

        world
            .revoker()
            .execute(owned(&row))
            .await
            .expect("a system computer's custody can end");

        assert_eq!(world.log().writes.len(), 1);
    }

    #[tokio::test]
    async fn the_row_written_is_the_one_the_verdict_named_stamped_once() {
        let row = app_managed(None);
        let world = World::holding(row.clone());

        let ended = world
            .revoker()
            .execute(owned(&row))
            .await
            .expect("custody ends");

        assert_eq!(world.log().writes, vec![("h1".to_owned(), NOW)]);
        assert_eq!(ended.computer.revoked_at, Some(NOW));
    }

    #[tokio::test]
    async fn ending_custody_announces_the_agents_that_just_went_offline() {
        let row = app_managed(None);
        let world = World::holding(row.clone());

        let ended = world
            .revoker()
            .execute(owned(&row))
            .await
            .expect("custody ends");

        let log = world.log();
        assert_eq!(log.announcements, vec!["h1".to_owned()]);
        assert_eq!(log.disconnects, vec!["h1".to_owned()]);
        assert!(ended.availability_announcement_failure.is_none());
        assert!(ended.daemon_disconnect_failure.is_none());
    }

    #[tokio::test]
    async fn a_repeat_revoke_stays_silent_but_still_kicks_the_daemon() {
        let already = app_managed(Some(NOW - 5_000));
        let world = World::holding(already.clone());

        let ended = world
            .revoker()
            .execute(owned(&already))
            .await
            .expect("a repeat revoke is an answer, not a refusal");

        let log = world.log();
        assert_eq!(log.writes, vec![("h1".to_owned(), NOW)]);
        assert!(log.announcements.is_empty());
        assert_eq!(log.disconnects, vec!["h1".to_owned()]);
        assert_eq!(ended.computer.revoked_at, Some(NOW - 5_000));
    }

    #[tokio::test]
    async fn a_computer_gone_under_the_lock_is_a_fault_not_an_answer() {
        let row = app_managed(None);
        let world = World::empty();

        let error = world
            .revoker()
            .execute(owned(&row))
            .await
            .expect_err("an admitted row cannot vanish");

        let RevokeComputerError::ComputerVanished { computer } = error else {
            panic!("the fault names the computer");
        };
        assert_eq!(computer.as_str(), "h1");
        let log = world.log();
        assert!(log.announcements.is_empty());
        assert!(log.disconnects.is_empty());
    }

    #[tokio::test]
    async fn a_failed_announcement_is_reported_and_the_revoke_stands() {
        let row = app_managed(None);
        let mut world = World::holding(row.clone());
        world.announcement_fails = true;

        let ended = world
            .revoker()
            .execute(owned(&row))
            .await
            .expect("the commit already happened");

        assert!(ended.availability_announcement_failure.is_some());
        assert_eq!(ended.computer.revoked_at, Some(NOW));
        assert_eq!(world.log().disconnects, vec!["h1".to_owned()]);
    }

    #[tokio::test]
    async fn a_failed_disconnect_is_reported_and_the_revoke_stands() {
        let row = app_managed(None);
        let mut world = World::holding(row.clone());
        world.disconnect_fails = true;

        let ended = world
            .revoker()
            .execute(owned(&row))
            .await
            .expect("the commit already happened");

        assert!(ended.daemon_disconnect_failure.is_some());
        assert!(ended.availability_announcement_failure.is_none());
        assert_eq!(ended.computer.revoked_at, Some(NOW));
    }
}
