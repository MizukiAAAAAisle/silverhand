//! Viewer-private channel tiers and workspace mute suppressors.

use crate::identity::{ConversationId, UserId, WorkspaceId};
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
pub enum AttentionPreferenceRefusal {
    ChannelNotFound,
    Forbidden,
    WorkspaceNotFound,
    InvalidInput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelAttentionPreference {
    conversation: ConversationId,
    mode: ChannelAttentionMode,
}

impl ChannelAttentionPreference {
    pub fn committed(conversation: ConversationId, mode: ChannelAttentionMode) -> Self {
        Self { conversation, mode }
    }
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub fn mode(&self) -> ChannelAttentionMode {
        self.mode
    }
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

/// The one committed identity from which both viewer-private effects and the
/// HTTP acknowledgement are projected. Preference writes intentionally remain
/// PUT-idempotent storage operations that publish on every successful request,
/// matching the existing product contract even when the value was unchanged.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommittedAttentionPreference {
    Channel {
        viewer: UserId,
        workspace: WorkspaceId,
        preference: ChannelAttentionPreference,
    },
    Workspace {
        viewer: UserId,
        preference: WorkspaceAttentionPreference,
    },
}

impl CommittedAttentionPreference {
    pub fn channel(
        viewer: UserId,
        workspace: WorkspaceId,
        conversation: ConversationId,
        mode: ChannelAttentionMode,
    ) -> Self {
        Self::Channel {
            viewer,
            workspace,
            preference: ChannelAttentionPreference::committed(conversation, mode),
        }
    }
    pub fn workspace(viewer: UserId, workspace: WorkspaceId, muted: bool) -> Self {
        Self::Workspace {
            viewer,
            preference: WorkspaceAttentionPreference::projected(workspace, muted),
        }
    }
    pub fn viewer(&self) -> &UserId {
        match self {
            Self::Channel { viewer, .. } | Self::Workspace { viewer, .. } => viewer,
        }
    }
    pub fn workspace_id(&self) -> &WorkspaceId {
        match self {
            Self::Channel { workspace, .. } => workspace,
            Self::Workspace { preference, .. } => preference.workspace(),
        }
    }
    pub fn conversation_id(&self) -> Option<&ConversationId> {
        match self {
            Self::Channel { preference, .. } => Some(preference.conversation()),
            Self::Workspace { .. } => None,
        }
    }
    pub fn channel_preference(&self) -> Option<&ChannelAttentionPreference> {
        match self {
            Self::Channel { preference, .. } => Some(preference),
            Self::Workspace { .. } => None,
        }
    }
    pub fn workspace_preference(&self) -> Option<&WorkspaceAttentionPreference> {
        match self {
            Self::Workspace { preference, .. } => Some(preference),
            Self::Channel { .. } => None,
        }
    }
}

pub trait AttentionPreferencePort {
    type Error: Error + Send + Sync + 'static;

    fn set_channel(
        &self,
        viewer: UserId,
        conversation: ConversationId,
        mode: Option<ChannelAttentionMode>,
    ) -> impl Future<
        Output = Result<
            Result<CommittedAttentionPreference, AttentionPreferenceRefusal>,
            Self::Error,
        >,
    > + Send;

    fn get_workspace(
        &self,
        viewer: &UserId,
        workspace: WorkspaceId,
    ) -> impl Future<
        Output = Result<
            Result<WorkspaceAttentionPreference, AttentionPreferenceRefusal>,
            Self::Error,
        >,
    > + Send;

    fn set_workspace(
        &self,
        viewer: UserId,
        workspace: WorkspaceId,
        muted: Option<bool>,
    ) -> impl Future<
        Output = Result<
            Result<CommittedAttentionPreference, AttentionPreferenceRefusal>,
            Self::Error,
        >,
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
    fn preference_changed(
        &self,
        fact: &CommittedAttentionPreference,
    ) -> impl Future<Output = Result<(), AttentionPreferenceEffectFailure>> + Send;
    fn badge_changed(
        &self,
        fact: &CommittedAttentionPreference,
    ) -> impl Future<Output = Result<(), AttentionPreferenceEffectFailure>> + Send;
}

#[derive(Debug)]
pub struct AttentionPreferenceExecution {
    committed: CommittedAttentionPreference,
    first_failure: Option<AttentionPreferenceEffectFailure>,
}

impl AttentionPreferenceExecution {
    pub fn committed(&self) -> &CommittedAttentionPreference {
        &self.committed
    }
    pub fn first_failure(&self) -> Option<&AttentionPreferenceEffectFailure> {
        self.first_failure.as_ref()
    }
}

async fn finish(
    aftermath: &impl AttentionPreferenceAftermath,
    committed: CommittedAttentionPreference,
) -> AttentionPreferenceExecution {
    let mut first_failure = aftermath.preference_changed(&committed).await.err();
    if let Err(error) = aftermath.badge_changed(&committed).await
        && first_failure.is_none()
    {
        first_failure = Some(error);
    }
    AttentionPreferenceExecution {
        committed,
        first_failure,
    }
}

pub async fn set_channel_attention_preference<P: AttentionPreferencePort>(
    port: &P,
    aftermath: &impl AttentionPreferenceAftermath,
    viewer: UserId,
    conversation: ConversationId,
    mode: Option<ChannelAttentionMode>,
) -> Result<Result<AttentionPreferenceExecution, AttentionPreferenceRefusal>, P::Error> {
    match port.set_channel(viewer, conversation, mode).await? {
        Ok(committed) => Ok(Ok(finish(aftermath, committed).await)),
        Err(refusal) => Ok(Err(refusal)),
    }
}

pub async fn set_workspace_attention_preference<P: AttentionPreferencePort>(
    port: &P,
    aftermath: &impl AttentionPreferenceAftermath,
    viewer: UserId,
    workspace: WorkspaceId,
    muted: Option<bool>,
) -> Result<Result<AttentionPreferenceExecution, AttentionPreferenceRefusal>, P::Error> {
    match port.set_workspace(viewer, workspace, muted).await? {
        Ok(committed) => Ok(Ok(finish(aftermath, committed).await)),
        Err(refusal) => Ok(Err(refusal)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{convert::Infallible, io, sync::Mutex};

    struct Port;
    impl AttentionPreferencePort for Port {
        type Error = Infallible;
        async fn set_channel(
            &self,
            viewer: UserId,
            conversation: ConversationId,
            mode: Option<ChannelAttentionMode>,
        ) -> Result<Result<CommittedAttentionPreference, AttentionPreferenceRefusal>, Self::Error>
        {
            Ok(Ok(CommittedAttentionPreference::channel(
                viewer,
                WorkspaceId::parse("w").unwrap(),
                conversation,
                mode.unwrap(),
            )))
        }
        async fn get_workspace(
            &self,
            _: &UserId,
            workspace: WorkspaceId,
        ) -> Result<Result<WorkspaceAttentionPreference, AttentionPreferenceRefusal>, Self::Error>
        {
            Ok(Ok(WorkspaceAttentionPreference::projected(
                workspace, false,
            )))
        }
        async fn set_workspace(
            &self,
            viewer: UserId,
            workspace: WorkspaceId,
            muted: Option<bool>,
        ) -> Result<Result<CommittedAttentionPreference, AttentionPreferenceRefusal>, Self::Error>
        {
            Ok(Ok(CommittedAttentionPreference::workspace(
                viewer,
                workspace,
                muted.unwrap(),
            )))
        }
    }
    struct Effects(Mutex<Vec<&'static str>>);
    impl AttentionPreferenceAftermath for Effects {
        async fn preference_changed(
            &self,
            _: &CommittedAttentionPreference,
        ) -> Result<(), AttentionPreferenceEffectFailure> {
            self.0.lock().unwrap().push("preference");
            Err(AttentionPreferenceEffectFailure::from_source(
                io::Error::other("hub"),
            ))
        }
        async fn badge_changed(
            &self,
            _: &CommittedAttentionPreference,
        ) -> Result<(), AttentionPreferenceEffectFailure> {
            self.0.lock().unwrap().push("badge");
            Ok(())
        }
    }
    #[tokio::test]
    async fn committed_write_attempts_both_effects_and_keeps_first_failure() {
        let effects = Effects(Mutex::new(vec![]));
        let done = set_channel_attention_preference(
            &Port,
            &effects,
            UserId::parse("u").unwrap(),
            ConversationId::parse("c").unwrap(),
            Some(ChannelAttentionMode::Mentions),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(effects.0.into_inner().unwrap(), ["preference", "badge"]);
        assert!(done.first_failure().is_some());
        assert_eq!(done.committed().viewer().as_str(), "u");
    }
}
