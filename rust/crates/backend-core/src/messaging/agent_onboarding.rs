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
    /// Build the intent from facts the provisioning unit of work already holds: the
    /// line to greet on, the id it minted for the message, the rendered body, and the
    /// write timestamp.
    pub fn new(
        conversation: ConversationId,
        id: MessageId,
        content: String,
        created_at_ms: i64,
    ) -> Self {
        Self {
            conversation,
            id,
            content,
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
}

/// The body an agent-scoped agent is greeted with on the direct line between it and
/// the person who created it.
///
/// The agent and the creator are named through the canonical reference form so the
/// runtime reading its own onboarding sees the same destinations any reader would;
/// `system_prompt.md` is code-spanned so a Markdown reader renders the file name as
/// literal text rather than prose.
pub fn render_direct_line_body(
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
    fn the_intent_pins_the_onboarding_subtype() {
        let intent = OnboardingSystemMessage::new(
            ConversationId::parse("pair-1").unwrap(),
            MessageId::parse("msg-1").unwrap(),
            "hi".to_owned(),
            42,
        );
        assert_eq!(intent.subtype(), "onboarding");
        assert_eq!(intent.conversation().as_str(), "pair-1");
        assert_eq!(intent.id().as_str(), "msg-1");
        assert_eq!(intent.content(), "hi");
        assert_eq!(intent.created_at_ms(), 42);
    }
}
