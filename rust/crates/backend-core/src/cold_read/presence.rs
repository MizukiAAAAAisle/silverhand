//! Who is present, as the client's first read of the `user_presence` stream.
//!
//! One reason to change: how a stored last-seen row and a live presence answer
//! become one listed value. WHEN a viewer becomes absent is not decided here — it
//! is [`crate::policy::presence_grace`], the same authority the `user_presence`
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

use crate::identity::UserId;

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
        last_seen_at: Option<i64>,
    },
}

/// The stored half: one row of the listed viewers.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserPresenceFacts {
    pub id: UserId,
    pub last_seen_at: Option<i64>,
}

/// One answered row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserPresenceRow {
    pub user_id: UserId,
    pub presence: UserPresence,
}

/// The live half: whether a viewer is present RIGHT NOW.
///
/// An implementation answers from the connection set and the pending grace
/// windows through [`crate::policy::presence_grace::is_online`], and from nothing
/// else. Two obligations on whoever implements it, neither checkable here:
/// it must be the same registry the `user_presence` event publishes from, and it
/// must not re-derive presence from a timestamp.
pub trait OnlineViewers {
    fn is_online(&self, user_id: &UserId) -> bool;
}

/// Answer presence for every listed viewer, in the order given.
///
/// Each row is asked about with its OWN id, so there is no coordinate to splice:
/// unlike a read that composes channels keyed independently, a mismatch here has
/// no way to occur rather than a rule that refuses it.
pub fn read_user_presence(
    users: &[UserPresenceFacts],
    online: &impl OnlineViewers,
) -> Vec<UserPresenceRow> {
    users
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
    use crate::policy::presence_grace;

    fn user_id(id: &str) -> UserId {
        UserId::parse(id).expect("user id")
    }

    fn facts(id: &str, last_seen_at: Option<i64>) -> UserPresenceFacts {
        UserPresenceFacts {
            id: user_id(id),
            last_seen_at,
        }
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

    /// The stamp is ancient and the viewer is present anyway: presence is never
    /// recomputed from it.
    #[test]
    fn a_present_viewer_reports_no_last_seen_even_with_one_stored() {
        let rows = read_user_presence(&[facts("u1", Some(1))], &Registry::with_present(&["u1"]));
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
        let rows = read_user_presence(&[facts("u1", Some(1_700))], &Registry::with_present(&[]));
        assert_eq!(
            rows[0].presence,
            UserPresence::Offline {
                last_seen_at: Some(1_700)
            }
        );
    }

    #[test]
    fn a_viewer_never_observed_present_is_offline_without_a_stamp() {
        let rows = read_user_presence(&[facts("u1", None)], &Registry::with_present(&[]));
        assert_eq!(
            rows[0].presence,
            UserPresence::Offline { last_seen_at: None }
        );
    }

    #[test]
    fn every_row_is_asked_about_its_own_viewer() {
        let registry = Registry::with_present(&["u2"]);
        let rows = read_user_presence(
            &[
                facts("u1", Some(1)),
                facts("u2", Some(2)),
                facts("u3", Some(3)),
            ],
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
                    last_seen_at: Some(1)
                },
                &UserPresence::Online,
                &UserPresence::Offline {
                    last_seen_at: Some(3)
                },
            ]
        );
    }

    #[test]
    fn the_answer_keeps_the_listed_order() {
        let rows = read_user_presence(
            &[facts("u3", None), facts("u1", None), facts("u2", None)],
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
        let rows = read_user_presence(&[facts("u1", Some(1_700))], &GraceRegistry);
        assert_eq!(rows[0].presence, UserPresence::Online);
    }
}
