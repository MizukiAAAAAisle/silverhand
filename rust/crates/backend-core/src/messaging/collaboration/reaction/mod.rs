//! Message-reaction application boundary.
//!
//! Emoji grammar, the atomic mutation, cold reads, and post-commit publication
//! are separate capabilities. They share facts, not a service/context object.

mod emoji;
mod mutation;
mod read;

pub use emoji::{InvalidReactionEmoji, ReactionEmoji};
pub use mutation::{
    CommittedReaction, ReactionActor, ReactionAftermath, ReactionChange, ReactionChangedFact,
    ReactionMutation, ReactionMutationOutcome, ReactionMutationPort, ReactionMutationRefusal,
    Reactor, change_reaction,
};
pub use read::{
    ReactionAggregate, ReactionDetail, ReactionReactor, ReactionReadPort, ReactionReadRefusal,
};
