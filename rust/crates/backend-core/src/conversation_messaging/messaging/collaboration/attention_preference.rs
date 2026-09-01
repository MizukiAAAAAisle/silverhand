//! Viewer-private channel tiers and workspace mute suppressors.

use crate::foundation::identity::{ConversationId, UserId, WorkspaceId};
use std::{error::Error, future::Future};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelAttentionMode {
    All,
    Mentions,
    Mute,
}
impl ChannelAttentionMode {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "all" => Some(Self::All),
            "mentions" => Some(Self::Mentions),
            "mute" => Some(Self::Mute),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Mentions => "mentions",
            Self::Mute => "mute",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelAttentionAdmissionRefusal {
    ChannelNotFound,
    Forbidden,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelAttentionWriteRefusal {
    ChannelNotFound,
    Forbidden,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceAttentionReadRefusal {
    Forbidden,
    WorkspaceNotFound,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceAttentionAdmissionRefusal {
    Forbidden,
    WorkspaceNotFound,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceAttentionWriteRefusal {
    Forbidden,
    WorkspaceNotFound,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceAttentionPreference {
    workspace: WorkspaceId,
    muted: bool,
}
impl WorkspaceAttentionPreference {
    pub fn projected(workspace: WorkspaceId, muted: bool) -> Self {
        Self { workspace, muted }
    }
    pub fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }
    pub fn muted(&self) -> bool {
        self.muted
    }
}

/// Consumer-language views over adapter-owned committed projections. The
/// concrete value is minted inside the adapter from its winning authority row;
/// core exposes no public from-parts constructor that can splice coordinates.
pub trait ChannelAttentionCommit: Send + Sync {
    fn viewer(&self) -> &UserId;
    fn workspace(&self) -> &WorkspaceId;
    fn conversation(&self) -> &ConversationId;
    fn mode(&self) -> ChannelAttentionMode;
}
pub trait WorkspaceAttentionCommit: Send + Sync {
    fn viewer(&self) -> &UserId;
    fn workspace(&self) -> &WorkspaceId;
    fn muted(&self) -> bool;
}

pub trait AttentionPreferencePort {
    type Error: Error + Send + Sync + 'static;
    type ChannelTarget: Send;
    type WorkspaceTarget: Send;
    type ChannelCommit: ChannelAttentionCommit;
    type WorkspaceCommit: WorkspaceAttentionCommit;

    /// Read-only preflight before the HTTP adapter reads the body.
    fn admit_channel(
        &self,
        viewer: &UserId,
        conversation: &ConversationId,
    ) -> impl Future<
        Output = Result<Result<Self::ChannelTarget, ChannelAttentionAdmissionRefusal>, Self::Error>,
    > + Send;
    /// Rechecks the same authority inside the root write transaction.
    fn commit_channel(
        &self,
        target: Self::ChannelTarget,
        mode: ChannelAttentionMode,
    ) -> impl Future<
        Output = Result<Result<Self::ChannelCommit, ChannelAttentionWriteRefusal>, Self::Error>,
    > + Send;
    fn get_workspace(
        &self,
        viewer: &UserId,
        workspace: WorkspaceId,
    ) -> impl Future<
        Output = Result<
            Result<WorkspaceAttentionPreference, WorkspaceAttentionReadRefusal>,
            Self::Error,
        >,
    > + Send;
    fn admit_workspace_write(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> impl Future<
        Output = Result<
            Result<Self::WorkspaceTarget, WorkspaceAttentionAdmissionRefusal>,
            Self::Error,
        >,
    > + Send;
    fn commit_workspace(
        &self,
        target: Self::WorkspaceTarget,
        muted: bool,
    ) -> impl Future<
        Output = Result<Result<Self::WorkspaceCommit, WorkspaceAttentionWriteRefusal>, Self::Error>,
    > + Send;
}

#[derive(Debug, thiserror::Error)]
#[error("a committed attention preference effect failed")]
pub struct AttentionPreferenceEffectFailure {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}
impl AttentionPreferenceEffectFailure {
    pub fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}
pub trait AttentionPreferenceAftermath {
    fn channel_preference_changed(
        &self,
        fact: &impl ChannelAttentionCommit,
    ) -> impl Future<Output = Result<(), AttentionPreferenceEffectFailure>> + Send;
    fn channel_badge_changed(
        &self,
        fact: &impl ChannelAttentionCommit,
    ) -> impl Future<Output = Result<(), AttentionPreferenceEffectFailure>> + Send;
    fn workspace_preference_changed(
        &self,
        fact: &impl WorkspaceAttentionCommit,
    ) -> impl Future<Output = Result<(), AttentionPreferenceEffectFailure>> + Send;
    fn workspace_badge_changed(
        &self,
        fact: &impl WorkspaceAttentionCommit,
    ) -> impl Future<Output = Result<(), AttentionPreferenceEffectFailure>> + Send;
}

#[derive(Debug)]
pub struct AttentionPreferenceExecution<C> {
    committed: C,
    first_failure: Option<AttentionPreferenceEffectFailure>,
}
impl<C> AttentionPreferenceExecution<C> {
    pub fn committed(&self) -> &C {
        &self.committed
    }
    pub fn first_failure(&self) -> Option<&AttentionPreferenceEffectFailure> {
        self.first_failure.as_ref()
    }
}
async fn channel_effects(
    aftermath: &impl AttentionPreferenceAftermath,
    fact: &impl ChannelAttentionCommit,
) -> Option<AttentionPreferenceEffectFailure> {
    let mut first = aftermath.channel_preference_changed(fact).await.err();
    if let Err(error) = aftermath.channel_badge_changed(fact).await
        && first.is_none()
    {
        first = Some(error);
    }
    first
}
async fn workspace_effects(
    aftermath: &impl AttentionPreferenceAftermath,
    fact: &impl WorkspaceAttentionCommit,
) -> Option<AttentionPreferenceEffectFailure> {
    let mut first = aftermath.workspace_preference_changed(fact).await.err();
    if let Err(error) = aftermath.workspace_badge_changed(fact).await
        && first.is_none()
    {
        first = Some(error);
    }
    first
}

pub async fn commit_channel_attention_preference<P: AttentionPreferencePort>(
    port: &P,
    aftermath: &impl AttentionPreferenceAftermath,
    target: P::ChannelTarget,
    mode: ChannelAttentionMode,
) -> Result<
    Result<AttentionPreferenceExecution<P::ChannelCommit>, ChannelAttentionWriteRefusal>,
    P::Error,
> {
    let committed = match port.commit_channel(target, mode).await? {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    let first_failure = channel_effects(aftermath, &committed).await;
    Ok(Ok(AttentionPreferenceExecution {
        committed,
        first_failure,
    }))
}
pub async fn commit_workspace_attention_preference<P: AttentionPreferencePort>(
    port: &P,
    aftermath: &impl AttentionPreferenceAftermath,
    target: P::WorkspaceTarget,
    muted: bool,
) -> Result<
    Result<AttentionPreferenceExecution<P::WorkspaceCommit>, WorkspaceAttentionWriteRefusal>,
    P::Error,
> {
    let committed = match port.commit_workspace(target, muted).await? {
        Ok(v) => v,
        Err(r) => return Ok(Err(r)),
    };
    let first_failure = workspace_effects(aftermath, &committed).await;
    Ok(Ok(AttentionPreferenceExecution {
        committed,
        first_failure,
    }))
}

/// The removed public from-parts/cross-arm constructors stay absent.
/// ```compile_fail
/// # use silverhand_backend_core::conversation_messaging::messaging::collaboration::attention_preference::*;
/// let _ = CommittedChannelAttentionPreference::from_authoritative_channel;
/// ```
const _: () = ();

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io, sync::Mutex};
    struct ChannelFact {
        viewer: UserId,
        workspace: WorkspaceId,
        conversation: ConversationId,
    }
    impl ChannelAttentionCommit for ChannelFact {
        fn viewer(&self) -> &UserId {
            &self.viewer
        }
        fn workspace(&self) -> &WorkspaceId {
            &self.workspace
        }
        fn conversation(&self) -> &ConversationId {
            &self.conversation
        }
        fn mode(&self) -> ChannelAttentionMode {
            ChannelAttentionMode::Mentions
        }
    }
    struct Effects(Mutex<Vec<&'static str>>);
    impl AttentionPreferenceAftermath for Effects {
        async fn channel_preference_changed(
            &self,
            _: &impl ChannelAttentionCommit,
        ) -> Result<(), AttentionPreferenceEffectFailure> {
            self.0.lock().unwrap().push("preference");
            Err(AttentionPreferenceEffectFailure::from_source(
                io::Error::other("hub"),
            ))
        }
        async fn channel_badge_changed(
            &self,
            _: &impl ChannelAttentionCommit,
        ) -> Result<(), AttentionPreferenceEffectFailure> {
            self.0.lock().unwrap().push("badge");
            Ok(())
        }
        async fn workspace_preference_changed(
            &self,
            _: &impl WorkspaceAttentionCommit,
        ) -> Result<(), AttentionPreferenceEffectFailure> {
            Ok(())
        }
        async fn workspace_badge_changed(
            &self,
            _: &impl WorkspaceAttentionCommit,
        ) -> Result<(), AttentionPreferenceEffectFailure> {
            Ok(())
        }
    }
    #[tokio::test]
    async fn shared_projection_attempts_both_effects_and_keeps_first_failure() {
        let effects = Effects(Mutex::new(vec![]));
        let committed = ChannelFact {
            viewer: UserId::parse("u").unwrap(),
            workspace: WorkspaceId::parse("w").unwrap(),
            conversation: ConversationId::parse("c").unwrap(),
        };
        let first = super::channel_effects(&effects, &committed).await;
        assert_eq!(effects.0.into_inner().unwrap(), ["preference", "badge"]);
        assert!(first.is_some());
    }
}
