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

/// The `title` a conversation-scoped agent's personal home DM carries, and the folded
/// `title_key` that DM row stores. Pinned here so provisioning writes them and the seal
/// binds the after-image against the one spelling, never an adapter literal.
pub const ONBOARDING_DM_TITLE: &str = "Onboarding";
pub const ONBOARDING_DM_TITLE_KEY: &str = "onboarding";

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

    /// Build the intent to greet a conversation-scoped agent in the personal home DM
    /// provisioning just opened for it.
    ///
    /// Only the agent is named here — a conversation-scoped agent's home DM has no second
    /// human participant to reference in the body. As with [`Self::agent_direct_line`] the
    /// prose is rendered through the one canonical renderer; the caller controls only WHERE
    /// it lands, the minted id, and the write timestamp.
    pub fn conversation_dm(
        conversation: ConversationId,
        id: MessageId,
        agent_handle: &ParticipantHandle,
        created_at_ms: i64,
    ) -> Self {
        Self {
            conversation,
            id,
            content: render_dm_body(agent_handle),
            created_at_ms,
        }
    }

    /// Build the intent to greet a member agent in a newly-created workspace's
    /// Onboarding channel. Names the recipient and every OTHER member agent with
    /// canonical reference tokens (never the plain `@name` alias, which addresses
    /// nobody), the workspace name in inline code, and the fixed role/L2 guidance —
    /// the reference `onboardingBody`. The body is rendered through the one canonical
    /// renderer; the caller controls only WHERE it lands, the minted id, and the clock.
    pub fn workspace_onboarding(
        conversation: ConversationId,
        id: MessageId,
        workspace_name: &str,
        recipient_handle: &ParticipantHandle,
        others: &[WorkspaceOnboardingPeer],
        created_at_ms: i64,
    ) -> Self {
        Self {
            conversation,
            id,
            content: render_workspace_onboarding_body(workspace_name, recipient_handle, others),
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

    /// Re-stamp the message's `created_at` with the WRITER's post-lock instant.
    /// The onboarding-message clock authority lives in the append writer, not
    /// the route: the route builds the message shape with a placeholder timestamp, and
    /// the writer samples ONCE after it holds the `BEGIN IMMEDIATE` lock + validated
    /// the stream facts, then stamps that single instant into BOTH the inserted row and
    /// the sealed after-image it verifies. Consumes and returns self so the stamped
    /// value is the only one that ever reaches the insert/seal.
    #[must_use]
    pub fn stamped_at(mut self, created_at_ms: i64) -> Self {
        self.created_at_ms = created_at_ms;
        self
    }

    /// Re-bind the message's id with the WRITER's minted id. The
    /// onboarding-message id authority lives in the append writer, not the route: the
    /// route builds the message shape with a PLACEHOLDER id, and the writer mints the
    /// real id inside the same UoW that reserves the seq / inserts the row / bumps the
    /// head, so a route-side pre-mint can never race ahead of the append's stream
    /// gates. Consumes and returns self so the minted id is the only one that reaches
    /// the insert/seal and the committed target.
    #[must_use]
    pub fn with_id(mut self, id: MessageId) -> Self {
        self.id = id;
        self
    }

    /// The metadata discriminator this message carries. Fixed, so the persistence
    /// primitive stamps the subtype from the intent rather than from a parameter.
    pub fn subtype(&self) -> &'static str {
        ONBOARDING_SUBTYPE
    }

    /// Bind the row the persistence primitive read back after writing this intent, and
    /// mint the sealed fact that the message provisioning meant to land actually did —
    /// on the line it named, carrying the body it rendered, at the clock it stamped,
    /// under the system/onboarding shape, at the head of the stream, with none of the
    /// participant / thread / cc columns a normal message carries.
    ///
    /// The write adapter WITNESSES: it returns the after-image it read from the row it
    /// just inserted and the stream head it just bumped. It does not get to assert the
    /// message landed correctly — this seal re-derives every touched column from the raw
    /// after-image, so a mislabelled, misplaced, re-authored, or non-head insert cannot
    /// pass for a completed onboarding message. It is `pub(crate)` because only a core
    /// use case, holding the sealed sub-facts this write depends on, is allowed to mint
    /// [`OnboardingWritten`] — the write adapter across the crate boundary cannot.
    pub(crate) fn seal_written(
        &self,
        witness: OnboardingWriteWitness,
    ) -> Result<OnboardingWritten, OnboardingWriteMismatch> {
        self.check_written(&witness)?;
        Ok(OnboardingWritten {
            conversation: self.conversation.clone(),
            id: self.id.clone(),
        })
    }

    /// The fail-closed verification a WRITE ADAPTER (across the crate boundary) runs:
    /// the same re-derivation as [`OnboardingSystemMessage::seal_written`], but it
    /// returns only the verdict — it never mints the [`OnboardingWritten`] fact, which
    /// stays core-only. The onboarding writer calls this on the after-image it read
    /// back inside its own transaction; a mislabelled / misplaced / re-authored /
    /// non-head insert returns `Err`, so the writer aborts the transaction and the
    /// message is never delivered.
    pub fn verify_written(
        &self,
        witness: &OnboardingWriteWitness,
    ) -> Result<(), OnboardingWriteMismatch> {
        self.check_written(witness)
    }

    fn check_written(
        &self,
        witness: &OnboardingWriteWitness,
    ) -> Result<(), OnboardingWriteMismatch> {
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
        if witness.content != self.content {
            return Err(OnboardingWriteMismatch {
                reason: "written content differs from the rendered body",
            });
        }
        if witness.created_at_ms != self.created_at_ms {
            return Err(OnboardingWriteMismatch {
                reason: "written timestamp differs from the stamped clock",
            });
        }
        // The from-kind and metadata SHAPE is judged by the ONE recognizer, so a write-time
        // seal and a read-time recognition can never disagree on what "an onboarding message"
        // is. The remaining checks below are write-time-only invariants (the exact rendered
        // body, the minted id, the stamped clock, the stream-head position) that a caller
        // holding only a committed id cannot re-derive.
        recognize_onboarding_shape(&witness.from_kind, &witness.metadata).map_err(|mismatch| {
            OnboardingWriteMismatch {
                reason: mismatch.reason(),
            }
        })?;
        if witness.from_agent_id.is_some() || witness.from_user_id.is_some() {
            return Err(OnboardingWriteMismatch {
                reason: "written system message carries a from-participant",
            });
        }
        if witness.author_id.is_some()
            || witness.author_name.is_some()
            || witness.author_display_name.is_some()
        {
            return Err(OnboardingWriteMismatch {
                reason: "written system message carries an author snapshot",
            });
        }
        if witness.thread_root_id.is_some() {
            return Err(OnboardingWriteMismatch {
                reason: "written onboarding message is threaded",
            });
        }
        if witness.cc_source_message_id.is_some() {
            return Err(OnboardingWriteMismatch {
                reason: "written onboarding message carries a cc source",
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
        Ok(())
    }
}

/// The raw after-image the write adapter read back for an onboarding message: every column
/// the onboarding writer touches, verbatim, so the core seal can re-derive the whole write
/// rather than trust the adapter's word for it. The participant / author / thread / cc
/// columns are `Option<String>` because the onboarding writer never sets them — the seal
/// proves that by requiring each to be absent. `metadata` is the [`OnboardingMetadataDigest`]
/// the adapter decoded from the stored blob (the domain has no JSON runtime), and it carries
/// no verdict — only [`OnboardingSystemMessage::seal_written`] turns this into a fact.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OnboardingWriteWitness {
    pub id: String,
    pub conversation: String,
    pub content: String,
    pub created_at_ms: i64,
    pub from_kind: String,
    pub from_agent_id: Option<String>,
    pub from_user_id: Option<String>,
    pub author_id: Option<String>,
    pub author_name: Option<String>,
    pub author_display_name: Option<String>,
    pub thread_root_id: Option<String>,
    pub cc_source_message_id: Option<String>,
    pub metadata: OnboardingMetadataDigest,
    pub seq: i64,
    pub head_latest_seq: i64,
}

/// The adapter's decoding of a stored message's metadata, reduced to exactly what the seal
/// judges: the `subtype` discriminator, and whether the blob carried ANY other key. The
/// domain asserts the subtype is onboarding AND nothing else rode along — the metadata JSON
/// encoding is a storage concern the adapter owns, so it decodes and the domain judges the
/// digest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OnboardingMetadataDigest {
    pub subtype: Option<String>,
    pub has_extra_keys: bool,
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

/// Recognise a stored row's SHAPE as an onboarding system message from only the two columns
/// that discriminate it — the `from_kind` and the decoded metadata digest. This is the
/// read-time twin of the from-kind/metadata checks [`OnboardingSystemMessage::seal_written`]
/// makes at write time: a caller that holds a committed message id but not the rendered
/// intent (the post-commit inbox-ensure) cannot re-derive the body, id, clock, or stream
/// position, but it CAN — and must — refuse to treat an ordinary same-conversation message as
/// an onboarding one. Both callers route through this ONE function and the ONE spelling of the
/// from-kind and subtype, so the shape rule can never drift between the seal and the recognizer.
pub fn recognize_onboarding_shape(
    from_kind: &str,
    metadata: &OnboardingMetadataDigest,
) -> Result<(), OnboardingShapeMismatch> {
    if from_kind != ONBOARDING_FROM_KIND {
        return Err(OnboardingShapeMismatch {
            reason: "message is not a system message",
        });
    }
    if metadata.subtype.as_deref() != Some(ONBOARDING_SUBTYPE) {
        return Err(OnboardingShapeMismatch {
            reason: "metadata does not carry the onboarding subtype",
        });
    }
    if metadata.has_extra_keys {
        return Err(OnboardingShapeMismatch {
            reason: "metadata carries keys beyond the onboarding subtype",
        });
    }
    Ok(())
}

/// Why a stored row is not recognised as an onboarding system message. Distinct from
/// [`OnboardingWriteMismatch`] because it names only the shape (from-kind + metadata) a
/// read-time caller can judge, not the full write-time after-image.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("row is not an onboarding system message: {reason}")]
pub struct OnboardingShapeMismatch {
    reason: &'static str,
}

impl OnboardingShapeMismatch {
    /// The static label describing which shape check failed, for a caller that folds this
    /// into its own boundary-logged fault.
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

/// The body a conversation-scoped agent is greeted with in its personal home DM.
///
/// Only the agent is named — its home DM has no second human participant. `system_prompt.md`,
/// `MEMORY.md` and `notes/` are code-spanned so a Markdown reader renders the file names as
/// literal text rather than prose.
/// One OTHER member agent named in a workspace-onboarding body: its handle (for the
/// canonical reference token) and its runtime kind (shown in parentheses).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceOnboardingPeer {
    pub handle: ParticipantHandle,
    pub runtime: String,
}

/// The workspace-onboarding body, verbatim from the reference `onboardingBody`:
/// the recipient's canonical reference token, the workspace name in inline code, the
/// peer roster (or the "only agent" line), and the fixed role/L2 guidance.
fn render_workspace_onboarding_body(
    workspace_name: &str,
    recipient_handle: &ParticipantHandle,
    others: &[WorkspaceOnboardingPeer],
) -> String {
    let recipient = format_reference_token(PrincipalKind::Agent, recipient_handle);
    let workspace = super::markdown::inline_code(workspace_name);
    let others_line = if others.is_empty() {
        "You're the only agent here right now.".to_owned()
    } else {
        let list = others
            .iter()
            .map(|peer| {
                format!(
                    "- {} ({})",
                    format_reference_token(PrincipalKind::Agent, &peer.handle),
                    peer.runtime
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!("Other agents in this workspace:\n{list}")
    };
    // The reference `onboardingBody` leaves `L1 system_prompt.md` as BARE text (no
    // code span), unlike the DM greeting — only the workspace name is inline-coded.
    format!(
        "You ({recipient}) just joined workspace {workspace}.\n{others_line}\n\nYour role \
         contract is auto-loaded above (sourced from L1 system_prompt.md, shared across every \
         workspace), and this workspace's MEMORY.md is auto-loaded as Active Workspace \
         Memory.\nSend one short greeting introducing yourself by your global role. Write \
         global identity / role / working-style guidance to L1 system_prompt.md. Use this \
         workspace's L2 only for durable, workspace-specific knowledge absent from the \
         codebase, task board, and channel/thread history. Do not mention internal file paths \
         to the user unless they ask."
    )
}

fn render_dm_body(agent_name: &ParticipantHandle) -> String {
    let agent = format_reference_token(PrincipalKind::Agent, agent_name);
    let system_prompt = super::markdown::inline_code("system_prompt.md");
    let memory = super::markdown::inline_code("MEMORY.md");
    let notes = super::markdown::inline_code("notes/");

    format!(
        "You ({agent}) are now in your personal DM with the user.\nYour role contract lives \
         at L1 {system_prompt}, this computer's authority on who you are; it applies in every \
         workspace on this computer, and edits take effect on the agent's next spawn. This DM \
         also has its own L2 {memory} / {notes} for memory that stays here.\nSend one short \
         greeting: say hi by name, state your current global role briefly (or say it is not \
         defined yet), and ask what role the user would like you to play. Write global \
         identity / role / working-style guidance to L1 {system_prompt}. Use this DM's L2 only \
         for durable, DM-specific knowledge absent from the codebase, task board, and \
         channel/thread history. Do not mention internal file paths to the user unless they \
         ask."
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
            content: render_direct_line_body(&handle("Alice"), &handle("shiki")),
            created_at_ms: 42,
            from_kind: "system".to_owned(),
            from_agent_id: None,
            from_user_id: None,
            author_id: None,
            author_name: None,
            author_display_name: None,
            thread_root_id: None,
            cc_source_message_id: None,
            metadata: OnboardingMetadataDigest {
                subtype: Some("onboarding".to_owned()),
                has_extra_keys: false,
            },
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
            witness.metadata.subtype = subtype;
            assert!(intent().seal_written(witness).is_err());
        }
    }

    #[test]
    fn metadata_beyond_the_onboarding_subtype_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.metadata.has_extra_keys = true;
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn a_reauthored_body_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.content = format!("{} tampered", witness.content);
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn a_clock_other_than_the_stamped_moment_refuses_to_seal() {
        let mut witness = faithful_witness();
        witness.created_at_ms = 43;
        assert!(intent().seal_written(witness).is_err());
    }

    #[test]
    fn any_participant_author_thread_or_cc_column_refuses_to_seal() {
        let set = |mutate: fn(&mut OnboardingWriteWitness)| {
            let mut witness = faithful_witness();
            mutate(&mut witness);
            witness
        };
        let cases: [fn(&mut OnboardingWriteWitness); 7] = [
            |w| w.from_agent_id = Some("a1".to_owned()),
            |w| w.from_user_id = Some("u1".to_owned()),
            |w| w.author_id = Some("u1".to_owned()),
            |w| w.author_name = Some("shiki".to_owned()),
            |w| w.author_display_name = Some("shiki".to_owned()),
            |w| w.thread_root_id = Some("root".to_owned()),
            |w| w.cc_source_message_id = Some("src".to_owned()),
        ];
        for mutate in cases {
            assert!(intent().seal_written(set(mutate)).is_err());
        }
    }

    #[test]
    fn the_dm_body_names_only_the_agent_and_pins_the_three_files() {
        let body = render_dm_body(&handle("Alice"));
        assert_eq!(
            body,
            "You (<silverhand://agent/Alice>) are now in your personal DM with the user.\nYour \
             role contract lives at L1 `system_prompt.md`, this computer's authority on who you \
             are; it applies in every workspace on this computer, and edits take effect on the \
             agent's next spawn. This DM also has its own L2 `MEMORY.md` / `notes/` for memory \
             that stays here.\nSend one short greeting: say hi by name, state your current global \
             role briefly (or say it is not defined yet), and ask what role the user would like \
             you to play. Write global identity / role / working-style guidance to L1 \
             `system_prompt.md`. Use this DM's L2 only for durable, DM-specific knowledge absent \
             from the codebase, task board, and channel/thread history. Do not mention internal \
             file paths to the user unless they ask."
        );
        assert_eq!(body.lines().count(), 3);
    }

    #[test]
    fn the_dm_intent_renders_the_dm_body_and_seals_against_it() {
        let intent = OnboardingSystemMessage::conversation_dm(
            ConversationId::parse("dm-1").unwrap(),
            MessageId::parse("msg-9").unwrap(),
            &handle("Alice"),
            7,
        );
        assert_eq!(intent.content(), render_dm_body(&handle("Alice")));
        let mut witness = faithful_witness();
        witness.id = "msg-9".to_owned();
        witness.conversation = "dm-1".to_owned();
        witness.content = render_dm_body(&handle("Alice"));
        witness.created_at_ms = 7;
        assert!(intent.seal_written(witness).is_ok());
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

    #[test]
    fn the_shape_recognizer_accepts_only_a_system_onboarding_row() {
        let onboarding = OnboardingMetadataDigest {
            subtype: Some(ONBOARDING_SUBTYPE.to_owned()),
            has_extra_keys: false,
        };
        // The genuine shape: a system message whose metadata is exactly the onboarding subtype.
        assert!(recognize_onboarding_shape(ONBOARDING_FROM_KIND, &onboarding).is_ok());
        // An ordinary agent/user message in the same line is refused, so the read-time door
        // cannot be tricked into enqueuing arbitrary same-conversation traffic.
        assert!(recognize_onboarding_shape("agent", &onboarding).is_err());
        assert!(recognize_onboarding_shape("user", &onboarding).is_err());
        // A system message carrying a different (or absent) subtype is not onboarding.
        for subtype in [None, Some(String::new()), Some("reply".to_owned())] {
            let digest = OnboardingMetadataDigest {
                subtype,
                has_extra_keys: false,
            };
            assert!(recognize_onboarding_shape(ONBOARDING_FROM_KIND, &digest).is_err());
        }
        // The onboarding subtype plus any other key is not the exact onboarding shape.
        let with_extra = OnboardingMetadataDigest {
            subtype: Some(ONBOARDING_SUBTYPE.to_owned()),
            has_extra_keys: true,
        };
        assert!(recognize_onboarding_shape(ONBOARDING_FROM_KIND, &with_extra).is_err());
    }
}
