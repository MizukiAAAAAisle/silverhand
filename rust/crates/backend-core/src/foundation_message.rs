//! Isolated foundation-only semantic Unit-of-Work proof. The product Messaging
//! contract is not defined by this module.

use std::future::Future;

use crate::persistence::PersistenceFailure;

/// A persisted message, as the application sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub id: i64,
    pub body: String,
    pub created_at_ms: i64,
}

/// The single business fact of one atomic create behind [`MessageUnitOfWork`],
/// projected downstream into the SQLite durable payload and the wire event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageCreatedFact {
    pub message: Message,
}

/// A total and the latest row that must originate from one snapshot: they
/// disagree if another writer commits between the two reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessagePageFact {
    pub total: i64,
    pub latest: Option<Message>,
}

/// Create a message and its durable event as one semantic atomic write. The
/// port exposes no connection, statement, row, transaction handle, or driver
/// error; the adapter owns how the transaction is run.
pub trait MessageUnitOfWork: Clone + Send + Sync + 'static {
    fn create_message_with_event(
        &self,
        body: String,
    ) -> impl Future<Output = Result<MessageCreatedFact, PersistenceFailure>> + Send;
}

/// A consistent read whose atomicity requirement is snapshot consistency
/// (total + latest from one snapshot) rather than a writer reservation.
pub trait MessageReadUnitOfWork: Clone + Send + Sync + 'static {
    fn latest_page(
        &self,
    ) -> impl Future<Output = Result<MessagePageFact, PersistenceFailure>> + Send;
}
