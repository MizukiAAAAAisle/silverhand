//! Message-reaction application boundary.
//!
//! Emoji grammar, the atomic mutation, cold reads, and post-commit publication
//! are separate capabilities. They share facts, not a service/context object.

mod count;
mod emoji;
mod mutation;
mod read;

pub use count::{InvalidReactionCount, ReactionCount};
pub use emoji::{InvalidReactionEmoji, ReactionEmoji};
pub use mutation::{
    CommittedReaction, ReactionActor, ReactionAftermath, ReactionChange, ReactionChangedFact,
    ReactionExecution, ReactionMutation, ReactionMutationOutcome, ReactionMutationPort,
    ReactionMutationRefusal, ReactionPublicationFailure, Reactor, change_reaction,
};
pub use read::{
    ReactionAggregate, ReactionDetail, ReactionReactor, ReactionReadPort, ReactionReadRefusal,
};
