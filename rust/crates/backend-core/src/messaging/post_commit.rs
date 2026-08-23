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
    /// The author's view of their direct lines is stale — a line may be new, and an
    /// existing one has a new preview and a new position. First, because a copy
    /// nobody can see the line for cannot be read.
    DirectLineInvalidation,
    CopyPublished,
    AuthorNotified,
    RuntimeStarted,
    CopyDelivered,
    /// An addressed agent that received no copy, and why.
    SkipRecorded,
    /// The message itself, published to the conversation it landed in.
    MessagePublished,
    /// The durable record that a person was named. A write of its own, in its own
    /// transaction, after the send has already committed.
    MentionedViewerRecorded,
    ViewerNotified,
    /// What every reader's unread state now is. It READS the record above, so it
    /// runs after that write has been attempted.
    UnreadPublished,
    MainDelivered,
    /// Only for recipients that are not already running.
    IdleStarted,
}

/// A copy landed on a direct line, so the AUTHOR's view of their lines is out of
/// date: the line may be new, and even an old one now has a different preview and a
/// different place in the list.
///
/// The audience is the author, not the recipient: an agent is not a viewer of the
/// list, so passing it here would leave an adapter unable to address anyone.
pub trait DirectLineInvalidation {
    fn direct_lines_changed(
        &self,
        author: &UserId,
        line: &ConversationId,
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

/// The recipient may not be running. A runtime is located by the conversation it
/// serves as well as by the agent, because a conversation-scoped one cannot be
/// found by agent alone.
pub trait RuntimeStart {
    fn start(
        &self,
        conversation: &ConversationId,
        agent: &AgentId,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
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

/// The durable record that a person was named in a message they can see.
///
/// This is a WRITE, after the send committed and in a transaction of its own, so it
/// has its own custody: if it fails the message stands and stays published, and the
/// named person simply has no directed item in their badge. Nothing already
/// committed may be undone for it, and no later attempt may be skipped because of
/// it.
pub trait MentionedViewerRecord {
    fn record_mentioned_viewer(
        &self,
        viewer: &UserId,
        message: &MessageId,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<CommittedViewerMention, EffectFailure>> + Send;
}

/// One recorded mention, as the row that now exists. Returned rather than implied,
/// because the publication below can fail while this row remains: a capability that
/// answered only "did both halves work" would lose that state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedViewerMention {
    pub viewer: UserId,
    pub message: MessageId,
    pub conversation: ConversationId,
}

/// Tells the named person's client that the row above exists.
pub trait ViewerNotification {
    fn notify_viewer(
        &self,
        mention: &CommittedViewerMention,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The message, published to the conversation it landed in.
pub trait MainPublication {
    fn publish_message(
        &self,
        fact: &MessageCreatedFact,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// Everyone's unread state after this message. It reads the mention rows, which is
/// why it cannot run before they are written.
pub trait UnreadPublication {
    fn publish_unread(
        &self,
        conversation: &ConversationId,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The message is owed to the conversation's agent participants.
pub trait MainDelivery {
    fn deliver_to_participants(
        &self,
        fact: &MessageCreatedFact,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// A recipient that is not running is started afterwards. Delivery does not depend
/// on it: an idle runtime is started because nobody is there to receive, not in
/// order to receive.
pub trait IdleStart {
    fn start_idle_recipients(
        &self,
        fact: &MessageCreatedFact,
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
                        .direct_lines_changed(&author, &copy.conversation_id),
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
                    ports.start.start(&copy.conversation_id, agent),
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

/// The capabilities a main-line send's aftermath needs.
pub struct MainEffects<'ports, P, R, V, U, D, S> {
    pub publication: &'ports P,
    pub mentions: &'ports R,
    pub viewers: &'ports V,
    pub unread: &'ports U,
    pub delivery: &'ports D,
    pub idle: &'ports S,
}

/// Tells the world about a committed main-line send.
///
/// The order is load-bearing in one place and one place only: a named person's
/// durable mention row is written before unread state is published, because the
/// badge's directed count READS that row — publishing first sends a value that
/// predates the mention, and the client does not ask again. Everything else is
/// ordered for readability, and each attempt is isolated: per named viewer, so one
/// person's failure does not cost another theirs.
pub async fn announce_main_send<P, R, V, U, D, S>(
    fact: &MessageCreatedFact,
    mentioned_viewers: &[UserId],
    ports: MainEffects<'_, P, R, V, U, D, S>,
) -> EffectReport
where
    P: MainPublication,
    R: MentionedViewerRecord,
    V: ViewerNotification,
    U: UnreadPublication,
    D: MainDelivery,
    S: IdleStart,
{
    let mut report = EffectReport::default();
    let id = fact.message.id.clone();
    let conversation = fact.message.conversation_id.clone();

    attempt(
        &mut report,
        &id,
        EffectStep::MessagePublished,
        ports.publication.publish_message(fact),
    )
    .await;

    for viewer in mentioned_viewers {
        report
            .attempted
            .push((id.clone(), EffectStep::MentionedViewerRecorded));
        match ports
            .mentions
            .record_mentioned_viewer(viewer, &id, &conversation)
            .await
        {
            // The row exists whatever the publication does next, and the failure of
            // one named person's record does not reach the next person's.
            Ok(mention) => {
                attempt(
                    &mut report,
                    &id,
                    EffectStep::ViewerNotified,
                    ports.viewers.notify_viewer(&mention),
                )
                .await;
            }
            Err(failure) => {
                report
                    .failed
                    .push((id.clone(), EffectStep::MentionedViewerRecorded, failure));
            }
        }
    }

    attempt(
        &mut report,
        &id,
        EffectStep::UnreadPublished,
        ports.unread.publish_unread(&conversation),
    )
    .await;
    attempt(
        &mut report,
        &id,
        EffectStep::MainDelivered,
        ports.delivery.deliver_to_participants(fact),
    )
    .await;
    attempt(
        &mut report,
        &id,
        EffectStep::IdleStarted,
        ports.idle.start_idle_recipients(fact),
    )
    .await;
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
            author: &UserId,
            line: &ConversationId,
        ) -> Result<(), EffectFailure> {
            self.answer(
                &format!("{}|{}", author.as_str(), line.as_str()),
                EffectStep::DirectLineInvalidation,
            )
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
        async fn start(
            &self,
            conversation: &ConversationId,
            agent: &AgentId,
        ) -> Result<(), EffectFailure> {
            self.answer(
                &format!("{}|{}", conversation.as_str(), agent.as_str()),
                EffectStep::RuntimeStarted,
            )
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

    /// A failure is only actionable with its reason, so the cause survives the
    /// boundary rather than being flattened into "an effect failed".
    #[tokio::test]
    async fn a_failure_keeps_the_cause_it_was_given() {
        let recorder = Recorder::failing(&[EffectStep::CopyPublished]);

        let report = announce_send(
            &fact(vec![copied("copy-1", "line-1", "agent-1", "Alice")]),
            ports(&recorder),
        )
        .await;

        let (_, step, failure) = &report.failed[0];
        assert_eq!(*step, EffectStep::CopyPublished);
        assert_eq!(
            std::error::Error::source(failure).unwrap().to_string(),
            "this effect was told to fail"
        );
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
        // Both arguments of each call are pinned: the author's view is invalidated
        // for the line the copy landed on, and the runtime is located by that same
        // line together with the agent.
        for line in ["line-1", "line-2"] {
            assert_eq!(
                recorder.steps_of(&format!("user-1|{line}")),
                vec![EffectStep::DirectLineInvalidation]
            );
        }
        for (line, agent) in [("line-1", "agent-1"), ("line-2", "agent-2")] {
            assert_eq!(
                recorder.steps_of(&format!("{line}|{agent}")),
                vec![EffectStep::RuntimeStarted]
            );
        }
    }

    impl MainPublication for Recorder {
        async fn publish_message(&self, fact: &MessageCreatedFact) -> Result<(), EffectFailure> {
            self.answer(fact.message.id.as_str(), EffectStep::MessagePublished)
        }
    }

    impl MentionedViewerRecord for Recorder {
        async fn record_mentioned_viewer(
            &self,
            viewer: &UserId,
            message: &MessageId,
            conversation: &ConversationId,
        ) -> Result<CommittedViewerMention, EffectFailure> {
            self.answer(
                &format!("{}|{}", viewer.as_str(), message.as_str()),
                EffectStep::MentionedViewerRecorded,
            )?;
            Ok(CommittedViewerMention {
                viewer: viewer.clone(),
                message: message.clone(),
                conversation: conversation.clone(),
            })
        }
    }

    impl ViewerNotification for Recorder {
        async fn notify_viewer(
            &self,
            mention: &CommittedViewerMention,
        ) -> Result<(), EffectFailure> {
            self.answer(
                &format!("{}|{}", mention.viewer.as_str(), mention.message.as_str()),
                EffectStep::ViewerNotified,
            )
        }
    }

    impl UnreadPublication for Recorder {
        async fn publish_unread(&self, conversation: &ConversationId) -> Result<(), EffectFailure> {
            self.answer(conversation.as_str(), EffectStep::UnreadPublished)
        }
    }

    impl MainDelivery for Recorder {
        async fn deliver_to_participants(
            &self,
            fact: &MessageCreatedFact,
        ) -> Result<(), EffectFailure> {
            self.answer(fact.message.id.as_str(), EffectStep::MainDelivered)
        }
    }

    impl IdleStart for Recorder {
        async fn start_idle_recipients(
            &self,
            fact: &MessageCreatedFact,
        ) -> Result<(), EffectFailure> {
            self.answer(fact.message.id.as_str(), EffectStep::IdleStarted)
        }
    }

    fn main_ports(
        recorder: &Recorder,
    ) -> MainEffects<'_, Recorder, Recorder, Recorder, Recorder, Recorder, Recorder> {
        MainEffects {
            publication: recorder,
            mentions: recorder,
            viewers: recorder,
            unread: recorder,
            delivery: recorder,
            idle: recorder,
        }
    }

    fn viewers(names: &[&str]) -> Vec<UserId> {
        names
            .iter()
            .map(|name| UserId::parse(*name).unwrap())
            .collect()
    }

    /// The main line's own order, ending in delivery and THEN the conditional start
    /// of whoever was idle — delivery does not wait on a runtime, and a runtime is
    /// started because nobody was there to receive.
    #[tokio::test]
    async fn a_main_line_send_is_announced_in_its_own_order() {
        let recorder = Recorder::default();

        let report = announce_main_send(
            &fact(Vec::new()),
            &viewers(&["viewer-1"]),
            main_ports(&recorder),
        )
        .await;

        assert_eq!(
            report.steps_for(&MessageId::parse("source-message").unwrap()),
            vec![
                EffectStep::MessagePublished,
                EffectStep::MentionedViewerRecorded,
                EffectStep::ViewerNotified,
                EffectStep::UnreadPublished,
                EffectStep::MainDelivered,
                EffectStep::IdleStarted,
            ]
        );
        assert!(report.failed.is_empty());
    }

    /// The row is written before unread is published, because the badge's directed
    /// count reads it. Anything after a failure still runs.
    #[tokio::test]
    async fn unread_is_published_after_the_mention_row_is_attempted() {
        for failing in [
            EffectStep::MessagePublished,
            EffectStep::MentionedViewerRecorded,
            EffectStep::ViewerNotified,
            EffectStep::UnreadPublished,
            EffectStep::MainDelivered,
            EffectStep::IdleStarted,
        ] {
            let recorder = Recorder::failing(&[failing]);

            let report = announce_main_send(
                &fact(Vec::new()),
                &viewers(&["viewer-1"]),
                main_ports(&recorder),
            )
            .await;

            let steps = report.steps_for(&MessageId::parse("source-message").unwrap());
            let recorded = steps
                .iter()
                .position(|step| *step == EffectStep::MentionedViewerRecorded);
            let unread = steps
                .iter()
                .position(|step| *step == EffectStep::UnreadPublished);
            assert!(
                recorded < unread,
                "{failing:?} disturbed the one order that carries weight: {steps:?}"
            );
            assert!(
                steps.contains(&EffectStep::MainDelivered)
                    && steps.contains(&EffectStep::IdleStarted),
                "{failing:?} truncated the announcement: {steps:?}"
            );
            assert_eq!(report.failed_steps(), vec![failing]);
        }
    }

    /// A record that fails has no fact to publish — there is no value to pass — and
    /// the person's notification is simply not attempted. Everything else still is.
    #[tokio::test]
    async fn a_failed_record_leaves_nothing_to_notify_with() {
        let recorder = Recorder::failing(&[EffectStep::MentionedViewerRecorded]);

        let report = announce_main_send(
            &fact(Vec::new()),
            &viewers(&["viewer-1"]),
            main_ports(&recorder),
        )
        .await;

        assert!(!recorder.called(EffectStep::ViewerNotified));
        assert!(recorder.called(EffectStep::UnreadPublished));
        assert_eq!(
            report.failed_steps(),
            vec![EffectStep::MentionedViewerRecorded]
        );
    }

    /// One named person's failure is theirs alone: the next person's row is still
    /// written and their client still told.
    #[tokio::test]
    async fn one_viewers_failure_does_not_cost_another_theirs() {
        let recorder = Recorder::failing(&[EffectStep::ViewerNotified]);

        announce_main_send(
            &fact(Vec::new()),
            &viewers(&["viewer-1", "viewer-2"]),
            main_ports(&recorder),
        )
        .await;

        for viewer in ["viewer-1", "viewer-2"] {
            assert_eq!(
                recorder.steps_of(&format!("{viewer}|source-message")),
                vec![
                    EffectStep::MentionedViewerRecorded,
                    EffectStep::ViewerNotified
                ],
                "{viewer} lost their own two steps"
            );
        }
    }
}
