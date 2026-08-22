//! Item 1 of the infra prototype: the transaction dependency direction.
//!
//! What is proved here, stated at its real strength rather than its flattering
//! one:
//!
//! 1. **Compile proof, and only of this**: the ports need no concrete driver
//!    type. `DriverFreeStore` below implements both of them with neither the
//!    adapter nor the driver crate in scope, so a connection, statement, row, or
//!    driver error appearing in a port signature would break this file's build.
//! 2. **Not a compile proof**: the *absence of a generic async closure or a
//!    transaction capability* is currently held by API shape plus the lexical
//!    fences below — nothing more. If the application later defined its own
//!    driver-free `TxScope` and handed out a generic closure over it, this file
//!    would still compile. A mechanical dependency direction needs a crate
//!    boundary plus visibility, which is future work, not something this file
//!    demonstrates.
//! 3. `root` vs `deferred` is a private adapter concern: the choice appears
//!    nowhere in the application layer's source, and the type expressing it is
//!    not part of the crate's public surface.

use std::{fs, path::Path};

use silverhand_rust_backend_spike::application::{
    CreateMessage, Message, MessageCreatedFact, MessagePageFact, MessageReadUnitOfWork,
    MessageUnitOfWork, PersistenceFailure, ReadLatestPage,
};

/// Implements both ports with no persistence technology in scope. Its existence
/// proves the ports need no concrete driver type — and nothing beyond that.
#[derive(Clone)]
struct DriverFreeStore;

impl MessageUnitOfWork for DriverFreeStore {
    async fn create_message_with_event(
        &self,
        body: String,
    ) -> Result<MessageCreatedFact, PersistenceFailure> {
        Ok(MessageCreatedFact {
            message: Message {
                id: 1,
                body,
                created_at_ms: 42,
            },
        })
    }
}

impl MessageReadUnitOfWork for DriverFreeStore {
    async fn latest_page(&self) -> Result<MessagePageFact, PersistenceFailure> {
        Ok(MessagePageFact {
            total: 1,
            latest: Some(Message {
                id: 1,
                body: "only".into(),
                created_at_ms: 42,
            }),
        })
    }
}

#[tokio::test]
async fn both_use_cases_run_without_ever_seeing_a_transaction() {
    let write = CreateMessage::new(DriverFreeStore);
    let read = ReadLatestPage::new(DriverFreeStore);

    let created = write.execute("  trimmed body  ".into()).await.unwrap();
    let page = read.execute().await.unwrap();

    assert_eq!(created.message.body, "trimmed body");
    assert_eq!(page.total, 1);
    assert_eq!(page.latest.unwrap().id, 1);
}

const APPLICATION_SOURCE: &str = "src/application.rs";
const ADAPTER_SOURCE: &str = "src/adapters/sqlite.rs";

/// Markers that would mean a transaction capability had reached the application
/// layer. Complementary to the compile-level proof above: it catches a capability
/// smuggled in through a name rather than a type.
const TRANSACTION_MARKERS: [&str; 8] = [
    "transaction",
    "begin",
    "commit",
    "rollback",
    "savepoint",
    "immediate",
    "deferred_read",
    "atomically",
];

#[test]
fn application_layer_names_no_transaction_capability() {
    // Prose is not code: the port's own doc comment legitimately says it exposes
    // no transaction handle, and a gate that reads comments would flag that.
    let source = strip_comment_lines(&read_crate_file(APPLICATION_SOURCE)).to_ascii_lowercase();

    for marker in TRANSACTION_MARKERS {
        assert!(
            !source.contains(marker),
            "{APPLICATION_SOURCE} names transaction capability {marker:?}"
        );
    }
}

#[test]
fn adapter_owns_both_modes_and_keeps_the_choice_private() {
    let source = read_crate_file(ADAPTER_SOURCE);

    for required in [
        "enum TxMode",
        "RootWrite",
        "DeferredRead",
        "BEGIN IMMEDIATE",
        "BEGIN DEFERRED",
        "begin_with(ROOT_WRITE_BEGIN)",
        "begin_with(DEFERRED_READ_BEGIN)",
        "self.begin(TxMode::RootWrite)",
        "self.begin(TxMode::DeferredRead)",
    ] {
        assert!(
            source.contains(required),
            "adapter no longer owns required transaction detail {required:?}"
        );
    }

    assert!(
        !source.contains("pub enum TxMode") && !source.contains("pub(crate) enum TxMode"),
        "TxMode must stay private to the adapter module"
    );
    assert!(
        !source.contains("pub async fn begin"),
        "the begin helper must stay private to the adapter module"
    );
}

fn read_crate_file(relative: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("failed to read {}: {error}", path.display());
    })
}

fn strip_comment_lines(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}
