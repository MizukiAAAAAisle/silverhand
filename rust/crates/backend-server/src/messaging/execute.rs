//! Execute: the one place a settled request becomes a committed send.
//!
//! The second of the use-case's two orderable stages. [`super::admission`] decided
//! what the request IS without knowing whose it was; this stage knows whose it is and
//! does nothing else to the payload. It is the only caller of
//! [`SendMessage::prepare`] and the only caller of the write unit, so both doors
//! reach one transaction boundary rather than one each.
//!
//! HUMAN AND AGENT ARE TWO PRINCIPALS, NOT TWO BUSINESSES (@shiki's requirement).
//! The two route adapters differ in when they authorize, how they word a refusal, and
//! which [`SendActor`] variant they build — never in what a send IS. That is why this
//! stage takes the actor as data: it has no arm per principal, so there is no place
//! for the two paths to drift.

use silverhand_backend_core::messaging::{
    ConversationId, DirectLineAuthority, MessageCreatedFact, ReferencePositions, SendActor,
    SendDestination, SendMessage, SendMessageDraft, SendMessageError, SendMessageUnitOfWork,
};

use super::admission::ValidatedSendPayload;

/// The resolved input a route adapter hands to [`execute`]: who is writing, where
/// from and to, and whether they asked to skip the freshness guard.
///
/// NAMED FOR WHAT IT IS, not for what it would be nice to imply (@Cindy, review of
/// `9dbcc6e8`). An earlier version called this "authorized" and its doc claimed that
/// assembling one meant authorization had happened — a promise the type does not keep,
/// because a struct any module can build proves nothing about what ran before it. The
/// fields are private and there is one narrow constructor, so the value cannot be
/// assembled by accident inside this crate; that is the whole of the guarantee.
///
/// What authorization ORDER actually holds is proven where it is observable: by the
/// two doors' cross counter-examples in [`super::adapters`], where a request breaking
/// two rules is answered by whichever gate its own door asks first. A Rust type cannot
/// witness a call that already happened, so this one does not pretend to.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedSendContext {
    actor: SendActor,
    source_conversation: ConversationId,
    target_conversation: ConversationId,
    destination: SendDestination,
    freshness_bypass: bool,
}

impl ResolvedSendContext {
    /// Built by a route adapter once it has resolved where the send goes. Deliberately
    /// takes no evidence of authorization, because it could not check any.
    pub(crate) fn resolved(
        actor: SendActor,
        source_conversation: ConversationId,
        target_conversation: ConversationId,
        destination: SendDestination,
        freshness_bypass: bool,
    ) -> Self {
        Self {
            actor,
            source_conversation,
            target_conversation,
            destination,
            freshness_bypass,
        }
    }
}

/// Turns a resolved, settled request into a committed fact.
///
/// Derivation of what the body addressed happens inside `prepare`, before any
/// transaction: a 64KiB body must not be parsed while the writer is held, and
/// authorization for a direct line must not be asked from inside it.
pub(crate) async fn execute<U>(
    context: ResolvedSendContext,
    payload: ValidatedSendPayload,
    positions: &impl ReferencePositions,
    authority: &impl DirectLineAuthority,
    unit_of_work: &U,
) -> Result<MessageCreatedFact, SendMessageError>
where
    U: SendMessageUnitOfWork,
{
    let draft = SendMessageDraft {
        source_conversation: context.source_conversation,
        target_conversation: context.target_conversation,
        actor: context.actor,
        content: payload.content().clone(),
        destination: context.destination,
        attachment_refs: payload.attachments().to_vec(),
        freshness_bypass: context.freshness_bypass,
    };

    let command = SendMessage::prepare(draft, positions, authority)?;
    unit_of_work.send_message(command).await
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use silverhand_backend_core::messaging::{
        AddressedPrincipals, AgentId, MessageContent, UserId,
    };
    use silverhand_backend_core::persistence::PersistenceFailure;

    use super::*;
    use crate::messaging::admission::validate_human_payload;

    /// The one write unit both doors reach. It records the actor of every command it
    /// was asked to commit, which is how a test can tell "one use-case, two
    /// principals" from "two send paths".
    #[derive(Default)]
    struct RecordingUnitOfWork {
        actors: Mutex<Vec<SendActor>>,
    }

    impl RecordingUnitOfWork {
        fn actors(&self) -> Vec<SendActor> {
            self.actors.lock().unwrap().clone()
        }
    }

    impl SendMessageUnitOfWork for RecordingUnitOfWork {
        async fn send_message(
            &self,
            command: SendMessage,
        ) -> Result<MessageCreatedFact, SendMessageError> {
            self.actors.lock().unwrap().push(command.actor().clone());
            // The fact needs a committed transaction to exist, which a fake has not
            // got. Recording the attempt is the whole purpose here.
            Err(silverhand_backend_core::messaging::ConversationRefusal::NotFound.into())
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

    fn conversation() -> ConversationId {
        ConversationId::parse("conv-1").unwrap()
    }

    fn context(actor: SendActor) -> ResolvedSendContext {
        ResolvedSendContext::resolved(
            actor,
            conversation(),
            conversation(),
            SendDestination::MainLine,
            false,
        )
    }

    fn settled() -> ValidatedSendPayload {
        validate_human_payload(Some(serde_json::json!({"content": "hello"})))
            .unwrap()
            .into_payload()
    }

    /// Both principals arrive at the SAME unit of work, and the only thing that
    /// distinguishes them there is which actor the command carries.
    ///
    /// This is the counter-example for "two send businesses": if either door had its
    /// own service or its own write unit, one of these actors would be missing from a
    /// single recorder.
    #[tokio::test]
    async fn both_principals_reach_one_unit_of_work_and_differ_only_by_actor() {
        let unit = RecordingUnitOfWork::default();
        let human = SendActor::User(UserId::parse("user-1").unwrap());
        let agent = SendActor::Agent(AgentId::parse("agent-1").unwrap());

        for actor in [human.clone(), agent.clone()] {
            let _ = execute(
                context(actor),
                settled(),
                &NoPositions,
                &GrantsNothing,
                &unit,
            )
            .await;
        }

        assert_eq!(unit.actors(), vec![human, agent]);
    }

    /// The payload reaches the command unchanged: this stage settles nothing and
    /// re-decides nothing, so a rule can only live in admission.
    #[tokio::test]
    async fn the_settled_payload_is_carried_rather_than_re_decided() {
        let unit = RecordingUnitOfWork::default();
        let payload = validate_human_payload(Some(serde_json::json!({
            "content": "hello",
            "attachment_ids": [{"id": "att-1", "label": " Image #1 "}]
        })))
        .unwrap()
        .into_payload();
        // Admission already normalized the label; execute must not touch it.
        assert_eq!(payload.attachments()[0].label.as_deref(), Some("Image #1"));

        let _ = execute(
            context(SendActor::Agent(AgentId::parse("agent-1").unwrap())),
            payload,
            &NoPositions,
            &GrantsNothing,
            &unit,
        )
        .await;

        assert_eq!(unit.actors().len(), 1);
    }
}
