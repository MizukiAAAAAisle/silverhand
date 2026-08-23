//! What a committed send owes the world afterwards.
//!
//! Everything here happens after the writer has been released, so nothing it does
//! can change what was written. That is the whole shape of this module: the send is
//! already a fact, and these are attempts to tell people about it.
//!
//! Each capability is its own trait with its own failure. A single wide port would
//! make "one failure does not affect another" a claim about this file's control
//! flow; separate ports make it a property of the dependency graph, because no
//! attempt can be reached only through another.

use std::{error::Error, future::Future};

use super::{
    AgentId, ConversationId, MessageCreatedFact, MessageId, ParticipantHandle, UserId,
    mention_cc::{CommittedMentionCopy, MentionCopyOutcome, MentionCopySkip},
};

/// One attempt failed. The cause is kept, because "telling someone failed" is only
/// actionable with the reason attached.
#[derive(Debug, thiserror::Error)]
#[error("a post-commit effect could not be completed")]
pub struct EffectFailure {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl EffectFailure {
    pub fn from_source<E>(source: E) -> Self
    where
        E: Error + Send + Sync + 'static,
    {
        Self {
            source: Box::new(source),
        }
    }
}

/// The attempts a committed send makes, in the order they are made.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum EffectStep {
    /// The list of direct lines changed shape, so a reader's view of it is stale.
    /// First, because a copy that arrives on a line nobody knows exists cannot be
    /// read.
    DirectLineInvalidation,
    CopyPublished,
    AuthorNotified,
    RuntimeStarted,
    CopyDelivered,
    /// An addressed agent that received no copy, and why.
    SkipRecorded,
}

/// A direct line came into existence, so anything showing the set of lines is out
/// of date.
pub trait DirectLineInvalidation {
    fn direct_lines_changed(
        &self,
        line: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The copy itself, published to whoever is watching the line it landed on.
pub trait MessagePublication {
    fn publish_copy(
        &self,
        copy: &CommittedMentionCopy,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The author's own record that their mention left the room.
pub trait CopyNotification {
    fn notify_author(
        &self,
        author: &UserId,
        agent: &AgentId,
        copy: &CommittedMentionCopy,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The recipient may not be running.
pub trait RuntimeStart {
    fn start(&self, agent: &AgentId) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The recipient is owed this message now. Independent of starting it: delivery
/// enqueues on its own and the runtime decides what to do about it, so a start that
/// failed does not mean a delivery that cannot be attempted.
pub trait RuntimeDelivery {
    fn deliver(
        &self,
        agent: &AgentId,
        copy: &CommittedMentionCopy,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// An addressed agent that got no copy is a fact worth keeping: "nothing was
/// copied" alone cannot distinguish a member from a stranger.
pub trait MentionSkipRecord {
    fn record_skip(
        &self,
        skipped: &SkippedMention<'_>,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

#[derive(Clone, Copy, Debug)]
pub struct SkippedMention<'facts> {
    pub handle: &'facts ParticipantHandle,
    pub reason: MentionCopySkip,
    pub agent: Option<&'facts AgentId>,
    pub source_conversation: &'facts ConversationId,
    pub source_message: &'facts MessageId,
}

/// What was attempted and what did not work. Not a `Result`: the send happened, and
/// no attempt here can unhappen it.
#[derive(Debug, Default)]
pub struct EffectReport {
    pub attempted: Vec<(MessageId, EffectStep)>,
    pub failed: Vec<(MessageId, EffectStep, EffectFailure)>,
}

impl EffectReport {
    pub fn steps_for(&self, message: &MessageId) -> Vec<EffectStep> {
        self.attempted
            .iter()
            .filter(|(id, _)| id == message)
            .map(|(_, step)| *step)
            .collect()
    }

    pub fn failed_steps(&self) -> Vec<EffectStep> {
        self.failed.iter().map(|(_, step, _)| *step).collect()
    }
}

/// The capabilities one send's aftermath needs, held together only for the call.
/// Each is its own type parameter, so an implementation may combine them and this
/// orchestration still cannot make one attempt depend on another.
pub struct SendEffects<'ports, I, P, N, S, D, R> {
    pub direct_lines: &'ports I,
    pub publication: &'ports P,
    pub notification: &'ports N,
    pub start: &'ports S,
    pub delivery: &'ports D,
    pub skips: &'ports R,
}

/// Tells the world about a committed send.
///
/// Every attempt is made, in order, whatever the ones before it did: they answer
/// different questions and none of them supplies another. Per copy, because the
/// order that matters is the order within one copy's own story — the line exists,
/// the copy is published, the author is told, the recipient is started, the copy is
/// delivered.
pub async fn announce_send<I, P, N, S, D, R>(
    fact: &MessageCreatedFact,
    ports: SendEffects<'_, I, P, N, S, D, R>,
) -> EffectReport
where
    I: DirectLineInvalidation,
    P: MessagePublication,
    N: CopyNotification,
    S: RuntimeStart,
    D: RuntimeDelivery,
    R: MentionSkipRecord,
{
    let mut report = EffectReport::default();
    let author = match &fact.message.from_user_id {
        Some(author) => author.clone(),
        // Only a person's mention is copied, so an absent author means there is
        // nothing here to announce.
        None => return report,
    };

    for outcome in &fact.mention_copies {
        match outcome {
            MentionCopyOutcome::Copied {
                agent,
                copy,
                handle: _,
            } => {
                let id = copy.id.clone();
                attempt(
                    &mut report,
                    &id,
                    EffectStep::DirectLineInvalidation,
                    ports
                        .direct_lines
                        .direct_lines_changed(&copy.conversation_id, agent),
                )
                .await;
                attempt(
                    &mut report,
                    &id,
                    EffectStep::CopyPublished,
                    ports.publication.publish_copy(copy),
                )
                .await;
                attempt(
                    &mut report,
                    &id,
                    EffectStep::AuthorNotified,
                    ports.notification.notify_author(&author, agent, copy),
                )
                .await;
                attempt(
                    &mut report,
                    &id,
                    EffectStep::RuntimeStarted,
                    ports.start.start(agent),
                )
                .await;
                attempt(
                    &mut report,
                    &id,
                    EffectStep::CopyDelivered,
                    ports.delivery.deliver(agent, copy),
                )
                .await;
            }
            MentionCopyOutcome::Skipped {
                handle,
                reason,
                agent,
            } => {
                attempt(
                    &mut report,
                    &fact.message.id,
                    EffectStep::SkipRecorded,
                    ports.skips.record_skip(&SkippedMention {
                        handle,
                        reason: *reason,
                        agent: agent.as_ref(),
                        source_conversation: &fact.message.conversation_id,
                        source_message: &fact.message.id,
                    }),
                )
                .await;
            }
        }
    }
    report
}

async fn attempt(
    report: &mut EffectReport,
    message: &MessageId,
    step: EffectStep,
    effect: impl Future<Output = Result<(), EffectFailure>>,
) {
    report.attempted.push((message.clone(), step));
    if let Err(failure) = effect.await {
        report.failed.push((message.clone(), step, failure));
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashSet, sync::Mutex};

    use super::*;
    use crate::messaging::{
        CreatedMessage, FromKind, MessageContent, MessageSeq,
        mention_cc::{MENTION_COPY_SUBTYPE, MentionCopyMetadata},
    };

    #[derive(Debug, thiserror::Error)]
    #[error("this effect was told to fail")]
    struct Told;

    /// One port set that records every call in order and fails the steps it was
    /// told to. Recording through a shared cell keeps the trait signatures honest:
    /// the ports take `&self`, because an attempt is not allowed to hold the
    /// orchestration open.
    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<(String, EffectStep)>>,
        failing: HashSet<EffectStep>,
    }

    impl Recorder {
        fn failing(steps: &[EffectStep]) -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                failing: steps.iter().copied().collect(),
            }
        }

        fn answer(&self, id: &str, step: EffectStep) -> Result<(), EffectFailure> {
            self.calls.lock().unwrap().push((id.to_owned(), step));
            if self.failing.contains(&step) {
                return Err(EffectFailure::from_source(Told));
            }
            Ok(())
        }

        fn steps_of(&self, id: &str) -> Vec<EffectStep> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(called, _)| called == id)
                .map(|(_, step)| *step)
                .collect()
        }

        fn called(&self, step: EffectStep) -> bool {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .any(|(_, called)| *called == step)
        }
    }

    impl DirectLineInvalidation for Recorder {
        async fn direct_lines_changed(
            &self,
            line: &ConversationId,
            _agent: &AgentId,
        ) -> Result<(), EffectFailure> {
            self.answer(line.as_str(), EffectStep::DirectLineInvalidation)
        }
    }

    impl MessagePublication for Recorder {
        async fn publish_copy(&self, copy: &CommittedMentionCopy) -> Result<(), EffectFailure> {
            self.answer(copy.id.as_str(), EffectStep::CopyPublished)
        }
    }

    impl CopyNotification for Recorder {
        async fn notify_author(
            &self,
            _author: &UserId,
            _agent: &AgentId,
            copy: &CommittedMentionCopy,
        ) -> Result<(), EffectFailure> {
            self.answer(copy.id.as_str(), EffectStep::AuthorNotified)
        }
    }

    impl RuntimeStart for Recorder {
        async fn start(&self, agent: &AgentId) -> Result<(), EffectFailure> {
            self.answer(agent.as_str(), EffectStep::RuntimeStarted)
        }
    }

    impl RuntimeDelivery for Recorder {
        async fn deliver(
            &self,
            _agent: &AgentId,
            copy: &CommittedMentionCopy,
        ) -> Result<(), EffectFailure> {
            self.answer(copy.id.as_str(), EffectStep::CopyDelivered)
        }
    }

    impl MentionSkipRecord for Recorder {
        async fn record_skip(&self, skipped: &SkippedMention<'_>) -> Result<(), EffectFailure> {
            self.answer(skipped.handle.as_str(), EffectStep::SkipRecorded)
        }
    }

    fn ports(
        recorder: &Recorder,
    ) -> SendEffects<'_, Recorder, Recorder, Recorder, Recorder, Recorder, Recorder> {
        SendEffects {
            direct_lines: recorder,
            publication: recorder,
            notification: recorder,
            start: recorder,
            delivery: recorder,
            skips: recorder,
        }
    }

    fn copy(id: &str, line: &str) -> CommittedMentionCopy {
        CommittedMentionCopy {
            id: MessageId::parse(id).unwrap(),
            conversation_id: ConversationId::parse(line).unwrap(),
            from_kind: FromKind::System,
            content: "copied".to_owned(),
            metadata: MentionCopyMetadata {
                subtype: MENTION_COPY_SUBTYPE,
                source_workspace_id: "ws-1".to_owned(),
                source_workspace_name: "Space".to_owned(),
                source_conversation_id: ConversationId::parse("conv-1").unwrap(),
                source_conversation_title: "Channel".to_owned(),
                source_message_id: MessageId::parse("source-message").unwrap(),
                source_from_kind: FromKind::User,
                source_from_user_id: UserId::parse("user-1").unwrap(),
                source_message_content: "ping".to_owned(),
            },
            seq: MessageSeq::try_from(1).unwrap(),
            created_at_ms: 7,
            cc_source_message_id: MessageId::parse("source-message").unwrap(),
        }
    }

    fn fact(outcomes: Vec<MentionCopyOutcome>) -> MessageCreatedFact {
        MessageCreatedFact {
            message: CreatedMessage {
                id: MessageId::parse("source-message").unwrap(),
                conversation_id: ConversationId::parse("conv-1").unwrap(),
                from_kind: FromKind::User,
                from_agent_id: None,
                from_user_id: Some(UserId::parse("user-1").unwrap()),
                author: None,
                content: MessageContent::parse("ping").unwrap(),
                attachments: Vec::new(),
                seq: MessageSeq::try_from(1).unwrap(),
                created_at_ms: 7,
                thread_root_id: None,
            },
            thread: None,
            freshness_bypassed: false,
            mention_copies: outcomes,
        }
    }

    fn copied(id: &str, line: &str, agent: &str, handle: &str) -> MentionCopyOutcome {
        MentionCopyOutcome::Copied {
            handle: ParticipantHandle::parse(handle).unwrap(),
            agent: AgentId::parse(agent).unwrap(),
            copy: Box::new(copy(id, line)),
        }
    }

    const IN_ORDER: [EffectStep; 5] = [
        EffectStep::DirectLineInvalidation,
        EffectStep::CopyPublished,
        EffectStep::AuthorNotified,
        EffectStep::RuntimeStarted,
        EffectStep::CopyDelivered,
    ];

    #[tokio::test]
    async fn one_copy_is_announced_in_order() {
        let recorder = Recorder::default();

        let report = announce_send(
            &fact(vec![copied("copy-1", "line-1", "agent-1", "Alice")]),
            ports(&recorder),
        )
        .await;

        assert_eq!(
            report.steps_for(&MessageId::parse("copy-1").unwrap()),
            IN_ORDER
        );
        assert!(report.failed.is_empty());
    }

    /// Every step is attempted whatever the ones before it did: they answer
    /// different questions, and none of them supplies another.
    #[tokio::test]
    async fn any_single_failure_leaves_the_rest_attempted() {
        for failing in IN_ORDER {
            let recorder = Recorder::failing(&[failing]);

            let report = announce_send(
                &fact(vec![copied("copy-1", "line-1", "agent-1", "Alice")]),
                ports(&recorder),
            )
            .await;

            assert_eq!(
                report.steps_for(&MessageId::parse("copy-1").unwrap()),
                IN_ORDER,
                "{failing:?} truncated the announcement"
            );
            assert_eq!(report.failed_steps(), vec![failing]);
        }
    }

    /// The one that used to be described as a dependency: a recipient that could not
    /// be started is still owed the message, and delivery enqueues on its own.
    #[tokio::test]
    async fn a_recipient_that_cannot_be_started_is_still_delivered_to() {
        let recorder = Recorder::failing(&[EffectStep::RuntimeStarted]);

        let report = announce_send(
            &fact(vec![copied("copy-1", "line-1", "agent-1", "Alice")]),
            ports(&recorder),
        )
        .await;

        assert!(recorder.called(EffectStep::CopyDelivered));
        assert_eq!(report.failed_steps(), vec![EffectStep::RuntimeStarted]);
    }

    #[tokio::test]
    async fn every_failure_at_once_still_leaves_the_send_a_fact() {
        let recorder = Recorder::failing(&IN_ORDER);
        let committed = fact(vec![copied("copy-1", "line-1", "agent-1", "Alice")]);

        let report = announce_send(&committed, ports(&recorder)).await;

        assert_eq!(report.failed_steps(), IN_ORDER);
        // The fact is untouched: it is an argument, not an outcome, and nothing here
        // returns a failure the caller could mistake for the send failing.
        assert_eq!(committed.message.id.as_str(), "source-message");
        assert_eq!(committed.mention_copies.len(), 1);
    }

    /// A copy that did not happen is still reported, and its failure to be recorded
    /// does not touch the copies that did.
    #[tokio::test]
    async fn a_skipped_mention_is_recorded_and_its_failure_is_contained() {
        let recorder = Recorder::failing(&[EffectStep::SkipRecorded]);

        let report = announce_send(
            &fact(vec![
                MentionCopyOutcome::Skipped {
                    handle: ParticipantHandle::parse("Bob").unwrap(),
                    reason: MentionCopySkip::AlreadyMember,
                    agent: Some(AgentId::parse("agent-2").unwrap()),
                },
                copied("copy-1", "line-1", "agent-1", "Alice"),
            ]),
            ports(&recorder),
        )
        .await;

        assert!(recorder.called(EffectStep::SkipRecorded));
        assert_eq!(report.failed_steps(), vec![EffectStep::SkipRecorded]);
        assert_eq!(
            report.steps_for(&MessageId::parse("copy-1").unwrap()),
            IN_ORDER
        );
    }

    /// With more than one copy, the order that matters is the order within each
    /// copy's own story — and a step failing for one does not disturb another's.
    #[tokio::test]
    async fn each_copy_keeps_its_own_order() {
        let recorder = Recorder::failing(&[EffectStep::CopyPublished]);

        announce_send(
            &fact(vec![
                copied("copy-1", "line-1", "agent-1", "Alice"),
                copied("copy-2", "line-2", "agent-2", "Bob"),
            ]),
            ports(&recorder),
        )
        .await;

        // Each copy's own steps, in order. The line and the agent are recorded under
        // their own identities, so the per-copy sequence is the message's.
        for id in ["copy-1", "copy-2"] {
            assert_eq!(
                recorder.steps_of(id),
                vec![
                    EffectStep::CopyPublished,
                    EffectStep::AuthorNotified,
                    EffectStep::CopyDelivered
                ],
                "copy {id} lost its order"
            );
        }
        for line in ["line-1", "line-2"] {
            assert_eq!(
                recorder.steps_of(line),
                vec![EffectStep::DirectLineInvalidation]
            );
        }
        for agent in ["agent-1", "agent-2"] {
            assert_eq!(recorder.steps_of(agent), vec![EffectStep::RuntimeStarted]);
        }
    }
}
