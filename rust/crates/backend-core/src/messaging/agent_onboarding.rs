//! The greeting a newly activated agent is met with in the line provisioning opens
//! for it.
//!
//! An onboarding message is a durable system message: it lands in
//! `messages.content`, and it is read again by cold reads, by replay, and by the
//! agent runtime's own input. Its body is therefore a product projection, not a
//! rendering choice — the recipient and creator are NAMED through the one canonical
//! reference form, never spelled, so a handle cannot fabricate a destination or a
//! line of its own.
//!
//! Everything here is a pure function of facts provisioning read inside its unit of
//! work. How the intent is encoded for storage belongs to whatever writes the row;
//! what this module guarantees is that the row's SHAPE — a system message carrying
//! only the onboarding subtype — is not a caller's choice.

use super::{
    ConversationId, MessageId, ParticipantHandle, PrincipalKind, addressing::format_reference_token,
};

/// The `from_kind` every onboarding message carries. The one spelling, so the seal that
/// binds the write's after-image never compares against an adapter literal.
const ONBOARDING_FROM_KIND: &str = "system";

/// The subtype a stored onboarding message carries, so a reader can recognise one
/// without parsing its prose. The sole spelling of the discriminator, mirroring the
/// system-message subtype registry the other implementation writes.
pub const ONBOARDING_SUBTYPE: &str = "onboarding";

/// Provisioning's typed intent for the onboarding system message.
///
/// It exists so the write cluster that consumes it is not a generic message insert:
/// the caller supplies WHERE the message lands, its rendered body, its minted id and
/// the moment it was written — and nothing else. The kind is always system and the
/// metadata always carries only [`ONBOARDING_SUBTYPE`]; neither is expressible as a
/// caller choice, so a mislabelled or mis-authored message cannot be smuggled
/// through the persistence primitive.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OnboardingSystemMessage {
    conversation: ConversationId,
    id: MessageId,
    content: String,
    created_at_ms: i64,
}

impl OnboardingSystemMessage {
    /// Build the intent to greet an agent on the direct line provisioning just opened
    /// between it and its creator.
    ///
    /// The body is rendered HERE, from the two typed handles, through the one canonical
    /// renderer — there is no path that lets a caller supply arbitrary prose under the
    /// onboarding shape. What the caller controls is only WHERE the message lands (the
    /// line's conversation), the id it minted, and the write timestamp.
    pub fn agent_direct_line(
        conversation: ConversationId,
        id: MessageId,
        agent_handle: &ParticipantHandle,
        creator_handle: &ParticipantHandle,
        created_at_ms: i64,
    ) -> Self {
        Self {
            conversation,
            id,
            content: render_direct_line_body(agent_handle, creator_handle),
            created_at_ms,
        }
    }

    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn id(&self) -> &MessageId {
        &self.id
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn created_at_ms(&self) -> i64 {
        self.created_at_ms
    }

    /// The metadata discriminator this message carries. Fixed, so the persistence
    /// primitive stamps the subtype from the intent rather than from a parameter.
    pub fn subtype(&self) -> &'static str {
        ONBOARDING_SUBTYPE
    }

    /// Bind the row the persistence primitive read back after writing this intent, and
    /// mint the sealed fact that the message provisioning meant to land actually did —
    /// on the line it named, under the system/onboarding shape, at the head of the
    /// stream.
    ///
    /// The write adapter WITNESSES: it returns the after-image it read from the row it
    /// just inserted and the stream head it just bumped. It does not get to assert the
    /// message landed correctly — this seal re-derives that from the raw columns, so a
    /// mislabelled, misplaced, or non-head insert cannot pass for a completed onboarding
    /// message. Only this function mints [`OnboardingWritten`].
    pub fn seal_written(
        &self,
        witness: OnboardingWriteWitness,
    ) -> Result<OnboardingWritten, OnboardingWriteMismatch> {
        if witness.id != self.id.as_str() {
            return Err(OnboardingWriteMismatch {
                reason: "written id differs from the minted id",
            });
        }
        if witness.conversation != self.conversation.as_str() {
            return Err(OnboardingWriteMismatch {
                reason: "written conversation differs from the greeted line",
            });
        }
        if witness.from_kind != ONBOARDING_FROM_KIND {
            return Err(OnboardingWriteMismatch {
                reason: "written message is not a system message",
            });
        }
        if witness.subtype.as_deref() != Some(ONBOARDING_SUBTYPE) {
            return Err(OnboardingWriteMismatch {
                reason: "written metadata does not carry the onboarding subtype",
            });
        }
        if witness.seq < 1 {
            return Err(OnboardingWriteMismatch {
                reason: "written sequence is not positive",
            });
        }
        if witness.head_latest_seq != witness.seq {
            return Err(OnboardingWriteMismatch {
                reason: "written message is not at the head of its stream",
            });
        }
        Ok(OnboardingWritten {
            conversation: self.conversation.clone(),
            id: self.id.clone(),
        })
    }
}

/// The raw after-image the write adapter read back for an onboarding message: the row it
/// inserted and the stream head it bumped, verbatim. The `subtype` is the value the adapter
/// decoded from the stored metadata — the metadata's JSON encoding is a storage concern the
/// adapter owns, so the domain reads the decoded discriminator, not the blob. It carries no
/// verdict — only [`OnboardingSystemMessage::seal_written`] turns it into a fact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OnboardingWriteWitness {
    pub id: String,
    pub conversation: String,
    pub from_kind: String,
    pub subtype: Option<String>,
    pub seq: i64,
    pub head_latest_seq: i64,
}

/// The sealed fact that an onboarding message provisioning intended actually landed on
/// the line it named. Minted only by [`OnboardingSystemMessage::seal_written`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OnboardingWritten {
    conversation: ConversationId,
    id: MessageId,
}

impl OnboardingWritten {
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }

    pub fn id(&self) -> &MessageId {
        &self.id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("onboarding write after-image does not match the sealed intent: {reason}")]
pub struct OnboardingWriteMismatch {
    reason: &'static str,
}

impl OnboardingWriteMismatch {
    /// The static label describing which after-image check failed, for a caller that folds
    /// this into its own boundary-logged fault.
    pub fn reason(&self) -> &'static str {
        self.reason
    }
}

/// The body an agent-scoped agent is greeted with on the direct line between it and
/// the person who created it.
///
/// The agent and the creator are named through the canonical reference form so the
/// runtime reading its own onboarding sees the same destinations any reader would;
/// `system_prompt.md` is code-spanned so a Markdown reader renders the file name as
/// literal text rather than prose.
fn render_direct_line_body(
    agent_name: &ParticipantHandle,
    creator_handle: &ParticipantHandle,
) -> String {
    let agent = format_reference_token(PrincipalKind::Agent, agent_name);
    let creator = format_reference_token(PrincipalKind::Human, creator_handle);
    let system_prompt = super::markdown::inline_code("system_prompt.md");

    format!(
        "You ({agent}) have just been created as an agent-scoped agent: one session of you serves \
         every conversation you are in, and this stream is your direct line with the person who \
         created you ({creator}) — they are the only other participant here.\nSend one short \
         greeting in THIS conversation: say hi by name, state your current global role briefly (or \
         say it is not defined yet), and ask what role they would like you to play.\nWrite global \
         identity / role / working-style guidance to your L1 {system_prompt} once they answer; it \
         applies in every conversation and takes effect on your next spawn. Do not mention internal \
         file paths to the user unless they ask."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handle(raw: &str) -> ParticipantHandle {
        ParticipantHandle::parse(raw).unwrap()
    }

    #[test]
    fn the_direct_line_body_names_both_parties_with_the_canonical_form() {
        let body = render_direct_line_body(&handle("Alice"), &handle("shiki"));

        assert_eq!(
            body,
            "You (<silverhand://agent/Alice>) have just been created as an agent-scoped agent: one \
             session of you serves every conversation you are in, and this stream is your direct \
             line with the person who created you (<silverhand://human/shiki>) — they are the only \
             other participant here.\nSend one short greeting in THIS conversation: say hi by name, \
             state your current global role briefly (or say it is not defined yet), and ask what \
             role they would like you to play.\nWrite global identity / role / working-style \
             guidance to your L1 `system_prompt.md` once they answer; it applies in every \
             conversation and takes effect on your next spawn. Do not mention internal file paths \
             to the user unless they ask."
        );
    }

    #[test]
    fn the_body_is_three_logical_lines() {
        let body = render_direct_line_body(&handle("Alice"), &handle("shiki"));
        assert_eq!(body.lines().count(), 3);
    }

    #[test]
    fn the_intent_renders_the_body_and_pins_the_onboarding_subtype() {
        let intent = OnboardingSystemMessage::agent_direct_line(
            ConversationId::parse("pair-1").unwrap(),
            MessageId::parse("msg-1").unwrap(),
            &handle("Alice"),
            &handle("shiki"),
            42,
        );
        assert_eq!(intent.subtype(), "onboarding");
        assert_eq!(intent.conversation().as_str(), "pair-1");
        assert_eq!(intent.id().as_str(), "msg-1");
        assert_eq!(
            intent.content(),
            render_direct_line_body(&handle("Alice"), &handle("shiki"))
        );
        assert_eq!(intent.created_at_ms(), 42);
    }

    fn intent() -> OnboardingSystemMessage {
        OnboardingSystemMessage::agent_direct_line(
            ConversationId::parse("pair-1").unwrap(),
            MessageId::parse("msg-1").unwrap(),
            &handle("Alice"),
            &handle("shiki"),
            42,
        )
    }

    fn faithful_witness() -> OnboardingWriteWitness {
        OnboardingWriteWitness {
            id: "msg-1".to_owned(),
            conversation: "pair-1".to_owned(),
            from_kind: "system".to_owned(),
            subtype: Some("onboarding".to_owned()),
            seq: 1,
            head_latest_seq: 1,
        }
    }

    #[test]
    fn a_faithful_after_image_seals_the_written_fact() {
        let written = intent().seal_written(faithful_witness()).unwrap();
        assert_eq!(written.conversation().as_str(), "pair-1");
        assert_eq!(written.id().as_str(), "msg-1");
    }

    #[test]
    fn a_mismatched_id_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.id = "msg-2".to_owned();
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn a_foreign_conversation_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.conversation = "pair-2".to_owned();
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn a_non_system_from_kind_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.from_kind = "agent".to_owned();
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn a_subtype_other_than_onboarding_refuses_to_seal() {
        for subtype in [None, Some(String::new()), Some("reply".to_owned())] {
            let mut witness = faithful_witness();
            witness.subtype = subtype;
            assert!(intent().seal_written(witness).is_err());
        }
    }

    #[test]
    fn a_message_below_the_stream_head_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.seq = 3;
        witness.head_latest_seq = 5;
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn a_non_positive_sequence_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.seq = 0;
        witness.head_latest_seq = 0;
        assert!(intent().seal_written(witness).is_err());
    }
}
