use std::{error::Error, future::Future};

use crate::{
    identity::{AgentId, ConversationId, UserId},
    messaging::MessageId,
};

use super::ReactionEmoji;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Reactor {
    Human(UserId),
    Agent(AgentId),
}

impl Reactor {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Human(_) => "user",
            Self::Agent(_) => "agent",
        }
    }

    pub fn id(&self) -> &str {
        match self {
            Self::Human(id) => id.as_str(),
            Self::Agent(id) => id.as_str(),
        }
    }
}

/// The caller identity plus the only ambient coordinate an anchored runtime may use.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReactionActor {
    Human(UserId),
    Agent {
        id: AgentId,
        source: Option<ConversationId>,
    },
}

impl ReactionActor {
    pub fn reactor(&self) -> Reactor {
        match self {
            Self::Human(id) => Reactor::Human(id.clone()),
            Self::Agent { id, .. } => Reactor::Agent(id.clone()),
        }
    }

    pub fn source(&self) -> Option<&ConversationId> {
        match self {
            Self::Human(_) | Self::Agent { source: None, .. } => None,
            Self::Agent {
                source: Some(source),
                ..
            } => Some(source),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReactionChange {
    Add,
    Remove,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionMutation {
    actor: ReactionActor,
    message: MessageId,
    emoji: ReactionEmoji,
    change: ReactionChange,
    occurred_at_ms: i64,
}

impl ReactionMutation {
    pub fn new(
        actor: ReactionActor,
        message: MessageId,
        emoji: ReactionEmoji,
        change: ReactionChange,
        occurred_at_ms: i64,
    ) -> Self {
        Self {
            actor,
            message,
            emoji,
            change,
            occurred_at_ms,
        }
    }

    pub fn actor(&self) -> &ReactionActor {
        &self.actor
    }
    pub fn message(&self) -> &MessageId {
        &self.message
    }
    pub fn emoji(&self) -> &ReactionEmoji {
        &self.emoji
    }
    pub fn change(&self) -> ReactionChange {
        self.change
    }
    pub fn occurred_at_ms(&self) -> i64 {
        self.occurred_at_ms
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ReactionMutationRefusal {
    #[error("reaction target is outside the runtime's visible scope")]
    TargetHidden,
    #[error("message not found")]
    MessageNotFound,
    #[error("system messages cannot receive reactions")]
    SystemMessageNotReactable,
    #[error("conversation not found")]
    ConversationNotFound,
    #[error("caller cannot react in this conversation")]
    Forbidden,
    #[error("runtime lacks the send_messages capability")]
    CapabilityDenied,
    #[error("conversation is closed")]
    ConversationClosed,
    #[error("conversation is archived")]
    ConversationArchived,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionChangedFact {
    message: MessageId,
    conversation: ConversationId,
    thread_root: Option<MessageId>,
    emoji: ReactionEmoji,
    change: ReactionChange,
    reactor: Reactor,
    count: i64,
}

impl ReactionChangedFact {
    #[allow(clippy::too_many_arguments)]
    pub fn committed(
        message: MessageId,
        conversation: ConversationId,
        thread_root: Option<MessageId>,
        emoji: ReactionEmoji,
        change: ReactionChange,
        reactor: Reactor,
        count: i64,
    ) -> Self {
        Self {
            message,
            conversation,
            thread_root,
            emoji,
            change,
            reactor,
            count,
        }
    }
    pub fn message(&self) -> &MessageId {
        &self.message
    }
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub fn thread_root(&self) -> Option<&MessageId> {
        self.thread_root.as_ref()
    }
    pub fn emoji(&self) -> &ReactionEmoji {
        &self.emoji
    }
    pub fn change(&self) -> ReactionChange {
        self.change
    }
    pub fn reactor(&self) -> &Reactor {
        &self.reactor
    }
    pub fn count(&self) -> i64 {
        self.count
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedReaction {
    changed: bool,
    emoji: ReactionEmoji,
    count: i64,
    fact: Option<ReactionChangedFact>,
}

impl CommittedReaction {
    pub fn committed(emoji: ReactionEmoji, count: i64, fact: Option<ReactionChangedFact>) -> Self {
        Self {
            changed: fact.is_some(),
            emoji,
            count,
            fact,
        }
    }
    pub fn changed(&self) -> bool {
        self.changed
    }
    pub fn emoji(&self) -> &ReactionEmoji {
        &self.emoji
    }
    pub fn count(&self) -> i64 {
        self.count
    }
    pub fn fact(&self) -> Option<&ReactionChangedFact> {
        self.fact.as_ref()
    }
}

pub trait ReactionMutationPort {
    type Error: Error + Send + Sync + 'static;
    fn mutate(
        &self,
        mutation: ReactionMutation,
    ) -> impl Future<
        Output = Result<Result<CommittedReaction, ReactionMutationRefusal>, Self::Error>,
    > + Send;
}

/// Post-commit owner. Implementations report their own failures; a publication
/// fault cannot turn a committed write into a refusal or request compensation.
pub trait ReactionAftermath {
    fn announce(&self, fact: &ReactionChangedFact) -> impl Future<Output = ()> + Send;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionMutationOutcome {
    changed: bool,
    emoji: ReactionEmoji,
    count: i64,
}

impl ReactionMutationOutcome {
    pub fn changed(&self) -> bool {
        self.changed
    }
    pub fn emoji(&self) -> &ReactionEmoji {
        &self.emoji
    }
    pub fn count(&self) -> i64 {
        self.count
    }
}

pub async fn change_reaction<P: ReactionMutationPort>(
    port: &P,
    aftermath: &impl ReactionAftermath,
    mutation: ReactionMutation,
) -> Result<Result<ReactionMutationOutcome, ReactionMutationRefusal>, P::Error> {
    let committed = match port.mutate(mutation).await? {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    if let Some(fact) = committed.fact() {
        aftermath.announce(fact).await;
    }
    Ok(Ok(ReactionMutationOutcome {
        changed: committed.changed(),
        emoji: committed.emoji().clone(),
        count: committed.count(),
    }))
}
