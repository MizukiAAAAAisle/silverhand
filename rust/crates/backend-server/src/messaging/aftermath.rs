//! The single production aftermath for a committed message send, and the write doors
//! it binds itself to.
//!
//! The write transaction returns one [`SendMessageOutcome`]. This module is the only
//! place that fans its committed half into the three core aftermath plans: mention-copy
//! effects, then exactly one of main-line or reply effects. Every component of the
//! concrete production composition is required at construction; none is optional.
//!
//! It is also the only source of the messaging write doors. Every door reads the
//! aftermath from `&self` instead of taking it as a parameter, so the composition
//! statements that mount them have no fan-out argument to get wrong.

use std::{future::Future, sync::Arc};

use axum::Router;
use silverhand_backend_core::messaging::{
    ChannelAccess, DirectLineAuthority, SendCapability, SendMessageOutcome, SendMessageUnitOfWork,
    TargetAddress,
    collaboration::direct_pair_initiation::DirectPairInitiationPort,
    mention_cc::MentionCopySkip,
    post_commit::{
        CommittedMessagePublication, CopyNotification, DirectLineInvalidation, EffectReport,
        IdleStart, MainDelivery, MainEffects, MentionSkipRecord, MentionedViewerRecord,
        MessagePublication, ReplyDelivery, ReplyEffects, RuntimeDelivery, RuntimeStart,
        SendEffects, SkippedMention, UnreadPublication, ViewerNotification, announce_main_send,
        announce_reply_send, announce_send,
    },
};

use super::{
    collaboration::direct_pair_initiation,
    router::{SendState, send_routers},
};

/// A required post-commit boundary. It cannot fail the already-committed send; each
/// effect reports its own failure and the caller still returns success. Test routers
/// may substitute this seam; the executable composition must install
/// [`MessagingAftermath`].
pub trait SendAftermath {
    fn announce(&self, outcome: &SendMessageOutcome) -> impl Future<Output = ()> + Send;
}

/// The production composition of the event hub, daemon lifecycle, durable mention
/// rows and unread read model.
///
/// The type has four components because the real adapters deliberately implement
/// related narrow ports on one authority:
///
/// - `events`: direct-line, copy/message and viewer publication;
/// - `daemon`: runtime start/delivery, main/reply delivery and idle start;
/// - `mentions`: durable mentioned-viewer rows;
/// - `unread`: placement-aware unread/badge or direct-pair invalidation.
///
/// It is a HANDLE: the four components live behind one `Arc` and [`Clone`] is written by
/// hand with NO bound on them (the shape `InitiationState` already uses). That is the
/// point of the type. `#[derive(Clone)]` would ask each component to be `Clone` and
/// duplicate whatever answered, so "both send doors run the SAME aftermath" would hold
/// only while every concrete component happened to be a shared handle; a by-value
/// component would give each door private state with no compile error. Bound-free `Clone`
/// cannot be satisfied by a by-value component set, so it states the sharing itself
/// rather than describing today's components.
///
/// The constructor is crate-private and [`crate::scope_events::ScopeEventHub::messaging_aftermath`]
/// is the only public source, so a composition crate cannot mint a second aftermath at all:
///
/// ```compile_fail
/// use silverhand_backend_server::messaging::aftermath::MessagingAftermath;
///
/// // Crate-private. A composition root has no way to assemble a second fan-out.
/// let _ = MessagingAftermath::new((), (), (), ());
/// ```
///
/// The control for that gate, because a `compile_fail` block passes on ANY error and would
/// otherwise also pass on a renamed type or a bad import. It proves the same public path is
/// live AND that cloning asks nothing of the components — so reverting to
/// `#[derive(Clone)]` reddens here:
///
/// ```
/// use silverhand_backend_server::messaging::aftermath::MessagingAftermath;
///
/// // Deliberately not `Clone`: a `Mutex` cannot be duplicated.
/// struct ByValue(std::sync::Mutex<u8>);
///
/// fn second_door(
///     first: &MessagingAftermath<ByValue, ByValue, ByValue, ByValue>,
/// ) -> MessagingAftermath<ByValue, ByValue, ByValue, ByValue> {
///     first.clone()
/// }
/// let _ = second_door;
/// ```
pub struct MessagingAftermath<E, D, M, U> {
    inner: Arc<Components<E, D, M, U>>,
}

struct Components<E, D, M, U> {
    events: E,
    daemon: D,
    mentions: M,
    unread: U,
}

impl<E, D, M, U> Clone for MessagingAftermath<E, D, M, U> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<E, D, M, U> MessagingAftermath<E, D, M, U> {
    pub(crate) fn new(events: E, daemon: D, mentions: M, unread: U) -> Self {
        Self {
            inner: Arc::new(Components {
                events,
                daemon,
                mentions,
                unread,
            }),
        }
    }
}

impl<E, D, M, U> MessagingAftermath<E, D, M, U>
where
    Self: SendAftermath + Send + Sync + 'static,
{
    /// The two authenticated send doors, bound to THIS aftermath by construction.
    ///
    /// A `&self` seam rather than an aftermath parameter, following
    /// `DaemonDeliveryRuntime::agent_run_states_router`: the composition statement that
    /// mounts the doors has no fan-out argument, so forking one door onto a different
    /// aftermath would take constructing a whole second one — a review-visible act rather
    /// than a silently swapped argument. [`send_routers`] stays public as the
    /// component/spy substrate.
    pub fn send_doors<C, T, K, A, W>(
        &self,
        channel_access: C,
        target_address: T,
        capability: K,
        authority: A,
        unit_of_work: W,
    ) -> (Router, Router)
    where
        C: ChannelAccess + Send + Sync + 'static,
        T: TargetAddress + Send + Sync + 'static,
        K: SendCapability + Send + Sync + 'static,
        A: DirectLineAuthority + Send + Sync + 'static,
        W: SendMessageUnitOfWork + Send + Sync + 'static,
    {
        send_routers(SendState {
            channel_access,
            target_address,
            capability,
            authority,
            unit_of_work,
            aftermath: self.clone(),
        })
    }

    /// The direct-pair initiation door, bound to THIS aftermath — and to the authority it
    /// publishes on — by construction.
    ///
    /// `initiation` is a builder rather than a ready port because the winner-only pair-open
    /// announcement has to ride the SAME authority the committed sends publish on. The
    /// closure is handed this aftermath's own publication component, so the mount cannot
    /// announce the pair-open on one transport while its first message publishes on another.
    pub fn direct_pair_initiation_door<I, L, W>(
        &self,
        initiation: impl FnOnce(E) -> I,
        direct_lines: L,
        unit_of_work: W,
    ) -> Router
    where
        E: Clone,
        I: DirectPairInitiationPort + Send + Sync + 'static,
        L: DirectLineAuthority + Send + Sync + 'static,
        W: SendMessageUnitOfWork + Send + Sync + 'static,
    {
        direct_pair_initiation::router(
            initiation(self.inner.events.clone()),
            direct_lines,
            unit_of_work,
            self.clone(),
        )
    }
}

// The components are reached through the shared `Arc`, so a door's `&self` crosses an await
// only if the whole component set is `Send` as well as `Sync` — the price of sharing one
// instance instead of handing each door a duplicate.
impl<E, D, M, U> SendAftermath for MessagingAftermath<E, D, M, U>
where
    E: DirectLineInvalidation
        + MessagePublication
        + CopyNotification
        + CommittedMessagePublication
        + ViewerNotification
        + Send
        + Sync,
    D: RuntimeStart + RuntimeDelivery + MainDelivery + ReplyDelivery + IdleStart + Send + Sync,
    M: MentionedViewerRecord + Send + Sync,
    U: UnreadPublication + Send + Sync,
{
    async fn announce(&self, outcome: &SendMessageOutcome) {
        let committed = outcome.committed();
        let skips = MentionSkipLog;

        report_failures(
            announce_send(
                committed,
                SendEffects {
                    direct_lines: &self.inner.events,
                    publication: &self.inner.events,
                    notification: &self.inner.events,
                    start: &self.inner.daemon,
                    delivery: &self.inner.daemon,
                    skips: &skips,
                },
            )
            .await,
        );

        if let Some(main) = committed.main_line() {
            report_failures(
                announce_main_send(
                    main,
                    MainEffects {
                        publication: &self.inner.events,
                        mentions: &self.inner.mentions,
                        viewers: &self.inner.events,
                        unread: &self.inner.unread,
                        delivery: &self.inner.daemon,
                        idle: &self.inner.daemon,
                    },
                )
                .await,
            );
        } else if let Some(reply) = committed.reply_cluster() {
            report_failures(
                announce_reply_send(
                    reply,
                    ReplyEffects {
                        publication: &self.inner.events,
                        mentions: &self.inner.mentions,
                        viewers: &self.inner.events,
                        unread: &self.inner.unread,
                        delivery: &self.inner.daemon,
                    },
                )
                .await,
            );
        } else {
            // The core constructor makes the delivery plan total. Keep an operator
            // assertion here because silently omitting path-specific effects after a
            // future invariant regression would be worse than an explicit report.
            tracing::error!(
                event = "message.aftermath_invariant_failed",
                message_id = committed.message().id.as_str(),
                "committed send has neither a main-line nor reply aftermath"
            );
        }
    }
}

/// The real terminal owner for a skipped mention is operator observation, matching
/// the reference implementation. It is intentionally not a durable row or a viewer
/// event: the sender's unresolved-reference response is the user-facing half.
struct MentionSkipLog;

impl MentionSkipRecord for MentionSkipLog {
    async fn record_skip(
        &self,
        skipped: &SkippedMention<'_>,
    ) -> Result<(), silverhand_backend_core::messaging::post_commit::EffectFailure> {
        tracing::info!(
            event = "mention_cc.skip",
            reason = mention_skip_reason(skipped.reason),
            handle = skipped.handle.as_str(),
            agent_id = skipped.agent.map(|agent| agent.as_str()),
            source_conversation_id = skipped.source_conversation.as_str(),
            source_message_id = skipped.source_message.as_str(),
            "mention-cc: mention not copied"
        );
        Ok(())
    }
}

fn mention_skip_reason(reason: MentionCopySkip) -> &'static str {
    match reason {
        MentionCopySkip::SourceNotWorkspacePlaced => "source_not_workspace_placed",
        MentionCopySkip::UnknownHandle => "unknown_handle",
        MentionCopySkip::AlreadyMember => "already_member",
        MentionCopySkip::NoDirectLine => "no_direct_line",
    }
}

fn report_failures(report: EffectReport) {
    for (message, step, failure) in report.failed {
        tracing::warn!(
            event = "message.post_commit_effect_failed",
            message_id = message.as_str(),
            effect = ?step,
            error_chain = crate::error::describe(&failure),
            "committed message post-commit effect failed"
        );
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::{Arc, Mutex},
    };

    use silverhand_backend_core::{
        identity::{AgentId, ConversationId},
        messaging::{MessageId, ParticipantHandle, post_commit::EffectStep},
    };
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;

    #[derive(Clone, Default)]
    struct LogBuffer(Arc<Mutex<Vec<u8>>>);

    struct LogWriter(LogBuffer);

    impl Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for LogBuffer {
        type Writer = LogWriter;

        fn make_writer(&'a self) -> Self::Writer {
            LogWriter(self.clone())
        }
    }

    impl LogBuffer {
        fn events(&self) -> Vec<serde_json::Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("event transport refused the frame")]
    struct TransportFailure {
        #[source]
        source: io::Error,
    }

    /// The thirteenth post-commit port has a real terminal owner: every closed skip
    /// reason becomes one structured operator fact with typed coordinates. It is not
    /// silently discarded and none of the branch detail is pushed into a client body.
    #[tokio::test(flavor = "current_thread")]
    async fn every_mention_skip_reason_reaches_the_operator_once() {
        let logs = LogBuffer::default();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .without_time()
            .with_target(false)
            .with_writer(logs.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);

        let handle = ParticipantHandle::parse("peer").unwrap();
        let agent = AgentId::parse("agent-1").unwrap();
        let conversation = ConversationId::parse("conversation-1").unwrap();
        let message = MessageId::parse("message-1").unwrap();
        let cases = [
            (
                MentionCopySkip::SourceNotWorkspacePlaced,
                "source_not_workspace_placed",
            ),
            (MentionCopySkip::UnknownHandle, "unknown_handle"),
            (MentionCopySkip::AlreadyMember, "already_member"),
            (MentionCopySkip::NoDirectLine, "no_direct_line"),
        ];

        for (reason, _) in cases {
            MentionSkipLog
                .record_skip(&SkippedMention {
                    handle: &handle,
                    reason,
                    agent: Some(&agent),
                    source_conversation: &conversation,
                    source_message: &message,
                })
                .await
                .unwrap();
        }

        let events = logs.events();
        assert_eq!(events.len(), cases.len());
        for (event, (_, expected_reason)) in events.iter().zip(cases) {
            assert_eq!(event["fields"]["event"], "mention_cc.skip");
            assert_eq!(event["fields"]["reason"], expected_reason);
            assert_eq!(event["fields"]["handle"], "peer");
            assert_eq!(event["fields"]["agent_id"], "agent-1");
            assert_eq!(event["fields"]["source_conversation_id"], "conversation-1");
            assert_eq!(event["fields"]["source_message_id"], "message-1");
        }
    }

    /// A failed effect is reported after the write with its complete cause chain. The
    /// report is observational only: it has no return channel that could turn the
    /// already-committed send into a 500 or request a second transaction attempt.
    #[test]
    fn each_failed_effect_is_reported_once_with_its_source_chain() {
        let logs = LogBuffer::default();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .without_time()
            .with_target(false)
            .with_writer(logs.clone())
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        let message = MessageId::parse("message-1").unwrap();

        report_failures(EffectReport {
            attempted: vec![(message.clone(), EffectStep::MessagePublished)],
            failed: vec![(
                message,
                EffectStep::MessagePublished,
                silverhand_backend_core::messaging::post_commit::EffectFailure::from_source(
                    TransportFailure {
                        source: io::Error::other("socket closed"),
                    },
                ),
            )],
        });

        let events = logs.events();
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0]["fields"]["event"],
            "message.post_commit_effect_failed"
        );
        assert_eq!(events[0]["fields"]["message_id"], "message-1");
        assert_eq!(events[0]["fields"]["effect"], "MessagePublished");
        let chain = events[0]["fields"]["error_chain"].as_str().unwrap();
        assert!(chain.contains("post-commit effect could not be completed"));
        assert!(chain.contains("event transport refused the frame"));
        assert!(chain.contains("socket closed"));
    }
}
