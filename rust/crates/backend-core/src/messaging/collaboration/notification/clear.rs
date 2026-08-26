use crate::identity::{ConversationId, UserId, WorkspaceId};
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
                BadgeWorkspaceSet::from_workspaces([
                    WorkspaceId::parse("w1").unwrap(),
                    WorkspaceId::parse("w1").unwrap(),
                    WorkspaceId::parse("w2").unwrap(),
                ]),
            ))
        }
    }
    struct Effects(Mutex<Vec<&'static str>>);
    #[derive(Debug, thiserror::Error)]
    #[error("boom")]
    struct Boom;
    impl NotificationAftermath for Effects {
        async fn unread_changed(
            &self,
            _: &CommittedNotificationClear,
        ) -> Result<(), NotificationClearFailure> {
            self.0.lock().unwrap().push("unread");
            Err(NotificationClearFailure::from_source(Boom))
        }
        async fn badge_changed(
            &self,
            _: &CommittedNotificationClear,
            w: &WorkspaceId,
        ) -> Result<(), NotificationClearFailure> {
            self.0
                .lock()
                .unwrap()
                .push(if w.as_str() == "w1" { "w1" } else { "w2" });
            Ok(())
        }
    }
    #[tokio::test]
    async fn committed_clear_attempts_every_effect_and_keeps_the_first_failure() {
        let effects = Effects(Mutex::new(vec![]));
        let result = clear_notifications(
            &Port,
            &effects,
            UserId::parse("u").unwrap(),
            NotificationClearSelector::All,
        )
        .await
        .unwrap();
        assert_eq!(effects.0.into_inner().unwrap(), ["unread", "w1", "w2"]);
        assert_eq!(result.committed().marked(), 2);
        assert!(result.first_failure().is_some());
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedNotificationClear {
    viewer: UserId,
    change: NotificationClearChange,
}

/// A canonical, duplicate-free set of workspaces whose absolute tiered badge
/// changed across the committed clear.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BadgeWorkspaceSet(Vec<WorkspaceId>);

impl BadgeWorkspaceSet {
    pub fn from_workspaces(workspaces: impl IntoIterator<Item = WorkspaceId>) -> Self {
        let mut workspaces = workspaces.into_iter().collect::<Vec<_>>();
        workspaces.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
        workspaces.dedup_by(|left, right| left.as_str() == right.as_str());
        Self(workspaces)
    }

    pub fn iter(&self) -> impl Iterator<Item = &WorkspaceId> {
        self.0.iter()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum NotificationClearChange {
    Unchanged,
    Changed {
        marked: NonZeroU64,
        badge_workspaces: BadgeWorkspaceSet,
    },
}

impl CommittedNotificationClear {
    pub fn unchanged(viewer: UserId) -> Self {
        Self {
            viewer,
            change: NotificationClearChange::Unchanged,
        }
    }

    pub fn changed(
        viewer: UserId,
        marked: NonZeroU64,
        badge_workspaces: BadgeWorkspaceSet,
    ) -> Self {
        Self {
            viewer,
            change: NotificationClearChange::Changed {
                marked,
                badge_workspaces,
            },
        }
    }
    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }
    pub fn marked(&self) -> u64 {
        match &self.change {
            NotificationClearChange::Unchanged => 0,
            NotificationClearChange::Changed { marked, .. } => marked.get(),
        }
    }
    pub fn badge_workspaces(&self) -> impl Iterator<Item = &WorkspaceId> {
        match &self.change {
            NotificationClearChange::Unchanged => None,
            NotificationClearChange::Changed {
                badge_workspaces, ..
            } => Some(badge_workspaces.iter()),
        }
        .into_iter()
        .flatten()
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

pub trait NotificationAftermath {
    fn unread_changed(
        &self,
        fact: &CommittedNotificationClear,
    ) -> impl Future<Output = Result<(), NotificationClearFailure>> + Send;
    fn badge_changed(
        &self,
        fact: &CommittedNotificationClear,
        workspace: &WorkspaceId,
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
    if committed.marked() > 0 {
        if let Err(error) = aftermath.unread_changed(&committed).await {
            first_failure = Some(error);
        }
        for workspace in committed.badge_workspaces() {
            if let Err(error) = aftermath.badge_changed(&committed, workspace).await
                && first_failure.is_none()
            {
                first_failure = Some(error);
            }
        }
    }
    Ok(ClearNotifications {
        committed,
        first_failure,
    })
}
