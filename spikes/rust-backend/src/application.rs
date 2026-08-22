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

/// The application asks for one semantic atomic operation. It does not expose
/// connections, statements, rows, transaction handles, or driver errors.
pub trait MessageUnitOfWork: Clone + Send + Sync + 'static {
    fn create_message_with_event(
        &self,
        body: String,
    ) -> impl Future<Output = Result<MessageCreatedFact, PersistenceFailure>> + Send;
}

#[derive(Debug, Error)]
#[error("persistence operation failed")]
pub struct PersistenceFailure;

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
