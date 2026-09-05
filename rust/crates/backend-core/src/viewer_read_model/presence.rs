//! Who is present, as the client's first read of the `user_presence` stream.
//!
//! One reason to change: how a stored last-seen row and a live presence answer
//! become one listed value. WHEN a viewer becomes absent is not decided here — it
//! is [`crate::viewer_read_model::presence_grace`], the same authority the `user_presence`
//! event publishes from, so this read and that event observe one fact.
//!
//! ## No time arithmetic
//!
//! Presence is `connected || a grace window is still pending`. It is deliberately
//! NOT `now - last_seen_at < window`: the stored stamp is written when a window
//! EXPIRES, so recomputing presence from it would answer for viewers whose window
//! is still open, and would keep answering after a restart lost the windows. A
//! read that never consults the clock cannot drift from the transition that
//! published the event.
//!
//! ## Process-local and lost on restart
//!
//! There is no sweep and no persisted window: a restart forgets every pending
//! window, so viewers who were mid-grace read offline from their stored stamp.
//! That is the reference behaviour, not a gap to close here — closing it would
//! give presence a second authority whose value no event announces.
//!
//! ## A closed snapshot over validated facts
//!
//! The listed viewers are not a free vector: they are a [`PresenceSnapshot`], a
//! set with no repeated identity standing in ONE total order (`created_at`, then
//! `id`), so a bare SQL scan's engine-incidental order and a port that hands back
//! a duplicate cannot reach the wire as a `200`. A stored stamp is likewise not a
//! free integer: it is a [`LastSeenAt`], validated non-negative and inside the
//! JS-safe range the `number` wire carries losslessly, WHEN a row is decoded —
//! before liveness is consulted, so an online viewer whose stamp will be
//! suppressed still cannot hide a corrupt one behind the suppression.

use thiserror::Error;

use crate::foundation::identity::UserId;

/// The largest integer an IEEE-754 double — the JavaScript `number` the wire
/// contract carries — represents exactly: `2^53 - 1`. A stored stamp beyond it
/// could not round-trip through a client, so it is corruption, not a late instant.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// A stored last-seen stamp validated as a wire-safe instant: non-negative and no
/// larger than [`MAX_SAFE_INTEGER`]. It is fallible to build precisely so a
/// committed row cannot smuggle a value the `number` wire could not carry; the
/// inner integer is reachable only through [`LastSeenAt::get`] for the wire.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LastSeenAt(i64);

/// A stored `last_seen_at` outside the wire-safe range. Carries the offending
/// value for the operator log; it is never rendered to the client.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
#[error("last_seen_at {0} is negative or beyond the JS safe-integer range")]
pub struct LastSeenOutOfRange(pub i64);

impl LastSeenAt {
    /// Validate a stored value at decode. Corruption — negative, or beyond the
    /// range the wire can carry — is refused HERE, not masked at render.
    pub fn from_stored(value: i64) -> Result<Self, LastSeenOutOfRange> {
        if (0..=MAX_SAFE_INTEGER).contains(&value) {
            Ok(Self(value))
        } else {
            Err(LastSeenOutOfRange(value))
        }
    }

    /// The validated instant, for the wire.
    pub fn get(self) -> i64 {
        self.0
    }
}

/// One viewer's presence.
///
/// The stamp exists only on the absent arm, so "a present viewer reports no
/// last-seen" is structural: there is no field on `Online` to fill in from a
/// stored row, and no renderer can leak one by forgetting to suppress it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UserPresence {
    Online,
    Offline {
        /// Absent for a viewer never observed present. A never-seen viewer is not
        /// dated from their creation or from now — an unknown instant stays
        /// unknown.
        last_seen_at: Option<LastSeenAt>,
    },
}

/// The stored half: one row of the listed viewers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserPresenceFacts {
    pub id: UserId,
    pub last_seen_at: Option<LastSeenAt>,
    /// The row's creation instant. It never reaches the wire; it is the primary
    /// key of the listed order, so the snapshot stands in a total order rather
    /// than whatever order a bare scan happened to return.
    pub created_at: i64,
}

/// One answered row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserPresenceRow {
    pub user_id: UserId,
    pub presence: UserPresence,
}

/// The listed viewers as a CLOSED fact: no identity appears twice, and the rows
/// stand in one total order — `created_at` ascending, ties broken by `id`. Built
/// only through [`PresenceSnapshot::seal`], so a port that returns a duplicate
/// identity or a non-total order describes corruption and is refused rather than
/// projected.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PresenceSnapshot {
    rows: Vec<UserPresenceFacts>,
}

/// Why a loaded list is not a listable snapshot. Both are corruption of the read,
/// never a product-level refusal.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum PresenceSnapshotError {
    #[error("viewer {0} is listed more than once in the presence snapshot")]
    DuplicateIdentity(String),
    #[error("presence snapshot is not ordered by (created_at, id)")]
    NotTotallyOrdered,
}

impl PresenceSnapshot {
    /// Seal a loaded list into the closed snapshot, or refuse it. The order is
    /// VERIFIED, not repaired: a strictly increasing `(created_at, id)` is the
    /// contract the SQL adapter is held to, so a port that returns rows out of
    /// that order is a broken port, not a snapshot to reorder silently.
    pub fn seal(rows: Vec<UserPresenceFacts>) -> Result<Self, PresenceSnapshotError> {
        let mut identities: Vec<&str> = rows.iter().map(|row| row.id.as_str()).collect();
        identities.sort_unstable();
        if let Some(pair) = identities.windows(2).find(|pair| pair[0] == pair[1]) {
            return Err(PresenceSnapshotError::DuplicateIdentity(pair[0].to_owned()));
        }
        for pair in rows.windows(2) {
            let earlier = (pair[0].created_at, pair[0].id.as_str());
            let later = (pair[1].created_at, pair[1].id.as_str());
            if later <= earlier {
                return Err(PresenceSnapshotError::NotTotallyOrdered);
            }
        }
        Ok(Self { rows })
    }

    fn rows(&self) -> &[UserPresenceFacts] {
        &self.rows
    }
}

/// The live half: whether a viewer is present RIGHT NOW.
///
/// An implementation answers from the connection set and the pending grace
/// windows through [`crate::viewer_read_model::presence_grace::is_online`], and from nothing
/// else. Two obligations on whoever implements it, neither checkable here:
/// it must be the same registry the `user_presence` event publishes from, and it
/// must not re-derive presence from a timestamp.
pub trait OnlineViewers {
    fn is_online(&self, user_id: &UserId) -> bool;
}

/// Answer presence for every listed viewer, in the snapshot's total order.
///
/// Each row is asked about with its OWN id, so there is no coordinate to splice:
/// unlike a read that composes channels keyed independently, a mismatch here has
/// no way to occur rather than a rule that refuses it.
pub fn read_user_presence(
    snapshot: &PresenceSnapshot,
    online: &impl OnlineViewers,
) -> Vec<UserPresenceRow> {
    snapshot
        .rows()
        .iter()
        .map(|user| UserPresenceRow {
            user_id: user.id.clone(),
            presence: if online.is_online(&user.id) {
                UserPresence::Online
            } else {
                UserPresence::Offline {
                    last_seen_at: user.last_seen_at,
                }
            },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;
    use crate::viewer_read_model::presence_grace;

    fn user_id(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn facts(id: &str, last_seen_at: Option<i64>, created_at: i64) -> UserPresenceFacts {
        UserPresenceFacts {
            id: user_id(id),
            last_seen_at: last_seen_at.map(|value| LastSeenAt::from_stored(value).unwrap()),
            created_at,
        }
    }

    fn sealed(rows: Vec<UserPresenceFacts>) -> PresenceSnapshot {
        PresenceSnapshot::seal(rows).expect("fixture rows are a valid snapshot")
    }

    /// Records what it was asked, so a read that answered from the wrong id — or
    /// from one answer reused for every row — is visible.
    struct Registry {
        present: Vec<UserId>,
        asked: RefCell<Vec<UserId>>,
    }

    impl Registry {
        fn with_present(present: &[&str]) -> Self {
            Self {
                present: present.iter().map(|id| user_id(id)).collect(),
                asked: RefCell::new(Vec::new()),
            }
        }
    }

    impl OnlineViewers for Registry {
        fn is_online(&self, user_id: &UserId) -> bool {
            self.asked.borrow_mut().push(user_id.clone());
            self.present.contains(user_id)
        }
    }

    #[test]
    fn last_seen_at_accepts_the_wire_safe_range_and_refuses_outside_it() {
        assert!(LastSeenAt::from_stored(0).is_ok());
        assert_eq!(LastSeenAt::from_stored(1_700).unwrap().get(), 1_700);
        assert!(LastSeenAt::from_stored(MAX_SAFE_INTEGER).is_ok());
        assert_eq!(LastSeenAt::from_stored(-1), Err(LastSeenOutOfRange(-1)));
        assert_eq!(
            LastSeenAt::from_stored(MAX_SAFE_INTEGER + 1),
            Err(LastSeenOutOfRange(MAX_SAFE_INTEGER + 1))
        );
    }

    #[test]
    fn seal_refuses_a_duplicate_identity() {
        let error = PresenceSnapshot::seal(vec![facts("u1", None, 1), facts("u1", None, 2)])
            .expect_err("a repeated identity is not a listable set");
        assert_eq!(
            error,
            PresenceSnapshotError::DuplicateIdentity("u1".to_owned())
        );
    }

    #[test]
    fn seal_refuses_a_non_total_order() {
        let error = PresenceSnapshot::seal(vec![facts("u2", None, 2), facts("u1", None, 1)])
            .expect_err("descending created_at is not the contracted order");
        assert_eq!(error, PresenceSnapshotError::NotTotallyOrdered);
    }

    #[test]
    fn seal_requires_created_at_ties_to_be_broken_by_ascending_id() {
        // Same instant, id-ascending: a valid total order.
        assert!(PresenceSnapshot::seal(vec![facts("a", None, 100), facts("b", None, 100)]).is_ok());
        // Same instant, id-descending: the reverse-seed tie must NOT pass — the
        // adapter's `id ASC` tiebreak is the only stable answer.
        let error = PresenceSnapshot::seal(vec![facts("b", None, 100), facts("a", None, 100)])
            .expect_err("a created_at tie in descending id order is not total");
        assert_eq!(error, PresenceSnapshotError::NotTotallyOrdered);
    }

    /// The stamp is ancient and the viewer is present anyway: presence is never
    /// recomputed from it.
    #[test]
    fn a_present_viewer_reports_no_last_seen_even_with_one_stored() {
        let rows = read_user_presence(
            &sealed(vec![facts("u1", Some(1), 1)]),
            &Registry::with_present(&["u1"]),
        );
        assert_eq!(
            rows,
            vec![UserPresenceRow {
                user_id: user_id("u1"),
                presence: UserPresence::Online,
            }]
        );
    }

    #[test]
    fn an_absent_viewer_carries_the_stored_stamp() {
        let rows = read_user_presence(
            &sealed(vec![facts("u1", Some(1_700), 1)]),
            &Registry::with_present(&[]),
        );
        assert_eq!(
            rows[0].presence,
            UserPresence::Offline {
                last_seen_at: Some(LastSeenAt::from_stored(1_700).unwrap())
            }
        );
    }

    #[test]
    fn a_viewer_never_observed_present_is_offline_without_a_stamp() {
        let rows = read_user_presence(
            &sealed(vec![facts("u1", None, 1)]),
            &Registry::with_present(&[]),
        );
        assert_eq!(
            rows[0].presence,
            UserPresence::Offline { last_seen_at: None }
        );
    }

    #[test]
    fn every_row_is_asked_about_its_own_viewer() {
        let registry = Registry::with_present(&["u2"]);
        let rows = read_user_presence(
            &sealed(vec![
                facts("u1", Some(1), 1),
                facts("u2", Some(2), 2),
                facts("u3", Some(3), 3),
            ]),
            &registry,
        );

        assert_eq!(
            registry.asked.borrow().as_slice(),
            &[user_id("u1"), user_id("u2"), user_id("u3")]
        );
        assert_eq!(
            rows.iter().map(|row| &row.presence).collect::<Vec<_>>(),
            vec![
                &UserPresence::Offline {
                    last_seen_at: Some(LastSeenAt::from_stored(1).unwrap())
                },
                &UserPresence::Online,
                &UserPresence::Offline {
                    last_seen_at: Some(LastSeenAt::from_stored(3).unwrap())
                },
            ]
        );
    }

    #[test]
    fn the_answer_keeps_the_snapshot_order_which_follows_created_at_not_id() {
        // created_at drives the order (u3 first), independent of id.
        let rows = read_user_presence(
            &sealed(vec![
                facts("u3", None, 1),
                facts("u1", None, 2),
                facts("u2", None, 3),
            ]),
            &Registry::with_present(&[]),
        );
        assert_eq!(
            rows.iter().map(|row| &row.user_id).collect::<Vec<_>>(),
            vec![&user_id("u3"), &user_id("u1"), &user_id("u2")]
        );
    }

    /// Composed the way production must: no connection, a window still pending.
    /// The viewer reads present, and the stamp their expiry will eventually write
    /// stays suppressed.
    struct GraceRegistry;

    impl OnlineViewers for GraceRegistry {
        fn is_online(&self, _user_id: &UserId) -> bool {
            presence_grace::is_online(false, true)
        }
    }

    #[test]
    fn a_viewer_inside_the_grace_window_still_reads_present() {
        let rows = read_user_presence(&sealed(vec![facts("u1", Some(1_700), 1)]), &GraceRegistry);
        assert_eq!(rows[0].presence, UserPresence::Online);
    }
}
