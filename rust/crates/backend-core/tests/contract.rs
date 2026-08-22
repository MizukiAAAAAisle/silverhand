//! Driver-free contract test for the foundation message ports.
//!
//! `DriverFreeStore` implements both Unit-of-Work ports with no driver crate in
//! scope, so a connection, statement, row, or driver error in a port signature
//! would break this build; the ports are driven directly to completion.

use std::sync::{Arc, Mutex};

use silverhand_backend_core::foundation_message::{
    Message, MessageCreatedFact, MessagePageFact, MessageReadUnitOfWork, MessageUnitOfWork,
    PersistenceFailure,
};

/// Implements both ports with no persistence technology in scope, backed by an
/// in-memory vector so reads can reflect prior writes.
#[derive(Clone, Default)]
struct DriverFreeStore {
    rows: Arc<Mutex<Vec<Message>>>,
}

impl MessageUnitOfWork for DriverFreeStore {
    async fn create_message_with_event(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, PersistenceFailure> {
        let mut rows = self.rows.lock().unwrap();
        let id = rows.len() as i64 + 1;
        let message = Message {
            id,
            body,
            created_at_ms: id * 1_000,
        };
        rows.push(message.clone());
        Ok(MessageCreatedFact { message })
    }
}

impl MessageReadUnitOfWork for DriverFreeStore {
    async fn latest_page(&self) -> Result<MessagePageFact, PersistenceFailure> {
        let rows = self.rows.lock().unwrap();
        Ok(MessagePageFact {
            total: rows.len() as i64,
            latest: rows.last().cloned(),
        })
    }
}

#[tokio::test]
async fn ports_are_implementable_and_runnable_without_a_driver() {
    let store = DriverFreeStore::default();

    let created = store
        .create_message_with_event("hello".into())
        .await
        .unwrap();
    assert_eq!(created.message.id, 1);
    assert_eq!(created.message.body, "hello");

    let page = store.latest_page().await.unwrap();
    assert_eq!(page.total, 1);
    assert_eq!(page.latest.unwrap().body, "hello");
}

#[tokio::test]
async fn read_reflects_prior_writes() {
    let store = DriverFreeStore::default();
    store.create_message_with_event("a".into()).await.unwrap();
    store.create_message_with_event("b".into()).await.unwrap();

    let page = store.latest_page().await.unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.latest.unwrap().body, "b");
}

#[test]
fn persistence_failure_preserves_source_cause() {
    use std::error::Error;

    #[derive(Debug)]
    struct DriverError;
    impl std::fmt::Display for DriverError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "driver exploded")
        }
    }
    impl Error for DriverError {}

    let failure = PersistenceFailure::from_source(DriverError);
    let cause = failure.source().expect("source cause must be reachable");
    assert_eq!(cause.to_string(), "driver exploded");
}
