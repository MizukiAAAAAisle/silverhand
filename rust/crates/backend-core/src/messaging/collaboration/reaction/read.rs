use std::{error::Error, future::Future};

use crate::{identity::UserId, messaging::MessageId};

use super::{ReactionEmoji, Reactor};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionAggregate {
    emoji: ReactionEmoji,
    count: i64,
    viewer_reacted: bool,
}

impl ReactionAggregate {
    pub fn projected(emoji: ReactionEmoji, count: i64, viewer_reacted: bool) -> Self {
        Self {
            emoji,
            count,
            viewer_reacted,
        }
    }
    pub fn emoji(&self) -> &ReactionEmoji {
        &self.emoji
    }
    pub fn count(&self) -> i64 {
        self.count
    }
    pub fn viewer_reacted(&self) -> bool {
        self.viewer_reacted
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionReactor {
    principal: Reactor,
    display_name: String,
}

impl ReactionReactor {
    pub fn projected(principal: Reactor, display_name: String) -> Self {
        Self {
            principal,
            display_name,
        }
    }
    pub fn principal(&self) -> &Reactor {
        &self.principal
    }
    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReactionDetail {
    emoji: ReactionEmoji,
    reactors: Vec<ReactionReactor>,
}

impl ReactionDetail {
    pub fn projected(emoji: ReactionEmoji, reactors: Vec<ReactionReactor>) -> Self {
        Self { emoji, reactors }
    }
    pub fn emoji(&self) -> &ReactionEmoji {
        &self.emoji
    }
    pub fn reactors(&self) -> &[ReactionReactor] {
        &self.reactors
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReactionReadRefusal;

pub trait ReactionReadPort {
    type Error: Error + Send + Sync + 'static;

    fn detail(
        &self,
        viewer: &UserId,
        message: &MessageId,
    ) -> impl Future<Output = Result<Result<Vec<ReactionDetail>, ReactionReadRefusal>, Self::Error>> + Send;

    fn aggregates(
        &self,
        viewer: &Reactor,
        messages: &[MessageId],
    ) -> impl Future<Output = Result<Vec<(MessageId, Vec<ReactionAggregate>)>, Self::Error>> + Send;
}
