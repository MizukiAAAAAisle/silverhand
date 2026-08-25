//! Human channel creation: one workspace-keyed durable UoW and commit-only effects.
//!
//! Input title parsing and every mutable membership/governance fact remain port
//! authorities. The application layer owns the order: commit, bind the returned
//! fact to the request, then attempt both post-commit obligations without ever
//! compensating the durable channel.

use std::{collections::HashSet, error::Error, future::Future};

use crate::identity::{UserId, WorkspaceId};

use super::{ChannelDirectoryRow, ChannelStatus, ChannelVisibility, DirectoryRoster};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HumanChannelCreateRequest {
    title: String,
    member_agent_ids: Vec<String>,
    member_user_ids: Option<Vec<String>>,
    visibility: ChannelVisibility,
}

impl HumanChannelCreateRequest {
    pub fn new(
        title: String,
        member_agent_ids: Vec<String>,
        member_user_ids: Option<Vec<String>>,
        visibility: Option<ChannelVisibility>,
    ) -> Self {
        Self {
            title,
            member_agent_ids: dedupe(member_agent_ids),
            member_user_ids: member_user_ids.map(dedupe),
            visibility: visibility.unwrap_or(ChannelVisibility::Private),
        }
    }

    pub fn title(&self) -> &str {
        &self.title
    }
    pub fn member_agent_ids(&self) -> &[String] {
        &self.member_agent_ids
    }
    pub fn member_user_ids(&self) -> Option<&[String]> {
        self.member_user_ids.as_deref()
    }
    pub const fn visibility(&self) -> ChannelVisibility {
        self.visibility
    }
}

fn dedupe(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HumanChannelCreateRefusal {
    #[error("workspace not found")]
    WorkspaceNotFound,
    #[error("viewer cannot govern workspace")]
    Forbidden,
    #[error("channel title is invalid")]
    InvalidTitle,
    #[error("agent-home DM channels cannot be public")]
    AgentHomePublic,
    #[error("agent-home channels use only the home owner and current user")]
    AgentHomeExplicitMembers,
    #[error("agent-home owner not found")]
    AgentHomeOwnerNotFound,
    #[error("requested agent does not exist: {0}")]
    AgentNotFound(String),
    #[error("requested agent is not a workspace member: {0}")]
    AgentNotWorkspaceMember(String),
    #[error("requested user is not a workspace member: {0}")]
    UserNotWorkspaceMember(String),
    #[error("conversation title is already taken")]
    TitleTaken,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CreatedChannelKind {
    Regular,
    AgentHome,
}

/// The opaque address pair returned by a terminal title authority. Production
/// implementations keep their pair's fields private, so application callers
/// cannot split a display title from its canonical key or forge either from
/// parts.
pub trait CommittedChannelAddress: Clone + std::fmt::Debug + Eq + Send + Sync {
    fn title(&self) -> &str;
    fn key(&self) -> &str;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommittedHumanChannelCreation<A: CommittedChannelAddress> {
    source_viewer: UserId,
    source_workspace: WorkspaceId,
    kind: CreatedChannelKind,
    address: A,
    channel: ChannelDirectoryRow,
}

impl<A: CommittedChannelAddress> CommittedHumanChannelCreation<A> {
    pub fn regular(
        source_viewer: UserId,
        source_workspace: WorkspaceId,
        address: A,
        channel: ChannelDirectoryRow,
    ) -> Result<Self, ChannelCreationProjectionError> {
        Self::projected(
            source_viewer,
            source_workspace,
            CreatedChannelKind::Regular,
            address,
            channel,
        )
    }

    pub fn agent_home(
        source_viewer: UserId,
        source_workspace: WorkspaceId,
        address: A,
        channel: ChannelDirectoryRow,
    ) -> Result<Self, ChannelCreationProjectionError> {
        Self::projected(
            source_viewer,
            source_workspace,
            CreatedChannelKind::AgentHome,
            address,
            channel,
        )
    }

    fn projected(
        source_viewer: UserId,
        source_workspace: WorkspaceId,
        kind: CreatedChannelKind,
        address: A,
        channel: ChannelDirectoryRow,
    ) -> Result<Self, ChannelCreationProjectionError> {
        if channel.source_viewer() != &source_viewer || channel.workspace() != &source_workspace {
            return Err(ChannelCreationProjectionError::ForeignChannelCoordinate);
        }
        if channel.title() != address.title() || address.key().is_empty() {
            return Err(ChannelCreationProjectionError::AddressRowMismatch);
        }
        if channel.status() != ChannelStatus::Idle
            || channel.archived_at().is_some()
            || !channel.is_member()
            || channel.spawned_by_agent().is_some()
        {
            return Err(ChannelCreationProjectionError::NotFreshHumanCreation);
        }
        match (kind, channel.roster(), channel.visibility()) {
            (CreatedChannelKind::Regular, DirectoryRoster::Open, _)
            | (CreatedChannelKind::AgentHome, DirectoryRoster::Fixed, ChannelVisibility::Private) =>
                {}
            _ => return Err(ChannelCreationProjectionError::KindRosterVisibilityMismatch),
        }
        Ok(Self {
            source_viewer,
            source_workspace,
            kind,
            address,
            channel,
        })
    }

    pub fn bind(
        self,
        requested_viewer: &UserId,
        requested_workspace: &WorkspaceId,
    ) -> Result<BoundHumanChannelCreation<A>, ChannelCreationProjectionError> {
        if &self.source_viewer != requested_viewer
            || &self.source_workspace != requested_workspace
            || self.channel.source_viewer() != requested_viewer
            || self.channel.workspace() != requested_workspace
        {
            return Err(ChannelCreationProjectionError::ForeignCommitCoordinate);
        }
        Ok(BoundHumanChannelCreation(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundHumanChannelCreation<A: CommittedChannelAddress>(CommittedHumanChannelCreation<A>);

impl<A: CommittedChannelAddress> BoundHumanChannelCreation<A> {
    pub fn viewer(&self) -> &UserId {
        &self.0.source_viewer
    }
    pub fn workspace(&self) -> &WorkspaceId {
        &self.0.source_workspace
    }
    pub const fn kind(&self) -> CreatedChannelKind {
        self.0.kind
    }
    pub fn channel(&self) -> &ChannelDirectoryRow {
        &self.0.channel
    }
    pub fn address(&self) -> &A {
        &self.0.address
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ChannelCreationProjectionError {
    #[error("created channel carries a foreign viewer or workspace coordinate")]
    ForeignChannelCoordinate,
    #[error("created channel address and stored display title disagree")]
    AddressRowMismatch,
    #[error("created channel is not a fresh human-created row")]
    NotFreshHumanCreation,
    #[error("created channel kind, roster and visibility disagree")]
    KindRosterVisibilityMismatch,
    #[error("committed channel creation does not belong to the request")]
    ForeignCommitCoordinate,
}

pub trait HumanChannelCreatePort {
    type Error: Error + Send + Sync + 'static;
    type Address: CommittedChannelAddress;

    fn create_human_channel(
        &self,
        viewer: UserId,
        workspace: WorkspaceId,
        request: HumanChannelCreateRequest,
    ) -> impl Future<
        Output = Result<
            Result<CommittedHumanChannelCreation<Self::Address>, HumanChannelCreateRefusal>,
            Self::Error,
        >,
    > + Send;
}

pub trait HumanChannelCreateAftermath<A: CommittedChannelAddress> {
    fn workspace_channels_changed(
        &self,
        fact: &BoundHumanChannelCreation<A>,
    ) -> impl Future<Output = Result<(), ChannelCreationAftermathFailure>> + Send;

    fn title_address_taken(
        &self,
        fact: &BoundHumanChannelCreation<A>,
    ) -> impl Future<Output = Result<(), ChannelCreationAftermathFailure>> + Send;
}

#[derive(Debug, thiserror::Error)]
#[error("a committed channel-creation aftermath failed")]
pub struct ChannelCreationAftermathFailure {
    #[source]
    source: Box<dyn Error + Send + Sync + 'static>,
}

impl ChannelCreationAftermathFailure {
    pub fn from_source(source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            source: Box::new(source),
        }
    }
}

pub struct HumanChannelCreateExecution<A: CommittedChannelAddress> {
    committed: BoundHumanChannelCreation<A>,
    first_aftermath_failure: Option<ChannelCreationAftermathFailure>,
}

impl<A: CommittedChannelAddress> HumanChannelCreateExecution<A> {
    pub fn committed(&self) -> &BoundHumanChannelCreation<A> {
        &self.committed
    }
    pub fn first_aftermath_failure(&self) -> Option<&ChannelCreationAftermathFailure> {
        self.first_aftermath_failure.as_ref()
    }
}

pub async fn create_human_channel<P: HumanChannelCreatePort>(
    port: &P,
    aftermath: &impl HumanChannelCreateAftermath<P::Address>,
    viewer: UserId,
    workspace: WorkspaceId,
    request: HumanChannelCreateRequest,
) -> Result<
    Result<HumanChannelCreateExecution<P::Address>, HumanChannelCreateRefusal>,
    HumanChannelCreateExecutionError<P::Error>,
> {
    let committed = match port
        .create_human_channel(viewer.clone(), workspace.clone(), request)
        .await
        .map_err(HumanChannelCreateExecutionError::Persistence)?
    {
        Ok(committed) => committed,
        Err(refusal) => return Ok(Err(refusal)),
    };
    let committed = committed.bind(&viewer, &workspace)?;

    let mut first_aftermath_failure = aftermath.workspace_channels_changed(&committed).await.err();
    if let Err(error) = aftermath.title_address_taken(&committed).await
        && first_aftermath_failure.is_none()
    {
        first_aftermath_failure = Some(error);
    }

    Ok(Ok(HumanChannelCreateExecution {
        committed,
        first_aftermath_failure,
    }))
}

#[derive(Debug, thiserror::Error)]
pub enum HumanChannelCreateExecutionError<E: Error + 'static> {
    #[error("channel creation persistence failed")]
    Persistence(#[source] E),
    #[error(transparent)]
    Identity(#[from] ChannelCreationProjectionError),
}

#[cfg(test)]
mod tests {
    use std::{
        error::Error,
        sync::{Arc, Mutex},
    };

    use crate::identity::ConversationId;

    use super::*;

    fn user(raw: &str) -> UserId {
        UserId::parse(raw).unwrap()
    }
    fn workspace(raw: &str) -> WorkspaceId {
        WorkspaceId::parse(raw).unwrap()
    }
    fn row(viewer: &str, workspace_id: &str, roster: DirectoryRoster) -> ChannelDirectoryRow {
        ChannelDirectoryRow::projected(
            user(viewer),
            workspace(workspace_id),
            ConversationId::parse("created").unwrap(),
            roster,
            "General".into(),
            ChannelStatus::Idle,
            None,
            None,
            None,
            None,
            0,
            10,
            10,
            ChannelVisibility::Private,
            true,
        )
        .unwrap()
    }
    #[derive(Clone, Debug, Eq, PartialEq)]
    struct Address {
        title: &'static str,
        key: &'static str,
    }
    impl CommittedChannelAddress for Address {
        fn title(&self) -> &str {
            self.title
        }
        fn key(&self) -> &str {
            self.key
        }
    }
    fn address() -> Address {
        Address {
            title: "General",
            key: "general",
        }
    }

    #[test]
    fn request_dedupes_each_explicit_member_axis_without_inventing_a_snapshot() {
        let request = HumanChannelCreateRequest::new(
            "General".into(),
            vec!["a".into(), "a".into(), "b".into()],
            Some(vec!["u".into(), "u".into()]),
            None,
        );
        assert_eq!(request.member_agent_ids(), ["a", "b"]);
        assert_eq!(request.member_user_ids().unwrap(), ["u"]);
        assert_eq!(request.visibility(), ChannelVisibility::Private);

        let omitted = HumanChannelCreateRequest::new("General".into(), vec![], None, None);
        assert!(omitted.member_user_ids().is_none());
    }

    #[test]
    fn committed_creation_seals_kind_freshness_and_all_identity_coordinates() {
        assert_eq!(
            CommittedHumanChannelCreation::regular(
                user("u"),
                workspace("w"),
                address(),
                row("u", "other", DirectoryRoster::Open),
            )
            .unwrap_err(),
            ChannelCreationProjectionError::ForeignChannelCoordinate
        );
        assert_eq!(
            CommittedHumanChannelCreation::agent_home(
                user("u"),
                workspace("w"),
                address(),
                row("u", "w", DirectoryRoster::Open),
            )
            .unwrap_err(),
            ChannelCreationProjectionError::KindRosterVisibilityMismatch
        );
        let committed = CommittedHumanChannelCreation::regular(
            user("u"),
            workspace("w"),
            address(),
            row("u", "w", DirectoryRoster::Open),
        )
        .unwrap();
        assert_eq!(
            committed.clone().bind(&user("other"), &workspace("w")),
            Err(ChannelCreationProjectionError::ForeignCommitCoordinate)
        );
        assert_eq!(
            committed.bind(&user("u"), &workspace("other")),
            Err(ChannelCreationProjectionError::ForeignCommitCoordinate)
        );
    }

    #[derive(Debug, thiserror::Error)]
    #[error("store failed")]
    struct StoreFailure;

    struct Store(CommittedHumanChannelCreation<Address>);
    impl HumanChannelCreatePort for Store {
        type Error = StoreFailure;
        type Address = Address;
        async fn create_human_channel(
            &self,
            _: UserId,
            _: WorkspaceId,
            _: HumanChannelCreateRequest,
        ) -> Result<
            Result<CommittedHumanChannelCreation<Self::Address>, HumanChannelCreateRefusal>,
            Self::Error,
        > {
            Ok(Ok(self.0.clone()))
        }
    }

    #[derive(Debug, thiserror::Error)]
    #[error("{0}")]
    struct EffectFailure(&'static str);

    struct Effects(Arc<Mutex<Vec<&'static str>>>);
    impl HumanChannelCreateAftermath<Address> for Effects {
        async fn workspace_channels_changed(
            &self,
            _: &BoundHumanChannelCreation<Address>,
        ) -> Result<(), ChannelCreationAftermathFailure> {
            self.0.lock().unwrap().push("workspace");
            Err(ChannelCreationAftermathFailure::from_source(EffectFailure(
                "first",
            )))
        }
        async fn title_address_taken(
            &self,
            _: &BoundHumanChannelCreation<Address>,
        ) -> Result<(), ChannelCreationAftermathFailure> {
            self.0.lock().unwrap().push("title");
            Err(ChannelCreationAftermathFailure::from_source(EffectFailure(
                "later",
            )))
        }
    }

    #[tokio::test]
    async fn commit_precedes_both_effects_and_only_the_first_failure_survives() {
        let calls = Arc::new(Mutex::new(vec![]));
        let result = create_human_channel(
            &Store(
                CommittedHumanChannelCreation::regular(
                    user("u"),
                    workspace("w"),
                    address(),
                    row("u", "w", DirectoryRoster::Open),
                )
                .unwrap(),
            ),
            &Effects(calls.clone()),
            user("u"),
            workspace("w"),
            HumanChannelCreateRequest::new("General".into(), vec![], None, None),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(*calls.lock().unwrap(), ["workspace", "title"]);
        let failure = result.first_aftermath_failure().unwrap();
        assert_eq!(failure.source().unwrap().to_string(), "first");
        assert_eq!(
            result.committed().channel().conversation().as_str(),
            "created"
        );
    }
}
