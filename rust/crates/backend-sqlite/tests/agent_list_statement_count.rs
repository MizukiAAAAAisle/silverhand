//! The falsifier for the LIST read's BOUNDED audience (#task:2195, batch 5, P0).
//!
//! The batch's thesis is that the visibility ACL is computed in a fixed number of SQL
//! statements, not once per candidate. A `1 + 2N` per-candidate audience read satisfies
//! every behavioural test in `agent_list_read.rs` — the facts it builds are identical —
//! so nothing there can tell a bounded read from an unbounded one. This test can: it
//! COUNTS the read statements the adapter issues and pins that the count does not grow
//! with the candidate count.
//!
//! It lives in its own test binary because it installs a PROCESS-WIDE tracing subscriber
//! (`set_global_default`) to catch sqlx's per-statement `sqlx::query` events — sqlx runs
//! SQLite on a worker thread, so a thread-local subscriber would miss them, and the
//! global default may be set only once per process. The subscriber is hand-rolled over
//! `tracing` alone (a normal dependency), so this adds no dev-dependency and leaves the
//! frozen lockfile untouched.
//!
//! It counts only statements whose summary begins with `SELECT`: those are the adapter's
//! READS. Connection-setup `PRAGMA`s fire on whichever measured read the pool happens to
//! open a fresh connection on, so counting them would be pool noise, not read work; sqlx
//! does not log `BEGIN`/`COMMIT` as query events at all. The self-check
//! (`reads_for_one > 0`) makes a broken counter fail LOUD rather than pass green: if sqlx
//! emitted nothing we would otherwise "prove" boundedness by counting zero against zero.

use std::sync::{Arc, Mutex};

use silverhand_backend_core::{
    foundation::identity::UserId, identity_access::agent_list_read::AgentListReadModel,
};
use silverhand_backend_sqlite::agent_list_read::SqliteAgentListColdRead;
use sqlx::Connection;
use tracing::{
    Event, Metadata, Subscriber,
    field::{Field, Visit},
    level_filters::LevelFilter,
    span::{Attributes, Id, Record},
};

#[path = "support/current_schema_snapshot.rs"]
mod current_schema;

/// A minimal global subscriber that records the summary of every sqlx statement event. It
/// reports every callsite enabled so sqlx's `Drop`-time `sqlx::query` event is never
/// filtered before it reaches `event`, where only that target is recorded.
#[derive(Clone, Default)]
struct StatementLog {
    summaries: Arc<Mutex<Vec<String>>>,
}

impl StatementLog {
    /// The statements recorded since `from`, keeping only the reads (`SELECT …`).
    fn reads_since(&self, from: usize) -> Vec<String> {
        self.summaries.lock().unwrap()[from..]
            .iter()
            .filter(|summary| summary.starts_with("SELECT"))
            .cloned()
            .collect()
    }

    fn len(&self) -> usize {
        self.summaries.lock().unwrap().len()
    }
}

/// Pulls sqlx's `summary` field (the leading words of the SQL) off an event.
#[derive(Default)]
struct SummaryVisitor(Option<String>);

impl Visit for SummaryVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "summary" {
            self.0 = Some(value.to_owned());
        }
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "summary" && self.0.is_none() {
            self.0 = Some(format!("{value:?}"));
        }
    }
}

impl Subscriber for StatementLog {
    fn enabled(&self, _metadata: &Metadata<'_>) -> bool {
        true
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        Some(LevelFilter::TRACE)
    }

    fn new_span(&self, _span: &Attributes<'_>) -> Id {
        Id::from_u64(1)
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}

    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}

    fn event(&self, event: &Event<'_>) {
        if event.metadata().target() == "sqlx::query" {
            let mut visitor = SummaryVisitor::default();
            event.record(&mut visitor);
            self.summaries
                .lock()
                .unwrap()
                .push(visitor.0.unwrap_or_default());
        }
    }

    fn enter(&self, _span: &Id) {}

    fn exit(&self, _span: &Id) {}
}

fn user(id: &str) -> UserId {
    UserId::parse(id).expect("user id")
}

// A tiny fixture using the CREATOR arm only, so no relation rows are needed: `u-solo`
// created one agent, `u-many` created three. That is all the differential needs — one
// viewer with strictly more candidates than the other — while the bounded batch still
// issues its two (empty) arm reads for both.
const FIXTURE: &[&str] = &[
    "INSERT INTO users (id, name, display_name, created_at, updated_at) VALUES \
       ('u-solo', 'solo', 'Solo', 1, 1), \
       ('u-many', 'many', 'Many', 1, 1)",
    "INSERT INTO hosts (id, name, kind, created_at) VALUES ('h1', 'host-one', 'desktop', 1)",
    "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) VALUES \
       ('a-solo', 'agent-solo', 'qoder', 'h1', 100, 100, 'u-solo')",
    "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) VALUES \
       ('a-m1', 'agent-m1', 'qoder', 'h1', 200, 200, 'u-many')",
    "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) VALUES \
       ('a-m2', 'agent-m2', 'qoder', 'h1', 300, 300, 'u-many')",
    "INSERT INTO agents (id, name, runtime, host_id, created_at, updated_at, created_by_user_id) VALUES \
       ('a-m3', 'agent-m3', 'qoder', 'h1', 400, 400, 'u-many')",
];

#[tokio::test]
async fn the_list_read_issues_a_constant_number_of_read_statements() {
    let log = StatementLog::default();
    tracing::subscriber::set_global_default(log.clone())
        .expect("the only test in this binary owns the process-wide default");

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("agent-list-statement-count.sqlite");
    let mut db = current_schema::create_current_schema(&path).await;
    for statement in FIXTURE {
        sqlx::query(*statement).execute(&mut db).await.unwrap();
    }
    db.close().await.unwrap();

    let list = SqliteAgentListColdRead::open(&path).await.unwrap();

    // Warm the pool so a connection is established before either measured read.
    list.read_agent_candidates(&user("u-many")).await.unwrap();

    let before_one = log.len();
    let one = list.read_agent_candidates(&user("u-solo")).await.unwrap();
    let reads_for_one = log.reads_since(before_one);

    let before_many = log.len();
    let many = list.read_agent_candidates(&user("u-many")).await.unwrap();
    let reads_for_many = log.reads_since(before_many);

    // The two reads must genuinely differ in candidate count, or the differential is
    // vacuous.
    assert_eq!(
        one.len(),
        1,
        "u-solo should see exactly its one created agent"
    );
    assert!(
        many.len() > one.len(),
        "u-many ({}) must see strictly more candidates than u-solo ({}) for the \
         differential to bite",
        many.len(),
        one.len()
    );

    // Self-check: no reads captured means the subscriber never saw sqlx's events, so a
    // passing equality below would be zero-against-zero — a false green. Fail loud.
    assert!(
        !reads_for_one.is_empty(),
        "no sqlx::query read events were captured; the counter is broken, not a pass"
    );

    // The load-bearing assertion. A per-candidate audience read is `1 + 2N` SELECTs, so
    // its count would grow from u-solo to u-many; the bounded set-shaped read is a
    // constant three (candidate rows, then one statement per arm).
    assert_eq!(
        reads_for_one.len(),
        reads_for_many.len(),
        "read-statement count grew with candidate count ({} for one candidate vs {} for \
         {}); the audience read is not bounded.\n  one:  {reads_for_one:#?}\n  many: \
         {reads_for_many:#?}",
        reads_for_one.len(),
        reads_for_many.len(),
        many.len()
    );
}
