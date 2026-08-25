//! Human thread-follow state and idempotent follow/unfollow units.
//!
//! A follower row is a delivery subscription, never a permission.  Reads and
//! writes therefore re-earn conversation participation independently, while a
//! successful value keeps every source coordinate until the authenticated
//! consumer binds it.

use std::{collections::HashSet, error::Error, future::Future};

use crate::{
    identity::{AgentId, ConversationId, UserId},
    messaging::ThreadRootId,
};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct FollowedAt(i64);

impl FollowedAt {
    const MAX_JAVASCRIPT_INTEGER: i64 = 9_007_199_254_740_991;

    pub fn new(value: i64) -> Result<Self, InvalidFollowedAt> {
        if !(0..=Self::MAX_JAVASCRIPT_INTEGER).contains(&value) {
            return Err(InvalidFollowedAt);
        }
        Ok(Self(value))
    }

    pub const fn get(self) -> i64 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("thread follower followed_at must be nonnegative and exact on the JavaScript wire")]
pub struct InvalidFollowedAt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadFollowerAgent {
    conversation: ConversationId,
    root: ThreadRootId,
    agent: AgentId,
    followed_at: FollowedAt,
}

impl ThreadFollowerAgent {
    pub fn projected(
        conversation: ConversationId,
        root: ThreadRootId,
        agent: AgentId,
        followed_at: FollowedAt,
    ) -> Self {
        Self {
            conversation,
            root,
            agent,
            followed_at,
        }
    }

    pub fn agent(&self) -> &AgentId {
        &self.agent
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadFollowerState {
    viewer: UserId,
    conversation: ConversationId,
    requested: ThreadRootId,
    root: ThreadRootId,
    viewer_following: bool,
    agents: Vec<ThreadFollowerAgent>,
}

impl ThreadFollowerState {
    pub fn projected(
        viewer: UserId,
        conversation: ConversationId,
        requested: ThreadRootId,
        root: ThreadRootId,
        viewer_following: bool,
        agents: Vec<ThreadFollowerAgent>,
    ) -> Result<Self, MalformedThreadFollowerSet> {
        let identities_are_unique = agents
            .iter()
            .map(|agent| agent.agent.as_str())
            .collect::<HashSet<_>>()
            .len()
            == agents.len();
        if !identities_are_unique
            || !agents
                .windows(2)
                .all(|pair| agent_key(&pair[0]) < agent_key(&pair[1]))
        {
            return Err(MalformedThreadFollowerSet);
        }
        Ok(Self {
            viewer,
            conversation,
            requested,
            root,
            viewer_following,
            agents,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        conversation: &ConversationId,
        requested: &ThreadRootId,
    ) -> Result<BoundThreadFollowerState, ThreadFollowIdentityMismatch> {
        if &self.viewer != viewer
            || &self.conversation != conversation
            || &self.requested != requested
            || self
                .agents
                .iter()
                .any(|agent| &agent.conversation != conversation || agent.root != self.root)
        {
            return Err(ThreadFollowIdentityMismatch);
        }
        Ok(BoundThreadFollowerState(self))
    }
}

fn agent_key(value: &ThreadFollowerAgent) -> (FollowedAt, &str) {
    (value.followed_at, value.agent.as_str())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundThreadFollowerState(ThreadFollowerState);

impl BoundThreadFollowerState {
    pub fn root(&self) -> &ThreadRootId {
        &self.0.root
    }
    pub const fn viewer_following(&self) -> bool {
        self.0.viewer_following
    }
    pub fn agents(&self) -> &[ThreadFollowerAgent] {
        &self.0.agents
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("thread follower agents are not in unique total order")]
pub struct MalformedThreadFollowerSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("thread follower fact identity differs from the authenticated request")]
pub struct ThreadFollowIdentityMismatch;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedHumanFollow {
    viewer: UserId,
    conversation: ConversationId,
    requested: ThreadRootId,
    root: ThreadRootId,
    changed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedHumanUnfollow {
    viewer: UserId,
    conversation: ConversationId,
    requested: ThreadRootId,
    root: ThreadRootId,
    changed: bool,
}

macro_rules! committed_operation {
    ($type:ty, $bound:ident) => {
        impl $type {
            pub fn committed(
                viewer: UserId,
                conversation: ConversationId,
                requested: ThreadRootId,
                root: ThreadRootId,
                changed: bool,
            ) -> Self {
                Self {
                    viewer,
                    conversation,
                    requested,
                    root,
                    changed,
                }
            }

            pub fn bind(
                self,
                viewer: &UserId,
                conversation: &ConversationId,
                requested: &ThreadRootId,
            ) -> Result<$bound, ThreadFollowIdentityMismatch> {
                if &self.viewer != viewer
                    || &self.conversation != conversation
                    || &self.requested != requested
                {
                    return Err(ThreadFollowIdentityMismatch);
                }
                Ok($bound(self))
            }
        }
    };
}

committed_operation!(CommittedHumanFollow, BoundHumanFollow);
committed_operation!(CommittedHumanUnfollow, BoundHumanUnfollow);

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundHumanFollow(CommittedHumanFollow);

impl BoundHumanFollow {
    pub fn root(&self) -> &ThreadRootId {
        &self.0.root
    }
    pub const fn changed(&self) -> bool {
        self.0.changed
    }
    fn fact(&self) -> Option<ThreadFollowChangedFact<'_>> {
        self.0.changed.then_some(ThreadFollowChangedFact {
            viewer: &self.0.viewer,
            conversation: &self.0.conversation,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundHumanUnfollow(CommittedHumanUnfollow);

impl BoundHumanUnfollow {
    pub fn root(&self) -> &ThreadRootId {
        &self.0.root
    }
    pub const fn changed(&self) -> bool {
        self.0.changed
    }
    fn fact(&self) -> Option<ThreadFollowChangedFact<'_>> {
        self.0.changed.then_some(ThreadFollowChangedFact {
            viewer: &self.0.viewer,
            conversation: &self.0.conversation,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThreadFollowChangedFact<'a> {
    viewer: &'a UserId,
    conversation: &'a ConversationId,
}

impl ThreadFollowChangedFact<'_> {
    pub fn viewer(&self) -> &UserId {
        self.viewer
    }
    pub fn conversation(&self) -> &ConversationId {
        self.conversation
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ThreadFollowerStateRefusal {
    #[error("conversation not found")]
    ConversationNotFound,
    #[error("viewer cannot interact with conversation")]
    Forbidden,
    #[error("thread root message not found in conversation")]
    RootNotFound,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HumanFollowRefusal {
    #[error("conversation not found")]
    ConversationNotFound,
    #[error("viewer cannot interact with conversation")]
    Forbidden,
    #[error("thread root message not found in conversation")]
    RootNotFound,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HumanUnfollowRefusal {
    #[error("conversation not found")]
    ConversationNotFound,
    #[error("viewer cannot interact with conversation")]
    Forbidden,
    #[error("thread root message not found in conversation")]
    RootNotFound,
}

pub trait ThreadFollowPort {
    type Error: Error + Send + Sync + 'static;

    fn state(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
        message: &ThreadRootId,
    ) -> impl Future<
        Output = Result<Result<ThreadFollowerState, ThreadFollowerStateRefusal>, Self::Error>,
    > + Send;

    fn follow(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        message: ThreadRootId,
    ) -> impl Future<Output = Result<Result<CommittedHumanFollow, HumanFollowRefusal>, Self::Error>> + Send;

    fn unfollow(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        message: ThreadRootId,
    ) -> impl Future<
        Output = Result<Result<CommittedHumanUnfollow, HumanUnfollowRefusal>, Self::Error>,
    > + Send;
}

pub trait ThreadFollowAftermath {
    fn unread_changed(
        &self,
        fact: ThreadFollowChangedFact<'_>,
    ) -> impl Future<Output = Result<(), ThreadFollowPublicationFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
#[error("the committed thread-follow change could not publish unread state")]
pub struct ThreadFollowPublicationFailure {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl ThreadFollowPublicationFailure {
    pub fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

pub struct FollowExecution {
    committed: BoundHumanFollow,
    publication_failure: Option<ThreadFollowPublicationFailure>,
}

impl FollowExecution {
    pub fn committed(&self) -> &BoundHumanFollow {
        &self.committed
    }
    pub fn publication_failure(&self) -> Option<&ThreadFollowPublicationFailure> {
        self.publication_failure.as_ref()
    }
}

pub struct UnfollowExecution {
    committed: BoundHumanUnfollow,
    publication_failure: Option<ThreadFollowPublicationFailure>,
}

impl UnfollowExecution {
    pub fn committed(&self) -> &BoundHumanUnfollow {
        &self.committed
    }
    pub fn publication_failure(&self) -> Option<&ThreadFollowPublicationFailure> {
        self.publication_failure.as_ref()
    }
}

pub async fn follow_human<P: ThreadFollowPort>(
    port: &P,
    aftermath: &impl ThreadFollowAftermath,
    viewer: UserId,
    conversation: ConversationId,
    message: ThreadRootId,
) -> Result<Result<FollowExecution, HumanFollowRefusal>, ThreadFollowExecutionError<P::Error>> {
    let committed = match port
        .follow(viewer.clone(), conversation.clone(), message.clone())
        .await
        .map_err(ThreadFollowExecutionError::Persistence)?
    {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let committed = committed.bind(&viewer, &conversation, &message)?;
    let publication_failure = match committed.fact() {
        Some(fact) => aftermath.unread_changed(fact).await.err(),
        None => None,
    };
    Ok(Ok(FollowExecution {
        committed,
        publication_failure,
    }))
}

pub async fn unfollow_human<P: ThreadFollowPort>(
    port: &P,
    aftermath: &impl ThreadFollowAftermath,
    viewer: UserId,
    conversation: ConversationId,
    message: ThreadRootId,
) -> Result<Result<UnfollowExecution, HumanUnfollowRefusal>, ThreadUnfollowExecutionError<P::Error>>
{
    let committed = match port
        .unfollow(viewer.clone(), conversation.clone(), message.clone())
        .await
        .map_err(ThreadUnfollowExecutionError::Persistence)?
    {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let committed = committed.bind(&viewer, &conversation, &message)?;
    let publication_failure = match committed.fact() {
        Some(fact) => aftermath.unread_changed(fact).await.err(),
        None => None,
    };
    Ok(Ok(UnfollowExecution {
        committed,
        publication_failure,
    }))
}

#[derive(Debug, thiserror::Error)]
pub enum ThreadFollowExecutionError<E: Error + 'static> {
    #[error("thread-follow persistence failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] ThreadFollowIdentityMismatch),
}

#[derive(Debug, thiserror::Error)]
pub enum ThreadUnfollowExecutionError<E: Error + 'static> {
    #[error("thread-unfollow persistence failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] ThreadFollowIdentityMismatch),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(conversation: &str, root: &str, id: &str, at: i64) -> ThreadFollowerAgent {
        ThreadFollowerAgent::projected(
            ConversationId::parse(conversation).unwrap(),
            ThreadRootId::parse(root).unwrap(),
            AgentId::parse(id).unwrap(),
            FollowedAt::new(at).unwrap(),
        )
    }

    #[test]
    fn state_is_totally_ordered_and_every_source_coordinate_binds() {
        let viewer = UserId::parse("viewer").unwrap();
        let conversation = ConversationId::parse("c").unwrap();
        let state = ThreadFollowerState::projected(
            viewer.clone(),
            conversation.clone(),
            ThreadRootId::parse("r").unwrap(),
            ThreadRootId::parse("r").unwrap(),
            true,
            vec![agent("c", "r", "a", 1), agent("c", "r", "b", 1)],
        )
        .unwrap();
        assert!(
            state
                .clone()
                .bind(
                    &viewer,
                    &ConversationId::parse("other").unwrap(),
                    &ThreadRootId::parse("r").unwrap(),
                )
                .is_err()
        );
        assert!(
            state
                .clone()
                .bind(
                    &viewer,
                    &conversation,
                    &ThreadRootId::parse("other-request").unwrap(),
                )
                .is_err()
        );
        assert_eq!(
            state
                .bind(&viewer, &conversation, &ThreadRootId::parse("r").unwrap())
                .unwrap()
                .agents()
                .len(),
            2
        );
        assert!(
            ThreadFollowerState::projected(
                viewer.clone(),
                conversation.clone(),
                ThreadRootId::parse("r").unwrap(),
                ThreadRootId::parse("r").unwrap(),
                false,
                vec![agent("c", "r", "b", 1), agent("c", "r", "a", 1)],
            )
            .is_err()
        );
        assert!(
            ThreadFollowerState::projected(
                viewer.clone(),
                conversation.clone(),
                ThreadRootId::parse("r").unwrap(),
                ThreadRootId::parse("r").unwrap(),
                false,
                vec![agent("c", "r", "a", 1), agent("c", "r", "a", 2)],
            )
            .is_err()
        );
        let spliced = ThreadFollowerState::projected(
            viewer.clone(),
            conversation.clone(),
            ThreadRootId::parse("r").unwrap(),
            ThreadRootId::parse("r").unwrap(),
            false,
            vec![agent("other", "r", "a", 1)],
        )
        .unwrap();
        assert!(
            spliced
                .bind(&viewer, &conversation, &ThreadRootId::parse("r").unwrap())
                .is_err()
        );
    }

    #[test]
    fn followed_at_is_wire_exact() {
        assert!(FollowedAt::new(-1).is_err());
        assert!(FollowedAt::new(FollowedAt::MAX_JAVASCRIPT_INTEGER + 1).is_err());
    }
}
