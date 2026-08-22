use std::future::Future;

use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: i64,
    pub body: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageCreatedFact {
    pub message: Message,
}

/// Two facts that must come from one snapshot: a total and the latest row
/// disagree if another writer commits between the two statements.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessagePageFact {
    pub total: i64,
    pub latest: Option<Message>,
}

/// The application asks for one semantic atomic operation. It does not expose
/// connections, statements, rows, transaction handles, or driver errors.
pub trait MessageUnitOfWork: Clone + Send + Sync + 'static {
    fn create_message_with_event(
        &self,
        body: String,
    ) -> impl Future<Output = Result<MessageCreatedFact, PersistenceFailure>> + Send;
}

/// A second semantic operation whose atomicity requirement is snapshot
/// consistency rather than a writer reservation. The application states the
/// requirement; how it is obtained stays behind this port.
pub trait MessageReadUnitOfWork: Clone + Send + Sync + 'static {
    fn latest_page(
        &self,
    ) -> impl Future<Output = Result<MessagePageFact, PersistenceFailure>> + Send;
}

/// Infra failed. The cause travels as an erased source, so the chain survives to
/// the boundary that renders it while this layer gains no driver type.
#[derive(Debug, Error)]
#[error("persistence operation failed")]
pub struct PersistenceFailure {
    #[source]
    source: Box<dyn std::error::Error + Send + Sync + 'static>,
}

impl PersistenceFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

#[derive(Debug, Error)]
pub enum CreateMessageError {
    #[error("body must contain 1..=10000 characters")]
    InvalidBody,
    #[error(transparent)]
    Persistence(#[from] PersistenceFailure),
}

#[derive(Clone)]
pub struct CreateMessage<U> {
    unit_of_work: U,
}

impl<U: MessageUnitOfWork> CreateMessage<U> {
    pub fn new(unit_of_work: U) -> Self {
        Self { unit_of_work }
    }

    pub async fn execute(&self, body: String) -> Result<MessageCreatedFact, CreateMessageError> {
        let body = body.trim();
        if body.is_empty() || body.chars().count() > 10_000 {
            return Err(CreateMessageError::InvalidBody);
        }

        self.unit_of_work
            .create_message_with_event(body.to_owned())
            .await
            .map_err(Into::into)
    }
}

#[derive(Clone)]
pub struct ReadLatestPage<U> {
    unit_of_work: U,
}

impl<U: MessageReadUnitOfWork> ReadLatestPage<U> {
    pub fn new(unit_of_work: U) -> Self {
        Self { unit_of_work }
    }

    pub async fn execute(&self) -> Result<MessagePageFact, PersistenceFailure> {
        self.unit_of_work.latest_page().await
    }
}
