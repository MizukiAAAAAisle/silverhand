//! The internal agent channel-fork domain: an agent forks a new workspace channel
//! from a source conversation it participates in. Mirrors `ChannelService.createChannel`
//! for the `ChannelForkActor` (agent) path.
//!
//! The route resolves the fork-source address + workspace scope; the WRITER owns the
//! full authority in ONE `BEGIN IMMEDIATE`: fresh `create_channels` capability, the
//! per-source-agent workspace-membership gate (before the actor checks), the
//! per-workspace title-collision gate, the id allocation (after the gates so a failing
//! entropy cannot mask a refusal), the channel + members + inherited roster inserts,
//! the two seed messages through the canonical seq/head primitives, and the SEALED
//! post-images the aftermath consumes. The seed message PAYLOAD + coordinates the
//! aftermath delivers are these committed facts (no route-minted ids); the delivery/
//! start AUDIENCE, however, is NOT the committed fork roster — the aftermath re-reads
//! the LIVE conversation roster at effect time for each of the prompt and start phases,
//! so a member that left/joined between commit and effect is excluded/
//! included. Sealed seed payload vs live audience are distinct axes.

use crate::conversation_messaging::messaging::MessageId;
use crate::conversation_messaging::messaging::conversation_title::CanonicalConversationTitle;
use crate::conversation_messaging::messaging::environment::SendEntropy;
use crate::foundation::identity::WorkspaceId;
use crate::foundation::identity::{AgentId, ConversationId};
use crate::foundation::persistence::PersistenceFailure;
use std::future::Future;

/// Why the agent channel-fork refused, decided in the write transaction. Each maps
/// to a reference `ChannelService` error status/code.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChannelForkRefusal {
    /// The target workspace does not exist — `404 workspace_not_found`.
    WorkspaceNotFound,
    /// The target workspace is an agent-home, not regular — `400 workspace_not_regular`.
    WorkspaceNotRegular,
    /// The acting agent lacks `create_channels` on the workspace — `403
    /// capability_denied` (fresh-replayed in the writer, not a route precheck).
    CapabilityDenied,
    /// A derived source-roster member is not a member of the target workspace — `400
    /// agent_not_workspace_member` (carries the id). Checked BEFORE the actor/source
    /// gates, matching the reference member-validation order (#21).
    AgentNotWorkspaceMember { agent: AgentId },
    /// The fork-source conversation does not exist — `404 source_conversation_not_found`.
    SourceConversationNotFound,
    /// The acting agent is not a member of the source conversation — `403
    /// agent_not_member_of_source_conv`.
    AgentNotMemberOfSource,
    /// The source conversation belongs to a different workspace — `403
    /// agent_workspace_mismatch`.
    AgentWorkspaceMismatch,
    /// The channel title is already taken IN THIS WORKSPACE — `409
    /// conversation_title_taken`; carries the canonical title for the exact reference
    /// message (#29).
    TitleTaken { title: String },
}

/// A committed seed-message coordinate the awaited aftermath consumes to deliver the
/// message: its `id` + `conversation` are the delivery target (the OnboardingDelivery
/// leg ensures the recipient's durable inbox custody for `(conversation, id)` and
/// wakes it), and `seq`/`content` are the committed ordinal + body for evidence. The
/// FULL row seal — author/from/metadata/head — lives in the durable message row the
/// writer committed via `append_seed_message` (the canonical reserve→insert→head-bump
/// primitive); this carrier is deliberately just the delivery coordinate, NOT a claim
/// to re-seal those columns. Never a route-minted id or a live reread (#4-refinement).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSeedMessage {
    pub id: MessageId,
    pub conversation: ConversationId,
    pub seq: i64,
    pub content: String,
}

/// The committed fork result carrying the sealed post-images the awaited aftermath
/// consumes: the new channel, the two seed messages, and the member agents + inherited
/// human roster (the effect coordinates). The wire returns only `{ channel_id }`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedChannelFork {
    pub channel: ConversationId,
    /// The acting agent: the context seed is delivered to it; the prompt is
    /// distributed to the OTHER member agents. Carried on the committed fork so the
    /// awaited aftermath routes the two legs without a live reread (#40).
    pub actor_agent: AgentId,
    pub context_message: SealedSeedMessage,
    pub prompt_message: SealedSeedMessage,
    pub member_agents: Vec<AgentId>,
    pub member_users: Vec<String>,
}

/// The fork request an agent makes: the target workspace, fork-source, acting
/// agent, the new channel title, and the RAW `context_summary`/`initial_prompt`
/// inputs. The writer composes the seed bodies, mints the ids (after the gates),
/// samples the clock, and validates every gate atomically. No pre-minted ids / no
/// pre-sampled clock reach the writer (#31/#9).
pub struct ChannelForkRequest {
    pub workspace: WorkspaceId,
    pub source_conversation: ConversationId,
    pub actor_agent: AgentId,
    pub title: CanonicalConversationTitle,
    pub context_summary: String,
    pub initial_prompt: String,
}

/// Whether an agent holds the `create_channels` capability in a workspace — the
/// caller-side gate the fork route requires (owner arm ∪ explicit grant). A
/// dedicated predicate keyed on the `create_channels` token.
pub trait CreateChannelsCapability {
    fn may_create_channels(
        &self,
        agent: &AgentId,
        workspace: &WorkspaceId,
    ) -> impl Future<Output = Result<bool, PersistenceFailure>> + Send;
}

/// The clock the fork writer samples ONCE, sampled INSIDE the writer after its gates
/// pass: an injectable writer input, not a bare `SystemTime::now()`, so
/// a held-writer / abnormal-clock falsifier can drive it and every stamped row shares
/// the one instant.
pub trait ChannelForkClock: Send + Sync {
    fn now_ms(&self) -> i64;
}

/// The agent channel-fork write authority: ONE `BEGIN IMMEDIATE` transaction that
/// fresh-replays capability + per-source-agent workspace-membership + source/actor +
/// per-workspace title gates, mints ids after the gates, inserts the channel + member
/// agents + inherited human roster, appends the two seed messages via the canonical
/// seq/head primitives, and returns the sealed post-images. Any refusal rolls back
/// whole (no channel, no members, no messages, no title-address event).
pub trait ChannelForkWrite {
    fn fork_channel<B: SendEntropy + Send + Sync, C: ChannelForkClock>(
        &self,
        request: &ChannelForkRequest,
        entropy: &B,
        clock: &C,
    ) -> impl Future<
        Output = Result<Result<CommittedChannelFork, ChannelForkRefusal>, PersistenceFailure>,
    > + Send;
}
