//! Stop every running runtime seat one agent owns, and report how many stopped.
//!
//! The route has already admitted the caller (visibility + authority). This use case
//! answers the remaining question — "what is actually running, and stop each of it" —
//! against a SINGLE, source-bound SQLite snapshot: the host and the seats are read
//! together ([`AgentBulkStopReadPort::read_bulk_stop_snapshot`]) so a host reassignment
//! that races the request cannot split the host a seat is dispatched to from the seat set
//! it was captured with. The snapshot also carries the id the host was read FROM, which is
//! bound to the requested agent before anything is dispatched: a resolver that answered for
//! a different row is a fail-closed defect, never a stop sent to the wrong custody.
//!
//! Each running seat is stopped through the exact scope-keyed transport
//! ([`ScopeRuntimeStopPort`], owned by the daemon transport lane). This module never
//! re-derives the host, chooses a default, or interprets placement — it forwards the three
//! coordinates it captured (`host`, `scope`, `generation`).
//!
//! Aggregation mirrors the TypeScript `Promise.allSettled` contract exactly:
//!   - the count of FULFILLED stops is reported;
//!   - every non-fulfilled seat is preserved IN INPUT ORDER as [`BulkStopSeatFailure`]
//!     residue (its coordinate plus a typed refusal or a hard-fault cause), so the boundary
//!     logs each on a partial success without the count swallowing it;
//!   - an all-failed run's representative is the FIRST failure in that SAME ordered list —
//!     never a second, separately-ordered pass.
//!
//! Concurrency is not part of that contract: the daemon stop is idempotent and the result
//! order is fixed by the seat read, so the seats are stopped SEQUENTIALLY in that order. The
//! observable outcome (a count, or a first-failure representative) is identical to the
//! product's concurrent settle.

use std::future::Future;

use crate::{
    application_orchestration::teardown::facts::{AgentRuntimeSessionFacts, is_running_session},
    foundation::identity::{AgentId, HostId},
    foundation::persistence::PersistenceFailure,
    host_runtime::runtime_credential::{RuntimeGeneration, RuntimeScope},
    host_runtime::scope_runtime_stop::{
        ScopeRuntimeStopPort, ScopeRuntimeStopRefusal, ScopeRuntimeStopTarget,
    },
};

/// One SQLite-snapshot capture of everything the bulk stop needs, taken under a single
/// consistent read so the host and the seats cannot come from two different states.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentBulkStopSnapshot {
    /// The id the host was read FROM — the agent row's own primary key. Bound to the
    /// requested id by the use case so a resolver that answered for a different agent is a
    /// fail-closed defect, not a stop dispatched to the wrong custody.
    pub source: AgentId,
    /// The host every captured seat is dispatched to. Captured WITH the seats, never
    /// re-resolved per stop.
    pub host: HostId,
    /// Every seat the agent owns, RAW (running and not) in the seat table's stable order.
    /// The running filter is a domain rule applied here, not by the adapter.
    pub sessions: Vec<AgentRuntimeSessionFacts>,
}

/// The read face: one source-bound, single-snapshot capture, or `None` when the agent row
/// is absent (a delete that raced the already-admitted request).
pub trait AgentBulkStopReadPort: Clone + Send + Sync + 'static {
    fn read_bulk_stop_snapshot(
        &self,
        agent_id: &AgentId,
    ) -> impl Future<Output = Result<Option<AgentBulkStopSnapshot>, PersistenceFailure>> + Send;
}

/// Why one seat's stop did not succeed, kept with the coordinate that identifies it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BulkStopSeatFailure {
    pub scope: RuntimeScope,
    pub generation: RuntimeGeneration,
    pub cause: BulkStopSeatFault,
}

/// The two ways a seat stop fails: a typed placement refusal the transport could honestly
/// establish, or a hard fault carried as its already-rendered cause message. The port's
/// error is generic, so its `Display` is captured here — that is all the boundary needs for
/// the untyped `500` body and the log line, and it keeps this outcome free of the port's
/// concrete error type.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BulkStopSeatFault {
    Refused(ScopeRuntimeStopRefusal),
    Faulted(String),
}

/// The aggregate outcome. `Ran` carries the fulfilled count and the input-ordered failure
/// residue together, so the boundary derives BOTH the partial-success log and the all-failed
/// representative from one ordered list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentBulkStopOutcome {
    /// The row was gone when the snapshot was taken (a delete raced the admitted request).
    /// The boundary answers the anti-enumeration `404`, as the product's own `agents.get`
    /// miss would.
    NoSuchAgent,
    /// The snapshot resolved a host from a row whose id is not the requested agent — a
    /// resolver defect. Fail-closed; nothing is dispatched.
    SourceUntrustworthy,
    /// The stop ran over the running seats. `stopped` counts fulfilled; `failures` keeps
    /// every non-fulfilled seat in input order (empty ⇒ every running seat stopped, or
    /// there were none: a true no-op).
    Ran {
        stopped: u32,
        failures: Vec<BulkStopSeatFailure>,
    },
}

/// Read the single-snapshot capture, bind its source, then stop each RUNNING seat through
/// the exact transport, aggregating per the `allSettled` contract. A read failure is the
/// only hard `Err` (the boundary maps it to a safe `500`): once seats are known, an
/// individual seat's transport fault is captured as residue, never propagated.
pub async fn bulk_stop_agent_runtimes<R, S>(
    reads: &R,
    stops: &S,
    agent_id: &AgentId,
) -> Result<AgentBulkStopOutcome, PersistenceFailure>
where
    R: AgentBulkStopReadPort,
    S: ScopeRuntimeStopPort,
{
    let Some(snapshot) = reads.read_bulk_stop_snapshot(agent_id).await? else {
        return Ok(AgentBulkStopOutcome::NoSuchAgent);
    };
    if &snapshot.source != agent_id {
        return Ok(AgentBulkStopOutcome::SourceUntrustworthy);
    }

    let AgentBulkStopSnapshot { host, sessions, .. } = snapshot;
    let mut stopped: u32 = 0;
    let mut failures: Vec<BulkStopSeatFailure> = Vec::new();

    for session in sessions.into_iter().filter(is_running_session) {
        let generation = session.generation;
        let scope = session.scope;
        let target = ScopeRuntimeStopTarget::new(host.clone(), scope.clone(), generation);
        match stops.hard_stop(&target).await {
            Ok(Ok(_outcome)) => stopped += 1,
            Ok(Err(refusal)) => failures.push(BulkStopSeatFailure {
                scope,
                generation,
                cause: BulkStopSeatFault::Refused(refusal),
            }),
            Err(error) => failures.push(BulkStopSeatFailure {
                scope,
                generation,
                cause: BulkStopSeatFault::Faulted(error.to_string()),
            }),
        }
    }

    Ok(AgentBulkStopOutcome::Ran { stopped, failures })
}

#[cfg(test)]
mod tests {
    use std::{
        error::Error,
        fmt,
        sync::{Arc, Mutex},
    };

    use crate::{
        foundation::identity::ConversationId, host_runtime::runtime_event::RuntimeObservedStatus,
        host_runtime::scope_runtime_stop::ScopeRuntimeStopOutcome,
    };

    use super::*;

    fn agent(id: &str) -> AgentId {
        AgentId::parse(id).expect("agent id")
    }

    fn host(id: &str) -> HostId {
        HostId::parse(id).expect("host id")
    }

    fn generation(value: i64) -> RuntimeGeneration {
        RuntimeGeneration::new(value).expect("generation")
    }

    fn agent_seat(
        id: &str,
        status: RuntimeObservedStatus,
        gen_value: i64,
    ) -> AgentRuntimeSessionFacts {
        AgentRuntimeSessionFacts {
            scope: RuntimeScope::AgentSlot { agent: agent(id) },
            status,
            generation: generation(gen_value),
        }
    }

    fn conversation_seat(
        id: &str,
        source: &str,
        status: RuntimeObservedStatus,
        gen_value: i64,
    ) -> AgentRuntimeSessionFacts {
        AgentRuntimeSessionFacts {
            scope: RuntimeScope::ConversationSlot {
                agent: agent(id),
                source: ConversationId::parse(source).expect("conversation id"),
            },
            status,
            generation: generation(gen_value),
        }
    }

    #[derive(Clone)]
    struct FakeReads {
        snapshot: Result<Option<AgentBulkStopSnapshot>, ReadFault>,
    }

    /// A cloneable stand-in for a persistence failure, so the fake can hand one back by
    /// value on every clone.
    #[derive(Clone, Debug)]
    struct ReadFault;

    impl fmt::Display for ReadFault {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("bulk stop snapshot read failed")
        }
    }

    impl Error for ReadFault {}

    impl FakeReads {
        fn present(snapshot: AgentBulkStopSnapshot) -> Self {
            Self {
                snapshot: Ok(Some(snapshot)),
            }
        }

        fn absent() -> Self {
            Self { snapshot: Ok(None) }
        }

        fn failing() -> Self {
            Self {
                snapshot: Err(ReadFault),
            }
        }
    }

    impl AgentBulkStopReadPort for FakeReads {
        async fn read_bulk_stop_snapshot(
            &self,
            _agent_id: &AgentId,
        ) -> Result<Option<AgentBulkStopSnapshot>, PersistenceFailure> {
            self.snapshot
                .clone()
                .map_err(PersistenceFailure::from_source)
        }
    }

    /// The scripted per-seat verdict the fake stop port replays, in call order.
    #[derive(Clone)]
    enum StopScript {
        Ok,
        Refused(ScopeRuntimeStopRefusal),
        Faulted(&'static str),
    }

    #[derive(Debug)]
    struct StopFault(&'static str);

    impl fmt::Display for StopFault {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str(self.0)
        }
    }

    impl Error for StopFault {}

    #[derive(Clone)]
    struct FakeStops {
        script: Arc<Mutex<std::collections::VecDeque<StopScript>>>,
        seen: Arc<Mutex<Vec<ScopeRuntimeStopTarget>>>,
    }

    impl FakeStops {
        fn scripted(script: Vec<StopScript>) -> Self {
            Self {
                script: Arc::new(Mutex::new(script.into())),
                seen: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn targets(&self) -> Vec<ScopeRuntimeStopTarget> {
            self.seen.lock().unwrap().clone()
        }
    }

    impl ScopeRuntimeStopPort for FakeStops {
        type Error = StopFault;

        async fn hard_stop(
            &self,
            target: &ScopeRuntimeStopTarget,
        ) -> Result<Result<ScopeRuntimeStopOutcome, ScopeRuntimeStopRefusal>, Self::Error> {
            self.seen.lock().unwrap().push(target.clone());
            let next = self
                .script
                .lock()
                .unwrap()
                .pop_front()
                .expect("stop called more times than scripted");
            match next {
                StopScript::Ok => Ok(Ok(ScopeRuntimeStopOutcome)),
                StopScript::Refused(refusal) => Ok(Err(refusal)),
                StopScript::Faulted(message) => Err(StopFault(message)),
            }
        }
    }

    #[tokio::test]
    async fn an_absent_row_is_no_such_agent_and_never_dispatches() {
        let stops = FakeStops::scripted(vec![]);
        let outcome = bulk_stop_agent_runtimes(&FakeReads::absent(), &stops, &agent("a1"))
            .await
            .expect("read ok");

        assert_eq!(outcome, AgentBulkStopOutcome::NoSuchAgent);
        assert!(
            stops.targets().is_empty(),
            "an absent row must not dispatch"
        );
    }

    #[tokio::test]
    async fn a_snapshot_bound_to_a_different_agent_is_untrustworthy_and_never_dispatches() {
        // The row resolved carries `a2`'s host though `a1` was requested: a resolver defect.
        let reads = FakeReads::present(AgentBulkStopSnapshot {
            source: agent("a2"),
            host: host("h1"),
            sessions: vec![agent_seat("a2", RuntimeObservedStatus::Active, 1)],
        });
        let stops = FakeStops::scripted(vec![]);

        let outcome = bulk_stop_agent_runtimes(&reads, &stops, &agent("a1"))
            .await
            .expect("read ok");

        assert_eq!(outcome, AgentBulkStopOutcome::SourceUntrustworthy);
        assert!(
            stops.targets().is_empty(),
            "a source mismatch must not dispatch to the wrong custody"
        );
    }

    #[tokio::test]
    async fn only_running_seats_dispatch_and_carry_the_captured_host_and_own_coordinate() {
        // Idle + Crashed must be skipped; Starting + Active must dispatch, each with the
        // ONE captured host and its OWN scope/generation, in seat order.
        let reads = FakeReads::present(AgentBulkStopSnapshot {
            source: agent("a1"),
            host: host("captured-host"),
            sessions: vec![
                agent_seat("a1", RuntimeObservedStatus::Idle, 1),
                agent_seat("a1", RuntimeObservedStatus::Active, 2),
                conversation_seat("a1", "c9", RuntimeObservedStatus::Crashed, 3),
                conversation_seat("a1", "c7", RuntimeObservedStatus::Starting, 4),
            ],
        });
        let stops = FakeStops::scripted(vec![StopScript::Ok, StopScript::Ok]);

        let outcome = bulk_stop_agent_runtimes(&reads, &stops, &agent("a1"))
            .await
            .expect("read ok");

        assert_eq!(
            outcome,
            AgentBulkStopOutcome::Ran {
                stopped: 2,
                failures: vec![]
            }
        );
        let targets = stops.targets();
        assert_eq!(targets.len(), 2, "only the two running seats dispatch");
        assert!(targets.iter().all(|t| t.host() == &host("captured-host")));
        // Active agent-slot (gen 2) then Starting conversation-slot c7 (gen 4), in order.
        assert_eq!(targets[0].generation(), generation(2));
        assert!(matches!(targets[0].scope(), RuntimeScope::AgentSlot { .. }));
        assert_eq!(targets[1].generation(), generation(4));
        assert!(matches!(
            targets[1].scope(),
            RuntimeScope::ConversationSlot { source, .. } if source.as_str() == "c7"
        ));
    }

    #[tokio::test]
    async fn no_running_seats_is_an_empty_ran_no_op() {
        let reads = FakeReads::present(AgentBulkStopSnapshot {
            source: agent("a1"),
            host: host("h1"),
            sessions: vec![
                agent_seat("a1", RuntimeObservedStatus::Idle, 1),
                conversation_seat("a1", "c1", RuntimeObservedStatus::Crashed, 2),
            ],
        });
        let stops = FakeStops::scripted(vec![]);

        let outcome = bulk_stop_agent_runtimes(&reads, &stops, &agent("a1"))
            .await
            .expect("read ok");

        assert_eq!(
            outcome,
            AgentBulkStopOutcome::Ran {
                stopped: 0,
                failures: vec![]
            }
        );
        assert!(stops.targets().is_empty());
    }

    #[tokio::test]
    async fn partial_success_keeps_the_fulfilled_count_and_ordered_residue() {
        let reads = FakeReads::present(AgentBulkStopSnapshot {
            source: agent("a1"),
            host: host("h1"),
            sessions: vec![
                conversation_seat("a1", "c1", RuntimeObservedStatus::Active, 1),
                conversation_seat("a1", "c2", RuntimeObservedStatus::Active, 2),
                conversation_seat("a1", "c3", RuntimeObservedStatus::Active, 3),
            ],
        });
        // ok, refused, faulted — a mixed outcome.
        let stops = FakeStops::scripted(vec![
            StopScript::Ok,
            StopScript::Refused(ScopeRuntimeStopRefusal::HostAttachPending),
            StopScript::Faulted("transport exploded"),
        ]);

        let outcome = bulk_stop_agent_runtimes(&reads, &stops, &agent("a1"))
            .await
            .expect("read ok");

        assert_eq!(
            outcome,
            AgentBulkStopOutcome::Ran {
                stopped: 1,
                failures: vec![
                    BulkStopSeatFailure {
                        scope: RuntimeScope::ConversationSlot {
                            agent: agent("a1"),
                            source: ConversationId::parse("c2").unwrap(),
                        },
                        generation: generation(2),
                        cause: BulkStopSeatFault::Refused(
                            ScopeRuntimeStopRefusal::HostAttachPending
                        ),
                    },
                    BulkStopSeatFailure {
                        scope: RuntimeScope::ConversationSlot {
                            agent: agent("a1"),
                            source: ConversationId::parse("c3").unwrap(),
                        },
                        generation: generation(3),
                        cause: BulkStopSeatFault::Faulted("transport exploded".to_string()),
                    },
                ],
            }
        );
    }

    #[tokio::test]
    async fn all_failed_preserves_the_input_order_first_failure() {
        let reads = FakeReads::present(AgentBulkStopSnapshot {
            source: agent("a1"),
            host: host("h1"),
            sessions: vec![
                conversation_seat("a1", "c1", RuntimeObservedStatus::Active, 1),
                conversation_seat("a1", "c2", RuntimeObservedStatus::Active, 2),
            ],
        });
        // First seat REFUSED, second FAULTED. The all-failed representative must be the
        // FIRST in seat order (the refusal), not whichever completed first.
        let stops = FakeStops::scripted(vec![
            StopScript::Refused(ScopeRuntimeStopRefusal::HostRevoked),
            StopScript::Faulted("later fault"),
        ]);

        let outcome = bulk_stop_agent_runtimes(&reads, &stops, &agent("a1"))
            .await
            .expect("read ok");

        match outcome {
            AgentBulkStopOutcome::Ran { stopped, failures } => {
                assert_eq!(stopped, 0);
                assert_eq!(failures.len(), 2);
                assert_eq!(
                    failures[0].cause,
                    BulkStopSeatFault::Refused(ScopeRuntimeStopRefusal::HostRevoked)
                );
                assert_eq!(failures[0].generation, generation(1));
            }
            other => panic!("expected an all-failed Ran, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_read_failure_propagates_as_the_hard_error() {
        let stops = FakeStops::scripted(vec![]);
        let result = bulk_stop_agent_runtimes(&FakeReads::failing(), &stops, &agent("a1")).await;

        assert!(result.is_err(), "a read failure must bubble as a hard Err");
        assert!(stops.targets().is_empty());
    }
}
