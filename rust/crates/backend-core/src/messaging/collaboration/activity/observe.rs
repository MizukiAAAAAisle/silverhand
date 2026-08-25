//! The single viewer-owned Activity elimination use case.
//!
//! A batch is admitted and committed atomically by one persistence port.  The
//! core only exposes closed post-commit facts: a workspace conversation and a
//! direct pair cannot share coordinates, notification dismissals exist only for
//! rows this call changed, and directed-only badge workspaces are de-duplicated
//! from workspace conversations already carrying the same absolute projection.

use std::{error::Error, future::Future};

use crate::{
    identity::{ConversationId, UserId, WorkspaceId},
    messaging::{MessageSeq, NotificationId, ThreadRootId},
};

pub const OBSERVE_BATCH_MAX: usize = 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StreamPosition {
    AtSeq(MessageSeq),
    StreamHead,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObserveSource {
    Stream {
        conversation: ConversationId,
        thread_root: Option<ThreadRootId>,
        position: StreamPosition,
    },
    Notification(NotificationId),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum InvalidObserveBatch {
    #[error("an observation batch must contain at least one source")]
    Empty,
    #[error("an observation batch cannot contain more than 1000 sources")]
    TooLarge,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObserveBatch(Vec<ObserveSource>);

impl ObserveBatch {
    pub fn new(sources: Vec<ObserveSource>) -> Result<Self, InvalidObserveBatch> {
        if sources.is_empty() {
            return Err(InvalidObserveBatch::Empty);
        }
        if sources.len() > OBSERVE_BATCH_MAX {
            return Err(InvalidObserveBatch::TooLarge);
        }
        Ok(Self(sources))
    }

    pub fn sources(&self) -> &[ObserveSource] {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObserveRefusal {
    ConversationNotFound,
    Forbidden,
    ThreadRootNotFound,
    ThreadRootIsReply,
    PositionFuture,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ObservedConversation {
    Workspace {
        conversation: ConversationId,
        workspace: WorkspaceId,
    },
    DirectPair {
        conversation: ConversationId,
    },
}

impl ObservedConversation {
    pub fn workspace(conversation: ConversationId, workspace: WorkspaceId) -> Self {
        Self::Workspace {
            conversation,
            workspace,
        }
    }

    pub fn direct_pair(conversation: ConversationId) -> Self {
        Self::DirectPair { conversation }
    }

    pub fn conversation(&self) -> &ConversationId {
        match self {
            Self::Workspace { conversation, .. } | Self::DirectPair { conversation } => {
                conversation
            }
        }
    }

    pub fn workspace_id(&self) -> Option<&WorkspaceId> {
        match self {
            Self::Workspace { workspace, .. } => Some(workspace),
            Self::DirectPair { .. } => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ObservationChange {
    Unchanged,
    Changed {
        conversations: Vec<ObservedConversation>,
        directed_badge_workspaces: Vec<WorkspaceId>,
        dismissed_notifications: Vec<NotificationId>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedObservation {
    viewer: UserId,
    change: ObservationChange,
}

impl CommittedObservation {
    pub fn unchanged(viewer: UserId) -> Self {
        Self {
            viewer,
            change: ObservationChange::Unchanged,
        }
    }

    pub fn changed(
        viewer: UserId,
        mut conversations: Vec<ObservedConversation>,
        mut directed_badge_workspaces: Vec<WorkspaceId>,
        mut dismissed_notifications: Vec<NotificationId>,
    ) -> Self {
        conversations.sort_unstable_by(|left, right| {
            left.conversation()
                .as_str()
                .cmp(right.conversation().as_str())
        });
        conversations.dedup_by(|left, right| left.conversation() == right.conversation());

        directed_badge_workspaces.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
        directed_badge_workspaces.dedup_by(|left, right| left == right);
        directed_badge_workspaces.retain(|workspace| {
            !conversations
                .iter()
                .any(|conversation| conversation.workspace_id() == Some(workspace))
        });

        dismissed_notifications.sort_unstable_by(|left, right| left.as_str().cmp(right.as_str()));
        dismissed_notifications.dedup_by(|left, right| left == right);

        if conversations.is_empty()
            && directed_badge_workspaces.is_empty()
            && dismissed_notifications.is_empty()
        {
            return Self::unchanged(viewer);
        }
        Self {
            viewer,
            change: ObservationChange::Changed {
                conversations,
                directed_badge_workspaces,
                dismissed_notifications,
            },
        }
    }

    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn changed_anything(&self) -> bool {
        matches!(self.change, ObservationChange::Changed { .. })
    }

    pub fn conversations(&self) -> impl Iterator<Item = &ObservedConversation> {
        match &self.change {
            ObservationChange::Unchanged => None,
            ObservationChange::Changed { conversations, .. } => Some(conversations.iter()),
        }
        .into_iter()
        .flatten()
    }

    pub fn directed_badge_workspaces(&self) -> impl Iterator<Item = &WorkspaceId> {
        match &self.change {
            ObservationChange::Unchanged => None,
            ObservationChange::Changed {
                directed_badge_workspaces,
                ..
            } => Some(directed_badge_workspaces.iter()),
        }
        .into_iter()
        .flatten()
    }

    pub fn dismissed_notifications(&self) -> &[NotificationId] {
        match &self.change {
            ObservationChange::Unchanged => &[],
            ObservationChange::Changed {
                dismissed_notifications,
                ..
            } => dismissed_notifications,
        }
    }
}

pub trait ObservationPort {
    type Error: Error + Send + Sync + 'static;

    fn observe(
        &self,
        viewer: UserId,
        batch: ObserveBatch,
    ) -> impl Future<Output = Result<Result<CommittedObservation, ObserveRefusal>, Self::Error>> + Send;
}

pub trait ObservationAftermath {
    fn conversation_changed(
        &self,
        fact: &CommittedObservation,
        conversation: &ObservedConversation,
    ) -> impl Future<Output = Result<(), ObservationEffectFailure>> + Send;

    fn badge_changed(
        &self,
        fact: &CommittedObservation,
        workspace: &WorkspaceId,
    ) -> impl Future<Output = Result<(), ObservationEffectFailure>> + Send;

    fn notifications_dismissed(
        &self,
        fact: &CommittedObservation,
    ) -> impl Future<Output = Result<(), ObservationEffectFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
#[error("a committed observation effect failed")]
pub struct ObservationEffectFailure {
    #[source]
    source: Box<dyn Error + Send + Sync>,
}

impl ObservationEffectFailure {
    pub fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

#[derive(Debug)]
pub struct ObserveDone {
    committed: CommittedObservation,
    first_failure: Option<ObservationEffectFailure>,
}

impl ObserveDone {
    pub fn committed(&self) -> &CommittedObservation {
        &self.committed
    }

    pub fn first_failure(&self) -> Option<&ObservationEffectFailure> {
        self.first_failure.as_ref()
    }
}

pub async fn observe<P: ObservationPort>(
    port: &P,
    aftermath: &impl ObservationAftermath,
    viewer: UserId,
    batch: ObserveBatch,
) -> Result<Result<ObserveDone, ObserveRefusal>, P::Error> {
    let committed = match port.observe(viewer, batch).await? {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let mut first_failure = None;
    for conversation in committed.conversations() {
        if let Err(error) = aftermath
            .conversation_changed(&committed, conversation)
            .await
            && first_failure.is_none()
        {
            first_failure = Some(error);
        }
    }
    for workspace in committed.directed_badge_workspaces() {
        if let Err(error) = aftermath.badge_changed(&committed, workspace).await
            && first_failure.is_none()
        {
            first_failure = Some(error);
        }
    }
    if !committed.dismissed_notifications().is_empty()
        && let Err(error) = aftermath.notifications_dismissed(&committed).await
        && first_failure.is_none()
    {
        first_failure = Some(error);
    }
    Ok(Ok(ObserveDone {
        committed,
        first_failure,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{convert::Infallible, sync::Mutex};

    struct Port;
    impl ObservationPort for Port {
        type Error = Infallible;
        async fn observe(
            &self,
            viewer: UserId,
            _: ObserveBatch,
        ) -> Result<Result<CommittedObservation, ObserveRefusal>, Self::Error> {
            Ok(Ok(CommittedObservation::changed(
                viewer,
                vec![
                    ObservedConversation::workspace(
                        ConversationId::parse("c").unwrap(),
                        WorkspaceId::parse("w").unwrap(),
                    ),
                    ObservedConversation::direct_pair(ConversationId::parse("pair").unwrap()),
                ],
                vec![
                    WorkspaceId::parse("w").unwrap(),
                    WorkspaceId::parse("directed-only").unwrap(),
                ],
                vec![NotificationId::parse("n").unwrap()],
            )))
        }
    }

    struct Effects(Mutex<Vec<&'static str>>);
    #[derive(Debug, thiserror::Error)]
    #[error("boom")]
    struct Boom;
    impl ObservationAftermath for Effects {
        async fn conversation_changed(
            &self,
            _: &CommittedObservation,
            conversation: &ObservedConversation,
        ) -> Result<(), ObservationEffectFailure> {
            self.0
                .lock()
                .unwrap()
                .push(if conversation.workspace_id().is_some() {
                    "workspace"
                } else {
                    "pair"
                });
            Err(ObservationEffectFailure::from_source(Boom))
        }
        async fn badge_changed(
            &self,
            _: &CommittedObservation,
            _: &WorkspaceId,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("badge");
            Ok(())
        }
        async fn notifications_dismissed(
            &self,
            _: &CommittedObservation,
        ) -> Result<(), ObservationEffectFailure> {
            self.0.lock().unwrap().push("dismiss");
            Ok(())
        }
    }

    #[tokio::test]
    async fn committed_fact_dedupes_axes_and_attempts_every_effect() {
        let effects = Effects(Mutex::new(vec![]));
        let done = observe(
            &Port,
            &effects,
            UserId::parse("u").unwrap(),
            ObserveBatch::new(vec![ObserveSource::Notification(
                NotificationId::parse("n").unwrap(),
            )])
            .unwrap(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            effects.0.into_inner().unwrap(),
            ["workspace", "pair", "badge", "dismiss"]
        );
        assert!(done.first_failure().is_some());
        assert_eq!(
            done.committed()
                .directed_badge_workspaces()
                .map(WorkspaceId::as_str)
                .collect::<Vec<_>>(),
            ["directed-only"]
        );
    }
}
