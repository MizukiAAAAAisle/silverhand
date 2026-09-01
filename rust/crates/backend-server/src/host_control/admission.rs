//! Websocket admission refusals, observable only while no connection supersedes them.
//!
//! The deployed lifetime is ported, including the sequence that makes a refusal
//! resurface — a contract, not an accident to be tidied away. A protocol mismatch
//! leaves a refusal behind after its own slot is gone; a later dialer that reserves
//! the slot withholds it while that dialer is not ready yet; if that dialer closes
//! before it is ready and its slot is removed, the older refusal is observable
//! again; only that dialer becoming ready clears it. There is no TTL and a close
//! clears nothing. A dialer refused because the slot is occupied is refused and
//! nothing more: it must not touch the recorded refusal.
//!
//! A token authentication failure is never recorded and never clears anything:
//! that check runs before admission, and a dialer that never authenticated must not
//! be able to place a fact into a host's observable status.
//!
//! Slot occupancy and readiness are read from the `daemon_delivery` registry, which
//! already distinguishes a reserved slot from an attached one. This leaf owns the
//! refusal record and the rule for when it may be seen, never a connection map of
//! its own.

use std::{
    collections::HashMap,
    error::Error,
    fmt,
    sync::{Arc, Mutex},
};

use silverhand_backend_core::foundation::identity::HostId;

/// One socket that reserved a host's slot. Minted from the transport's own
/// connection identity and nowhere else, so a recorded refusal and the current
/// occupancy can only be compared against values the connection authority issued.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DialerId(String);

impl DialerId {
    pub(crate) fn from_connection(connection_id: &str) -> Self {
        Self(connection_id.to_owned())
    }
}

/// Who currently holds this host's transport slot — reserved OR attached.
///
/// The narrowest fact this leaf can be handed, and deliberately not the attached
/// custody. The withhold rule asks "has a DIFFERENT dialer taken the slot", and a
/// readiness fact cannot answer it: under the compatibility gate a mid-handshake
/// replacement is not attached yet, so a refusal would be reported as this host's
/// state for the whole handshake window. Owned by this leaf and implemented by the
/// connection authority, so the leaf keeps no map of its own and cannot reach the
/// custody fact it must not use.
pub(crate) trait SlotOccupancy: Send + Sync {
    fn slot_dialer(&self, host_id: &str) -> Result<Option<DialerId>, AdmissionUnavailable>;
}

/// A refusal as recorded: the dialer it belongs to is part of the record, because
/// the withhold rule is a comparison against it, and it never leaves this crate.
pub(crate) struct ProtocolMismatch {
    pub(crate) dialer: DialerId,
    pub(crate) offered_protocol_version: u32,
    pub(crate) expected_protocol_version: u32,
    pub(crate) observed_at: i64,
}

/// Whether a record is a fact a reader has not been told about yet.
///
/// The identity of a refusal is the two versions that disagree: a stale daemon
/// re-recording the identical incompatibility is not news, and an incompatibility
/// that CHANGED is (the machine was upgraded to another incompatible build, or a
/// different machine dialed in with the same credential). The dialer and the
/// timestamp move on every attempt and are excluded on purpose — including them
/// would make every reconnect news again, which is the storm this answer exists to
/// avoid.
///
/// The announce edge itself is not in this task: the record is overwritten either
/// way, so the comparison has to happen here — once overwritten the previous fact
/// is gone and no later announcer could re-derive it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RefusalNews {
    /// The first refusal for this host, or one that disagrees differently.
    Changed,
    /// The same unresolved incompatibility, re-observed.
    SameUnresolvedFact,
}

/// What a reader may see once the refusal is not superseded. Carries no dialer:
/// the generation comparison is already made, and a consumer that could see the
/// dialer could make it again — differently.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ProtocolMismatchRefusal {
    pub offered_protocol_version: u32,
    pub expected_protocol_version: u32,
    pub observed_at: i64,
}

/// The process-local admission state cannot be read or written right now.
#[derive(Debug)]
pub struct AdmissionUnavailable;

impl fmt::Display for AdmissionUnavailable {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("host admission state is unavailable")
    }
}

impl Error for AdmissionUnavailable {}

/// The refusal record and the rule for when it may be seen.
///
/// Cloning shares one record set: the handle a composition holds and the handle the
/// connection task writes through are the same state, so there is no arrangement in
/// which a host's status is answered from a second, emptier ledger. There is no
/// public constructor for the same reason.
#[derive(Clone)]
pub struct HostAdmission {
    records: Arc<Mutex<HashMap<String, ProtocolMismatch>>>,
    slots: Arc<dyn SlotOccupancy>,
}

impl HostAdmission {
    pub(crate) fn new(slots: Arc<dyn SlotOccupancy>) -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
            slots,
        }
    }

    /// Record a refusal for the host the transport authenticated, replacing any
    /// earlier one. The host key is the connection's own — a frame never names the
    /// host it is refused for, so a refusal cannot be attributed to another machine.
    pub(crate) fn record(
        &self,
        host_id: &str,
        refusal: ProtocolMismatch,
    ) -> Result<RefusalNews, AdmissionUnavailable> {
        let mut records = self.records.lock().map_err(|_| AdmissionUnavailable)?;
        let news = match records.get(host_id) {
            Some(previous)
                if previous.offered_protocol_version == refusal.offered_protocol_version
                    && previous.expected_protocol_version == refusal.expected_protocol_version =>
            {
                RefusalNews::SameUnresolvedFact
            }
            _ => RefusalNews::Changed,
        };
        records.insert(host_id.to_owned(), refusal);
        Ok(news)
    }

    /// Resolve this host's refusal, because a daemon just proved it speaks the wire
    /// version. The only edge that clears: a close clears nothing, so a stale
    /// daemon's reconnect loop keeps the record continuously set instead of
    /// flickering the reason off between attempts.
    pub(crate) fn clear(&self, host_id: &str) -> Result<(), AdmissionUnavailable> {
        self.records
            .lock()
            .map_err(|_| AdmissionUnavailable)?
            .remove(host_id);
        Ok(())
    }

    /// The most recent UNRESOLVED refusal, or none when a different dialer holds the
    /// slot: that record describes a socket already gone, and the dialer holding the
    /// slot may be a fixed daemon that has simply not handshaken yet. A consumer
    /// therefore never compares generations itself — and cannot, having no dialer.
    ///
    /// Reading resolves nothing. Presence means "still unresolved", so the answer is
    /// stable for as long as the fact is.
    pub fn refusal(
        &self,
        host: &HostId,
    ) -> Result<Option<ProtocolMismatchRefusal>, AdmissionUnavailable> {
        let records = self.records.lock().map_err(|_| AdmissionUnavailable)?;
        let Some(refusal) = records.get(host.as_str()) else {
            return Ok(None);
        };
        if self
            .slots
            .slot_dialer(host.as_str())?
            .is_some_and(|holder| holder != refusal.dialer)
        {
            return Ok(None);
        }
        Ok(Some(ProtocolMismatchRefusal {
            offered_protocol_version: refusal.offered_protocol_version,
            expected_protocol_version: refusal.expected_protocol_version,
            observed_at: refusal.observed_at,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The occupancy the registry reports, driven directly so the rule can be
    /// exercised at every point of the sequence. The sequence itself is proven
    /// against the real registry over real sockets in `daemon_delivery_e2e`; this
    /// stands in only for the rule's own arms.
    struct Occupancy(Mutex<Option<DialerId>>);

    impl SlotOccupancy for Occupancy {
        fn slot_dialer(&self, _host_id: &str) -> Result<Option<DialerId>, AdmissionUnavailable> {
            Ok(self.0.lock().map_err(|_| AdmissionUnavailable)?.clone())
        }
    }

    fn ledger() -> (HostAdmission, Arc<Occupancy>) {
        let occupancy = Arc::new(Occupancy(Mutex::new(None)));
        (HostAdmission::new(occupancy.clone()), occupancy)
    }

    fn hold(occupancy: &Occupancy, dialer: Option<&str>) {
        *occupancy.0.lock().unwrap() = dialer.map(DialerId::from_connection);
    }

    fn mismatch(dialer: &str, offered: u32) -> ProtocolMismatch {
        ProtocolMismatch {
            dialer: DialerId::from_connection(dialer),
            offered_protocol_version: offered,
            expected_protocol_version: 2,
            observed_at: 1_700_000_000_000,
        }
    }

    fn host() -> HostId {
        HostId::parse("host-1").unwrap()
    }

    #[test]
    fn a_refusal_is_withheld_while_another_dialer_holds_the_slot_and_returns_when_it_is_gone() {
        let (admission, occupancy) = ledger();
        // The refused dialer still holds its own slot: the record explains this
        // host's state.
        hold(&occupancy, Some("connection-1"));
        admission
            .record("host-1", mismatch("connection-1", 1))
            .unwrap();
        assert_eq!(
            admission.refusal(&host()).unwrap(),
            Some(ProtocolMismatchRefusal {
                offered_protocol_version: 1,
                expected_protocol_version: 2,
                observed_at: 1_700_000_000_000,
            })
        );

        // Its slot is gone and nobody has taken it: still the last word on why this
        // host is offline, because a close resolves nothing.
        hold(&occupancy, None);
        assert!(admission.refusal(&host()).unwrap().is_some());

        // A different dialer has the slot: withheld, because that daemon may be a
        // fixed one that has not handshaken yet.
        hold(&occupancy, Some("connection-2"));
        assert_eq!(admission.refusal(&host()).unwrap(), None);

        // That dialer closed before proving anything, and its slot was removed: the
        // older refusal is observable again. Reading it never consumed it.
        hold(&occupancy, None);
        assert!(admission.refusal(&host()).unwrap().is_some());

        // Only a daemon that speaks the version clears it.
        admission.clear("host-1").unwrap();
        assert_eq!(admission.refusal(&host()).unwrap(), None);
    }

    #[test]
    fn a_refusal_is_news_only_when_the_incompatibility_itself_changed() {
        let (admission, _) = ledger();
        assert_eq!(
            admission
                .record("host-1", mismatch("connection-1", 1))
                .unwrap(),
            RefusalNews::Changed
        );
        // A reconnect loop: same disagreement, new dialer and new timestamp.
        assert_eq!(
            admission
                .record("host-1", mismatch("connection-2", 1))
                .unwrap(),
            RefusalNews::SameUnresolvedFact
        );
        // The machine was upgraded to a build that is still incompatible.
        assert_eq!(
            admission
                .record("host-1", mismatch("connection-3", 3))
                .unwrap(),
            RefusalNews::Changed
        );
        // Cleared, then refused again: the reader was told it was resolved, so the
        // same versions are news once more.
        admission.clear("host-1").unwrap();
        assert_eq!(
            admission
                .record("host-1", mismatch("connection-4", 3))
                .unwrap(),
            RefusalNews::Changed
        );
    }

    #[test]
    fn a_record_answers_only_for_the_host_it_was_refused_for() {
        let (admission, _) = ledger();
        admission
            .record("host-1", mismatch("connection-1", 1))
            .unwrap();
        assert_eq!(
            admission
                .refusal(&HostId::parse("host-2").unwrap())
                .unwrap(),
            None
        );
        admission.clear("host-2").unwrap();
        assert!(admission.refusal(&host()).unwrap().is_some());
    }
}
