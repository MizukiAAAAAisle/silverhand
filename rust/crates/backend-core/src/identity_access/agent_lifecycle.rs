//! Which stage of materialization an agent row is in.
//!
//! A sibling-shared vocabulary: visibility widens on it, teardown dispatches on
//! it, and a cold read projects it. It therefore cannot live inside any one of
//! those modules without making the other two depend on that module for a fact
//! it does not own.

use thiserror::Error;

/// The closed set of materialization stages. Closed because every consumer
/// branches exhaustively on it: a new stage must state its visibility, its
/// teardown obligation and its projection at the same time.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum MaterializationStatus {
    PendingMaterialization,
    Active,
    Failed,
}

impl MaterializationStatus {
    /// The stable persisted token. Adapters read and write exactly these.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PendingMaterialization => "pending_materialization",
            Self::Active => "active",
            Self::Failed => "failed",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, UnknownMaterializationStatus> {
        match raw {
            "pending_materialization" => Ok(Self::PendingMaterialization),
            "active" => Ok(Self::Active),
            "failed" => Ok(Self::Failed),
            _ => Err(UnknownMaterializationStatus),
        }
    }
}

/// A stored value outside the closed set is unreadable, not a fourth stage: it
/// reaches the caller as an error and never as a decision input.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Error)]
#[error("materialization status is outside the closed set")]
pub struct UnknownMaterializationStatus;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_stage_round_trips_through_its_persisted_token() {
        for status in [
            MaterializationStatus::PendingMaterialization,
            MaterializationStatus::Active,
            MaterializationStatus::Failed,
        ] {
            assert_eq!(MaterializationStatus::parse(status.as_str()), Ok(status));
        }
    }

    #[test]
    fn an_unknown_token_is_unreadable_rather_than_a_fourth_stage() {
        assert_eq!(
            MaterializationStatus::parse("archived"),
            Err(UnknownMaterializationStatus)
        );
        assert_eq!(
            MaterializationStatus::parse(""),
            Err(UnknownMaterializationStatus)
        );
    }
}
