//! One notification identity, spent at every station that handles it.
//!
//! The identity was declared twice: once as the minted opaque id the write path
//! reports, and once inside the notification model the read path returns. Nothing
//! detected it, because each half was internally consistent — the cost only showed
//! up as a string round trip whenever an id had to cross from one to the other, and
//! a round trip through `String` accepts values neither half would mint.
//!
//! This file carries a single minted id through aftermath, list, clear and activity
//! WITHOUT re-parsing it anywhere. Every station below takes the value by move, so a
//! second definition cannot come back without breaking this build.

use silverhand_backend_core::{
    conversation_messaging::messaging::{
        EnvironmentUnavailable, MessageId, NotificationId, ParticipantHandle, SendEntropy,
        collaboration::{
            activity::observe::ObserveSource,
            notification::{
                Notification, NotificationClearSelector, NotificationKind, NotificationTimestamp,
            },
        },
        post_commit::{CommittedMentionRow, MentionIntent},
    },
    foundation::identity::{ConversationId, UserId, WorkspaceId},
};

/// Entropy with no randomness in it, so the minted identity is a known value.
struct FixedEntropy;

impl SendEntropy for FixedEntropy {
    fn fill(&self, buffer: &mut [u8]) -> Result<(), EnvironmentUnavailable> {
        buffer.fill(0);
        Ok(())
    }
}

fn intent() -> MentionIntent {
    MentionIntent::committed(
        vec![ParticipantHandle::parse("alice").unwrap()],
        Some(UserId::parse("u-author").unwrap()),
        "alice".to_owned(),
        WorkspaceId::parse("w-1").unwrap(),
        ConversationId::parse("c-1").unwrap(),
        "General".to_owned(),
        MessageId::parse("m-1").unwrap(),
        "hello @alice".to_owned(),
    )
}

fn listed(id: NotificationId) -> Notification {
    Notification {
        id,
        kind: NotificationKind::MentionSelf,
        user: Some(UserId::parse("u-1").unwrap()),
        agent: None,
        workspace: Some(WorkspaceId::parse("w-1").unwrap()),
        conversation: Some(ConversationId::parse("c-1").unwrap()),
        message: Some(MessageId::parse("m-1").unwrap()),
        thread_root: None,
        source_workspace: None,
        source_conversation: None,
        source_message: None,
        payload_json: None,
        read_at: None,
        created_at: NotificationTimestamp::new(10).unwrap(),
    }
}

/// The minted id reaches the clear selector and the activity source by move, through
/// the row the write reported and the notification the list returned. No `parse`, no
/// `as_str`, no `String` anywhere on the path.
#[test]
fn one_minted_identity_travels_from_the_write_to_every_read() {
    let minted = NotificationId::mint(&FixedEntropy).unwrap();

    let row = CommittedMentionRow::committed(
        minted.clone(),
        10,
        UserId::parse("u-1").unwrap(),
        ParticipantHandle::parse("alice").unwrap(),
        intent(),
    );
    let notification = listed(row.id().clone());
    let selector = NotificationClearSelector::Id(notification.id.clone());
    let observed = ObserveSource::Notification(notification.id.clone());

    assert_eq!(row.id(), &minted);
    assert_eq!(notification.id, minted);
    assert_eq!(selector, NotificationClearSelector::Id(minted.clone()));
    assert_eq!(observed, ObserveSource::Notification(minted));
}

/// The surviving authority still refuses the one value neither half ever minted. The
/// deleted duplicate carried this rule too, so its removal has to leave it standing.
#[test]
fn an_empty_notification_identity_is_still_refused() {
    assert!(NotificationId::parse("").is_err());
    assert_eq!(NotificationId::parse("n-1").unwrap().as_str(), "n-1");
}
