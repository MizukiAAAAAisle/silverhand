use std::{error::Error, future::Future};

use crate::identity::{AgentId, UserId, WorkspaceId};

use super::{SavedAt, SavedEntry};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SavedSince(SavedAt);

impl SavedSince {
    pub fn new(value: i64) -> Option<Self> {
        SavedAt::new(value).ok().map(Self)
    }

    pub fn get(self) -> i64 {
        self.0.get()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SavedSender {
    Human(UserId),
    Agent(AgentId),
}

impl SavedSender {
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

#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct SavedListQuery {
    pub workspace: Option<WorkspaceId>,
    pub since: Option<SavedSince>,
    pub sender: Option<SavedSender>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SavedReadRefusal {
    #[error("workspace not found")]
    WorkspaceNotFound,
    #[error("viewer cannot read this workspace")]
    Forbidden,
}

pub trait SavedReadPort {
    type Error: Error + Send + Sync + 'static;

    fn list(
        &self,
        viewer: &UserId,
        query: SavedListQuery,
    ) -> impl Future<Output = Result<Result<Vec<SavedEntry>, SavedReadRefusal>, Self::Error>> + Send;
}
