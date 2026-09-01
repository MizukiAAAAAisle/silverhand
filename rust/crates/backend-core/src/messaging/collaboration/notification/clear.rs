use crate::foundation::identity::{ConversationId, UserId, WorkspaceId};
use crate::messaging::NotificationId;
use std::{error::Error, future::Future, num::NonZeroU64};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NotificationClearSelector {
    Id(NotificationId),
    Workspace(WorkspaceId),
    Conversation(ConversationId),
    All,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{convert::Infallible, sync::Mutex};
    struct Port;
    impl NotificationClearPort for Port {
        type Error = Infallible;
        async fn clear(
            &self,
            viewer: UserId,
            _: NotificationClearSelector,
        ) -> Result<CommittedNotificationClear, Self::Error> {
            Ok(CommittedNotificationClear::changed(
                viewer,
                NonZeroU64::new(2).unwrap(),
            ))
        }
    }
    struct Effects(Mutex<u32>);
    #[derive(Debug, thiserror::Error)]
    #[error("boom")]
    struct Boom;
    impl NotificationAftermath for Effects {
        async fn unread_changed(
            &self,
            _: &CommittedNotificationClear,
        ) -> Result<(), NotificationClearFailure> {
            *self.0.lock().unwrap() += 1;
            Err(NotificationClearFailure::from_source(Boom))
        }
    }
    #[tokio::test]
    async fn a_committed_clear_fires_the_unread_effect_once_and_keeps_its_failure() {
        let effects = Effects(Mutex::new(0));
        let result = clear_notifications(
            &Port,
            &effects,
            UserId::parse("u").unwrap(),
            NotificationClearSelector::All,
        )
        .await
        .unwrap();
        // The unread signal fires exactly once for a change, and a transport failure is
        // carried on the result rather than flipping the already-committed clear.
        assert_eq!(*effects.0.lock().unwrap(), 1);
        assert_eq!(result.committed().marked(), 2);
        assert!(result.first_failure().is_some());
    }

    struct Unchanged;
    impl NotificationClearPort for Unchanged {
        type Error = Infallible;
        async fn clear(
            &self,
            viewer: UserId,
            _: NotificationClearSelector,
        ) -> Result<CommittedNotificationClear, Self::Error> {
            Ok(CommittedNotificationClear::unchanged(viewer))
        }
    }
    struct CountingEffects(Mutex<u32>);
    impl NotificationAftermath for CountingEffects {
        async fn unread_changed(
            &self,
            _: &CommittedNotificationClear,
        ) -> Result<(), NotificationClearFailure> {
            *self.0.lock().unwrap() += 1;
            Ok(())
        }
    }
    #[tokio::test]
    async fn an_unchanged_clear_fires_no_effect() {
        let effects = CountingEffects(Mutex::new(0));
        let result = clear_notifications(
            &Unchanged,
            &effects,
            UserId::parse("u").unwrap(),
            NotificationClearSelector::All,
        )
        .await
        .unwrap();
        assert_eq!(*effects.0.lock().unwrap(), 0);
        assert_eq!(result.committed().marked(), 0);
        assert!(result.first_failure().is_none());
    }
}

/// The committed witness of a directed-notification mark-read: who acted, and how many
/// rows the write actually moved. It carries NO absolute badge projection — that value
/// is deliberately left to the client's authoritative REST refetch, because an absolute
/// count published out of commit order under a last-write-wins consumer can permanently
/// write back a stale value (see the module effect contract). The write authority seals
/// only the target result (`marked`); "which badge value is current" is never sealed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedNotificationClear {
    viewer: UserId,
    marked: u64,
}

impl CommittedNotificationClear {
    pub fn unchanged(viewer: UserId) -> Self {
        Self { viewer, marked: 0 }
    }

    pub fn changed(viewer: UserId, marked: NonZeroU64) -> Self {
        Self {
            viewer,
            marked: marked.get(),
        }
    }
    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }
    pub fn marked(&self) -> u64 {
        self.marked
    }
}

pub trait NotificationClearPort {
    type Error: Error + Send + Sync + 'static;
    fn clear(
        &self,
        viewer: UserId,
        selector: NotificationClearSelector,
    ) -> impl Future<Output = Result<CommittedNotificationClear, Self::Error>> + Send;
}

/// The post-commit effect of a directed-notification clear: a single viewer-private
/// signal that the viewer's unread state changed. It carries no absolute projection
/// value; a consumer treats it as a refetch trigger for the authoritative read, so
/// out-of-order delivery of two clears converges on the current committed state rather
/// than letting an earlier commit's stale value win.
pub trait NotificationAftermath {
    fn unread_changed(
        &self,
        fact: &CommittedNotificationClear,
    ) -> impl Future<Output = Result<(), NotificationClearFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
#[error("a committed notification clear effect failed")]
pub struct NotificationClearFailure {
    #[source]
    source: Box<dyn Error + Send + Sync>,
}
impl NotificationClearFailure {
    pub fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

#[derive(Debug)]
pub struct ClearNotifications {
    committed: CommittedNotificationClear,
    first_failure: Option<NotificationClearFailure>,
}
impl ClearNotifications {
    pub fn committed(&self) -> &CommittedNotificationClear {
        &self.committed
    }
    pub fn first_failure(&self) -> Option<&NotificationClearFailure> {
        self.first_failure.as_ref()
    }
}

pub async fn clear_notifications<P: NotificationClearPort>(
    port: &P,
    aftermath: &impl NotificationAftermath,
    viewer: UserId,
    selector: NotificationClearSelector,
) -> Result<ClearNotifications, P::Error> {
    let committed = port.clear(viewer, selector).await?;
    let mut first_failure = None;
    // A no-op clear moved no unread state, so it owes no signal. A real change fires the
    // unread signal exactly once; a transport failure is retained but never flips the
    // already-committed result.
    if committed.marked() > 0
        && let Err(error) = aftermath.unread_changed(&committed).await
    {
        first_failure = Some(error);
    }
    Ok(ClearNotifications {
        committed,
        first_failure,
    })
}
