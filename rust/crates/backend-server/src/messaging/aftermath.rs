//! The single production aftermath for a committed message send.
//!
//! The write transaction returns one [`SendMessageOutcome`]. This module is the only
//! place that fans its committed half into the three core aftermath plans: mention-copy
//! effects, then exactly one of main-line or reply effects. Every component of the
//! concrete production composition is required at construction; none is optional.

use std::future::Future;

use silverhand_backend_core::messaging::{
    SendMessageOutcome,
    mention_cc::MentionCopySkip,
    post_commit::{
        CommittedMessagePublication, CopyNotification, DirectLineInvalidation, EffectReport,
        IdleStart, MainDelivery, MainEffects, MentionSkipRecord, MentionedViewerRecord,
        MessagePublication, ReplyDelivery, ReplyEffects, RuntimeDelivery, RuntimeStart,
        SendEffects, SkippedMention, UnreadPublication, ViewerNotification, announce_main_send,
        announce_reply_send, announce_send,
    },
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
/// `Clone` because both send doors — the ordinary human/agent door and the direct-pair
/// initiation door — run the SAME required aftermath after a committed send. The type
/// carries no per-door state (only Clone handles), so cloning it is how "one aftermath,
/// two doors" is expressed without a second construction site that could drift.
#[derive(Clone)]
pub struct MessagingAftermath<E, D, M, U> {
    events: E,
    daemon: D,
    mentions: M,
    unread: U,
}

impl<E, D, M, U> MessagingAftermath<E, D, M, U> {
    pub fn new(events: E, daemon: D, mentions: M, unread: U) -> Self {
        Self {
            events,
            daemon,
            mentions,
            unread,
        }
    }
}

impl<E, D, M, U> SendAftermath for MessagingAftermath<E, D, M, U>
where
    E: DirectLineInvalidation
        + MessagePublication
        + CopyNotification
        + CommittedMessagePublication
        + ViewerNotification
        + Sync,
    D: RuntimeStart + RuntimeDelivery + MainDelivery + ReplyDelivery + IdleStart + Sync,
    M: MentionedViewerRecord + Sync,
    U: UnreadPublication + Sync,
{
    async fn announce(&self, outcome: &SendMessageOutcome) {
        let committed = outcome.committed();
        let skips = MentionSkipLog;

        report_failures(
            announce_send(
                committed,
                SendEffects {
                    direct_lines: &self.events,
                    publication: &self.events,
                    notification: &self.events,
                    start: &self.daemon,
                    delivery: &self.daemon,
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
                        publication: &self.events,
                        mentions: &self.mentions,
                        viewers: &self.events,
                        unread: &self.unread,
                        delivery: &self.daemon,
                        idle: &self.daemon,
                    },
                )
                .await,
            );
        } else if let Some(reply) = committed.reply_cluster() {
            report_failures(
                announce_reply_send(
                    reply,
                    ReplyEffects {
                        publication: &self.events,
                        mentions: &self.mentions,
                        viewers: &self.events,
                        unread: &self.unread,
                        delivery: &self.daemon,
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
