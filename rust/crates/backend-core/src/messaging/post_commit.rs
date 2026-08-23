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
    AgentId, ConversationId, CreatedMessage, MainCommittedSend, MessageCreatedFact, MessageId,
    NotificationId, ParticipantHandle, UserId, WorkspaceId,
    mention_cc::{CommittedMentionCopy, MentionCopyOutcome, MentionCopySkip},
};

/// What a committed send owes the world.
///
/// Two layers, because the facts have two shapes. Naming someone does not depend on
/// where the message landed, so mentions are common. Who receives the message does:
/// a main-line send reaches the conversation's participants, a reply reaches the
/// cluster's followers. Keeping those apart by type is what stops one path's
/// announcer from executing the other's plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PostCommitPlan {
    mentions: Vec<MentionRowDraft>,
    delivery: DeliveryPlan,
}

impl PostCommitPlan {
    /// Assembled by the unit of work that committed the send. A trust seam, like the
    /// fact that carries it: the caller of the port cannot reach it, and the store
    /// can, because the store is what decided these facts inside the transaction.
    pub fn committed(mentions: Vec<MentionRowDraft>, delivery: DeliveryPlan) -> Self {
        Self { mentions, delivery }
    }

    /// One draft per person this body named who can read the conversation.
    ///
    /// Read-only, so a caller cannot add a name the send did not — nor take one away:
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::post_commit::PostCommitPlan;
    ///
    /// fn tamper(plan: &PostCommitPlan) {
    ///     plan.mentions().push(todo!());
    /// }
    /// ```
    pub fn mentions(&self) -> &[MentionRowDraft] {
        &self.mentions
    }

    pub fn delivery(&self) -> &DeliveryPlan {
        &self.delivery
    }
}

/// Who receives the message, by the path it took.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliveryPlan {
    MainLine(MainDeliveryPlan),
    ReplyCluster(ReplyAudience),
}

/// A main-line send's recipients, and which of them this send is allowed to start.
///
/// The two lists differ, and not by accident. An agent writing into its own
/// conversation is not delivered its own message and starts nobody: the runtime it
/// would start is the one already running to write. An agent writing into ANOTHER
/// conversation is a different case — the target's own session is a recipient there,
/// and idle recipients are started. A person's send excludes nobody and starts
/// whoever is idle.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MainDeliveryPlan {
    recipients: Vec<AgentId>,
    start_eligible: Vec<AgentId>,
}

impl MainDeliveryPlan {
    pub fn committed(recipients: Vec<AgentId>, start_eligible: Vec<AgentId>) -> Self {
        Self {
            recipients,
            start_eligible,
        }
    }

    /// Who the message is owed to. Read-only for the same reason as the mentions: a
    /// recipient list a caller could edit would be a recipient list the send did not
    /// decide.
    ///
    /// ```compile_fail
    /// use silverhand_backend_core::messaging::post_commit::MainDeliveryPlan;
    ///
    /// fn tamper(plan: &MainDeliveryPlan) {
    ///     plan.recipients().push(todo!());
    /// }
    /// ```
    pub fn recipients(&self) -> &[AgentId] {
        &self.recipients
    }

    /// Which recipients this send may start if nothing is running for them. Whether
    /// one IS idle is volatile and is not decided here.
    pub fn start_eligible(&self) -> &[AgentId] {
        &self.start_eligible
    }
}

/// A reply's audience: the cluster's follower agents that still participate, minus
/// the sender.
///
/// Named for what it is rather than "the reply's delivery plan", because it carries
/// no delivery kind. Every recipient of a current reply is owed a turn — the kind is
/// the reply announcer's fixed contract, not something an adapter should have to
/// infer — while `observe` belongs to historical catch-up, which is written inside
/// the transaction and is no part of this.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplyAudience {
    recipients: Vec<AgentId>,
}

impl ReplyAudience {
    pub fn committed(recipients: Vec<AgentId>) -> Self {
        Self { recipients }
    }

    pub fn recipients(&self) -> &[AgentId] {
        &self.recipients
    }
}

/// Everything the durable record of "this person was named" needs, projected from
/// the send that named them.
///
/// It carries no timestamp and no identity: the row is written after the send, in a
/// transaction of its own, so when it happened and what it is called are the writing
/// adapter's own facts and are reported back on [`CommittedMentionRow`]. A draft that
/// claimed a timestamp would be naming a moment that had not arrived.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MentionRowDraft {
    viewer: UserId,
    mentioned_name: ParticipantHandle,
    trigger_name: String,
    source_workspace: WorkspaceCoordinate,
    source_conversation: ConversationId,
    source_conversation_title: String,
    source_message: MessageId,
    excerpt: String,
}

impl MentionRowDraft {
    #[allow(clippy::too_many_arguments)]
    pub fn committed(
        viewer: UserId,
        mentioned_name: ParticipantHandle,
        trigger_name: String,
        source_workspace: WorkspaceCoordinate,
        source_conversation: ConversationId,
        source_conversation_title: String,
        source_message: MessageId,
        excerpt: String,
    ) -> Self {
        Self {
            viewer,
            mentioned_name,
            trigger_name,
            source_workspace,
            source_conversation,
            source_conversation_title,
            source_message,
            excerpt,
        }
    }

    pub fn viewer(&self) -> &UserId {
        &self.viewer
    }

    pub fn mentioned_name(&self) -> &ParticipantHandle {
        &self.mentioned_name
    }

    /// Who named them, as a reader will see it: the sender's display name, or their
    /// name, or their id — whichever is the first that says something.
    pub fn trigger_name(&self) -> &str {
        &self.trigger_name
    }

    pub fn source_workspace(&self) -> &WorkspaceCoordinate {
        &self.source_workspace
    }

    pub fn source_conversation(&self) -> &ConversationId {
        &self.source_conversation
    }

    pub fn source_conversation_title(&self) -> &str {
        &self.source_conversation_title
    }

    pub fn source_message(&self) -> &MessageId {
        &self.source_message
    }

    pub fn excerpt(&self) -> &str {
        &self.excerpt
    }
}

/// A mention record only exists inside a workspace: it is navigated to by workspace
/// and conversation, and a direct line has no workspace to navigate from. So the
/// coordinate is required rather than optional — a draft without one would describe
/// a row a reader could not reach.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceCoordinate {
    id: WorkspaceId,
    name: String,
}

impl WorkspaceCoordinate {
    pub fn committed(id: WorkspaceId, name: String) -> Self {
        Self { id, name }
    }

    pub fn id(&self) -> &WorkspaceId {
        &self.id
    }

    pub fn name(&self) -> &str {
        &self.name
    }
}

/// The row that now exists: the draft it was written from, plus the identity and the
/// moment the writing adapter supplied. Returned so the publication that follows has
/// nothing to look up.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedMentionRow {
    pub id: NotificationId,
    pub created_at_ms: i64,
    pub draft: MentionRowDraft,
}

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
    /// Mints the row's identity, encodes the draft and inserts it — and nothing
    /// else. Every semantic field arrives in the draft, so there is nothing here to
    /// re-derive and no content to parse a second time.
    fn record_mentioned_viewer(
        &self,
        draft: &MentionRowDraft,
    ) -> impl Future<Output = Result<CommittedMentionRow, EffectFailure>> + Send;
}

/// Tells the named person's client that the row above exists. It takes the committed
/// row, because "the row is there but nobody was told" is a state that has to be
/// expressible: a capability answering only "did both halves work" would lose it.
pub trait ViewerNotification {
    fn notify_viewer(
        &self,
        mention: &CommittedMentionRow,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// The message, published to the conversation it landed in.
pub trait MainPublication {
    fn publish_message(
        &self,
        message: &CreatedMessage,
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

/// The message is owed to one recipient. Per recipient, from the plan, so an
/// adapter has nobody to look up and no policy left to re-decide.
pub trait MainDelivery {
    fn deliver_to(
        &self,
        recipient: &AgentId,
        message: &CreatedMessage,
    ) -> impl Future<Output = Result<(), EffectFailure>> + Send;
}

/// A recipient that is not running is started afterwards. Delivery does not depend
/// on it: an idle runtime is started because nobody is there to receive, not in
/// order to receive.
pub trait IdleStart {
    /// Asked of one eligible recipient. Whether it is idle is decided HERE, at the
    /// moment of asking, because it is a volatile fact.
    fn start_if_idle(
        &self,
        recipient: &AgentId,
        conversation: &ConversationId,
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
/// It takes the view, not the fact, so there is no way to hand it a reply:
///
/// ```compile_fail
/// use silverhand_backend_core::messaging::{MessageCreatedFact, post_commit};
///
/// fn announce(fact: &MessageCreatedFact, ports: post_commit::MainEffects<'_, (), (), (), (), (), ()>) {
///     let reply = fact.reply_cluster().expect("a reply");
///     let _ = post_commit::announce_main_send(reply, ports);
/// }
/// ```
///
/// The order is load-bearing in one place and one place only: a named person's
/// durable mention row is written before unread state is published, because the
/// badge's directed count READS that row — publishing first sends a value that
/// predates the mention, and the client does not ask again. Everything else is
/// ordered for readability, and each attempt is isolated: per named viewer and per
/// recipient, so one person's failure does not cost another theirs.
pub async fn announce_main_send<P, R, V, U, D, S>(
    send: MainCommittedSend<'_>,
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
    let message = send.message();
    let delivery = send.delivery();
    let id = message.id.clone();
    let conversation = message.conversation_id.clone();

    attempt(
        &mut report,
        &id,
        EffectStep::MessagePublished,
        ports.publication.publish_message(message),
    )
    .await;

    for draft in send.mentions() {
        report
            .attempted
            .push((id.clone(), EffectStep::MentionedViewerRecorded));
        match ports.mentions.record_mentioned_viewer(draft).await {
            // The row exists whatever the publication does next, and one named
            // person's failure does not reach the next person's.
            Ok(row) => {
                attempt(
                    &mut report,
                    &id,
                    EffectStep::ViewerNotified,
                    ports.viewers.notify_viewer(&row),
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
    for recipient in delivery.recipients() {
        attempt(
            &mut report,
            &id,
            EffectStep::MainDelivered,
            ports.delivery.deliver_to(recipient, message),
        )
        .await;
    }
    // After delivery, and only for those the plan allows: a runtime is started
    // because nobody was there to receive, not in order to receive.
    for recipient in delivery.start_eligible() {
        attempt(
            &mut report,
            &id,
            EffectStep::IdleStarted,
            ports.idle.start_if_idle(recipient, &conversation),
        )
        .await;
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

    fn draft_for(viewer: &str) -> MentionRowDraft {
        MentionRowDraft::committed(
            UserId::parse(viewer).unwrap(),
            ParticipantHandle::parse("Viewer").unwrap(),
            "Sender".to_owned(),
            WorkspaceCoordinate::committed(WorkspaceId::parse("ws-1").unwrap(), "Space".to_owned()),
            ConversationId::parse("conv-1").unwrap(),
            "Channel".to_owned(),
            MessageId::parse("source-message").unwrap(),
            "ping".to_owned(),
        )
    }

    fn main_plan(viewers: &[&str], recipients: &[&str]) -> PostCommitPlan {
        let recipients: Vec<AgentId> = recipients
            .iter()
            .map(|id| AgentId::parse(*id).unwrap())
            .collect();
        PostCommitPlan::committed(
            viewers.iter().map(|viewer| draft_for(viewer)).collect(),
            DeliveryPlan::MainLine(MainDeliveryPlan::committed(recipients.clone(), recipients)),
        )
    }

    fn fact_with(outcomes: Vec<MentionCopyOutcome>, plan: PostCommitPlan) -> MessageCreatedFact {
        MessageCreatedFact::committed(created_message(), None, plan, false, outcomes)
    }

    fn created_message() -> CreatedMessage {
        CreatedMessage {
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
        }
    }

    fn fact(outcomes: Vec<MentionCopyOutcome>) -> MessageCreatedFact {
        MessageCreatedFact::committed(
            created_message(),
            None,
            PostCommitPlan::committed(
                Vec::new(),
                DeliveryPlan::MainLine(MainDeliveryPlan::committed(Vec::new(), Vec::new())),
            ),
            false,
            outcomes,
        )
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
        async fn publish_message(&self, message: &CreatedMessage) -> Result<(), EffectFailure> {
            self.answer(message.id.as_str(), EffectStep::MessagePublished)
        }
    }

    impl MentionedViewerRecord for Recorder {
        async fn record_mentioned_viewer(
            &self,
            draft: &MentionRowDraft,
        ) -> Result<CommittedMentionRow, EffectFailure> {
            self.answer(
                &format!(
                    "{}|{}",
                    draft.viewer().as_str(),
                    draft.source_message().as_str()
                ),
                EffectStep::MentionedViewerRecorded,
            )?;
            // What a store does: mint the identity, stamp the moment, and keep every
            // other field exactly as it was given.
            Ok(CommittedMentionRow {
                id: NotificationId::parse(format!("row-{}", draft.viewer().as_str())).unwrap(),
                created_at_ms: 11,
                draft: draft.clone(),
            })
        }
    }

    impl ViewerNotification for Recorder {
        async fn notify_viewer(&self, mention: &CommittedMentionRow) -> Result<(), EffectFailure> {
            self.answer(
                &format!(
                    "{}|{}",
                    mention.draft.viewer().as_str(),
                    mention.draft.source_message().as_str()
                ),
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
        async fn deliver_to(
            &self,
            recipient: &AgentId,
            message: &CreatedMessage,
        ) -> Result<(), EffectFailure> {
            self.answer(
                &format!("{}|{}", recipient.as_str(), message.id.as_str()),
                EffectStep::MainDelivered,
            )
        }
    }

    impl IdleStart for Recorder {
        async fn start_if_idle(
            &self,
            recipient: &AgentId,
            conversation: &ConversationId,
        ) -> Result<(), EffectFailure> {
            self.answer(
                &format!("{}|{}", recipient.as_str(), conversation.as_str()),
                EffectStep::IdleStarted,
            )
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

    /// The main line's own order, ending in delivery and THEN the conditional start
    /// of whoever was idle — delivery does not wait on a runtime, and a runtime is
    /// started because nobody was there to receive.
    #[tokio::test]
    async fn a_main_line_send_is_announced_in_its_own_order() {
        let recorder = Recorder::default();

        let committed = fact_with(Vec::new(), main_plan(&["viewer-1"], &["agent-1"]));

        let report = announce_main_send(
            committed.main_line().expect("a main-line send"),
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

            let committed = fact_with(Vec::new(), main_plan(&["viewer-1"], &["agent-1"]));
            let report = announce_main_send(
                committed.main_line().expect("a main-line send"),
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

        let committed = fact_with(Vec::new(), main_plan(&["viewer-1"], &["agent-1"]));

        let report = announce_main_send(
            committed.main_line().expect("a main-line send"),
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

        let committed = fact_with(
            Vec::new(),
            main_plan(&["viewer-1", "viewer-2"], &["agent-1"]),
        );

        announce_main_send(
            committed.main_line().expect("a main-line send"),
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

    /// The two paths answer different questions about the same conversation, so their
    /// plans are different values — and a reply cannot be handed to the main-line
    /// announcer, because the view it needs does not exist for one.
    #[test]
    fn a_reply_and_a_main_line_send_reach_different_recipients() {
        let participants = ["agent-1", "agent-2"];
        let main = fact_with(Vec::new(), main_plan(&[], &participants));
        let reply = MessageCreatedFact {
            thread: Some(crate::messaging::ThreadReplyFact {
                thread_root_id: crate::messaging::ThreadRootId::parse("root-1").unwrap(),
                reply_count: 1,
            }),
            post_commit: PostCommitPlan::committed(
                Vec::new(),
                // Only one participant follows the cluster.
                DeliveryPlan::ReplyCluster(ReplyAudience::committed(vec![
                    AgentId::parse("agent-2").unwrap(),
                ])),
            ),
            ..fact(Vec::new())
        };

        assert!(main.reply_cluster().is_none());
        assert!(
            reply.main_line().is_none(),
            "a reply offered a main-line view"
        );

        let main_recipients = main.main_line().unwrap().delivery().recipients().to_vec();
        let reply_audience = reply
            .reply_cluster()
            .unwrap()
            .audience()
            .recipients()
            .to_vec();
        assert_eq!(
            main_recipients,
            vec![
                AgentId::parse("agent-1").unwrap(),
                AgentId::parse("agent-2").unwrap()
            ]
        );
        assert_ne!(main_recipients, reply_audience);
    }

    /// The store mints the row's identity and changes nothing else: what the
    /// publication receives is the draft it was given, field for field.
    #[tokio::test]
    async fn a_recorded_row_carries_the_draft_it_was_given() {
        let recorder = Recorder::default();
        let committed = fact_with(Vec::new(), main_plan(&["viewer-1"], &[]));
        let draft = committed.main_line().unwrap().mentions()[0].clone();

        let row = recorder
            .record_mentioned_viewer(&draft)
            .await
            .expect("the record was accepted");

        assert_eq!(row.draft, draft);
        assert!(!row.id.as_str().is_empty());
    }
}
