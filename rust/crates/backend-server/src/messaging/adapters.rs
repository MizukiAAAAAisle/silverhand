//! The two route adapters: same rules, different order.
//!
//! Each one is thin on purpose. An adapter decides only three things — WHEN it
//! authorizes relative to reading the body, how it words its own refusals, and which
//! [`SendActor`] variant it builds. Every rule about what a send IS lives in
//! [`super::admission`]; committing one lives in [`super::execute`]. Neither is
//! duplicated here, and neither can be, because an adapter has no rule of its own to
//! keep in sync.
//!
//! THE ORDERS ARE DIFFERENT AND BOTH ARE CONTRACTS. The human door completes
//! authorization before it has looked at a body: a channel that does not exist, or
//! one this person may not post to, is answered without regard to what they sent. The
//! agent door validates first and only then resolves a target and its capability. The
//! difference is observable — a request that breaks two rules is answered by whichever
//! gate its own door asks first — which is why the cross cases below are the real
//! test rather than the happy paths.

use silverhand_backend_core::messaging::{
    AgentId, ConversationId, DirectLineAuthority, MessageCreatedFact, ReferencePositions,
    SendActor, SendDestination, SendMessageError, SendMessageUnitOfWork, ThreadRootId, UserId,
};

use super::{
    admission::{PayloadRefusal, validate_agent_payload, validate_human_payload},
    execute::{ResolvedSendContext, execute},
};

/// The machinery a send needs whichever door it came through: where a body may
/// address from, who may open a direct line, and the write unit itself.
///
/// Bundled because both doors need exactly these three and need them identically —
/// eight loose parameters was the lint's way of saying the same thing. Naming the set
/// once also makes "one use-case" visible at the call site: the doors differ in their
/// gates, never in the machinery.
pub(crate) struct SendPorts<'ports, P, A, U> {
    pub positions: &'ports P,
    pub authority: &'ports A,
    pub unit_of_work: &'ports U,
}

/// Why the human door refused before it read anything. Its own vocabulary: a channel
/// is "not found" and a person is "forbidden", which is what that door answers with.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelAccessRefusal {
    NotFound,
    Forbidden,
}

/// Whether this person may post to THIS channel — a predicate, and deliberately nothing
/// more.
///
/// It answers ABOUT a coordinate it is given and cannot answer WITH one. An earlier
/// version returned a `ConversationId` that the door then used as both source and target:
/// nothing in that signature required the answer to be the channel it was asked about, so
/// an implementation slip or a later adapter drift could authorize against one
/// conversation and write the message into another (@Cindy, review of `7b9297f0`). A doc
/// saying "return it unchanged" is no fix — it is a restatement of the hole. The human
/// door's send coordinate is the path's, full stop.
///
/// [`TargetAccess`] is deliberately different: an absolute address is not a coordinate
/// yet when it arrives, so resolving one IS that port's job.
pub trait ChannelAccess {
    fn may_post(
        &self,
        channel: &ConversationId,
        author: &UserId,
    ) -> Result<(), ChannelAccessRefusal>;
}

/// Why the agent door refused an address, asked only once a payload is settled.
///
/// SIX ANSWERS, because the reference has six and a client keys on which one it got. Two
/// arms — "unresolvable" and "forbidden" — collapsed four distinct facts a caller acts on
/// differently: a token that is not an address is fixed by rewriting it, a stream the
/// credential cannot reach through this door is not fixed by rewriting anything, and a
/// missing capability is fixed by a human on a roster.
///
/// THREE STATUS FAMILIES, and the split is deliberate. 400 for the two that are judgements
/// about the TOKEN, which say nothing about what exists. 404 for the two that are about
/// existence — and that is exactly where unknown and unauthorized COLLAPSE, because a
/// separate 403 would let one address get a different number from another and turn this door
/// into an existence oracle. 403 only where the address was right and the CREDENTIAL is the
/// limit, which is a fact the caller cannot fix by trying another address.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TargetRefusal {
    /// The string is not an address.
    Malformed,
    /// A direct message addressed at its own author: an inbox is not a write destination.
    SelfPair,
    /// Names no stream this caller can use. Unknown and unauthorized are ONE answer here.
    Unresolved,
    /// Names a reply cluster that is not of that conversation.
    ThreadNotInTarget,
    /// The stream is the caller's, and this door acts only where the session is anchored.
    OutOfSessionScope,
    /// The credential lacks the capability this door asks for.
    CapabilityDenied,
}

/// Where an address landed. A stream, not a conversation: an absolute address may name
/// a reply cluster, and dropping that half would deliver every addressed reply onto the
/// main line instead.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedStream {
    pub conversation: ConversationId,
    pub thread_root: Option<ThreadRootId>,
}

/// Where an agent's send lands and whether it may, asked AFTER admission.
pub trait TargetAccess {
    fn resolve(&self, agent: &AgentId, target: &str) -> Result<ResolvedStream, TargetRefusal>;
}

/// Why the HUMAN door refused. Its own type rather than a shared one: a refusal a door
/// cannot produce has no business being representable in its answer, and a shared enum
/// would put an unanswerable arm in each door's wire mapping — a branch no test can
/// reach and every reader has to reason about.
///
/// Not `Clone`: a send failure carries a source chain, and duplicating one would invite
/// a second report of a single failure.
#[derive(Debug)]
pub(crate) enum HumanRefusal {
    Access(ChannelAccessRefusal),
    Payload(PayloadRefusal),
    Send(SendMessageError),
}

/// Why the AGENT door refused. The mirror of [`HumanRefusal`], and deliberately not the
/// same type: the two doors share every RULE and no refusal vocabulary.
#[derive(Debug)]
pub(crate) enum AgentRefusal {
    Payload(PayloadRefusal),
    Target(TargetRefusal),
    Send(SendMessageError),
}

/// The HUMAN door: authorize, then admit, then commit.
///
/// Authorization first is not an optimization — it is what keeps a person who may not
/// post to a channel from learning anything about how their body was judged.
pub(crate) async fn human_send<A, P, D, U>(
    channel: &ConversationId,
    author: &UserId,
    raw_body: Option<serde_json::Value>,
    access: &A,
    ports: SendPorts<'_, P, D, U>,
) -> Result<MessageCreatedFact, HumanRefusal>
where
    A: ChannelAccess,
    P: ReferencePositions,
    D: DirectLineAuthority,
    U: SendMessageUnitOfWork,
{
    access
        .may_post(channel, author)
        .map_err(HumanRefusal::Access)?;

    let request = validate_human_payload(raw_body).map_err(HumanRefusal::Payload)?;

    // A person posts where the person is LOOKING, so this door can only express a
    // placement inside the conversation it authorized against — never a foreign stream.
    let destination = match request.reply_to() {
        Some(message) => SendDestination::Reply(message.clone()),
        None => SendDestination::MainLine,
    };

    execute(
        ResolvedSendContext::resolved(
            SendActor::User(author.clone()),
            // BOTH coordinates are the path's channel, named here rather than taken from
            // the gate's answer. The gate has none to give.
            channel.clone(),
            channel.clone(),
            destination,
            // A human has no runtime, so there is nothing to be behind and no bypass
            // to ask for. The flag is `false` because the guard does not apply, not
            // because this door declined to offer it.
            false,
        ),
        request.into_payload(),
        ports.positions,
        ports.authority,
        ports.unit_of_work,
    )
    .await
    .map_err(HumanRefusal::Send)
}

/// The AGENT door: admit, then resolve a target and its capability, then commit.
///
/// Validating first is this door's contract: a runtime is told that its payload is
/// malformed before anything about where it aimed, because that is the error it can
/// correct without another round trip.
///
/// The `source` is the conversation the CREDENTIAL lives in and the target is wherever
/// the body's address resolved to. They are two coordinates on purpose: the source keys
/// the runtime's own field of view, so asking the capability of it would grant a send
/// into any stream to anyone who could post in their own.
pub(crate) async fn agent_send<A, P, D, U>(
    agent: &AgentId,
    source: &ConversationId,
    raw_body: Option<serde_json::Value>,
    access: &A,
    ports: SendPorts<'_, P, D, U>,
) -> Result<MessageCreatedFact, AgentRefusal>
where
    A: TargetAccess,
    P: ReferencePositions,
    D: DirectLineAuthority,
    U: SendMessageUnitOfWork,
{
    let request = validate_agent_payload(raw_body).map_err(AgentRefusal::Payload)?;

    let stream = access
        .resolve(agent, request.target())
        .map_err(AgentRefusal::Target)?;

    let destination = match stream.thread_root {
        Some(root) => SendDestination::Thread(root),
        None => SendDestination::MainLine,
    };
    let freshness_bypass = request.freshness_bypass();

    execute(
        ResolvedSendContext::resolved(
            SendActor::Agent(agent.clone()),
            source.clone(),
            stream.conversation,
            destination,
            freshness_bypass,
        ),
        request.into_payload(),
        ports.positions,
        ports.authority,
        ports.unit_of_work,
    )
    .await
    .map_err(AgentRefusal::Send)
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use silverhand_backend_core::messaging::{
        AddressedPrincipals, ConversationRefusal, MessageContent, MessageId, SendMessage,
    };
    use silverhand_backend_core::persistence::PersistenceFailure;

    use super::*;
    use crate::messaging::admission::{IssuePathSegment, ShapeIssue};

    /// What one command asked for, in the terms these two doors can differ in.
    #[derive(Clone, Debug, Eq, PartialEq)]
    struct Recorded {
        actor: SendActor,
        source: ConversationId,
        target: ConversationId,
        destination: SendDestination,
        freshness_bypass: bool,
    }

    /// Counts and records every command it was asked to commit. A refusal that reaches
    /// it is a refusal that happened too late; a command that reaches it can be read
    /// back field by field.
    #[derive(Default)]
    struct CountingUnitOfWork {
        calls: AtomicUsize,
        commands: Mutex<Vec<Recorded>>,
    }

    impl CountingUnitOfWork {
        fn commands(&self) -> Vec<Recorded> {
            self.commands.lock().unwrap().clone()
        }

        fn actors(&self) -> Vec<SendActor> {
            self.commands()
                .into_iter()
                .map(|command| command.actor)
                .collect()
        }

        fn destinations(&self) -> Vec<SendDestination> {
            self.commands()
                .into_iter()
                .map(|command| command.destination)
                .collect()
        }
    }

    impl SendMessageUnitOfWork for CountingUnitOfWork {
        async fn send_message(
            &self,
            command: SendMessage,
        ) -> Result<MessageCreatedFact, SendMessageError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.commands.lock().unwrap().push(Recorded {
                actor: command.actor().clone(),
                source: command.source_conversation().clone(),
                target: command.target_conversation().clone(),
                destination: command.destination().clone(),
                freshness_bypass: command.freshness_bypass(),
            });
            Err(ConversationRefusal::NotFound.into())
        }
    }

    struct NoPositions;

    impl ReferencePositions for NoPositions {
        fn autolink_spans(&self, _content: &MessageContent) -> Vec<std::ops::Range<usize>> {
            Vec::new()
        }
    }

    struct GrantsNothing;

    impl DirectLineAuthority for GrantsNothing {
        fn direct_lines(
            &self,
            _author: &UserId,
            _addressed: &AddressedPrincipals,
        ) -> Result<Vec<AgentId>, PersistenceFailure> {
            Ok(Vec::new())
        }
    }

    /// The gate, and ONLY the gate. It is handed `elsewhere()` so it would answer with a
    /// foreign conversation if the port let it — and the port does not, which is what
    /// `the_human_gate_cannot_move_the_send_it_authorized` reads back.
    struct Channel(Result<(), ChannelAccessRefusal>);

    impl ChannelAccess for Channel {
        fn may_post(
            &self,
            _channel: &ConversationId,
            _author: &UserId,
        ) -> Result<(), ChannelAccessRefusal> {
            let _would_rather_answer_with = elsewhere();
            self.0.clone()
        }
    }

    /// A resolver that answers with a fixed stream, so a test can say what an address
    /// resolved TO without restating the grammar that reads one.
    struct Target(Result<ResolvedStream, TargetRefusal>);

    impl Target {
        fn main_line() -> Self {
            Self(Ok(ResolvedStream {
                conversation: elsewhere(),
                thread_root: None,
            }))
        }

        fn cluster() -> Self {
            Self(Ok(ResolvedStream {
                conversation: elsewhere(),
                thread_root: Some(ThreadRootId::parse("root-1").unwrap()),
            }))
        }

        fn refuses(refusal: TargetRefusal) -> Self {
            Self(Err(refusal))
        }
    }

    impl TargetAccess for Target {
        fn resolve(
            &self,
            _agent: &AgentId,
            _target: &str,
        ) -> Result<ResolvedStream, TargetRefusal> {
            self.0.clone()
        }
    }

    fn ports<'a>(
        unit: &'a CountingUnitOfWork,
    ) -> SendPorts<'a, NoPositions, GrantsNothing, CountingUnitOfWork> {
        SendPorts {
            positions: &NoPositions,
            authority: &GrantsNothing,
            unit_of_work: unit,
        }
    }

    fn conversation() -> ConversationId {
        ConversationId::parse("conv-1").unwrap()
    }

    /// A stream that is NOT the one the credential lives in — the whole point of an
    /// absolute address.
    fn elsewhere() -> ConversationId {
        ConversationId::parse("conv-2").unwrap()
    }

    fn user() -> UserId {
        UserId::parse("user-1").unwrap()
    }

    fn agent() -> AgentId {
        AgentId::parse("agent-1").unwrap()
    }

    fn malformed() -> Option<serde_json::Value> {
        Some(serde_json::json!({"content": 7}))
    }

    fn human_body() -> Option<serde_json::Value> {
        Some(serde_json::json!({"content": "hello"}))
    }

    fn agent_body() -> Option<serde_json::Value> {
        Some(serde_json::json!({"content": "hello", "target": "#conv:conv-2"}))
    }

    fn payload_issues(refusal: AgentRefusal) -> Vec<ShapeIssue> {
        match refusal {
            AgentRefusal::Payload(PayloadRefusal::Shape(issues)) => issues,
            other => panic!("expected a shape refusal, got {other:?}"),
        }
    }

    /// THE HUMAN CROSS. The body is malformed AND the caller may not post. If the
    /// orders were the same, this would answer the payload refusal; the human door
    /// answers access, and the write unit is never reached.
    #[tokio::test]
    async fn the_human_door_answers_access_before_it_judges_a_body() {
        let unit = CountingUnitOfWork::default();

        for refusal in [
            ChannelAccessRefusal::NotFound,
            ChannelAccessRefusal::Forbidden,
        ] {
            let outcome = human_send(
                &conversation(),
                &user(),
                malformed(),
                &Channel(Err(refusal.clone())),
                ports(&unit),
            )
            .await;

            assert!(
                matches!(outcome, Err(HumanRefusal::Access(answered)) if answered == refusal),
                "the human door judged the body before deciding access"
            );
        }
        assert_eq!(unit.calls.load(Ordering::SeqCst), 0);
    }

    /// THE AGENT CROSS, and it is the mirror image. The body is malformed AND the
    /// target is unusable. The agent door answers the payload, because it validates
    /// first — so the very same pair of faults gets a different answer at each door.
    #[tokio::test]
    async fn the_agent_door_judges_a_body_before_it_resolves_a_target() {
        let unit = CountingUnitOfWork::default();

        for refusal in [TargetRefusal::Malformed, TargetRefusal::CapabilityDenied] {
            let outcome = agent_send(
                &agent(),
                &conversation(),
                malformed(),
                &Target::refuses(refusal),
                ports(&unit),
            )
            .await;

            assert!(
                matches!(outcome, Err(AgentRefusal::Payload(_))),
                "the agent door resolved a target before judging the body"
            );
        }
        assert_eq!(unit.calls.load(Ordering::SeqCst), 0);
    }

    /// Every refusal, from either gate of either door, stops before the write unit.
    #[tokio::test]
    async fn no_refusal_reaches_the_write_unit() {
        let unit = CountingUnitOfWork::default();

        let _ = human_send(
            &conversation(),
            &user(),
            human_body(),
            &Channel(Err(ChannelAccessRefusal::NotFound)),
            ports(&unit),
        )
        .await;
        let _ = human_send(
            &conversation(),
            &user(),
            malformed(),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;
        let _ = agent_send(
            &agent(),
            &conversation(),
            malformed(),
            &Target::main_line(),
            ports(&unit),
        )
        .await;
        let _ = agent_send(
            &agent(),
            &conversation(),
            agent_body(),
            &Target::refuses(TargetRefusal::CapabilityDenied),
            ports(&unit),
        )
        .await;

        assert_eq!(unit.calls.load(Ordering::SeqCst), 0);
    }

    /// Both doors, once past their own gates, reach ONE write unit and are told apart
    /// there only by which principal is sending.
    #[tokio::test]
    async fn both_doors_converge_on_one_write_unit() {
        let unit = CountingUnitOfWork::default();

        let _ = human_send(
            &conversation(),
            &user(),
            human_body(),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;
        let _ = agent_send(
            &agent(),
            &conversation(),
            agent_body(),
            &Target::main_line(),
            ports(&unit),
        )
        .await;

        assert_eq!(unit.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            unit.actors(),
            vec![SendActor::User(user()), SendActor::Agent(agent())]
        );
    }

    /// A SEND WITHOUT AN ADDRESS IS NOT A SEND, and the address is a body field.
    ///
    /// The counter-example for taking it from any coordinate that happens to be at
    /// hand: a door that substituted its own path parameter, or the conversation the
    /// credential lives in, would accept all three of these bodies and deliver them
    /// somewhere the caller never named.
    #[tokio::test]
    async fn the_agent_door_refuses_a_body_that_names_no_target() {
        let unit = CountingUnitOfWork::default();

        for (body, code) in [
            (serde_json::json!({"content": "hello"}), "invalid_type"),
            (
                serde_json::json!({"content": "hello", "target": null}),
                "invalid_type",
            ),
            (
                serde_json::json!({"content": "hello", "target": ""}),
                "too_small",
            ),
        ] {
            let outcome = agent_send(
                &agent(),
                &conversation(),
                Some(body.clone()),
                &Target::main_line(),
                ports(&unit),
            )
            .await;

            let issues = payload_issues(outcome.expect_err("a send with no address was accepted"));
            assert_eq!(issues.len(), 1, "{body}");
            assert_eq!(issues[0].code, code, "{body}");
            assert_eq!(
                issues[0].path,
                vec![IssuePathSegment::Field("target")],
                "{body}"
            );
        }
        assert_eq!(unit.calls.load(Ordering::SeqCst), 0);
    }

    /// EACH DOOR CARRIES THE DESTINATION ITS OWN BODY NAMED, and the two are different
    /// coordinates: the human door names a message to reply to inside the conversation
    /// it authorized against, the agent door's cluster comes from the address it
    /// resolved. A door that hard-coded the main line would record four main lines
    /// here.
    #[tokio::test]
    async fn each_door_carries_the_destination_its_own_body_named() {
        let unit = CountingUnitOfWork::default();

        let _ = human_send(
            &conversation(),
            &user(),
            human_body(),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;
        let _ = human_send(
            &conversation(),
            &user(),
            Some(serde_json::json!({"content": "hello", "reply_to_message_id": "msg-9"})),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;
        let _ = agent_send(
            &agent(),
            &conversation(),
            agent_body(),
            &Target::main_line(),
            ports(&unit),
        )
        .await;
        let _ = agent_send(
            &agent(),
            &conversation(),
            agent_body(),
            &Target::cluster(),
            ports(&unit),
        )
        .await;

        assert_eq!(
            unit.destinations(),
            vec![
                SendDestination::MainLine,
                SendDestination::Reply(MessageId::parse("msg-9").unwrap()),
                SendDestination::MainLine,
                SendDestination::Thread(ThreadRootId::parse("root-1").unwrap()),
            ]
        );
    }

    /// THE HUMAN GATE CANNOT MOVE THE SEND IT AUTHORIZED.
    ///
    /// The gate is asked about the path's channel and answers yes or no. It holds a second,
    /// foreign conversation and has no way to hand it back — the port's answer carries no
    /// coordinate at all — so "authorize against A, write into B" is not a mistake this
    /// door can make. Both of the command's coordinates are the channel the caller named.
    #[tokio::test]
    async fn the_human_gate_cannot_move_the_send_it_authorized() {
        let unit = CountingUnitOfWork::default();

        let _ = human_send(
            &conversation(),
            &user(),
            human_body(),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;

        let commands = unit.commands();
        assert_eq!(commands[0].source, conversation());
        assert_eq!(commands[0].target, conversation());
        assert_ne!(commands[0].target, elsewhere());
    }

    /// THE TWO COORDINATES STAY APART. An agent's credential lives in one conversation
    /// and its words land in whichever the address resolved to; collapsing them would
    /// make every send local. A human's are the same conversation, because that door
    /// cannot address a foreign stream at all.
    #[tokio::test]
    async fn an_agent_send_keeps_its_source_and_its_target_apart() {
        let unit = CountingUnitOfWork::default();

        let _ = agent_send(
            &agent(),
            &conversation(),
            agent_body(),
            &Target::main_line(),
            ports(&unit),
        )
        .await;
        let _ = human_send(
            &conversation(),
            &user(),
            human_body(),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;

        let commands = unit.commands();
        assert_eq!(commands[0].source, conversation());
        assert_eq!(commands[0].target, elsewhere());
        assert_eq!(commands[1].source, conversation());
        assert_eq!(commands[1].target, conversation());
    }

    /// ONLY A RUNTIME CAN ASK TO SKIP THE FRESHNESS GUARD, and only by saying so.
    ///
    /// The human door has no such field, so the same member in a human body is an
    /// unknown one — stripped, exactly as the reference's schemas strip unknown members
    /// rather than refusing them. Reading it there would hand a person an escape hatch
    /// from a guard that never applied to them.
    #[tokio::test]
    async fn only_a_runtime_can_ask_to_skip_the_freshness_guard() {
        let unit = CountingUnitOfWork::default();

        let _ = agent_send(
            &agent(),
            &conversation(),
            Some(serde_json::json!({
                "content": "hello",
                "target": "#conv:conv-2",
                "freshness_bypass": true
            })),
            &Target::main_line(),
            ports(&unit),
        )
        .await;
        let _ = agent_send(
            &agent(),
            &conversation(),
            agent_body(),
            &Target::main_line(),
            ports(&unit),
        )
        .await;
        let _ = human_send(
            &conversation(),
            &user(),
            Some(serde_json::json!({"content": "hello", "freshness_bypass": true})),
            &Channel(Ok(())),
            ports(&unit),
        )
        .await;

        assert_eq!(
            unit.commands()
                .into_iter()
                .map(|command| command.freshness_bypass)
                .collect::<Vec<_>>(),
            vec![true, false, false]
        );
    }
}
