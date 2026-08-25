use std::{collections::HashSet, error::Error, future::Future};

use crate::identity::{AgentId, ConversationId, UserId, WorkspaceId};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelVisibility {
    Private,
    Public,
}

impl ChannelVisibility {
    pub fn parse(raw: &str) -> Result<Self, UnknownChannelVisibility> {
        match raw {
            "private" => Ok(Self::Private),
            "public" => Ok(Self::Public),
            _ => Err(UnknownChannelVisibility),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Private => "private",
            Self::Public => "public",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored channel visibility is outside the published closed set")]
pub struct UnknownChannelVisibility;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelStatus {
    Starting,
    Active,
    Idle,
    Archived,
    Crashed,
}

impl ChannelStatus {
    pub fn parse(raw: &str) -> Result<Self, UnknownChannelStatus> {
        match raw {
            "starting" => Ok(Self::Starting),
            "active" => Ok(Self::Active),
            "idle" => Ok(Self::Idle),
            "archived" => Ok(Self::Archived),
            "crashed" => Ok(Self::Crashed),
            _ => Err(UnknownChannelStatus),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Active => "active",
            Self::Idle => "idle",
            Self::Archived => "archived",
            Self::Crashed => "crashed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored channel status is outside the published closed set")]
pub struct UnknownChannelStatus;

/// The two workspace directory arms.  Agent-home is an ownership relation,
/// never a boolean flag supplied independently of its owner coordinate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DirectoryWorkspaceKind {
    Regular,
    AgentHome { owner: AgentId },
}

/// One selected conversation row before its source coordinates are sealed to a
/// directory request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelDirectoryRow {
    source_viewer: UserId,
    workspace: WorkspaceId,
    conversation: ConversationId,
    roster: DirectoryRoster,
    title: String,
    status: ChannelStatus,
    spawned_by_agent: Option<AgentId>,
    closed_at: Option<i64>,
    close_summary: Option<String>,
    archived_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
    visibility: ChannelVisibility,
    is_member: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DirectoryRoster {
    Open,
    Fixed,
}

impl DirectoryRoster {
    pub fn parse(raw: &str) -> Result<Self, UnknownDirectoryRoster> {
        match raw {
            "open" => Ok(Self::Open),
            "fixed" => Ok(Self::Fixed),
            _ => Err(UnknownDirectoryRoster),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Fixed => "fixed",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored channel roster is outside the published closed set")]
pub struct UnknownDirectoryRoster;

#[allow(clippy::too_many_arguments)]
impl ChannelDirectoryRow {
    pub fn projected(
        source_viewer: UserId,
        workspace: WorkspaceId,
        conversation: ConversationId,
        roster: DirectoryRoster,
        title: String,
        status: ChannelStatus,
        spawned_by_agent: Option<AgentId>,
        closed_at: Option<i64>,
        close_summary: Option<String>,
        archived_at: Option<i64>,
        created_at: i64,
        updated_at: i64,
        visibility: ChannelVisibility,
        is_member: bool,
    ) -> Result<Self, ChannelDirectoryProjectionError> {
        if title.is_empty() {
            return Err(ChannelDirectoryProjectionError::EmptyTitle);
        }
        if roster == DirectoryRoster::Fixed && visibility == ChannelVisibility::Public {
            return Err(ChannelDirectoryProjectionError::PublicFixedRoster);
        }
        Ok(Self {
            source_viewer,
            workspace,
            conversation,
            roster,
            title,
            status,
            spawned_by_agent,
            closed_at,
            close_summary,
            archived_at,
            created_at,
            updated_at,
            visibility,
            is_member,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ChannelDirectoryProjectionError {
    #[error("stored channel title is empty")]
    EmptyTitle,
    #[error("a fixed-roster channel cannot be public")]
    PublicFixedRoster,
    #[error("directory contains a row from another viewer or workspace")]
    ForeignCoordinate,
    #[error("directory contains duplicate conversation identity")]
    DuplicateConversation,
    #[error("regular directory contains a fixed-roster row")]
    FixedRowInRegularDirectory,
    #[error("agent-home directory contains an open-roster row")]
    OpenRowInAgentHomeDirectory,
    #[error("archived directory contains an active row")]
    ActiveRowInArchivedDirectory,
    #[error("active directory contains an archived row")]
    ArchivedRowInActiveDirectory,
    #[error("archived directory exposed a non-member row")]
    ArchivedNonMember,
    #[error("active directory exposed a private non-member row")]
    PrivateNonMember,
    #[error("sort state contains an entity outside the active directory")]
    SortEntryOutsideDirectory,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelSortEntry {
    source_viewer: UserId,
    workspace: WorkspaceId,
    conversation: ConversationId,
    rank: Option<i64>,
    last_accessed_at: Option<i64>,
    starred_at: Option<i64>,
}

impl ChannelSortEntry {
    pub fn projected(
        source_viewer: UserId,
        workspace: WorkspaceId,
        conversation: ConversationId,
        rank: Option<i64>,
        last_accessed_at: Option<i64>,
        starred_at: Option<i64>,
    ) -> Self {
        Self {
            source_viewer,
            workspace,
            conversation,
            rank,
            last_accessed_at,
            starred_at,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelSortMode {
    Recent,
    Manual,
}

impl ChannelSortMode {
    pub fn parse(raw: &str) -> Result<Self, UnknownChannelSortMode> {
        match raw {
            "recent" => Ok(Self::Recent),
            "manual" => Ok(Self::Manual),
            _ => Err(UnknownChannelSortMode),
        }
    }
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Recent => "recent",
            Self::Manual => "manual",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("stored channel sort mode is outside the published closed set")]
pub struct UnknownChannelSortMode;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChannelSortState {
    source_viewer: UserId,
    workspace: WorkspaceId,
    mode: Option<ChannelSortMode>,
    entries: Vec<ChannelSortEntry>,
}

impl ChannelSortState {
    pub fn projected(
        source_viewer: UserId,
        workspace: WorkspaceId,
        mode: Option<ChannelSortMode>,
        entries: Vec<ChannelSortEntry>,
    ) -> Result<Self, ChannelDirectoryProjectionError> {
        let mut ids = HashSet::new();
        for entry in &entries {
            if entry.source_viewer != source_viewer || entry.workspace != workspace {
                return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
            }
            if !ids.insert(entry.conversation.clone()) {
                return Err(ChannelDirectoryProjectionError::DuplicateConversation);
            }
        }
        Ok(Self {
            source_viewer,
            workspace,
            mode,
            entries,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceChannelDirectory {
    source_viewer: UserId,
    workspace: WorkspaceId,
    kind: DirectoryWorkspaceKind,
    rows: Vec<ChannelDirectoryRow>,
    sort: Option<ChannelSortState>,
}

impl WorkspaceChannelDirectory {
    pub fn projected(
        source_viewer: UserId,
        workspace: WorkspaceId,
        kind: DirectoryWorkspaceKind,
        rows: Vec<ChannelDirectoryRow>,
        sort: Option<ChannelSortState>,
        archived: bool,
    ) -> Result<Self, ChannelDirectoryProjectionError> {
        let mut ids = HashSet::new();
        for row in &rows {
            if row.source_viewer != source_viewer || row.workspace != workspace {
                return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
            }
            if !ids.insert(row.conversation.clone()) {
                return Err(ChannelDirectoryProjectionError::DuplicateConversation);
            }
            if archived != row.archived_at.is_some() {
                return Err(if archived {
                    ChannelDirectoryProjectionError::ActiveRowInArchivedDirectory
                } else {
                    ChannelDirectoryProjectionError::ArchivedRowInActiveDirectory
                });
            }
            match (&kind, row.roster) {
                (DirectoryWorkspaceKind::Regular, DirectoryRoster::Open)
                | (DirectoryWorkspaceKind::AgentHome { .. }, DirectoryRoster::Fixed) => {}
                (DirectoryWorkspaceKind::Regular, DirectoryRoster::Fixed) => {
                    return Err(ChannelDirectoryProjectionError::FixedRowInRegularDirectory);
                }
                (DirectoryWorkspaceKind::AgentHome { .. }, DirectoryRoster::Open) => {
                    return Err(ChannelDirectoryProjectionError::OpenRowInAgentHomeDirectory);
                }
            }
            if archived && !row.is_member {
                return Err(ChannelDirectoryProjectionError::ArchivedNonMember);
            }
            if !archived && !row.is_member && row.visibility != ChannelVisibility::Public {
                return Err(ChannelDirectoryProjectionError::PrivateNonMember);
            }
        }
        if archived && sort.is_some() {
            return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
        }
        if let Some(sort) = &sort {
            if sort.source_viewer != source_viewer || sort.workspace != workspace {
                return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
            }
            let row_ids: HashSet<_> = rows.iter().map(|row| &row.conversation).collect();
            if sort
                .entries
                .iter()
                .any(|entry| !row_ids.contains(&entry.conversation))
            {
                return Err(ChannelDirectoryProjectionError::SortEntryOutsideDirectory);
            }
        }
        Ok(Self {
            source_viewer,
            workspace,
            kind,
            rows,
            sort,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> Result<BoundWorkspaceChannelDirectory, ChannelDirectoryProjectionError> {
        if &self.source_viewer != viewer || &self.workspace != workspace {
            return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
        }
        Ok(BoundWorkspaceChannelDirectory(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundWorkspaceChannelDirectory(WorkspaceChannelDirectory);

impl BoundWorkspaceChannelDirectory {
    pub fn workspace(&self) -> &WorkspaceId {
        &self.0.workspace
    }
    pub fn kind(&self) -> &DirectoryWorkspaceKind {
        &self.0.kind
    }
    pub fn rows(&self) -> &[ChannelDirectoryRow] {
        &self.0.rows
    }
    pub fn sort(&self) -> Option<&ChannelSortState> {
        self.0.sort.as_ref()
    }
}

impl ChannelDirectoryRow {
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub const fn roster(&self) -> DirectoryRoster {
        self.roster
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    pub const fn status(&self) -> ChannelStatus {
        self.status
    }
    pub fn spawned_by_agent(&self) -> Option<&AgentId> {
        self.spawned_by_agent.as_ref()
    }
    pub const fn closed_at(&self) -> Option<i64> {
        self.closed_at
    }
    pub fn close_summary(&self) -> Option<&str> {
        self.close_summary.as_deref()
    }
    pub const fn archived_at(&self) -> Option<i64> {
        self.archived_at
    }
    pub const fn created_at(&self) -> i64 {
        self.created_at
    }
    pub const fn updated_at(&self) -> i64 {
        self.updated_at
    }
    pub const fn visibility(&self) -> ChannelVisibility {
        self.visibility
    }
    pub const fn is_member(&self) -> bool {
        self.is_member
    }
}

impl ChannelSortState {
    pub const fn mode(&self) -> Option<ChannelSortMode> {
        self.mode
    }
    pub fn entries(&self) -> &[ChannelSortEntry] {
        &self.entries
    }
}

impl ChannelSortEntry {
    pub fn conversation(&self) -> &ConversationId {
        &self.conversation
    }
    pub const fn rank(&self) -> Option<i64> {
        self.rank
    }
    pub const fn last_accessed_at(&self) -> Option<i64> {
        self.last_accessed_at
    }
    pub const fn starred_at(&self) -> Option<i64> {
        self.starred_at
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchivedChannelRow {
    source_viewer: UserId,
    workspace: WorkspaceId,
    workspace_name: String,
    workspace_archived_at: Option<i64>,
    channel: ChannelDirectoryRow,
}

impl ArchivedChannelRow {
    pub fn projected(
        source_viewer: UserId,
        workspace: WorkspaceId,
        workspace_name: String,
        workspace_archived_at: Option<i64>,
        channel: ChannelDirectoryRow,
    ) -> Result<Self, ChannelDirectoryProjectionError> {
        if workspace_name.is_empty()
            || channel.source_viewer != source_viewer
            || channel.workspace != workspace
            || channel.archived_at.is_none()
            || !channel.is_member
        {
            return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
        }
        Ok(Self {
            source_viewer,
            workspace,
            workspace_name,
            workspace_archived_at,
            channel,
        })
    }

    pub fn workspace(&self) -> &WorkspaceId {
        &self.workspace
    }
    pub fn workspace_name(&self) -> &str {
        &self.workspace_name
    }
    pub const fn workspace_archived_at(&self) -> Option<i64> {
        self.workspace_archived_at
    }
    pub fn channel(&self) -> &ChannelDirectoryRow {
        &self.channel
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GlobalArchivedChannelDirectory {
    source_viewer: UserId,
    workspace_filter: Option<WorkspaceId>,
    rows: Vec<ArchivedChannelRow>,
}

impl GlobalArchivedChannelDirectory {
    pub fn projected(
        source_viewer: UserId,
        workspace_filter: Option<WorkspaceId>,
        rows: Vec<ArchivedChannelRow>,
    ) -> Result<Self, ChannelDirectoryProjectionError> {
        let mut ids = HashSet::new();
        for row in &rows {
            if row.source_viewer != source_viewer
                || workspace_filter
                    .as_ref()
                    .is_some_and(|workspace| workspace != &row.workspace)
            {
                return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
            }
            if !ids.insert(row.channel.conversation.clone()) {
                return Err(ChannelDirectoryProjectionError::DuplicateConversation);
            }
        }
        Ok(Self {
            source_viewer,
            workspace_filter,
            rows,
        })
    }

    pub fn bind(
        self,
        viewer: &UserId,
        workspace_filter: Option<&WorkspaceId>,
    ) -> Result<BoundGlobalArchivedChannelDirectory, ChannelDirectoryProjectionError> {
        if &self.source_viewer != viewer || self.workspace_filter.as_ref() != workspace_filter {
            return Err(ChannelDirectoryProjectionError::ForeignCoordinate);
        }
        Ok(BoundGlobalArchivedChannelDirectory(self))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BoundGlobalArchivedChannelDirectory(GlobalArchivedChannelDirectory);

impl BoundGlobalArchivedChannelDirectory {
    pub fn rows(&self) -> &[ArchivedChannelRow] {
        &self.0.rows
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum WorkspaceDirectoryRefusal {
    #[error("workspace not found")]
    NotFound,
    #[error("viewer cannot read workspace")]
    Forbidden,
}

pub trait ActiveChannelDirectoryPort {
    type Error: Error + Send + Sync + 'static;
    fn active(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> impl Future<
        Output = Result<Result<WorkspaceChannelDirectory, WorkspaceDirectoryRefusal>, Self::Error>,
    > + Send;
}

pub trait ArchivedWorkspaceChannelDirectoryPort {
    type Error: Error + Send + Sync + 'static;
    fn archived(
        &self,
        viewer: &UserId,
        workspace: &WorkspaceId,
    ) -> impl Future<
        Output = Result<Result<WorkspaceChannelDirectory, WorkspaceDirectoryRefusal>, Self::Error>,
    > + Send;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum GlobalArchivedDirectoryRefusal {
    #[error("workspace not found")]
    WorkspaceNotFound,
    #[error("viewer cannot read workspace")]
    Forbidden,
}

pub trait GlobalArchivedChannelDirectoryPort {
    type Error: Error + Send + Sync + 'static;

    fn archived_global(
        &self,
        viewer: &UserId,
        workspace_filter: Option<&WorkspaceId>,
        since: Option<i64>,
    ) -> impl Future<
        Output = Result<
            Result<GlobalArchivedChannelDirectory, GlobalArchivedDirectoryRefusal>,
            Self::Error,
        >,
    > + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        viewer: &str,
        workspace: &str,
        id: &str,
        roster: DirectoryRoster,
        archived: bool,
    ) -> ChannelDirectoryRow {
        ChannelDirectoryRow::projected(
            UserId::parse(viewer).unwrap(),
            WorkspaceId::parse(workspace).unwrap(),
            ConversationId::parse(id).unwrap(),
            roster,
            "General".into(),
            ChannelStatus::Active,
            None,
            None,
            None,
            archived.then_some(8),
            1,
            2,
            ChannelVisibility::Private,
            true,
        )
        .unwrap()
    }

    #[test]
    fn workspace_and_every_row_are_bound_before_projection() {
        let viewer = UserId::parse("u").unwrap();
        let workspace = WorkspaceId::parse("w").unwrap();
        let good = WorkspaceChannelDirectory::projected(
            viewer.clone(),
            workspace.clone(),
            DirectoryWorkspaceKind::Regular,
            vec![row("u", "w", "c", DirectoryRoster::Open, false)],
            None,
            false,
        )
        .unwrap();
        assert!(good.bind(&viewer, &workspace).is_ok());
        assert!(
            WorkspaceChannelDirectory::projected(
                viewer.clone(),
                workspace.clone(),
                DirectoryWorkspaceKind::Regular,
                vec![row("other", "w", "c", DirectoryRoster::Open, false)],
                None,
                false
            )
            .is_err()
        );
        assert!(
            WorkspaceChannelDirectory::projected(
                viewer,
                workspace,
                DirectoryWorkspaceKind::Regular,
                vec![row("u", "other", "c", DirectoryRoster::Open, false)],
                None,
                false
            )
            .is_err()
        );
    }

    #[test]
    fn directory_kind_and_lifecycle_are_closed_algebra() {
        let u = UserId::parse("u").unwrap();
        let w = WorkspaceId::parse("w").unwrap();
        assert!(
            WorkspaceChannelDirectory::projected(
                u.clone(),
                w.clone(),
                DirectoryWorkspaceKind::Regular,
                vec![row("u", "w", "c", DirectoryRoster::Fixed, false)],
                None,
                false
            )
            .is_err()
        );
        assert!(
            WorkspaceChannelDirectory::projected(
                u.clone(),
                w.clone(),
                DirectoryWorkspaceKind::AgentHome {
                    owner: AgentId::parse("a").unwrap()
                },
                vec![row("u", "w", "c", DirectoryRoster::Open, false)],
                None,
                false
            )
            .is_err()
        );
        assert!(
            WorkspaceChannelDirectory::projected(
                u,
                w,
                DirectoryWorkspaceKind::Regular,
                vec![row("u", "w", "c", DirectoryRoster::Open, true)],
                None,
                false
            )
            .is_err()
        );
    }

    #[test]
    fn only_active_regular_public_rows_may_widen_beyond_membership() {
        let u = UserId::parse("u").unwrap();
        let w = WorkspaceId::parse("w").unwrap();
        let public = ChannelDirectoryRow::projected(
            u.clone(),
            w.clone(),
            ConversationId::parse("public").unwrap(),
            DirectoryRoster::Open,
            "Public".into(),
            ChannelStatus::Active,
            None,
            None,
            None,
            None,
            1,
            1,
            ChannelVisibility::Public,
            false,
        )
        .unwrap();
        assert!(
            WorkspaceChannelDirectory::projected(
                u.clone(),
                w.clone(),
                DirectoryWorkspaceKind::Regular,
                vec![public.clone()],
                None,
                false,
            )
            .is_ok()
        );
        assert!(
            WorkspaceChannelDirectory::projected(
                u.clone(),
                w.clone(),
                DirectoryWorkspaceKind::Regular,
                vec![ChannelDirectoryRow {
                    archived_at: Some(2),
                    ..public
                }],
                None,
                true,
            )
            .is_err()
        );

        let fixed_nonmember = ChannelDirectoryRow {
            is_member: false,
            ..row("u", "w", "fixed", DirectoryRoster::Fixed, false)
        };
        assert!(
            WorkspaceChannelDirectory::projected(
                u,
                w,
                DirectoryWorkspaceKind::AgentHome {
                    owner: AgentId::parse("a").unwrap()
                },
                vec![fixed_nonmember],
                None,
                false,
            )
            .is_err()
        );
    }

    #[test]
    fn sort_and_global_archive_keep_their_source_coordinates() {
        let u = UserId::parse("u").unwrap();
        let w = WorkspaceId::parse("w").unwrap();
        let sort = ChannelSortState::projected(
            u.clone(),
            w.clone(),
            Some(ChannelSortMode::Manual),
            vec![ChannelSortEntry::projected(
                u.clone(),
                w.clone(),
                ConversationId::parse("c").unwrap(),
                Some(0),
                None,
                None,
            )],
        )
        .unwrap();
        assert!(
            WorkspaceChannelDirectory::projected(
                u.clone(),
                w.clone(),
                DirectoryWorkspaceKind::Regular,
                vec![row("u", "w", "c", DirectoryRoster::Open, false)],
                Some(sort),
                false,
            )
            .is_ok()
        );
        let foreign_sort = ChannelSortState::projected(
            u.clone(),
            w.clone(),
            None,
            vec![ChannelSortEntry::projected(
                u.clone(),
                w.clone(),
                ConversationId::parse("other").unwrap(),
                None,
                None,
                None,
            )],
        )
        .unwrap();
        assert!(
            WorkspaceChannelDirectory::projected(
                u.clone(),
                w.clone(),
                DirectoryWorkspaceKind::Regular,
                vec![row("u", "w", "c", DirectoryRoster::Open, false)],
                Some(foreign_sort),
                false,
            )
            .is_err()
        );

        let global_row = ArchivedChannelRow::projected(
            u.clone(),
            w.clone(),
            "Workspace".into(),
            None,
            row("u", "w", "archived", DirectoryRoster::Open, true),
        )
        .unwrap();
        let global =
            GlobalArchivedChannelDirectory::projected(u.clone(), Some(w.clone()), vec![global_row])
                .unwrap();
        assert!(global.bind(&u, Some(&w)).is_ok());
    }
}
